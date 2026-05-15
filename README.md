# opencode-mempalace

**OpenCode plugin** — real-time memory sync to MemPalace with auto-categorization and Knowledge Graph.

A self-contained OpenCode plugin that automatically saves conversations to MemPalace after every response. No cron, no background processes, no external scripts — pure TypeScript using OpenCode's plugin hooks.

## Features

- Auto-sync every conversation turn to MemPalace (delta-only, no duplicates)
- Automatic wing categorization (developer, creative, emotions, etc.)
- Knowledge Graph extraction (decisions, milestones, problems, preferences)
- Real-time via OpenCode plugin hooks — zero latency, zero cron
- Pure TypeScript with no external runtime dependencies

## Install

### Local (dev)

```json
{
  "plugin": ["/path/to/opencode-mempalace/src/index.ts"]
}
```

### From npm

```json
{
  "plugin": ["opencode-mempalace"]
}
```

## How it works

The plugin hooks into `chat.message` and triggers a sync after every response:

1. Reads OpenCode SQLite DB for new messages since last sync (delta)
2. Categorizes by wing (developer, creative, emotions, family, consciousness)
3. Exports delta conversations to temp files
4. Calls `mempalace mine` to store in vector memory
5. Extracts Knowledge Graph facts via keyword matching + chromadb
6. Deduplicates via SHA256 hashing — zero duplicates

## License

MIT
