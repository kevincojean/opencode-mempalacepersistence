import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdtempSync } from "fs"
import { writeFile, rm } from "fs/promises"
import { join } from "path"
import { loadPluginConfig } from "../src/config.js"

// ---------------------------------------------------------------------------
// Flat-key config parser
// ---------------------------------------------------------------------------
// Plugin config uses flat dot-separated keys (Java Spring properties style)
// in JSON form. Examples:
//   { "sanitizeSearchQuery.stripSymbols": false }
//   { "l1RecallCustomWakeUp.enabled": true }
//   { "plugins.oh-my-openagent.stripInjectedPrompts": true }
//
// Legacy nested form still resolves via the same walker (path-walking sees
// `.` as separator), so existing configs don't break silently.
// ---------------------------------------------------------------------------

let tmpDir: string

beforeAll(async () => {
  tmpDir = mkdtempSync("/tmp/mp-flat-cfg-")
})

afterAll(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

async function writeConfig(name: string, content: object): Promise<string> {
  const path = join(tmpDir, name)
  await writeFile(path, JSON.stringify(content), "utf-8")
  return path
}

describe("Flat-key config parser @config", () => {
  describe("l1RecallCustomWakeUp.*", () => {
    it("reads l1RecallCustomWakeUp.enabled from flat key", async () => {
      const path = await writeConfig("l1-enabled.json", { "l1RecallCustomWakeUp.enabled": true })
      const cfg = loadPluginConfig(path)
      expect(cfg.l1RecallCustomWakeUp.enabled).toBe(true)
    })

    it("reads l1RecallCustomWakeUp.cosineSimilarityThreshold from flat key with range validation", async () => {
      const path = await writeConfig("l1-cos.json", { "l1RecallCustomWakeUp.cosineSimilarityThreshold": 0.85 })
      const cfg = loadPluginConfig(path)
      expect(cfg.l1RecallCustomWakeUp.cosineSimilarityThreshold).toBe(0.85)
    })

    it("rejects l1RecallCustomWakeUp.cosineSimilarityThreshold outside [0,1]", async () => {
      const path = await writeConfig("l1-bad-cos.json", { "l1RecallCustomWakeUp.cosineSimilarityThreshold": 1.5 })
      const cfg = loadPluginConfig(path)
      expect(cfg.l1RecallCustomWakeUp.cosineSimilarityThreshold).toBe(0.7)
    })

    it("reads l1RecallCustomWakeUp.bm25Threshold from flat key", async () => {
      const path = await writeConfig("l1-bm25.json", { "l1RecallCustomWakeUp.bm25Threshold": 0.5 })
      const cfg = loadPluginConfig(path)
      expect(cfg.l1RecallCustomWakeUp.bm25Threshold).toBe(0.5)
    })

    it("reads l1RecallCustomWakeUp.minContentLength from flat key", async () => {
      const path = await writeConfig("l1-len.json", { "l1RecallCustomWakeUp.minContentLength": 100 })
      const cfg = loadPluginConfig(path)
      expect(cfg.l1RecallCustomWakeUp.minContentLength).toBe(100)
    })

    it("reads all l1RecallCustomWakeUp.* keys together", async () => {
      const path = await writeConfig("l1-all.json", {
        "l1RecallCustomWakeUp.enabled": true,
        "l1RecallCustomWakeUp.cosineSimilarityThreshold": 0.8,
        "l1RecallCustomWakeUp.bm25Threshold": 0.3,
        "l1RecallCustomWakeUp.minContentLength": 50,
      })
      const cfg = loadPluginConfig(path)
      expect(cfg.l1RecallCustomWakeUp).toEqual({
        enabled: true,
        cosineSimilarityThreshold: 0.8,
        bm25Threshold: 0.3,
        minContentLength: 50,
      })
    })
  })

  describe("plugins.oh-my-openagent.*", () => {
    it("reads plugins.oh-my-openagent.stripInjectedPrompts from flat key (kebab-case segment)", async () => {
      const path = await writeConfig("omo.json", { "plugins.oh-my-openagent.stripInjectedPrompts": true })
      const cfg = loadPluginConfig(path)
      expect(cfg.plugins.ohMyOpenAgent.stripInjectedPrompts).toBe(true)
    })

    it("falls back to default when plugins.oh-my-openagent.stripInjectedPrompts missing", async () => {
      const path = await writeConfig("omo-default.json", { autoInjectContext: true })
      const cfg = loadPluginConfig(path)
      expect(cfg.plugins.ohMyOpenAgent.stripInjectedPrompts).toBe(false)
    })
  })

  describe("sanitizeSearchQuery.*", () => {
    it("reads sanitizeSearchQuery.stripSymbols from flat key", async () => {
      const path = await writeConfig("sss-symbols.json", { "sanitizeSearchQuery.stripSymbols": false })
      const cfg = loadPluginConfig(path)
      expect(cfg.sanitizeSearchQuery.stripSymbols).toBe(false)
    })

    it("reads sanitizeSearchQuery.removeShortWords from flat key", async () => {
      const path = await writeConfig("sss-short.json", { "sanitizeSearchQuery.removeShortWords": false })
      const cfg = loadPluginConfig(path)
      expect(cfg.sanitizeSearchQuery.removeShortWords).toBe(false)
    })

    it("reads sanitizeSearchQuery.minWordLength from flat key with floor", async () => {
      const path = await writeConfig("sss-len.json", { "sanitizeSearchQuery.minWordLength": 5.7 })
      const cfg = loadPluginConfig(path)
      expect(cfg.sanitizeSearchQuery.minWordLength).toBe(5)
    })

    it("rejects negative sanitizeSearchQuery.minWordLength and falls back to default", async () => {
      const path = await writeConfig("sss-len-neg.json", { "sanitizeSearchQuery.minWordLength": -2 })
      const cfg = loadPluginConfig(path)
      expect(cfg.sanitizeSearchQuery.minWordLength).toBe(3)
    })

    it("reads all sanitizeSearchQuery.* keys together", async () => {
      const path = await writeConfig("sss-all.json", {
        "sanitizeSearchQuery.stripSymbols": false,
        "sanitizeSearchQuery.removeShortWords": false,
        "sanitizeSearchQuery.minWordLength": 6,
      })
      const cfg = loadPluginConfig(path)
      expect(cfg.sanitizeSearchQuery).toEqual({
        stripSymbols: false,
        removeShortWords: false,
        minWordLength: 6,
      })
    })
  })

  describe("mixed flat keys across groups", () => {
    it("reads flat keys from all groups in one config", async () => {
      const path = await writeConfig("mixed.json", {
        autoInjectContext: true,
        "l1RecallCustomWakeUp.enabled": true,
        "plugins.oh-my-openagent.stripInjectedPrompts": true,
        "sanitizeSearchQuery.stripSymbols": false,
        "sanitizeSearchQuery.minWordLength": 5,
      })
      const cfg = loadPluginConfig(path)
      expect(cfg.l1RecallCustomWakeUp.enabled).toBe(true)
      expect(cfg.plugins.ohMyOpenAgent.stripInjectedPrompts).toBe(true)
      expect(cfg.sanitizeSearchQuery.stripSymbols).toBe(false)
      expect(cfg.sanitizeSearchQuery.minWordLength).toBe(5)
      expect(cfg.sanitizeSearchQuery.removeShortWords).toBe(true)
    })
  })

  describe("legacy nested-object form (still works via path-walking)", () => {
    it("given legacy nested l1RecallCustomWakeUp object, when loaded, then nested values are read", async () => {
      const path = await writeConfig("legacy-l1.json", {
        l1RecallCustomWakeUp: { enabled: true, cosineSimilarityThreshold: 0.9 },
      })
      const cfg = loadPluginConfig(path)
      expect(cfg.l1RecallCustomWakeUp.enabled).toBe(true)
      expect(cfg.l1RecallCustomWakeUp.cosineSimilarityThreshold).toBe(0.9)
    })

    it("given legacy nested sanitizeSearchQuery object, when loaded, then nested values are read", async () => {
      const path = await writeConfig("legacy-sss.json", {
        sanitizeSearchQuery: { stripSymbols: false, minWordLength: 7 },
      })
      const cfg = loadPluginConfig(path)
      expect(cfg.sanitizeSearchQuery.stripSymbols).toBe(false)
      expect(cfg.sanitizeSearchQuery.minWordLength).toBe(7)
    })

    it("given legacy nested plugins object with kebab-case key, when loaded, then nested value is read", async () => {
      const path = await writeConfig("legacy-omo.json", {
        plugins: { "oh-my-openagent": { stripInjectedPrompts: true } },
      })
      const cfg = loadPluginConfig(path)
      expect(cfg.plugins.ohMyOpenAgent.stripInjectedPrompts).toBe(true)
    })
  })

  describe("invalid value handling", () => {
    it("given a non-boolean where boolean expected, when loaded, then default is kept", async () => {
      const path = await writeConfig("bad-bool.json", { "sanitizeSearchQuery.stripSymbols": "yes" })
      const cfg = loadPluginConfig(path)
      expect(cfg.sanitizeSearchQuery.stripSymbols).toBe(true)
    })

    it("given a non-number where number expected, when loaded, then default is kept", async () => {
      const path = await writeConfig("bad-num.json", { "sanitizeSearchQuery.minWordLength": "3" })
      const cfg = loadPluginConfig(path)
      expect(cfg.sanitizeSearchQuery.minWordLength).toBe(3)
    })

    it("given a non-array where string[] expected, when loaded, then default is kept", async () => {
      const path = await writeConfig("bad-arr.json", { autoMinedFiles: "README.md" })
      const cfg = loadPluginConfig(path)
      expect(cfg.autoMinedFiles).toEqual(["README.md", "AGENTS.md"])
    })

    it("given malformed JSON, when loaded, then all defaults are returned", async () => {
      const path = join(tmpDir, "bad-json.json")
      await writeFile(path, "{ not valid json", "utf-8")
      const cfg = loadPluginConfig(path)
      expect(cfg.skipCommands).toBe(true)
      expect(cfg.maxSearchChars).toBe(900)
    })

    it("given a missing config file, when loaded, then all defaults are returned", () => {
      const cfg = loadPluginConfig(join(tmpDir, "definitely-does-not-exist.json"))
      expect(cfg.skipCommands).toBe(true)
      expect(cfg.sanitizeSearchQuery.stripSymbols).toBe(true)
    })
  })
})
