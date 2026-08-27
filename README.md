# Hindsight

为 AI 编程助手提供持久化记忆的开源 MCP 服务器。

## 功能特性

- **持久化记忆**：记录对话内容，追踪文件变更，提取用户偏好与决策
- **自动画像生成**：根据交互数据构建用户画像，自动注入 AGENTS.md
- **上下文感知**：新的 AI 会话启动时即可获取你的编码风格和项目历史
- **多项目隔离**：每个项目独立存储记忆，同时支持全局用户偏好
- **文件监控**：自动追踪文件的创建、修改和删除操作

## 架构概览

```
┌──────────────────────────────────────────────────────┐
│                   MCP Server (std io)                │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ │
│  │  index.ts    │ │  profiler.ts │ │ fileWatcher  │ │
│  │  (工具路由)   │ │  (画像生成)   │ │  (文件监控)  │ │
│  └──────┬───────┘ └──────┬───────┘ └──────┬───────┘ │
│         └────────────────┼────────────────┼─────────┘ │
│                    ┌─────▼─────┐          │
│                    │  store.ts │ ◄────────┘
│                    │ (SQLite)  │
│                    └─────┬─────┘
└──────────────────────────┼───────────────────────────┘
                           │
              ┌────────────▼────────────┐
              │  ~/.hindsight/hindsight.db │
              │  ~/.config/opencode/AGENTS.md │
              └─────────────────────────┘
```

### 核心模块

- **`src/index.ts`** — MCP 服务器入口，定义 12 个工具并处理请求路由
- **`src/store.ts`** — SQLite 存储层，管理对话、文件事件和记忆的 CRUD、搜索、导出与清理
- **`src/profiler.ts`** — 画像生成器，从对话和文件事件中提取偏好、模式与决策
- **`src/fileWatcher.ts`** — 基于 chokidar 的文件监控，过滤构建目录和临时文件
- **`src/types.ts`** — TypeScript 类型定义（对话事件、文件事件、记忆、用户画像）

## 安装

```bash
npm install
npm run build
```

## 配置

将以下配置添加到 OpenCode 配置文件（`~/.config/opencode/opencode.json`）：

```json
{
  "mcpServers": {
    "hindsight": {
      "command": "node",
      "args": ["path/to/hindsight/dist/index.js"]
    }
  }
}
```

## MCP 工具

| 工具名 | 说明 | 必需参数 |
|--------|------|----------|
| 工具名 | 说明 | 必需参数 |
|--------|------|----------|
| `record_conversation` | 记录用户与 AI 的对话内容 | `role`, `content` |
| `start_file_watching` | 开始监控指定目录的文件变化 | `path` |
| `stop_file_watching` | 停止文件监控 | 无 |
| `get_user_context` | 获取当前用户画像和上下文 | 无 |
| `get_memories` | 查询已存储的记忆（支持类型过滤） | 无 |
| `add_memory` | 手动添加一条记忆 | `type`, `content` |
| `refresh_profile` | 基于最新数据刷新用户画像 | 无 |
| `delete_memory` | 按 ID 删除指定记忆 | `id` |
| `get_stats` | 获取数据库统计（对话/文件事件/记忆数量） | 无 |
| `search_memories` | 按关键词搜索记忆内容 | `query` |
| `export_data` | 导出全部数据（对话、文件事件、记忆）为 JSON | 无 |
| `clear_old_data` | 清理指定天数之前的历史数据 | `olderThanDays` |

### 记忆类型

- **preference** — 用户偏好（如技术选型偏好、编码习惯）
- **pattern** — 编码模式（如常用的文件结构、设计模式）
- **decision** — 项目决策（架构选择、技术取舍）
- **context** — 上下文信息（当前活跃目录、文件类型分布）

## 工作原理

1. **记录交互**：捕获对话内容和文件变更事件
2. **提取模式**：通过关键词匹配识别用户偏好、决策和编码模式
3. **生成画像**：将提取的信息聚合为结构化用户画像，写入 AGENTS.md
4. **提供上下文**：AI 助手在启动时读取画像，获得完整的用户上下文

## 数据存储

- **数据库**：`~/.hindsight/hindsight.db`（SQLite，通过 sql.js 运行）
- **用户画像**：`~/.config/opencode/AGENTS.md`（HINDSIGHT 标记区间自动更新）
- **自动清理**：30 天前的记录自动删除，文件事件上限 10,000 条
- **自动保存**：数据库变更每 500ms 异步刷盘

## 开发

```bash
npm run dev      # 监听模式编译
npm run test     # 运行集成测试
```

## 许可证

MIT
