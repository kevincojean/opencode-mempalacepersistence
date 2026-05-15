# opencode-mempalace
### OpenCode plugin — real-time memory sync to MemPalace with auto-categorization and Knowledge Graph

 A self-contained OpenCode plugin that automatically saves conversations to MemPalace after every response.
      No cron, no background processes, no external scripts — pure TypeScript using OpenCode's plugin hooks.
     Includes semantic mining, wing categorization, and Knowledge Graph fact extraction.
### Features
- Auto-sync every conversation turn to MemPalace (delta-only, no duplicates)
- Automatic wing categorization (developer, creative, emotions, etc.)
- Knowledge Graph extraction (decisions, milestones, problems, preferences)
- Real-time via OpenCode plugin hooks — zero latency, zero cron
- Pure TypeScript, no external dependencies

 ### Install
 ```json
 {
   "plugin": ["opencode-mempalace-sync"]
 }
```
### How it works

Uses OpenCode's plugin hooks to trigger mempalace mine after every response.
