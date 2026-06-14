import { existsSync, readFileSync } from "fs"

// ---------------------------------------------------------------------------
// Config types
// ---------------------------------------------------------------------------

export interface L1RecallCustomWakeUpConfig {
  enabled: boolean
  cosineSimilarityThreshold: number
  bm25Threshold: number
  minContentLength: number
}

export interface PluginConfig {
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
}

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULTS: PluginConfig = {
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
}

// ---------------------------------------------------------------------------
// Load & parse config from plugin-config.json
// ---------------------------------------------------------------------------

export function loadPluginConfig(filePath: string): PluginConfig {
  const config: PluginConfig = { ...DEFAULTS, l1RecallCustomWakeUp: { ...DEFAULTS.l1RecallCustomWakeUp } }

  if (!existsSync(filePath)) return config

  try {
    const raw = JSON.parse(readFileSync(filePath, "utf-8"))

    if (typeof raw?.maxMempalaceSearchChars === "number" && raw.maxMempalaceSearchChars > 0)
      config.maxSearchChars = raw.maxMempalaceSearchChars
    if (typeof raw?.maxWakeUpChars === "number" && raw.maxWakeUpChars > 0)
      config.maxWakeUpChars = raw.maxWakeUpChars
    if (typeof raw?.maxSearchResults === "number" && raw.maxSearchResults > 0)
      config.maxSearchResults = raw.maxSearchResults
    if (typeof raw?.searchDebounceMs === "number" && raw.searchDebounceMs > 0)
      config.searchDebounceMs = raw.searchDebounceMs
    if (typeof raw?.minQueryLength === "number" && raw.minQueryLength > 0)
      config.minQueryLength = raw.minQueryLength
    if (typeof raw?.scopeSearchToWing === "boolean")
      config.scopeSearchToWing = raw.scopeSearchToWing
    if (typeof raw?.l2RecallCosineSimilarityThreshold === "number" && raw.l2RecallCosineSimilarityThreshold >= 0 && raw.l2RecallCosineSimilarityThreshold <= 1)
      config.l2RecallCosineSimilarityThreshold = raw.l2RecallCosineSimilarityThreshold
    if (typeof raw?.l2RecallBm25Threshold === "number" && raw.l2RecallBm25Threshold >= 0)
      config.l2RecallBm25Threshold = raw.l2RecallBm25Threshold
    if (typeof raw?.l2RecallMinContentLength === "number" && raw.l2RecallMinContentLength >= 0)
      config.l2RecallMinContentLength = raw.l2RecallMinContentLength
    if (typeof raw?.mineExtractGeneral === "boolean")
      config.mineExtractGeneral = raw.mineExtractGeneral
    if (Array.isArray(raw?.autoMinedFiles))
      config.autoMinedFiles = raw.autoMinedFiles
    if (typeof raw?.autoMineFilesCaseSensitive === "boolean")
      config.autoMineFilesCaseSensitive = raw.autoMineFilesCaseSensitive
    if (typeof raw?.autoMinedFilesDelayMs === "number" && raw.autoMinedFilesDelayMs > 0)
      config.autoMinedFilesDelayMs = raw.autoMinedFilesDelayMs

    // Nested l1RecallCustomWakeUp
    if (typeof raw?.l1RecallCustomWakeUp === "object" && raw.l1RecallCustomWakeUp !== null) {
      const c = raw.l1RecallCustomWakeUp
      if (typeof c.enabled === "boolean") config.l1RecallCustomWakeUp.enabled = c.enabled
      if (typeof c.cosineSimilarityThreshold === "number" && c.cosineSimilarityThreshold >= 0 && c.cosineSimilarityThreshold <= 1)
        config.l1RecallCustomWakeUp.cosineSimilarityThreshold = c.cosineSimilarityThreshold
      if (typeof c.bm25Threshold === "number" && c.bm25Threshold >= 0)
        config.l1RecallCustomWakeUp.bm25Threshold = c.bm25Threshold
      if (typeof c.minContentLength === "number" && c.minContentLength >= 0)
        config.l1RecallCustomWakeUp.minContentLength = c.minContentLength
    }
  } catch {}

  return config
}
