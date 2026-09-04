import initSqlJs, { Database, BindParams } from "sql.js";
import { ConversationEvent, FileEvent, Memory } from "./types.js";
import path from "path";
import os from "os";
import fs from "fs";

const DB_CLEANUP_DAYS = 30;
const MAX_FILE_EVENTS = 10000;
const SAVE_DEBOUNCE_MS = 500;

export class Store {
  private db: Database | null = null;
  private dbPath: string;
  private initPromise: Promise<void>;
  private writeLock: Promise<void> = Promise.resolve();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;

  constructor(projectDir?: string) {
    const dbDir = projectDir
      ? path.join(projectDir, ".hindsight")
      : path.join(process.env.HINDSIGHT_DATA_DIR || os.homedir(), ".hindsight");
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    this.dbPath = path.join(dbDir, "hindsight.db");
    this.initPromise = this.init();
  }

  private async init() {
    const SQL = await initSqlJs();
    
    if (fs.existsSync(this.dbPath)) {
      const buffer = fs.readFileSync(this.dbPath);
      this.db = new SQL.Database(buffer);
    } else {
      this.db = new SQL.Database();
    }

    this.db.run(`
      CREATE TABLE IF NOT EXISTS conversations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        project TEXT
      )
    `);

    this.db.run(`
      CREATE TABLE IF NOT EXISTS file_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        path TEXT NOT NULL,
        action TEXT NOT NULL,
        project TEXT
      )
    `);

    this.migrateMemoriesTable();

    this.db.run(`CREATE INDEX IF NOT EXISTS idx_conv_timestamp ON conversations(timestamp)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_file_timestamp ON file_events(timestamp)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_memory_timestamp ON memories(timestamp)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_memory_type ON memories(type)`);

    this.scheduleSave();
    await this.cleanup();
  }

  private migrateMemoriesTable() {
    if (!this.db) return;
    const tables = this.db.exec("SELECT sql FROM sqlite_master WHERE type='table' AND name='memories'");
    if (tables.length === 0) {
      this.db.run(`
        CREATE TABLE memories (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp INTEGER NOT NULL,
          type TEXT NOT NULL,
          content TEXT NOT NULL,
          confidence REAL NOT NULL DEFAULT 0.5,
          source TEXT,
          project TEXT,
          UNIQUE(content, project)
        )
      `);
      return;
    }
    const tableSql = tables[0].values[0][0] as string;
    if (tableSql.includes("UNIQUE(content, project)")) return;

    this.db.run("BEGIN TRANSACTION");
    try {
      this.db.run(`
        CREATE TABLE memories_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp INTEGER NOT NULL,
          type TEXT NOT NULL,
          content TEXT NOT NULL,
          confidence REAL NOT NULL DEFAULT 0.5,
          source TEXT,
          project TEXT,
          UNIQUE(content, project)
        )
      `);
      this.db.run(`
        INSERT OR IGNORE INTO memories_new
        SELECT * FROM memories
      `);
      this.db.run(`DROP TABLE memories`);
      this.db.run(`ALTER TABLE memories_new RENAME TO memories`);
      this.db.run("COMMIT");
    } catch (err) {
      this.db.run("ROLLBACK");
      throw err;
    }
  }

  private async withLock<T>(fn: () => T): Promise<T> {
    const result = this.writeLock.then(fn);
    this.writeLock = result.then(
      () => {},
      () => {}
    );
    return result;
  }

  private scheduleSave() {
    this.dirty = true;
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.flushSave();
    }, SAVE_DEBOUNCE_MS);
  }

  flushSave() {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.dirty && this.db) {
      const data = this.db.export();
      const buffer = Buffer.from(data);
      fs.writeFileSync(this.dbPath, buffer);
      this.dirty = false;
    }
  }

  shutdown() {
    this.flushSave();
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  private async cleanup() {
    if (!this.db) return;
    
    const cutoff = Date.now() - DB_CLEANUP_DAYS * 24 * 60 * 60 * 1000;
    
    this.db.run("DELETE FROM conversations WHERE timestamp < ?", [cutoff]);
    this.db.run("DELETE FROM file_events WHERE timestamp < ?", [cutoff]);
    this.db.run("DELETE FROM memories WHERE timestamp < ?", [cutoff]);
    
    const countResult = this.db.exec("SELECT COUNT(*) FROM file_events");
    const count = countResult[0]?.values[0][0] as number;
    if (count > MAX_FILE_EVENTS) {
      const excess = count - MAX_FILE_EVENTS;
      this.db.run(`DELETE FROM file_events WHERE id IN (SELECT id FROM file_events ORDER BY timestamp ASC LIMIT ?)`, [excess]);
    }
    
    this.scheduleSave();
  }

  async addConversation(event: ConversationEvent): Promise<number> {
    await this.initPromise;
    return this.withLock(() => {
      if (!this.db) throw new Error("Database not initialized");
      
      this.db.run(
        "INSERT INTO conversations (timestamp, role, content, project) VALUES (?, ?, ?, ?)",
        [event.timestamp, event.role, event.content, event.project || null]
      );
      this.scheduleSave();
      
      const result = this.db.exec("SELECT last_insert_rowid()");
      return result[0].values[0][0] as number;
    });
  }

  async addFileEvent(event: FileEvent): Promise<number> {
    await this.initPromise;
    return this.withLock(() => {
      if (!this.db) throw new Error("Database not initialized");
      
      this.db.run(
        "INSERT INTO file_events (timestamp, path, action, project) VALUES (?, ?, ?, ?)",
        [event.timestamp, event.path, event.action, event.project || null]
      );
      this.scheduleSave();
      
      const result = this.db.exec("SELECT last_insert_rowid()");
      return result[0].values[0][0] as number;
    });
  }

  async addMemory(memory: Memory): Promise<number> {
    await this.initPromise;
    return this.withLock(() => {
      if (!this.db) throw new Error("Database not initialized");
      
      try {
        this.db.run(
          "INSERT INTO memories (timestamp, type, content, confidence, source, project) VALUES (?, ?, ?, ?, ?, ?)",
          [memory.timestamp, memory.type, memory.content, memory.confidence, memory.source, memory.project || null]
        );
        this.scheduleSave();
        
        const result = this.db.exec("SELECT last_insert_rowid()");
        return result[0].values[0][0] as number;
      } catch (err) {
        if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
          const existing = this.db.exec(
            "SELECT id FROM memories WHERE content = ? AND project IS ?",
            [memory.content, memory.project || null]
          );
          if (existing.length > 0) {
            return existing[0].values[0][0] as number;
          }
        }
        throw err;
      }
    });
  }

  async getConversationsAfter(id: number, project?: string): Promise<ConversationEvent[]> {
    await this.initPromise;
    if (!this.db) throw new Error("Database not initialized");
    
    let sql = "SELECT * FROM conversations WHERE id > ?";
    const params: BindParams = [id];
    
    if (project) {
      sql += " AND project = ?";
      params.push(project);
    }
    
    sql += " ORDER BY id ASC";
    
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    
    const results: ConversationEvent[] = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject() as unknown as ConversationEvent);
    }
    stmt.free();
    return results;
  }

  async getRecentConversations(limit: number = 20, project?: string): Promise<ConversationEvent[]> {
    await this.initPromise;
    if (!this.db) throw new Error("Database not initialized");

    let sql = "SELECT * FROM conversations";
    const params: BindParams = [];
    if (project) {
      sql += " WHERE project = ?";
      params.push(project);
    }
    sql += " ORDER BY timestamp DESC LIMIT ?";
    params.push(limit);

    const stmt = this.db.prepare(sql);
    stmt.bind(params);

    const results: ConversationEvent[] = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject() as unknown as ConversationEvent);
    }
    stmt.free();
    return results.reverse();
  }

  async getFileEventsAfter(id: number, project?: string): Promise<FileEvent[]> {
    await this.initPromise;
    if (!this.db) throw new Error("Database not initialized");
    
    let sql = "SELECT * FROM file_events WHERE id > ?";
    const params: BindParams = [id];
    
    if (project) {
      sql += " AND project = ?";
      params.push(project);
    }
    
    sql += " ORDER BY id ASC";
    
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    
    const results: FileEvent[] = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject() as unknown as FileEvent);
    }
    stmt.free();
    return results;
  }

  async getRecentFileEvents(limit: number = 100, project?: string): Promise<FileEvent[]> {
    await this.initPromise;
    if (!this.db) throw new Error("Database not initialized");
    
    let sql = "SELECT * FROM file_events";
    const params: BindParams = [];
    if (project) {
      sql += " WHERE project = ?";
      params.push(project);
    }
    sql += " ORDER BY timestamp DESC LIMIT ?";
    params.push(limit);
    
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    
    const results: FileEvent[] = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject() as unknown as FileEvent);
    }
    stmt.free();
    return results;
  }

  async deleteMemory(id: number): Promise<boolean> {
    await this.initPromise;
    return this.withLock(() => {
      if (!this.db) throw new Error("Database not initialized");
      const before = this.db.getRowsModified?.() ?? 0;
      this.db.run("DELETE FROM memories WHERE id = ?", [id]);
      const affected = this.db.getRowsModified?.() ?? 0;
      if (affected > before) {
        this.scheduleSave();
      }
      return affected > before;
    });
  }

  async updateMemory(
    id: number,
    updates: { content?: string; confidence?: number; type?: Memory["type"] }
  ): Promise<boolean> {    await this.initPromise;
    return this.withLock(() => {
      if (!this.db) throw new Error("Database not initialized");

      const exists = this.db!.exec("SELECT id FROM memories WHERE id = ?", [id]);
      if (exists.length === 0) return false;

      const sets: string[] = [];
      const params: BindParams = [];
      if (updates.content !== undefined) {
        sets.push("content = ?");
        params.push(updates.content);
      }
      if (updates.confidence !== undefined) {
        sets.push("confidence = ?");
        params.push(updates.confidence);
      }
      if (updates.type !== undefined) {
        sets.push("type = ?");
        params.push(updates.type);
      }
      if (sets.length === 0) return true;

      params.push(id);
      this.db.run(`UPDATE memories SET ${sets.join(", ")} WHERE id = ?`, params);
      this.scheduleSave();
      return true;
    });
  }

  async getStats(project?: string): Promise<{
    conversations: number;
    fileEvents: number;
    memories: number;
    byType: Record<string, number>;
    dbSizeBytes: number;
  }> {
    await this.initPromise;
    if (!this.db) throw new Error("Database not initialized");

    const countTable = (table: string): number => {
      let sql = `SELECT COUNT(*) FROM ${table}`;
      const params: BindParams = [];
      if (project) {
        sql += " WHERE project = ?";
        params.push(project);
      }
      const r = this.db!.exec(sql, params);
      return (r[0]?.values[0][0] as number) ?? 0;
    };

    const byType: Record<string, number> = {};
    let typeSql = "SELECT type, COUNT(*) as c FROM memories";
    const typeParams: BindParams = [];
    if (project) {
      typeSql += " WHERE project = ?";
      typeParams.push(project);
    }
    typeSql += " GROUP BY type";
    const typeRows = this.db.exec(typeSql, typeParams);
    for (const row of typeRows) {
      for (const v of row.values) {
        byType[v[0] as string] = v[1] as number;
      }
    }

    let dbSizeBytes = 0;
    try {
      dbSizeBytes = fs.existsSync(this.dbPath)
        ? fs.statSync(this.dbPath).size
        : 0;
    } catch {
      dbSizeBytes = 0;
    }

    return {
      conversations: countTable("conversations"),
      fileEvents: countTable("file_events"),
      memories: countTable("memories"),
      byType,
      dbSizeBytes,
    };
  }

  async listProjects(): Promise<{
    project: string;
    conversations: number;
    fileEvents: number;
    memories: number;
  }[]> {
    await this.initPromise;
    if (!this.db) throw new Error("Database not initialized");

    const map = new Map<string, { conversations: number; fileEvents: number; memories: number }>();
    const ensure = (p: string | null) => {
      const key = p || "__global__";
      if (!map.has(key)) {
        map.set(key, { conversations: 0, fileEvents: 0, memories: 0 });
      }
      return map.get(key)!;
    };

    const aggregate = (table: "conversations" | "file_events" | "memories", field: "conversations" | "fileEvents" | "memories") => {
      const rows = this.db!.exec(
        `SELECT project, COUNT(*) as c FROM ${table} GROUP BY project`
      );
      for (const row of rows) {
        for (const v of row.values) {
          const proj = (v[0] as string | null) || null;
          const count = (v[1] as number) ?? 0;
          ensure(proj)[field] = count;
        }
      }
    };

    aggregate("conversations", "conversations");
    aggregate("file_events", "fileEvents");
    aggregate("memories", "memories");

    return [...map.entries()]
      .map(([project, counts]) => ({ project, ...counts }))
      .sort((a, b) => (b.conversations + b.memories) - (a.conversations + a.memories));
  }

  async getMemories(type?: string, limit: number = 50, project?: string): Promise<Memory[]> {
    await this.initPromise;
    if (!this.db) throw new Error("Database not initialized");
    
    let sql = "SELECT * FROM memories";
    const conditions: string[] = [];
    const params: BindParams = [];
    if (type) {
      conditions.push("type = ?");
      params.push(type);
    }
    if (project) {
      conditions.push("project = ?");
      params.push(project);
    }
    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }
    sql += " ORDER BY timestamp DESC LIMIT ?";
    params.push(limit);
    
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    
    const results: Memory[] = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject() as unknown as Memory);
    }
    stmt.free();
    return results;
  }

  async getMemoryById(id: number): Promise<Memory | null> {
    await this.initPromise;
    if (!this.db) throw new Error("Database not initialized");

    const rows = this.db.exec("SELECT * FROM memories WHERE id = ?", [id]);
    if (rows.length === 0 || rows[0].values.length === 0) return null;

    const cols = rows[0].columns;
    const vals = rows[0].values[0];
    const obj: Record<string, unknown> = {};
    cols.forEach((c, i) => { obj[c] = vals[i]; });
    return obj as unknown as Memory;
  }

  async searchMemories(
    query: string,
    type?: string,
    limit: number = 50,
    project?: string
  ): Promise<Memory[]> {
    await this.initPromise;
    if (!this.db) throw new Error("Database not initialized");

    let sql = "SELECT * FROM memories";
    const conditions: string[] = ["content LIKE ?"];
    const params: BindParams = [`%${query}%`];
    if (type) {
      conditions.push("type = ?");
      params.push(type);
    }
    if (project) {
      conditions.push("project = ?");
      params.push(project);
    }
    sql += " WHERE " + conditions.join(" AND ");
    sql += " ORDER BY timestamp DESC LIMIT ?";
    params.push(limit);

    const stmt = this.db.prepare(sql);
    stmt.bind(params);

    const results: Memory[] = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject() as unknown as Memory);
    }
    stmt.free();
    return results;
  }

  async getAllConversations(project?: string): Promise<ConversationEvent[]> {
    await this.initPromise;
    if (!this.db) throw new Error("Database not initialized");
    let sql = "SELECT * FROM conversations";
    const params: BindParams = [];
    if (project) {
      sql += " WHERE project = ?";
      params.push(project);
    }
    sql += " ORDER BY timestamp ASC";
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const results: ConversationEvent[] = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject() as unknown as ConversationEvent);
    }
    stmt.free();
    return results;
  }

  async getAllFileEvents(project?: string): Promise<FileEvent[]> {
    await this.initPromise;
    if (!this.db) throw new Error("Database not initialized");
    let sql = "SELECT * FROM file_events";
    const params: BindParams = [];
    if (project) {
      sql += " WHERE project = ?";
      params.push(project);
    }
    sql += " ORDER BY timestamp ASC";
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const results: FileEvent[] = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject() as unknown as FileEvent);
    }
    stmt.free();
    return results;
  }

  async exportData(project?: string): Promise<{
    exportedAt: number;
    project: string | null;
    conversations: ConversationEvent[];
    fileEvents: FileEvent[];
    memories: Memory[];
  }> {
    const [conversations, fileEvents, memories] = await Promise.all([
      this.getAllConversations(project),
      this.getAllFileEvents(project),
      this.getMemories(undefined, 100000, project),
    ]);
    return {
      exportedAt: Date.now(),
      project: project || null,
      conversations,
      fileEvents,
      memories,
    };
  }

  async clearOldData(olderThanDays: number, project?: string): Promise<{
    deletedConversations: number;
    deletedFileEvents: number;
    deletedMemories: number;
  }> {
    await this.initPromise;
    return this.withLock(() => {
      if (!this.db) throw new Error("Database not initialized");
      if (olderThanDays < 0) {
        throw new Error("olderThanDays must be >= 0");
      }
      const cutoff = Date.now() - olderThanDays * 24 * 60 * 60 * 1000;

      const countDeleted = (table: string): number => {
        const sql = project
          ? `SELECT COUNT(*) FROM ${table} WHERE timestamp < ? AND project = ?`
          : `SELECT COUNT(*) FROM ${table} WHERE timestamp < ?`;
        const params: BindParams = project ? [cutoff, project] : [cutoff];
        const r = this.db!.exec(sql, params);
        return (r[0]?.values[0][0] as number) ?? 0;
      };

      const deletedConversations = countDeleted("conversations");
      const deletedFileEvents = countDeleted("file_events");
      const deletedMemories = countDeleted("memories");

      const deleteFrom = (table: string) => {
        const sql = project
          ? `DELETE FROM ${table} WHERE timestamp < ? AND project = ?`
          : `DELETE FROM ${table} WHERE timestamp < ?`;
        const params: BindParams = project ? [cutoff, project] : [cutoff];
        this.db!.run(sql, params);
      };

      deleteFrom("conversations");
      deleteFrom("file_events");
      deleteFrom("memories");

      this.scheduleSave();
      return { deletedConversations, deletedFileEvents, deletedMemories };
    });
  }
}
