import initSqlJs, { Database, BindParams } from "sql.js";
import { ConversationEvent, FileEvent, Memory } from "./types.js";
import path from "path";
import os from "os";
import fs from "fs";

const DEFAULT_RETENTION_DAYS = 30;
const MAX_FILE_EVENTS = 10000;
const MAX_CONVERSATIONS = 10000;
const MAX_MEMORIES = 5000;
const SAVE_DEBOUNCE_MS = 500;

export class Store {
  private db: Database | null = null;
  private dbPath: string;
  private lockPath: string;
  private initPromise: Promise<void>;
  private writeLock: Promise<void> = Promise.resolve();
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private dirty = false;
  readonly retentionDays: number;
  readonly maxFileEvents: number;
  readonly maxConversations: number;
  readonly maxMemories: number;

  constructor(projectDir?: string) {
    const dbDir = projectDir
      ? path.join(projectDir, ".hindsight")
      : path.join(process.env.HINDSIGHT_DATA_DIR || os.homedir(), ".hindsight");
    if (!fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    this.dbPath = path.join(dbDir, "hindsight.db");
    this.lockPath = path.join(dbDir, "hindsight.lock");
    const envDays = Number(process.env.HINDSIGHT_RETENTION_DAYS);
    this.retentionDays = Number.isFinite(envDays) && envDays >= 0
      ? Math.floor(envDays)
      : DEFAULT_RETENTION_DAYS;
    const envMaxEvents = Number(process.env.HINDSIGHT_MAX_FILE_EVENTS);
    this.maxFileEvents = Number.isFinite(envMaxEvents) && envMaxEvents > 0
      ? Math.floor(envMaxEvents)
      : MAX_FILE_EVENTS;
    const envMaxConv = Number(process.env.HINDSIGHT_MAX_CONVERSATIONS);
    this.maxConversations = Number.isFinite(envMaxConv) && envMaxConv > 0
      ? Math.floor(envMaxConv)
      : MAX_CONVERSATIONS;
    const envMaxMem = Number(process.env.HINDSIGHT_MAX_MEMORIES);
    this.maxMemories = Number.isFinite(envMaxMem) && envMaxMem > 0
      ? Math.floor(envMaxMem)
      : MAX_MEMORIES;
    this.initPromise = this.init();
  }

  private async isPidAlive(pid: number): Promise<boolean> {
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return (err as NodeJS.ErrnoException).code === "EPERM";
    }
  }

  /**
   * 独占数据目录锁：sql.js 是整文件导出覆盖写，多实例共享同一 DB 会互相覆盖。
   * 锁文件存在时，若持有者进程已死则接管（崩溃残留），否则拒绝启动。
   */
  private async acquireLock(): Promise<void> {
    const lockInfo = JSON.stringify({ pid: process.pid, startedAt: Date.now() });
    try {
      fs.writeFileSync(this.lockPath, lockInfo, { flag: "wx" });
      return;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
    }

    let holderPid: number | null = null;
    try {
      const raw = fs.readFileSync(this.lockPath, "utf-8");
      holderPid = (JSON.parse(raw) as { pid?: number }).pid ?? null;
    } catch {
      holderPid = null;
    }

    if (holderPid !== null && holderPid !== process.pid && (await this.isPidAlive(holderPid))) {
      throw new Error(
        `Another Hindsight instance (PID ${holderPid}) is already using this data directory. ` +
        `Multiple instances sharing one DB will overwrite each other's data.`
      );
    }

    console.error(
      holderPid === null
        ? `Hindsight: found unreadable lock file, overwriting`
        : `Hindsight: reclaimed stale lock from dead PID ${holderPid}`
    );
    fs.writeFileSync(this.lockPath, lockInfo);
  }

  releaseLock(): void {
    try {
      fs.unlinkSync(this.lockPath);
    } catch {
      // 锁已被清理或非本进程持有，忽略
    }
  }

  private async init() {
    await this.acquireLock();
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

    this.db.run(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )
    `);

    this.db.run(`CREATE INDEX IF NOT EXISTS idx_conv_timestamp ON conversations(timestamp)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_file_timestamp ON file_events(timestamp)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_memory_timestamp ON memories(timestamp)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_memory_type ON memories(type)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_conv_project_ts ON conversations(project, timestamp)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_file_project_ts ON file_events(project, timestamp)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_memory_project_ts ON memories(project, timestamp)`);
    this.db.run(`CREATE INDEX IF NOT EXISTS idx_memory_type_ts ON memories(type, timestamp)`);

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
    this.releaseLock();
  }

  private async cleanup() {
    if (!this.db) return;
    
    const cutoff = Date.now() - this.retentionDays * 24 * 60 * 60 * 1000;
    
    this.db.run("DELETE FROM conversations WHERE timestamp < ?", [cutoff]);
    this.db.run("DELETE FROM file_events WHERE timestamp < ?", [cutoff]);
    this.db.run("DELETE FROM memories WHERE timestamp < ?", [cutoff]);

    this.truncateTable("conversations", this.maxConversations);
    this.truncateTable("file_events", this.maxFileEvents);
    this.truncateTable("memories", this.maxMemories);
    
    this.scheduleSave();
  }

  private truncateTable(table: "conversations" | "file_events" | "memories", maxRows: number): void {
    if (!this.db) return;
    const countResult = this.db.exec(`SELECT COUNT(*) FROM ${table}`);
    const count = countResult[0]?.values[0][0] as number;
    if (count > maxRows) {
      const excess = count - maxRows;
      this.db.run(`DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} ORDER BY timestamp ASC LIMIT ?)`, [excess]);
    }
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

  async addConversations(events: ConversationEvent[]): Promise<number[]> {
    await this.initPromise;
    return this.withLock(() => {
      if (!this.db) throw new Error("Database not initialized");
      const ids: number[] = [];
      for (const event of events) {
        this.db.run(
          "INSERT INTO conversations (timestamp, role, content, project) VALUES (?, ?, ?, ?)",
          [event.timestamp, event.role, event.content, event.project || null]
        );
        const result = this.db.exec("SELECT last_insert_rowid()");
        ids.push(result[0].values[0][0] as number);
      }
      this.scheduleSave();
      return ids;
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

      const findExisting = (): number | null => {
        const sql = memory.project
          ? "SELECT id FROM memories WHERE content = ? AND project = ?"
          : "SELECT id FROM memories WHERE content = ? AND project IS NULL";
        const params: BindParams = memory.project
          ? [memory.content, memory.project]
          : [memory.content];
        const rows = this.db!.exec(sql, params);
        if (rows.length > 0 && rows[0].values.length > 0) {
          return rows[0].values[0][0] as number;
        }
        return null;
      };

      const existingId = findExisting();
      if (existingId !== null) {
        return existingId;
      }

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
          const racedId = findExisting();
          if (racedId !== null) {
            return racedId;
          }
        }
        throw err;
      }
    });
  }

  async replaceMemoryByPrefix(prefix: string, memory: Memory): Promise<number> {
    await this.initPromise;
    return this.withLock(() => {
      if (!this.db) throw new Error("Database not initialized");

      const escapedPrefix = prefix.replace(/[\\%_]/g, "\\$&");
      const likePattern = `${escapedPrefix}%`;
      const deleteSql = memory.project
        ? "DELETE FROM memories WHERE content LIKE ? ESCAPE '\\' AND project = ?"
        : "DELETE FROM memories WHERE content LIKE ? ESCAPE '\\' AND project IS NULL";
      const deleteParams: BindParams = memory.project
        ? [likePattern, memory.project]
        : [likePattern];
      this.db.run(deleteSql, deleteParams);

      this.db.run(
        "INSERT INTO memories (timestamp, type, content, confidence, source, project) VALUES (?, ?, ?, ?, ?, ?)",
        [memory.timestamp, memory.type, memory.content, memory.confidence, memory.source, memory.project || null]
      );
      this.scheduleSave();

      const result = this.db.exec("SELECT last_insert_rowid()");
      return result[0].values[0][0] as number;
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
      this.db.run("DELETE FROM memories WHERE id = ?", [id]);
      const affected = this.db.getRowsModified?.() ?? 0;
      if (affected > 0) {
        this.scheduleSave();
      }
      return affected > 0;
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
      try {
        this.db.run(`UPDATE memories SET ${sets.join(", ")} WHERE id = ?`, params);
      } catch (err) {
        if (err instanceof Error && err.message.includes("UNIQUE constraint failed")) {
          throw new Error("Memory with the same content already exists in this project");
        }
        throw err;
      }
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
    project: string | null;
    isGlobal: boolean;
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
      .map(([key, counts]) => ({
        project: key === "__global__" ? null : key,
        isGlobal: key === "__global__",
        ...counts,
      }))
      .sort((a, b) => (b.conversations + b.memories) - (a.conversations + a.memories));
  }

  async getMemories(
    type?: string,
    limit: number = 50,
    project?: string,
    minConfidence?: number,
    offset: number = 0
  ): Promise<Memory[]> {
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
    if (minConfidence !== undefined) {
      conditions.push("confidence >= ?");
      params.push(minConfidence);
    }
    if (conditions.length > 0) {
      sql += " WHERE " + conditions.join(" AND ");
    }
    sql += " ORDER BY timestamp DESC LIMIT ? OFFSET ?";
    params.push(limit, offset);
    
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
    const conditions: string[] = ["content LIKE ? ESCAPE '\\'"];
    const escapedQuery = query.replace(/[\\%_]/g, "\\$&");
    const params: BindParams = [`%${escapedQuery}%`];
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

  async getAllConversations(project?: string, offset?: number, limit?: number): Promise<ConversationEvent[]> {
    await this.initPromise;
    if (!this.db) throw new Error("Database not initialized");
    let sql = "SELECT * FROM conversations";
    const params: BindParams = [];
    if (project) {
      sql += " WHERE project = ?";
      params.push(project);
    }
    sql += " ORDER BY timestamp ASC";
    if (limit !== undefined) {
      sql += " LIMIT ? OFFSET ?";
      params.push(limit, offset ?? 0);
    } else if (offset !== undefined && offset > 0) {
      sql += " LIMIT -1 OFFSET ?";
      params.push(offset);
    }
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const results: ConversationEvent[] = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject() as unknown as ConversationEvent);
    }
    stmt.free();
    return results;
  }

  async getAllFileEvents(project?: string, offset?: number, limit?: number): Promise<FileEvent[]> {
    await this.initPromise;
    if (!this.db) throw new Error("Database not initialized");
    let sql = "SELECT * FROM file_events";
    const params: BindParams = [];
    if (project) {
      sql += " WHERE project = ?";
      params.push(project);
    }
    sql += " ORDER BY timestamp ASC";
    if (limit !== undefined) {
      sql += " LIMIT ? OFFSET ?";
      params.push(limit, offset ?? 0);
    } else if (offset !== undefined && offset > 0) {
      sql += " LIMIT -1 OFFSET ?";
      params.push(offset);
    }
    const stmt = this.db.prepare(sql);
    stmt.bind(params);
    const results: FileEvent[] = [];
    while (stmt.step()) {
      results.push(stmt.getAsObject() as unknown as FileEvent);
    }
    stmt.free();
    return results;
  }

  async exportData(
    project?: string,
    options?: {
      include?: ("conversations" | "fileEvents" | "memories")[];
      offset?: number;
      limit?: number;
    }
  ): Promise<{
    exportedAt: number;
    project: string | null;
    include: ("conversations" | "fileEvents" | "memories")[];
    offset: number;
    limit: number | null;
    counts: { conversations: number; fileEvents: number; memories: number };
    conversations: ConversationEvent[];
    fileEvents: FileEvent[];
    memories: Memory[];
  }> {
    const ALL: ("conversations" | "fileEvents" | "memories")[] = [
      "conversations",
      "fileEvents",
      "memories",
    ];
    const include = options?.include && options.include.length > 0 ? options.include : ALL;
    const offset = options?.offset ?? 0;
    const limit = options?.limit;
    const has = (k: string) => include.includes(k as any);

    const [conversations, fileEvents, memories] = await Promise.all([
      has("conversations") ? this.getAllConversations(project, offset, limit) : Promise.resolve([] as ConversationEvent[]),
      has("fileEvents") ? this.getAllFileEvents(project, offset, limit) : Promise.resolve([] as FileEvent[]),
      has("memories") ? this.getMemories(undefined, limit ?? 100000, project, undefined, offset) : Promise.resolve([] as Memory[]),
    ]);

    return {
      exportedAt: Date.now(),
      project: project || null,
      include,
      offset,
      limit: limit ?? null,
      counts: {
        conversations: conversations.length,
        fileEvents: fileEvents.length,
        memories: memories.length,
      },
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

      const totalDeleted =
        deletedConversations + deletedFileEvents + deletedMemories;
      if (totalDeleted > 0) {
        this.db.run("VACUUM");
      }

      this.scheduleSave();
      return { deletedConversations, deletedFileEvents, deletedMemories };
    });
  }

  async getMeta(key: string): Promise<string | null> {
    await this.initPromise;
    if (!this.db) throw new Error("Database not initialized");
    const rows = this.db.exec("SELECT value FROM meta WHERE key = ?", [key]);
    if (rows.length === 0 || rows[0].values.length === 0) return null;
    return rows[0].values[0][0] as string;
  }

  async setMeta(key: string, value: string): Promise<void> {
    await this.initPromise;
    return this.withLock(() => {
      if (!this.db) throw new Error("Database not initialized");
      this.db.run(
        "INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [key, value]
      );
      this.scheduleSave();
    });
  }
}
