import { existsSync, readFileSync } from "fs"

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------
//
// Internal types stay nested for ergonomic access in src/index.ts
// (e.g. `config.sanitizeSearchQuery.stripSymbols`). The user-facing JSON
// config uses flat dot-separated keys (Spring properties style), and the
// loadPluginConfig() parser translates flat -> nested via getFlatKey().
// ---------------------------------------------------------------------------

export interface L1RecallCustomWakeUpConfig {
  enabled: boolean
  cosineSimilarityThreshold: number
  bm25Threshold: number
  minContentLength: number
}

export interface OhMyOpenAgentPluginConfig {
  stripInjectedPrompts: boolean
}

export interface PluginsConfig {
  ohMyOpenAgent: OhMyOpenAgentPluginConfig
}

export interface SanitizeSearchQueryOptions {
  stripSymbols: boolean
  removeShortWords: boolean
  minWordLength: number
}

export interface PluginConfig {
  skipCommands: boolean
  maxSearchChars: number
  maxWakeUpChars: number
  maxSearchResults: number
  searchDebounceMs: number
  minQueryLength: number
  scopeSearchToWing: boolean
  l2RecallCosineSimilarityThreshold: number
  l2RecallBm25Threshold: number
  l2RecallMinContentLength: number
  l1RecallCustomWakeUp: L1RecallCustomWakeUpConfig
  mineExtractGeneral: boolean
  autoMinedFiles: string[]
  autoMineFilesCaseSensitive: boolean
  autoMinedFilesDelayMs: number
  mineTimeoutMs?: number
  maxRetries?: number
  retryDelayMs?: number
  fileLogging: boolean
  plugins: PluginsConfig
  sanitizeSearchQuery: SanitizeSearchQueryOptions
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULTS: PluginConfig = {
  skipCommands: true,
  maxSearchChars: 900,
  maxWakeUpChars: 900,
  maxSearchResults: 3,
  searchDebounceMs: 3000,
  minQueryLength: 15,
  scopeSearchToWing: false,
  l2RecallCosineSimilarityThreshold: 0.7,
  l2RecallBm25Threshold: 0.0,
  l2RecallMinContentLength: 50,
  l1RecallCustomWakeUp: {
    enabled: false,
    cosineSimilarityThreshold: 0.7,
    bm25Threshold: 0.0,
    minContentLength: 0,
  },
  mineExtractGeneral: true,
  autoMinedFiles: ["README.md", "AGENTS.md"],
  autoMineFilesCaseSensitive: false,
  autoMinedFilesDelayMs: 30000,
  mineTimeoutMs: 30000,
  maxRetries: 3,
  retryDelayMs: 2000,
  fileLogging: false,
  plugins: {
    ohMyOpenAgent: {
      stripInjectedPrompts: false,
    },
  },
  sanitizeSearchQuery: {
    stripSymbols: true,
    removeShortWords: true,
    minWordLength: 3,
  },
}

// ---------------------------------------------------------------------------
// Load & parse config from plugin-config.json
// ---------------------------------------------------------------------------
//
// User-facing config uses flat dot-separated keys (Java Spring properties
// style). The parser walks each dotted key through the raw JSON object.
// Nested objects (legacy form) still resolve correctly because the walk
// treats `.` as a path separator: `getFlatKey(raw, "a.b.c")` returns
// `raw.a.b.c` whether the JSON shape is `{"a.b.c": x}` or
// `{"a": {"b": {"c": x}}}`.
// ---------------------------------------------------------------------------

function getFlatKey(raw: unknown, dottedKey: string): unknown {
  if (raw == null || typeof raw !== "object") return undefined
  // Exact key match first - handles flat dotted keys stored as a single literal key
  // e.g. {"sanitizeSearchQuery.stripSymbols": false}
  if (dottedKey in (raw as object)) return (raw as any)[dottedKey]
  // Otherwise walk the path through nested objects - handles legacy nested form
  // e.g. {"sanitizeSearchQuery": {"stripSymbols": false}}
  let cur: any = raw
  for (const part of dottedKey.split(".")) {
    if (cur == null || typeof cur !== "object" || !(part in cur)) return undefined
    cur = cur[part]
  }
  return cur
}

function num(raw: unknown, key: string, predicate: (n: number) => boolean = () => true): number | undefined {
  const v = getFlatKey(raw, key)
  if (typeof v === "number" && predicate(v)) return v
  return undefined
}

function bool(raw: unknown, key: string): boolean | undefined {
  const v = getFlatKey(raw, key)
  return typeof v === "boolean" ? v : undefined
}

function strArray(raw: unknown, key: string): string[] | undefined {
  const v = getFlatKey(raw, key)
  return Array.isArray(v) ? (v as string[]) : undefined
}

export function loadPluginConfig(filePath: string): PluginConfig {
  const config: PluginConfig = {
    ...DEFAULTS,
    l1RecallCustomWakeUp: { ...DEFAULTS.l1RecallCustomWakeUp },
    plugins: { ohMyOpenAgent: { ...DEFAULTS.plugins.ohMyOpenAgent } },
    sanitizeSearchQuery: { ...DEFAULTS.sanitizeSearchQuery },
  }

  if (!existsSync(filePath)) return config

  try {
    const raw: unknown = JSON.parse(readFileSync(filePath, "utf-8"))

    // Top-level scalars
    const v0 = num(raw, "maxMempalaceSearchChars", n => n > 0); if (v0 !== undefined) config.maxSearchChars = v0
    const v1 = num(raw, "maxWakeUpChars", n => n > 0); if (v1 !== undefined) config.maxWakeUpChars = v1
    const v2 = num(raw, "maxSearchResults", n => n > 0); if (v2 !== undefined) config.maxSearchResults = v2
    const v3 = num(raw, "searchDebounceMs", n => n > 0); if (v3 !== undefined) config.searchDebounceMs = v3
    const v4 = num(raw, "minQueryLength", n => n > 0); if (v4 !== undefined) config.minQueryLength = v4
    const v5 = bool(raw, "scopeSearchToWing"); if (v5 !== undefined) config.scopeSearchToWing = v5
    const v6 = bool(raw, "skipCommands"); if (v6 !== undefined) config.skipCommands = v6
    const v7 = num(raw, "l2RecallCosineSimilarityThreshold", n => n >= 0 && n <= 1); if (v7 !== undefined) config.l2RecallCosineSimilarityThreshold = v7
    const v8 = num(raw, "l2RecallBm25Threshold", n => n >= 0); if (v8 !== undefined) config.l2RecallBm25Threshold = v8
    const v9 = num(raw, "l2RecallMinContentLength", n => n >= 0); if (v9 !== undefined) config.l2RecallMinContentLength = v9
    const v10 = bool(raw, "mineExtractGeneral"); if (v10 !== undefined) config.mineExtractGeneral = v10
    const v11 = strArray(raw, "autoMinedFiles"); if (v11 !== undefined) config.autoMinedFiles = v11
    const v12 = bool(raw, "autoMineFilesCaseSensitive"); if (v12 !== undefined) config.autoMineFilesCaseSensitive = v12
    const v13 = num(raw, "autoMinedFilesDelayMs", n => n > 0); if (v13 !== undefined) config.autoMinedFilesDelayMs = v13
    const v14 = num(raw, "mineTimeoutMs"); if (v14 !== undefined) config.mineTimeoutMs = v14 >= 1000 ? v14 : 30000
    const v15 = num(raw, "maxRetries", n => n >= 0); if (v15 !== undefined) config.maxRetries = v15
    const v16 = num(raw, "retryDelayMs", n => n >= 0); if (v16 !== undefined) config.retryDelayMs = v16
    const v17 = bool(raw, "fileLogging"); if (v17 !== undefined) config.fileLogging = v17

    // l1RecallCustomWakeUp.* (flat dotted keys)
    const l1e = bool(raw, "l1RecallCustomWakeUp.enabled"); if (l1e !== undefined) config.l1RecallCustomWakeUp.enabled = l1e
    const l1c = num(raw, "l1RecallCustomWakeUp.cosineSimilarityThreshold", n => n >= 0 && n <= 1); if (l1c !== undefined) config.l1RecallCustomWakeUp.cosineSimilarityThreshold = l1c
    const l1b = num(raw, "l1RecallCustomWakeUp.bm25Threshold", n => n >= 0); if (l1b !== undefined) config.l1RecallCustomWakeUp.bm25Threshold = l1b
    const l1m = num(raw, "l1RecallCustomWakeUp.minContentLength", n => n >= 0); if (l1m !== undefined) config.l1RecallCustomWakeUp.minContentLength = l1m

    // plugins.oh-my-openagent.stripInjectedPrompts (flat dotted keys, kebab-case segment preserved)
    const p1 = bool(raw, "plugins.oh-my-openagent.stripInjectedPrompts"); if (p1 !== undefined) config.plugins.ohMyOpenAgent.stripInjectedPrompts = p1

    // sanitizeSearchQuery.* (flat dotted keys)
    const s1 = bool(raw, "sanitizeSearchQuery.stripSymbols"); if (s1 !== undefined) config.sanitizeSearchQuery.stripSymbols = s1
    const s2 = bool(raw, "sanitizeSearchQuery.removeShortWords"); if (s2 !== undefined) config.sanitizeSearchQuery.removeShortWords = s2
    const s3 = num(raw, "sanitizeSearchQuery.minWordLength", n => n >= 0 && Number.isFinite(n)); if (s3 !== undefined) config.sanitizeSearchQuery.minWordLength = Math.floor(s3)
  } catch {}

  return config
}
