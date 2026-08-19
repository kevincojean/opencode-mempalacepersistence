# opencode-mempalace-persistence

> **Community plugin** — not officially maintained by the MemPalace team. Fully open source, ~200 lines of TypeScript.

An OpenCode plugin that automatically saves every conversation to MemPalace and uses stored memory to provide better, context-aware responses. Real-time, zero cron, zero external scripts.

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

> **⚠️ Backend warning**: opencode-mempalace-persistence works **really badly** with MemPalace's default backend, **ChromaDB**. This project works **well** with **Qdrant** as the vector store backend. Configure MemPalace to use Qdrant before relying on this plugin. See [doc/chromadb-corruptions.md](doc/chromadb-corruptions.md) for why.

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
# Install (requires mempalace>=3.4.0)
uv tool install "mempalace>=3.4.0"
# or
pipx install "mempalace>=3.4.0"

# Create palace
mempalace init ~/opencode-memory

# Configure MCP
mempalace mcp
```

> **⚠️ Warning**: MemPalace versions prior to 3.4.0 have a bug that causes the HNSW vector index to become corrupted, making up to 47% of stored memories invisible to semantic search. If you're using an older version, upgrade immediately and run `mempalace repair` to rebuild the index.

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
- **First message**: Injects `[MemPalace Identity]` from `~/.mempalace/identity.txt` + `[MemPalace L1]` (or `[MemPalace L1 : <wing>]` when wing-scoped) from `mempalace wake-up` (project goals, architecture, current tasks from L1 files)
- **Every message**: Runs `mempalace search` and injects results as `[MemPalace Recall]`

#### Advanced configuration

The `plugin-config.json` supports optional tuning parameters beyond `autoInjectContext`:

```json
{
  "autoInjectContext": true,
  "skipCommands": true,
  "maxMempalaceSearchChars": 900,
  "maxWakeUpChars": 900,
  "maxSearchResults": 3,
  "searchDebounceMs": 3000,
  "minQueryLength": 15,
  "scopeSearchToWing": false,
  "l1RecallCustomWakeUp.enabled": false,
  "l1RecallCustomWakeUp.cosineSimilarityThreshold": 0.7,
  "l1RecallCustomWakeUp.bm25Threshold": 0.0,
  "l1RecallCustomWakeUp.minContentLength": 0,
  "l2RecallCosineSimilarityThreshold": 0.7,
  "l2RecallBm25Threshold": 0.0,
  "l2RecallMinContentLength": 50,
  "sanitizeSearchQuery.stripSymbols": true,
  "sanitizeSearchQuery.removeShortWords": true,
  "sanitizeSearchQuery.minWordLength": 3,
  "mineExtractGeneral": true,
  "autoMinedFiles": ["README.md", "AGENTS.md"],
  "autoMineFilesCaseSensitive": false,
  "autoMinedFilesDelayMs": 30000,
  "fileLogging": false,
  "plugins.oh-my-openagent.stripInjectedPrompts": true
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
| `skipCommands` | `true` | When `true`, skips all memory injection and session recording for messages that start with `/` (slash commands like `/handoff`, `/remember`, etc.). Messages containing only commands are treated as meta-instructions rather than conversational content worth remembering. |
| `scopeSearchToWing` | `false` | Scope L2 (`mempalace wake-up`) and Recall (`mempalace search`) to a wing inferred from the current project directory. Wing name is sanitized with the pattern `wing_<project-basename>` (lowercased, non-alphanumeric chars replaced with `-`). Mining is also scoped to the same wing. **Note**: If multiple projects share the same basename (e.g., two repos named `api`), their wings will collide. |
| `l1RecallCustomWakeUp.enabled` | `false` | When `true`, replaces the native `mempalace wake-up` command with a custom wake-up that queries the palace using `mempalace search` and filters results by cosine/BM25 thresholds. Provides structured filtering with per-item scores instead of post-hoc line parsing. |
| `l1RecallCustomWakeUp.cosineSimilarityThreshold` | `0.7` | Minimum cosine similarity for L1 items. Items below this threshold are dropped. Set to `0` to disable. Only applies when `l1RecallCustomWakeUp.enabled` is `true`. |
| `l1RecallCustomWakeUp.bm25Threshold` | `0.0` | Minimum BM25 (keyword overlap) score for L1 items. Default `0` means no BM25 filtering. Raise to e.g. `0.5` to require keyword overlap. Only applies when `l1RecallCustomWakeUp.enabled` is `true`. |
| `l1RecallCustomWakeUp.minContentLength` | `0` | Minimum character length of item content to include in L1. Default `0` means no length filtering. Only applies when `l1RecallCustomWakeUp.enabled` is `true`. |
| `l2RecallCosineSimilarityThreshold` | `0.7` | Minimum cosine similarity to include a search result. Results below this threshold are dropped. Set to `0` to disable. |
| `l2RecallBm25Threshold` | `0.0` | Minimum BM25 (keyword overlap) score to include a result. Default `0` means no BM25 filtering. Raise to e.g. `0.5` to require keyword overlap. |
| `l2RecallMinContentLength` | `50` | Minimum character length of the content text to include a result. Filters out short boilerplate like "Done." or "Here's what I did." |
| `sanitizeSearchQuery.stripSymbols` | `true` | When `true`, strips symbols (non-word, non-space characters like punctuation) from the user message before sending it as a `mempalace search` query. Improves recall quality by removing noise that dilutes the embedding. Set to `false` to disable. |
| `sanitizeSearchQuery.removeShortWords` | `true` | When `true`, drops words whose length is less than or equal to `sanitizeSearchQuery.minWordLength` from the search query. Short words (articles, prepositions, pronouns) rarely help semantic recall and add noise. Set to `false` to keep all words. |
| `sanitizeSearchQuery.minWordLength` | `3` | The character-length threshold for `sanitizeSearchQuery.removeShortWords`. Words with `length <= minWordLength` are dropped. With the default `3`, words of length `1`, `2`, or `3` (e.g., "I", "am", "the", "foo") are removed. Set higher (e.g., `5`) to be more aggressive, or lower (e.g., `1`) to only drop single-character tokens. |
| `mineExtractGeneral` | `true` | When `true`, appends `--extract general` to the `mempalace mine --mode convos` command. This auto-classifies mined conversations into rooms (decisions, milestones, problems) instead of dumping everything into `technical`. |
| `autoMinedFiles` | `["README.md", "AGENTS.md"]` | Array of filenames to mine from the project root into MemPalace (using `--mode projects`) on `session.idle`. Seeds L1 with the project's overarching story. Set to `[]` to disable. Files are matched case-insensitively by default. |
| `autoMineFilesCaseSensitive` | `false` | When `true`, filenames in `autoMinedFiles` are matched case-sensitively. |
| `autoMinedFilesDelayMs` | `30000` | Delay in ms before mining project files after a session goes idle. Avoids mining during rapid session churn. |
| `fileLogging` | `false` | When `true`, enables file-based diagnostic logging to `/tmp/mempalace-diag.log` and (with `OPENCODE_MEMPALACE_DEBUG=1`) debug logging to `/tmp/opencode-mempalace.log`. Disabled by default — enable only for troubleshooting. |
| `plugins.oh-my-openagent.stripInjectedPrompts` | `false` | When `true`, strips known oh-my-openagent orchestration boilerplate from user messages before sending them as `mempalace search` queries. See [Plugin compatibility](#plugin-compatibility) below. |

> **Breaking change in 2.0.0**: Plugin config keys are now **flat dot-separated** (Java Spring properties style). Nested objects like `l1RecallCustomWakeUp: { enabled: true }` are no longer the canonical form. See [Migrating from v1.x](#migrating-from-v1x) below.

---

## Migrating from v1.x

Plugin config keys are flat dot-separated strings (Java Spring properties style). Why this change?

- **Easier to parse**: No nested objects, no structural ambiguity. Every key is a string. Tools like `jq`, `grep`, and `sed` work directly on the file.
- **Easier to maintain**: Keys are self-describing. `sanitizeSearchQuery.minWordLength` reads as a complete address without indenting.
- **Easier to write by hand**: No risk of forgetting a trailing comma inside a nested object, no risk of accidentally introducing a new sub-object name.
- **Closer to other config formats** (Spring Boot, dotenv, etc.) - less mental switching between tools.

### Before (v1.x, nested)

```json
{
  "l1RecallCustomWakeUp": {
    "enabled": true,
    "cosineSimilarityThreshold": 0.8
  },
  "sanitizeSearchQuery": {
    "stripSymbols": false,
    "removeShortWords": true,
    "minWordLength": 5
  },
  "plugins": {
    "oh-my-openagent": {
      "stripInjectedPrompts": true
    }
  }
}
```

### After (v2.x, flat)

```json
{
  "l1RecallCustomWakeUp.enabled": true,
  "l1RecallCustomWakeUp.cosineSimilarityThreshold": 0.8,
  "sanitizeSearchQuery.stripSymbols": false,
  "sanitizeSearchQuery.removeShortWords": true,
  "sanitizeSearchQuery.minWordLength": 5,
  "plugins.oh-my-openagent.stripInjectedPrompts": true
}
```

### What changed

| v1.x (nested) | v2.x (flat) |
|---|---|
| `l1RecallCustomWakeUp.enabled` | `l1RecallCustomWakeUp.enabled` *(same shape)* |
| `sanitizeSearchQuery.stripSymbols` | `sanitizeSearchQuery.stripSymbols` *(same shape)* |
| `plugins.oh-my-openagent.stripInjectedPrompts` | `plugins.oh-my-openagent.stripInjectedPrompts` *(same shape)* |
| `l1RecallCustomWakeUp: { enabled: true }` *(nested object)* | `"l1RecallCustomWakeUp.enabled": true` *(flat dotted key)* |

Top-level keys (`autoInjectContext`, `maxSearchChars`, `fileLogging`, etc.) are unchanged - they were already flat.

### Backwards compatibility

The parser supports both forms. If your existing `plugin-config.json` still uses nested objects, it will keep working - the path-walker treats `.` as a separator and resolves `{"a": {"b": x}}` exactly like `{"a.b": x}`. **However, the nested form is no longer the recommended style and will be removed in a future major release.**

If you want to be explicit about migrating now, flatten your existing config:

```bash
# Manual migration: copy values from nested objects to flat keys
# Then delete the nested objects from plugin-config.json
```

Or use your editor's JSON flattening tools.

---

## Plugin compatibility

When an orchestrator plugin like [oh-my-openagent](https://github.com/code-yeongyu/oh-my-openagent) drives the conversation, user messages are wrapped in structured boilerplate (`[CONTEXT]`, `... <!-- OMO_INTERNAL_INITIATOR -->`, `<system-reminder>`, `<ultrawork-mode>`, etc.). Without stripping, these 2000+ char prompts go straight to `mempalace search`, diluting the embedding → useless results.

Set `plugins.oh-my-openagent.stripInjectedPrompts: true` in `plugin-config.json` to strip this boilerplate before search:

```json
{
  "plugins.oh-my-openagent.stripInjectedPrompts": true
}
```

---

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
# Install (requires mempalace>=3.4.0)
uv tool install "mempalace>=3.4.0"
# or
pipx install "mempalace>=3.4.0"

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
  → If message is a slash command (e.g. /handoff, /remember) and skipCommands is true (default): processing stops — no memory injection, no session recording
  → First message: injects [MemPalace Identity] + [MemPalace L1] or [MemPalace L1 : <wing>] (project context from `mempalace wake-up`, filtered by l1Recall* quality thresholds)
  → Every message: runs `mempalace search` → injects [MemPalace Recall] (filtered by l2Recall* thresholds)
  → If scopeSearchToWing is true, all mempalace commands are scoped to wing_<project> (--wing flag)
  → Model sees context without having to search

The model responds
  → Plugin detects the response is complete
  → Saves the conversation to MemPalace (flat export, scoped to wing if scopeSearchToWing is true)
  → When mineExtractGeneral is true (default), --extract general auto-classifies mined conversations into rooms (decisions, milestones, problems)
  → If autoMinedFiles is non-empty, README.md/AGENTS.md (etc.) are mined on idle
  → Model records KG facts via MCP tools (mandatory per AGENTS.md)

Next time you ask
  → Plugin finds previous memory → injects it automatically (garbage items filtered out by l1Recall* / l2Recall* thresholds)
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
                 │       + [MemPalace L1] /       │
│         [MemPalace L1 : <wing>]│
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
