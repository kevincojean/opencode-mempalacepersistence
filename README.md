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

The plugin uses two hooks to detect complete conversation turns:

1. **`chat.message`** — fires when the user sends a message (buffers the user text)
2. **`event` (message.updated)** — fires when the assistant response finishes streaming (queries DB for assistant text, then syncs)

On each complete turn (user + assistant):
1. **Categorizes** by wing (developer, creative, emotions, family, consciousness)
2. **Mines**: Calls `mempalace mine` to store the turn in vector memory
3. **Knowledge Graph**: Extracts facts via keyword matching + chromadb query
4. **Deduplicates**: Each turn is unique content — no sync overhead

## License

MIT
