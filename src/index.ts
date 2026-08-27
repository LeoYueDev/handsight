#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { Store } from "./store.js";
import { FileWatcher } from "./fileWatcher.js";
import { Profiler } from "./profiler.js";

interface RecordConversationArgs {
  role: "user" | "assistant";
  content: string;
  project?: string;
}

interface FileWatchingArgs {
  path: string;
  project?: string;
}

interface GetMemoriesArgs {
  type?: "preference" | "pattern" | "decision" | "context";
  limit?: number;
  project?: string;
}

interface AddMemoryArgs {
  type: "preference" | "pattern" | "decision" | "context";
  content: string;
  confidence?: number;
  project?: string;
}

interface ProjectArgs {
  project?: string;
}

interface DeleteMemoryArgs {
  id: number;
}

interface SearchMemoriesArgs {
  query: string;
  type?: "preference" | "pattern" | "decision" | "context";
  limit?: number;
  project?: string;
}

interface ClearOldDataArgs {
  olderThanDays: number;
  project?: string;
}

const server = new Server(
  {
    name: "hindsight",
    version: "0.2.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

const store = new Store();
const profiler = new Profiler(store);
let fileWatcher: FileWatcher | null = null;

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "record_conversation",
        description: "记录用户与 AI 的对话内容",
        inputSchema: {
          type: "object",
          properties: {
            role: {
              type: "string",
              enum: ["user", "assistant"],
              description: "对话角色",
            },
            content: {
              type: "string",
              description: "对话内容",
            },
            project: {
              type: "string",
              description: "项目名称（可选）",
            },
          },
          required: ["role", "content"],
        },
      },
      {
        name: "start_file_watching",
        description: "开始监控指定目录的文件变化",
        inputSchema: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "要监控的目录路径",
            },
            project: {
              type: "string",
              description: "项目名称（可选）",
            },
          },
          required: ["path"],
        },
      },
      {
        name: "stop_file_watching",
        description: "停止文件监控",
        inputSchema: {
          type: "object",
          properties: {},
        },
      },
      {
        name: "get_user_context",
        description: "获取用户画像和上下文信息",
        inputSchema: {
          type: "object",
          properties: {
            project: {
              type: "string",
              description: "项目名称（可选）",
            },
          },
        },
      },
      {
        name: "get_memories",
        description: "获取存储的记忆",
        inputSchema: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["preference", "pattern", "decision", "context"],
              description: "记忆类型（可选）",
            },
            limit: {
              type: "number",
              description: "返回数量限制（默认 50）",
            },
            project: {
              type: "string",
              description: "项目名称（可选）",
            },
          },
        },
      },
      {
        name: "add_memory",
        description: "手动添加一条记忆",
        inputSchema: {
          type: "object",
          properties: {
            type: {
              type: "string",
              enum: ["preference", "pattern", "decision", "context"],
              description: "记忆类型",
            },
            content: {
              type: "string",
              description: "记忆内容",
            },
            confidence: {
              type: "number",
              description: "置信度（0-1，默认 0.8）",
            },
            project: {
              type: "string",
              description: "项目名称（可选）",
            },
          },
          required: ["type", "content"],
        },
      },
      {
        name: "refresh_profile",
        description: "基于最新数据刷新用户画像",
        inputSchema: {
          type: "object",
          properties: {
            project: {
              type: "string",
              description: "项目名称（可选）",
            },
          },
        },
      },
      {
        name: "delete_memory",
        description: "删除指定 ID 的记忆",
        inputSchema: {
          type: "object",
          properties: {
            id: {
              type: "number",
              description: "要删除的记忆 ID",
            },
          },
          required: ["id"],
        },
      },
      {
        name: "get_stats",
        description: "获取数据库统计信息（对话/文件事件/记忆数量）",
        inputSchema: {
          type: "object",
          properties: {
            project: {
              type: "string",
              description: "项目名称（可选）",
            },
          },
        },
      },
      {
        name: "search_memories",
        description: "按关键词搜索记忆内容",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "搜索关键词",
            },
            type: {
              type: "string",
              enum: ["preference", "pattern", "decision", "context"],
              description: "记忆类型过滤（可选）",
            },
            limit: {
              type: "number",
              description: "返回数量限制（默认 50）",
            },
            project: {
              type: "string",
              description: "项目名称（可选）",
            },
          },
          required: ["query"],
        },
      },
      {
        name: "export_data",
        description: "导出指定项目的全部数据（对话、文件事件、记忆）为 JSON",
        inputSchema: {
          type: "object",
          properties: {
            project: {
              type: "string",
              description: "项目名称（可选，不传则导出全部）",
            },
          },
        },
      },
      {
        name: "clear_old_data",
        description: "清理指定天数之前的历史数据（对话、文件事件、记忆）",
        inputSchema: {
          type: "object",
          properties: {
            olderThanDays: {
              type: "number",
              description: "清理多少天之前的数据（例如 30 表示清理 30 天前的数据）",
            },
            project: {
              type: "string",
              description: "项目名称（可选，不传则清理全部）",
            },
          },
          required: ["olderThanDays"],
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  switch (name) {
    case "record_conversation": {
      if (!args || typeof args !== 'object' || !('role' in args) || !('content' in args)) {
        throw new Error("Missing required parameters: role, content");
      }
      const { role, content, project } = args as unknown as RecordConversationArgs;
      if (role !== 'user' && role !== 'assistant') {
        throw new Error("Invalid role: must be 'user' or 'assistant'");
      }
      if (typeof content !== 'string') {
        throw new Error("Invalid content: must be a string");
      }
      const id = await store.addConversation({
        timestamp: Date.now(),
        role,
        content,
        project,
      });
      await profiler.refreshProfile(project);
      return {
        content: [
          {
            type: "text",
            text: `对话已记录 (ID: ${id})`,
          },
        ],
      };
    }

    case "start_file_watching": {
      if (!args || typeof args !== 'object' || !('path' in args)) {
        throw new Error("Missing required parameter: path");
      }
      const { path: watchPath, project } = args as unknown as FileWatchingArgs;
      if (typeof watchPath !== 'string') {
        throw new Error("Invalid path: must be a string");
      }
      if (fileWatcher) {
        fileWatcher.stop();
      }
      fileWatcher = new FileWatcher(watchPath, store, project);
      fileWatcher.start();
      return {
        content: [
          {
            type: "text",
            text: `开始监控目录: ${watchPath}`,
          },
        ],
      };
    }

    case "stop_file_watching": {
      if (fileWatcher) {
        fileWatcher.stop();
        fileWatcher = null;
        return {
          content: [
            {
              type: "text",
              text: "文件监控已停止",
            },
          ],
        };
      }
      return {
        content: [
          {
            type: "text",
            text: "没有正在运行的文件监控",
          },
        ],
      };
    }

    case "get_user_context": {
      const { project } = (args as ProjectArgs) || {};
      const profile = await profiler.getProfile(project);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(profile, null, 2),
          },
        ],
      };
    }

    case "get_memories": {
      const { type, limit = 50, project } = (args as GetMemoriesArgs) || {};
      const memories = await store.getMemories(type, limit, project);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(memories, null, 2),
          },
        ],
      };
    }

    case "add_memory": {
      if (!args || typeof args !== 'object' || !('type' in args) || !('content' in args)) {
        throw new Error("Missing required parameters: type, content");
      }
      const { type, content, confidence = 0.8, project } = args as unknown as AddMemoryArgs;
      if (typeof content !== 'string') {
        throw new Error("Invalid content: must be a string");
      }
      if (typeof confidence !== 'number' || confidence < 0 || confidence > 1) {
        throw new Error("Invalid confidence: must be a number between 0 and 1");
      }
      const id = await store.addMemory({
        timestamp: Date.now(),
        type,
        content,
        confidence,
        source: "manual",
        project,
      });
      await profiler.refreshProfile(project);
      return {
        content: [
          {
            type: "text",
            text: `记忆已添加 (ID: ${id})`,
          },
        ],
      };
    }

    case "refresh_profile": {
      const { project } = (args as ProjectArgs) || {};
      await profiler.refreshProfile(project);
      return {
        content: [
          {
            type: "text",
            text: "用户画像已刷新",
          },
        ],
      };
    }

    case "delete_memory": {
      if (!args || typeof args !== 'object' || !('id' in args)) {
        throw new Error("Missing required parameter: id");
      }
      const { id } = args as unknown as DeleteMemoryArgs;
      if (typeof id !== 'number') {
        throw new Error("Invalid id: must be a number");
      }
      const deleted = await store.deleteMemory(id);
      await profiler.refreshProfile();
      return {
        content: [
          {
            type: "text",
            text: deleted ? `记忆 ${id} 已删除` : `未找到记忆 ${id}`,
          },
        ],
      };
    }

    case "get_stats": {
      const { project } = (args as ProjectArgs) || {};
      const stats = await store.getStats(project);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(stats, null, 2),
          },
        ],
      };
    }

    case "search_memories": {
      if (!args || typeof args !== 'object' || !('query' in args)) {
        throw new Error("Missing required parameter: query");
      }
      const { query, type, limit = 50, project } = args as unknown as SearchMemoriesArgs;
      if (typeof query !== 'string' || query.trim() === '') {
        throw new Error("Invalid query: must be a non-empty string");
      }
      const memories = await store.searchMemories(query, type, limit, project);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(memories, null, 2),
          },
        ],
      };
    }

    case "export_data": {
      const { project } = (args as ProjectArgs) || {};
      const data = await store.exportData(project);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(data, null, 2),
          },
        ],
      };
    }

    case "clear_old_data": {
      if (!args || typeof args !== 'object' || !('olderThanDays' in args)) {
        throw new Error("Missing required parameter: olderThanDays");
      }
      const { olderThanDays, project } = args as unknown as ClearOldDataArgs;
      if (typeof olderThanDays !== 'number' || olderThanDays < 0) {
        throw new Error("Invalid olderThanDays: must be a non-negative number");
      }
      const result = await store.clearOldData(olderThanDays, project);
      return {
        content: [
          {
            type: "text",
            text: `已清理 ${olderThanDays} 天前的数据：对话 ${result.deletedConversations} 条，文件事件 ${result.deletedFileEvents} 条，记忆 ${result.deletedMemories} 条`,
          },
        ],
      };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Hindsight MCP Server running on stdio");
}

function shutdown() {
  if (fileWatcher) {
    fileWatcher.stop();
    fileWatcher = null;
  }
  store.shutdown();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
