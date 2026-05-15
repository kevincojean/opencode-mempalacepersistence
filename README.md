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

The plugin hooks into OpenCode's `chat.message` event and buffers each conversation turn:

1. **Buffers messages**: Listens to `chat.message` events and buffers user + assistant text from the message parts
2. **Turn detection**: When a new user message arrives, the previous assistant response is complete → sync triggers
3. **Categorizes** by wing (developer, creative, emotions, family, consciousness)
4. **Mines**: Calls `mempalace mine` to store the turn in vector memory
5. **Knowledge Graph**: Extracts facts via keyword matching + chromadb query
6. **Deduplicates**: SHA256 hashing of turn content — zero duplicates

## License

MIT
