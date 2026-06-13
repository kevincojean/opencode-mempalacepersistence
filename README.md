# opencode-mempalace-persistence

> **Community plugin** — not officially maintained by the MemPalace team. Fully open source, ~200 lines of TypeScript.

An OpenCode plugin that automatically saves every conversation to MemPalace and uses stored memory to provide better, context-aware responses. Real-time, zero cron, zero external scripts.

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

---

## How it works in 3 seconds

| Without plugin | With plugin |
|---|---|
| Every session starts from scratch | The model knows who you are and what you've done |
| You repeat context each time | Memory is automatic |
| Model starts from scratch each time | Memory persists across sessions |

The plugin injects relevant memories from MemPalace into every prompt (via `chat.message`), and saves every response back to MemPalace. A perfect feedback loop.

---

## Installation

### 1. Plugin (saves conversations)

```json
{
  "plugin": ["opencode-mempalace-persistence"]
}
```

Add this line to your `~/.config/opencode/opencode.json` and restart OpenCode.

### 2. Identity (who you are)

Create `~/.mempalace/identity.txt`:

```
I am [name], a [role]. I work with [technologies]. My main projects are [projects].
```

This file is loaded by the plugin — no need to add it to `instructions` in opencode.json.

### 3. MemPalace (if not already installed)

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

### 4. Memory injection (recommended)

The plugin automatically injects your identity + project context + relevant memories from MemPalace into every prompt. No model discipline required.

Create `~/.mempalace/plugin-config.json`:

```json
{
  "autoInjectContext": true
}
```

**Do NOT put this in `opencode.json`** — OpenCode's schema validation rejects unknown keys. The plugin reads its config from `~/.mempalace/plugin-config.json` instead.

When enabled:
- **First message**: Injects `[MemPalace Identity]` from `~/.mempalace/identity.txt` + `[MemPalace L1]` from `mempalace wake-up` (project goals, architecture, current tasks from L1 files)
- **Every message**: Runs `mempalace search` and injects results as `[MemPalace Recall]`

#### Advanced configuration

The `plugin-config.json` supports optional tuning parameters beyond `autoInjectContext`:

```json
{
  "autoInjectContext": true,
  "maxMempalaceSearchChars": 900,
  "maxWakeUpChars": 900,
  "maxSearchResults": 3,
  "searchDebounceMs": 3000,
  "minQueryLength": 15,
  "scopeSearchToWing": false,
  "l3RecallCosineSimilarityThreshold": 0.7,
  "l3RecallBm25MinScore": 0.0,
  "l3RecallMinContentLength": 50
}
```

| Parameter | Default | Description |
|---|---|---|
| `autoInjectContext` | `false` | Enable identity + L1 + recall injection on every message |
| `maxMempalaceSearchChars` | `900` | Max characters of `mempalace search` output to inject as `[MemPalace Recall]` |
| `maxWakeUpChars` | `900` | Max characters of `mempalace wake-up` L1+ output to inject as `[MemPalace L1]` |
| `maxSearchResults` | `3` | Number of search results (`--results` flag) |
| `searchDebounceMs` | `3000` | Minimum interval between consecutive searches (ms) |
| `minQueryLength` | `15` | Minimum user message character count to trigger a search |
| `scopeSearchToWing` | `false` | Scope L2 (`mempalace wake-up`) and Recall (`mempalace search`) to a wing inferred from the current project directory. Wing name is sanitized with the pattern `wing_<project-basename>` (lowercased, non-alphanumeric chars replaced with `-`). Mining is also scoped to the same wing. **Note**: If multiple projects share the same basename (e.g., two repos named `api`), their wings will collide. |
| `l3RecallCosineSimilarityThreshold` | `0.7` | Minimum cosine similarity to include a search result. Results below this threshold are dropped. Set to `0` to disable. |
| `l3RecallBm25MinScore` | `0.0` | Minimum BM25 (keyword overlap) score to include a result. Default `0` means no BM25 filtering. Raise to e.g. `0.5` to require keyword overlap. |
| `l3RecallMinContentLength` | `50` | Minimum character length of the content text to include a result. Filters out short boilerplate like "Done." or "Here's what I did." |

#### AGENTS.md for this mode

Create `~/.config/opencode/AGENTS.md`:

```markdown
# Memory & Knowledge instructions

## CRITICAL: You MUST follow these steps BEFORE every response.

### Step 1 — Query Knowledge Graph
Call `mempalace_mempalace_kg_query` for entity "user". Then filter the returned facts — keep only those whose text contains keywords from the user's question, so irrelevant facts are excluded.

### Step 2 — Record Knowledge Graph facts

After responding, if you discovered any new facts during the conversation (decisions made, milestones reached, problems encountered, preferences expressed, emotional states), call `mempalace_mempalace_kg_add` to record them. Object must be 128 characters or fewer.

**This is mandatory** — record facts you are confident about. Prefer quality over quantity; noisy KG entries degrade retrieval over time.

### Naming reminder
All MemPalace tools use the prefix `mempalace_mempalace_*` (not `mempalace_*`). Examples:
- `mempalace_mempalace_kg_query` (NOT `mempalace_kg_query`)
- `mempalace_mempalace_kg_add`
- `mempalace_mempalace_kg_invalidate`
If you ever catch yourself typing `mempalace_kg_query`, STOP — the correct prefix is `mempalace_mempalace_`.
```

#### Complete `~/.config/opencode/opencode.json`

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-mempalace-persistence"],
  "instructions": ["AGENTS.md"],
  "mcp": {
    "mempalace": {
      "type": "local",
      "command": ["mempalace-mcp"],
      "enabled": true
    }
  }
}
```

> Note: `identity.txt` is NOT listed in `instructions` — the plugin injects it automatically. It is also NOT in the `provider` block or `permission` block — those are optional and depend on your model setup.

### 5. Alternative: Model-driven memory (without autoInjectContext)

If you prefer the model to search MemPalace on its own via AGENTS.md (requires good model tool-use discipline), set `autoInjectContext` to `false` or omit the file:

```json
{
  "autoInjectContext": false
}
```

#### AGENTS.md for this mode

Create `~/.config/opencode/AGENTS.md`:

```markdown
# Memory & Knowledge instructions

## CRITICAL: You MUST follow these steps BEFORE every response.

### Step 1 — Search MemPalace
Call `mempalace_mempalace_search` with the user's question or key topics as query. Get the top 5-10 most relevant memory drawers.
**This is mandatory. Never skip this step. No exceptions.**

### Step 2 — Query Knowledge Graph
Call `mempalace_mempalace_kg_query` for entity "user". Then filter the returned facts.

### Step 3 — Record Knowledge Graph facts
After responding, call `mempalace_mempalace_kg_add` for any new facts.

### Naming reminder
All MemPalace tools use the prefix `mempalace_mempalace_*` (not `mempalace_*`).
```

And keep `"~/.mempalace/identity.txt"` in `instructions` in opencode.json since the plugin won't inject it.

#### Comparison

| Feature | **Auto-inject (Recommended)** | Model-driven (alternative) |
|---------|:-:|:-:|
| Memory search | Plugin injects automatically | Model calls `mempalace_search` |
| Identity | Plugin injects automatically | Via `instructions: ["identity.txt"]` |
| AGENTS.md | Minimal (KG only) | Full (search + KG) |
| Depends on model discipline | No | Yes |

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

## What happens after installation (auto-inject mode)

```
You ask a question
  → Plugin hooks into `chat.message`
  → First message: injects [MemPalace Identity] + [MemPalace L1] (project context from `mempalace wake-up`)
  → Every message: runs `mempalace search` → injects [MemPalace Recall]
  → If scopeSearchToWing is true, all mempalace commands are scoped to wing_<project> (--wing flag)
  → Model sees context without having to search

The model responds
  → Plugin detects the response is complete
  → Saves the conversation to MemPalace (flat export, scoped to wing if scopeSearchToWing is true)
  → Model records KG facts via MCP tools (mandatory per AGENTS.md)

Next time you ask
  → Plugin finds the previous memory → injects it automatically
  → The cycle continues, memory grows
```

---

## What gets saved

Every turn (question + answer) is saved as a drawer in MemPalace. No forced categorization — MemPalace's own mining handles organization. The model can optionally record KG facts (decisions, milestones, preferences) during conversation via MCP tools.

---

## Architecture

```
                 ┌──────────────────────────────┐
                 │         OpenCode              │
                 │                               │
  User msg ─────►│  chat.message hook            │
                 │    ↓                          │
                 │  First: [MemPalace Identity]  │
                 │       + [MemPalace L1]        │
                 │    ↓                          │
                 │  Always: [MemPalace Recall]   │
                 │  (autoInjectContext: true)    │
                 │    ↓                          │
                 │  Model sees context → answers │
                 │    ↓                          │
  Answer done ──►│  chat.message + session.idle  │
                 │    ↓                          │
                 │  Query OpenCode DB            │
                 │  since last sync              │
                 │    ↓                          │
                 │  Export → flat text files     │
                 │    ↓                          │
                 │  mempalace mine (async)       │
                 │  single serialized call       │
                 └──────────────────────────────┘
                            │
                            ▼
                 ┌──────────────────────────┐
                 │      MemPalace            │
                 │  ~/opencode-memory/       │
                 │  Vector DB + KG           │
                 └──────────────────────────┘
                            ▲
                            │
                 ┌──────────────────────────┐
                 │  Model (via AGENTS.md)    │
                 │  Records KG facts:       │
                 │  kg_add / kg_invalidate  │
                 └──────────────────────────┘
```

---

## Relevant files

| File | Purpose |
|---|---|
| `~/.config/opencode/opencode.json` | OpenCode config with plugin + MCP |
| `~/.config/opencode/AGENTS.md` | Tells the model to manage KG facts |
| `~/.mempalace/plugin-config.json` | Plugin config (`autoInjectContext`, `maxMempalaceSearchChars`, `maxWakeUpChars`, `maxSearchResults`, `searchDebounceMs`, `minQueryLength`) |
| `~/.mempalace/identity.txt` | Your identity (injected by plugin) |
| `~/.mempalace/config.json` | MemPalace config (palace path) |
| `~/.mempalace/knowledge_graph.sqlite3` | Knowledge Graph (structured facts) |
| `~/opencode-memory/` | MemPalace vector DB (all drawers) |
| `~/.mempalace/sync_state.json` | Last sync state |

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

## Testing

### Prerequisites

- [`opencode`](https://opencode.ai) CLI on `$PATH` (or set `OPENCODE_BIN`)
- `mempalace` installed and on `$PATH`
- Node.js dependencies installed (`npm install`)

### Run all e2e tests

```bash
npm run test:e2e
```

This builds the plugin (`tsc`), then runs the e2e test suite with vitest, stopping at the first failure (`--bail=1`).

### Watch mode (development)

```bash
npm run test:e2e:dev
```

Runs vitest in watch mode — useful when iterating on tests or code.

### Run tests by tag

Tests are tagged with `@injection`, `@search`, `@mining`, `@storage`, `@init`, `@config`:

```bash
npx vitest run --bail=1 --tags @injection
npx vitest run --bail=1 --tags @mining
```

### How it works

Tests spin up a sandboxed OpenCode instance with:
- A temporary `$HOME` with a test `opencode.jsonc` config, `plugin-config.json`, and `identity.txt`
- A local SSE test provider that streams mock AI responses
- An isolated mempalace palace under `/tmp/mp-e2e-*`

Each test case sends a message via `opencode run --format json`, then verifies database state, memory injection, or file mining through `opencode export` and `opencode db` queries.

Configuration: `vitest.config.ts` — 120s test timeout, forks pool, single-fork mode.

---

## License

MIT
