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

The plugin uses two triggers to detect complete conversation turns:

1. **`chat.message`** (user message) — syncs the previous turn (user Q + assistant A)
2. **`session.idle`** — syncs pending content when the session becomes idle (catches the last turn before shutdown)

On each sync:
1. Queries the OpenCode SQLite DB for new messages since the last sync
2. **Categorizes** by wing (developer, creative, emotions, family, consciousness)
3. **Mines**: Calls `mempalace mine` to store the turn in vector memory
4. **Knowledge Graph**: Extracts facts via keyword matching + chromadb query
5. **No duplicates**: Each turn has a unique content hash

## License

MIT
