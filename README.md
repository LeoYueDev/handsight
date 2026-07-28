# Hindsight

Open-source MCP server that gives AI coding assistants persistent memory.

## Features

- **Persistent Memory**: Records conversations, tracks file changes, extracts preferences and decisions
- **Auto Profile Generation**: Builds user profiles and injects them into AGENTS.md
- **Context Awareness**: New AI sessions start with full context of your coding style and project history
- **Multi-Project Support**: Isolated memory per project with global user preferences
- **File Watching**: Automatically tracks file modifications, creations, and deletions

## Installation

```bash
npm install
npm run build
```

## Configuration

Add to your OpenCode config (`~/.config/opencode/opencode.json`):

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

## Usage

Hindsight provides these MCP tools:

- `record_conversation` - Record user/AI conversations
- `start_file_watching` - Monitor file changes in a directory
- `stop_file_watching` - Stop file monitoring
- `get_user_context` - Get current user profile and context
- `get_memories` - Retrieve stored memories
- `add_memory` - Manually add a memory
- `refresh_profile` - Regenerate user profile

## How It Works

1. **Records Interactions**: Captures conversations and file changes
2. **Extracts Patterns**: Identifies preferences, decisions, and coding patterns
3. **Generates Profile**: Creates structured user profile in AGENTS.md
4. **Provides Context**: AI assistants read the profile on startup

## Data Storage

- Database: `~/.hindsight/hindsight.db` (SQLite)
- Profile: `~/.config/opencode/AGENTS.md`

## License

MIT
