# opencode-mempalace-persistence

An OpenCode plugin that automatically saves every conversation to MemPalace and uses stored memory to provide better, context-aware responses. Real-time, zero cron, zero external scripts.

> **It just works** — install, use OpenCode, the plugin handles the rest.

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

---

## How it works in 3 seconds

| Without plugin | With plugin |
|---|---|
| Every session starts from scratch | The model knows who you are and what you've done |
| You repeat context each time | Memory is automatic |
| Model starts from scratch each time | Memory persists across sessions |

The model searches MemPalace on every question (via AGENTS.md + MCP), and the plugin saves every response. A perfect feedback loop.

---

## Installation

### 1. Plugin (saves conversations)

```json
{
  "plugin": ["opencode-mempalace-persistence"]
}
```

Add this line to your `~/.config/opencode/opencode.json` and restart OpenCode.

### 2. Instructions for the model (uses memory)

Create `~/.config/opencode/AGENTS.md`:

```markdown
# Memory & Knowledge instructions

## CRITICAL: You MUST follow these steps BEFORE every response.

### Step 1 — Search MemPalace
Call `mempalace_mempalace_search` with the user's question or key topics as query. Get the top 5-10 most relevant memory drawers.
**This is mandatory. Never skip this step. No exceptions.** Every question — even seemingly trivial ones — may relate to past conversations, projects, or preferences you've forgotten. Searching costs ~nothing; skipping costs continuity.

### Step 2 — Query Knowledge Graph
Call `mempalace_mempalace_kg_query` for entity "user". Then filter the returned facts — keep only those whose text contains keywords from the user's question, so irrelevant facts are excluded.

### Step 3 — Use the context
Incorporate relevant memory and facts into your response. If the user's question relates to a past conversation, project, or decision, reference it naturally. If the search returned nothing useful, you are done — do NOT skip steps 1-2 just because you *expect* nothing.

### Naming reminder
All MemPalace tools use the prefix `mempalace_mempalace_*` (not `mempalace_*`). Examples:
- `mempalace_mempalace_search` (NOT `mempalace_search`)
- `mempalace_mempalace_kg_query` (NOT `mempalace_kg_query`)
- `mempalace_mempalace_add_drawer`
- `mempalace_mempalace_get_drawer`
- `mempalace_mempalace_list_wings`
If you ever catch yourself typing `mempalace_search` or `mempalace_kg_query`, STOP — the correct prefix is `mempalace_mempalace_`.

## Note

The KG stores structured facts like: decision (choices made), milestone (completed tasks), problem (issues encountered), preference (likes/dislikes), emotional (feelings). Use these to understand the user's history and context better.

### Knowledge Graph management

When you discover structured facts during conversation (decisions made, milestones reached, problems encountered, preferences expressed, emotional states), record them in the Knowledge Graph:

- **New facts**: Call `mempalace_mempalace_kg_add` with subject → predicate → object (e.g. `subject="user"`, `predicate="preference"`, `object="prefers TypeScript over Python"`)
- **Changed facts**: First call `mempalace_mempalace_kg_invalidate` on the old fact, then `mempalace_mempalace_kg_add` for the new one
- **Retrieval**: Call `mempalace_mempalace_kg_query` for entity "user" to see all known facts

This is optional but recommended — the more facts you record, the better the model understands the user's history and preferences.
```

### 3. Identity (who you are)

Create `~/.mempalace/identity.txt`:

```
I am [name], a [role]. I work with [technologies]. My main projects are [projects].
```

This is loaded automatically at session start via `instructions` in opencode.json.

### 4. Complete configuration

`~/.config/opencode/opencode.json`:

```json
{
  "model": "opencode/deepseek-v4-flash-free",
  "instructions": ["AGENTS.md", "~/.mempalace/identity.txt"],
  "plugin": ["opencode-mempalace-persistence"],
  "mcp": {
    "mempalace": {
      "type": "local",
      "command": ["mempalace-mcp"],
      "enabled": true
    }
  }
}
```

### 5. MemPalace (if not already installed)

```bash
# Install (requires mempalace>=3.3.5 for HNSW corruption fix)
uv tool install "mempalace>=3.3.5"
# or
pipx install "mempalace>=3.3.5"

# Create palace
mempalace init ~/opencode-memory

# Configure MCP
mempalace mcp
```

The `mempalace mcp` command gives you the exact MCP setup string for your configuration.

---

## What happens after installation

```
You ask a question
  → AGENTS.md tells the model: "search MemPalace first"
  → The model calls mempalace_search("question") via MCP
  → Finds relevant memories → gives a better answer

The model responds
  → The opencode-mempalace-persistence plugin detects the response is complete
  → Saves the conversation to MemPalace (flat export, no hardcoded wings)
  → The model may record KG facts via MCP tools (optional, per-session)

Next time you ask
  → The model finds the previous memory → coherent responses
  → The cycle continues, memory grows
```

---

## What gets saved

Every turn (question + answer) is saved as a drawer in MemPalace. No forced categorization — MemPalace's own mining handles organization. The model can optionally record KG facts (decisions, milestones, preferences) during conversation via MCP tools.

---

## Architecture

```
                 ┌──────────────────────────┐
                 │       OpenCode            │
                 │                           │
  User msg ─────►│  chat.message hook        │
                 │    ↓                      │
                 │  Query OpenCode DB        │
                 │  (messages since lastSync)│
                 │    ↓                      │
                 │  Export sessions → flat   │
                 │  (no wing subdirs)        │
                 │    ↓                      │
                 │  Save state immediately   │
                 │    ↓                      │
                 │  mempalace mine (async)   │
                 │  single call, serialized  │
                 │    ↓                      │
  Session idle ─►│  session.idle hook        │
                 │  (saves last turn)        │
                 └──────────────────────────┘
                            │
                            ▼
                 ┌──────────────────────────┐
                 │      MemPalace            │
                 │  ~/opencode-memory/       │
                 │  Vector DB                │
                 └──────────────────────────┘
                            ▲
                            │
                 ┌──────────────────────────┐
                 │  AGENTS.md + MCP          │
                 │  The model searches       │
                 │  MemPalace on every       │
                 │  question. Optionally     │
                 │  records KG facts via     │
                 │  kg_add / kg_invalidate   │
                 └──────────────────────────┘
```

---

## Relevant files

| File | Purpose |
|---|---|
| `~/.config/opencode/opencode.json` | OpenCode config with plugin + MCP + instructions |
| `~/.config/opencode/AGENTS.md` | Tells the model to search MemPalace |
| `~/.mempalace/identity.txt` | Your identity (loaded every session) |
| `~/.mempalace/config.json` | MemPalace config (palace path, wings, keywords) |
| `~/.mempalace/knowledge_graph.sqlite3` | Knowledge Graph (structured facts) |
| `~/opencode-memory/` | MemPalace vector DB (all drawers) |
| `~/.mempalace/sync_state.json` | Last sync state (plugin + Python script) |

---

## Install from npm

```json
{
  "plugin": ["opencode-mempalace-persistence"]
}
```

## Local development

```json
{
  "plugin": ["/path/to/opencode-mempalace-persistence/dist/index.js"]
}
```

## Debug logging

```bash
export OPENCODE_MEMPALACE_DEBUG=1
```

When set, the plugin writes a debug log to `/tmp/opencode-mempalace.log`.

---

## Recommendations

### Model choice affects memory retrieval reliability

Empirical data from the MemPalace community (Cat-9a diagnostic) shows that the model's tool-use discipline significantly impacts how reliably `mempalace_search` is invoked:

| Model | Skips search | Mean recall |
|-------|:-:|:-:|
| gemma4:e4b (4B) | **60%** | 0.417 |
| qwen3.5:4b (4B, Tau2-tuned) | **13%** | 0.717 |

For reliable read-side memory retrieval, **Qwen 3.5 4B+ or equivalent** is recommended as the minimum orchestrator. Smaller or older models may skip memory search on most questions regardless of AGENTS.md instructions.

### Forced invocation (belt and suspenders)

A plugin-level config flag that injects a mandatory `mempalace_search` directive into the system prompt (on top of AGENTS.md) can recover ~15pp of recall on low-discipline models. This is being evaluated as a future config option — suggestions welcome.

### Complementary: upstream OpenCode source adapter

The MemPalace project has an upstream PR ([#1484](https://github.com/MemPalace/mempalace/pull/1484)) adding `mempalace mine --source opencode` — a pull-based adapter for retrospective ingest of existing OpenCode sessions. This plugin (push, real-time) and the adapter (pull, backfill) are complementary:

| Approach | Direction | Captures |
|----------|-----------|----------|
| This plugin | Push | Live conversation turns |
| `mempalace mine --source opencode` (PR #1484) | Pull | Existing OpenCode session files |

For full coverage: install this plugin for live capture, run `mempalace mine --source opencode` once for backfill, never think about it again.

---

## License

MIT
