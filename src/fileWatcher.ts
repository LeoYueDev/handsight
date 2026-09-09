import * as chokidar from "chokidar";
import { Store } from "./store.js";

export class FileWatcher {
  private watcher: chokidar.FSWatcher | null = null;
  private watchPath: string;
  private store: Store;
  private project?: string;
  private errorCount = 0;
  private maxErrors = 10;
  private errorResetTimer: NodeJS.Timeout | null = null;
  private pausedUntil = 0;
  private static readonly ERROR_COOLDOWN_MS = 60000;

  constructor(watchPath: string, store: Store, project?: string) {
    this.watchPath = watchPath;
    this.store = store;
    this.project = project;
  }

  start() {
    this.watcher = chokidar.watch(this.watchPath, {
      ignored: [
        "**/node_modules/**",
        "**/.git/**",
        "**/dist/**",
        "**/build/**",
        "**/.next/**",
        "**/coverage/**",
        "**/.cache/**",
        "**/__pycache__/**",
        "**/*.pyc",
        "**/*.pyo",
        "**/venv/**",
        "**/env/**",
        "**/.env",
        "**/.DS_Store",
        "**/Thumbs.db",
        "**/.idea/**",
        "**/.vscode/**",
        "**/*.swp",
        "**/*.swo",
        "**/*~",
      ],
      persistent: true,
      ignoreInitial: false,
    });

    this.watcher
      .on("add", (path) => this.handleEvent("create", path))
      .on("change", (path) => this.handleEvent("modify", path))
      .on("unlink", (path) => this.handleEvent("delete", path))
      .on("error", (error) => {
        console.error("FileWatcher error:", error);
      });

    console.error(`FileWatcher started: ${this.watchPath}`);
  }

  private handleEvent(action: "create" | "modify" | "delete", path: string) {
    if (this.pausedUntil > 0) {
      if (Date.now() < this.pausedUntil) {
        return;
      }
      this.pausedUntil = 0;
      this.errorCount = 0;
      console.error("FileWatcher: cooldown elapsed, resuming event recording");
    }

    this.store.addFileEvent({
      timestamp: Date.now(),
      path,
      action,
      project: this.project,
    }).then(() => {
      if (this.errorCount > 0) {
        this.errorCount = 0;
        if (this.errorResetTimer) {
          clearTimeout(this.errorResetTimer);
          this.errorResetTimer = null;
        }
      }
    }).catch((err) => {
      this.errorCount++;
      console.error(`Failed to record file event (${this.errorCount}/${this.maxErrors}):`, err);
      
      if (this.errorCount >= this.maxErrors) {
        this.pausedUntil = Date.now() + FileWatcher.ERROR_COOLDOWN_MS;
        console.error("FileWatcher: database may be unavailable, pausing event recording for 60s");
        return;
      }

      if (!this.errorResetTimer) {
        this.errorResetTimer = setTimeout(() => {
          this.errorCount = 0;
          this.errorResetTimer = null;
          console.error("FileWatcher: error count reset after 60s");
        }, 60000);
      }
    });
  }

  stop() {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
      console.error("FileWatcher stopped");
    }
    if (this.errorResetTimer) {
      clearTimeout(this.errorResetTimer);
      this.errorResetTimer = null;
    }
  }
}
