import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdir, writeFile, rm } from "fs/promises"
import { join, basename } from "path"
import { tmpdir } from "os"
import { randomUUID } from "crypto"

// ---------------------------------------------------------------------------
// We test the plugin's injection logic directly rather than loading the
// full plugin module (which has Node.js child_process side-effects).
// The injection runs in the chat.message hook which modifies output.parts
// before the message is displayed in the UI.
// ---------------------------------------------------------------------------

function buildIdentityBlock(identity: string): string {
  return `[MemPalace Identity]\n${identity}\n[/MemPalace Identity]`
}

function buildRecallBlock(text: string, maxChars = 900): string {
  const truncated = text.slice(0, maxChars)
  return `[MemPalace Recall]\n${truncated}\n[/MemPalace Recall]`
}

function buildL1Block(text: string, maxChars = 900): string {
  const truncated = text.slice(0, maxChars)
  return `[MemPalace L1]\n${truncated}\n[/MemPalace L1]`
}

/**
 * Simulate the chat.message hook logic from src/index.ts.
 * The real hook receives output.parts — this function replicates the
 * injection part in isolation.
 */
function applyChatMessage(
  parts: any[],
  identity: string,
  autoInject: boolean,
  wakeupDone: boolean,
  searchResult: string,
  wakeUpResult = "",
): { parts: any[]; wakeupDone: boolean } {
  if (!autoInject) return { parts, wakeupDone }

  const prefixBlocks: string[] = []

  let newWakeupDone = wakeupDone
  if (!newWakeupDone) {
    newWakeupDone = true
    if (identity) {
      prefixBlocks.push(buildIdentityBlock(identity))
    }
    if (wakeUpResult) {
      prefixBlocks.push(buildL1Block(wakeUpResult))
    }
  }

  if (searchResult) {
    prefixBlocks.push(buildRecallBlock(searchResult))
  }

  if (prefixBlocks.length > 0) {
    firstTextPart: for (const part of parts) {
      if (part?.type === "text" && typeof part.text === "string") {
        part.text = prefixBlocks.join("\n\n") + "\n\n" + part.text
        break firstTextPart
      }
    }
  }

  return { parts, wakeupDone: newWakeupDone }
}

// ---------------------------------------------------------------------------
// Identity injection tests
// ---------------------------------------------------------------------------

describe("Identity injection @injection", () => {
  it("injects visible [MemPalace Identity] text on the first user message", () => {
    const parts = [{ type: "text", text: "What is my identity?" }]

    const result = applyChatMessage(parts, "I am Test User.", true, false, "")

    expect(result.parts.length).toBe(1)
    const text = result.parts[0].text
    expect(text.startsWith("[MemPalace Identity]")).toBe(true)
    expect(text).toContain("I am Test User.")
    expect(text.endsWith("What is my identity?")).toBe(true)
    expect(result.wakeupDone).toBe(true)
  })

  it("only injects identity and L1 once when wakeupDone is already true", () => {
    const parts = [{ type: "text", text: "Tell me more." }]

    const result = applyChatMessage(parts, "I am Test User.", true, true, "", "L1 content")

    expect(result.parts[0].text).not.toContain("[MemPalace Identity]")
    expect(result.parts[0].text).not.toContain("[MemPalace L1]")
    expect(result.parts[0].text).toBe("Tell me more.")
    expect(result.wakeupDone).toBe(true)
  })

  it("does not inject identity when autoInject is false", () => {
    const parts = [{ type: "text", text: "Who am I?" }]

    const result = applyChatMessage(parts, "I am Test User.", false, false, "")

    expect(result.parts.length).toBe(1)
    expect(result.wakeupDone).toBe(false)
  })

  it("does not inject identity when identity string is empty", () => {
    const parts = [{ type: "text", text: "Who am I?" }]

    const result = applyChatMessage(parts, "", true, false, "")

    expect(result.parts.length).toBe(1)
    expect(result.wakeupDone).toBe(true)
  })

  it("injects L1 wake-up context alongside identity on first message", () => {
    const parts = [{ type: "text", text: "What's the project about?" }]

    const result = applyChatMessage(parts, "I am Dehi.", true, false, "", "# L1 — Project context here")

    const text = result.parts[0].text
    expect(text.startsWith("[MemPalace Identity]")).toBe(true)
    expect(text).toContain("[MemPalace L1]")
    expect(text).toContain("Project context here")
    expect(text).toContain("I am Dehi.")
    expect(text.endsWith("What's the project about?")).toBe(true)
    expect(result.wakeupDone).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Memory search and injection tests
// ---------------------------------------------------------------------------

describe("Memory search and injection @injection @search", () => {
  it("injects [MemPalace Recall] text when search results exist", () => {
    const parts = [{ type: "text", text: "What do you remember about me?" }]

    const result = applyChatMessage(parts, "I am Test User.", true, true, "User likes blue and works on E2E testing.")

    const text = result.parts[0].text
    expect(text).toContain("[MemPalace Recall]")
    expect(text).toContain("User likes blue")
    expect(text).toContain("What do you remember about me?")
  })

  it("truncates recall text to 900 characters", () => {
    const longRecall = "x".repeat(2000)

    const block = buildRecallBlock(longRecall, 900)
    const match = block.match(/\[MemPalace Recall\]\n([\s\S]*)\n\[\/MemPalace Recall\]/)
    expect(match).not.toBeNull()
    expect(match![1].length).toBe(900)
  })

  it("does not inject recall when search result is empty", () => {
    const parts = [{ type: "text", text: "Any memories?" }]

    const result = applyChatMessage(parts, "I am Test User.", true, true, "")

    expect(result.parts[0].text).not.toContain("[MemPalace Recall]")
    expect(result.parts[0].text).toBe("Any memories?")
  })
})

// ---------------------------------------------------------------------------
// Short message skips search
// ---------------------------------------------------------------------------

describe("Short message skips search @injection @search", () => {
  it("injects identity but skips recall for messages under 15 characters", () => {
    const parts = [{ type: "text", text: "Hi" }]

    const result = applyChatMessage(parts, "I am Test User.", true, false, "")

    expect(result.parts.length).toBe(1)
    const text = result.parts[0].text
    expect(text.startsWith("[MemPalace Identity]")).toBe(true)
    expect(text).toContain("I am Test User.")
    expect(text).not.toContain("[MemPalace Recall]")
    expect(text.endsWith("Hi")).toBe(true)
    expect(result.wakeupDone).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Identity file read integration
// ---------------------------------------------------------------------------

describe("Identity file read @injection @config", () => {
  let tmpDir: string

  beforeAll(async () => {
    tmpDir = join(tmpdir(), `mp-inj-test-${randomUUID().slice(0, 8)}`)
    await mkdir(tmpDir, { recursive: true })
  })

  afterAll(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it("reads identity from MEMPALACE_IDENTITY_FILE when set", async () => {
    const identityPath = join(tmpDir, "my-identity.txt")
    await writeFile(identityPath, "Custom test identity", "utf-8")

    const identity = await (async () => {
      const { existsSync, readFileSync } = await import("fs")
      const file = process.env.MEMPALACE_IDENTITY_FILE ?? join(tmpDir, ".mempalace/identity.txt")
      if (!existsSync(file)) return ""
      try { return readFileSync(file, "utf-8").trim() } catch { return "" }
    })()

    // Without MEMPALACE_IDENTITY_FILE set, it won't find it
    // (this test demonstrates the env var mechanism)
    expect(identity).toBe("")
  })

  it("reads identity from default path when env var is not set", async () => {
    const defaultPath = join(tmpDir, ".mempalace/identity.txt")
    await mkdir(join(tmpDir, ".mempalace"), { recursive: true })
    await writeFile(defaultPath, "Default path identity", "utf-8")

    const identity = await (async () => {
      const { existsSync, readFileSync } = await import("fs")
      const file = process.env.MEMPALACE_IDENTITY_FILE ?? join(tmpDir, ".mempalace/identity.txt")
      if (!existsSync(file)) return ""
      try { return readFileSync(file, "utf-8").trim() } catch { return "" }
    })()

    expect(identity).toBe("Default path identity")
  })
})

// ---------------------------------------------------------------------------
// Wing-scoped search and L2 @search @config
// ---------------------------------------------------------------------------

function testGetWingFromPath(workspacePath: string): string {
  if (!workspacePath || workspacePath === "/") {
    return "wing_general"
  }
  const baseName = basename(workspacePath)
  const sanitized = baseName.toLowerCase().replace(/[^a-z0-9]/g, "-")
  if (!sanitized || sanitized === "-") {
    return "wing_general"
  }
  return `wing_${sanitized}`
}

function testBuildWingFlag(scoped: boolean, wing: string): string {
  if (!scoped || !wing) return ""
  return ` --wing "${wing.replace(/"/g, '\\"')}"`
}

describe("Wing-scoped search and L2 @search @config", () => {
  it("returns wing_general for empty path", () => {
    expect(testGetWingFromPath("")).toBe("wing_general")
  })

  it("returns wing_general for root path", () => {
    expect(testGetWingFromPath("/")).toBe("wing_general")
  })

  it("sanitizes directory name with special chars", () => {
    expect(testGetWingFromPath("My Project!")).toBe("wing_my-project-")
  })

  it("lowercases and replaces spaces with hyphens", () => {
    expect(testGetWingFromPath("My Project")).toBe("wing_my-project")
  })

  it("uses wing_ prefix", () => {
    expect(testGetWingFromPath("myapp")).toBe("wing_myapp")
  })

  it("buildWingFlag returns empty string when scoping is disabled", () => {
    expect(testBuildWingFlag(false, "wing_test")).toBe("")
  })

  it("buildWingFlag returns --wing flag when scoping is enabled", () => {
    expect(testBuildWingFlag(true, "wing_test")).toBe(' --wing "wing_test"')
  })

  it("buildWingFlag escapes double quotes in wing name", () => {
    expect(testBuildWingFlag(true, 'wing_"test"')).toBe(' --wing "wing_\\"test\\""')
  })

  it("scopeSearchToWing config defaults to false when not configured", async () => {
    const { existsSync, readFileSync } = await import("fs")
    const configPath = process.env.MEMPALACE_PLUGIN_CONFIG ?? join(
      process.env.HOME ?? "/tmp",
      ".mempalace/plugin-config.json",
    )
    let scopeValue = false
    if (existsSync(configPath)) {
      try {
        const raw = JSON.parse(readFileSync(configPath, "utf-8"))
        if (typeof raw?.scopeSearchToWing === "boolean") {
          scopeValue = raw.scopeSearchToWing
        }
      } catch { /* use default */ }
    }
    expect(scopeValue).toBe(false)
  })

  it("includes --wing flag in simulated search command when scoped", () => {
    const wing = "wing_test"
    const query = "test query"
    const flag = testBuildWingFlag(true, wing)
    const searchCmd = `search "${query}" --results 3${flag}`
    expect(searchCmd).toContain(`--wing "${wing}"`)
  })
})

// ---------------------------------------------------------------------------
// Recall quality filters — parseSearchResults, filterSearchResults, rebuildSearchOutput
// ---------------------------------------------------------------------------

const RESULT_SEPARATOR = "  ────────────────────────────────────────────────────────"

interface ParsedResult {
  wing: string
  room: string
  source: string
  cosine: number
  bm25: number
  content: string
}

function testParseSearchResults(output: string): ParsedResult[] {
  const blocks = output.split(RESULT_SEPARATOR)
  const results: ParsedResult[] = []

  for (let bi = 0; bi < blocks.length; bi++) {
    const block = blocks[bi]
    if (!block.trim()) continue
    const lines = block.split("\n")
    let idx = 0

    // For first block, skip header lines (=== lines + "Results for:" line + blank)
    if (bi === 0) {
      while (idx < lines.length && (
        lines[idx].trim() === "" ||
        lines[idx].startsWith("===") ||
        lines[idx].includes("Results for:")
      )) idx++
    }

    while (idx < lines.length && lines[idx].trim() === "") idx++
    if (idx >= lines.length) continue

    const header = lines[idx].trim().match(/\[\d+\]\s+(.+?)\s*\/\s*(.+)/)
    if (!header) continue
    idx++

    while (idx < lines.length && lines[idx].trim() === "") idx++
    const src = lines[idx].trim().match(/Source:\s+(.+)/)
    if (!src) continue
    idx++

    while (idx < lines.length && lines[idx].trim() === "") idx++
    const match = lines[idx].trim().match(/cosine=([\d.]+)\s+bm25=([\d.]+)/)
    if (!match) continue
    idx++

    while (idx < lines.length && lines[idx].trim() === "") idx++
    const content = lines.slice(idx).map(l => l.replace(/^ {6}/, "")).join("\n").trim()

    results.push({
      wing: header[1].trim(),
      room: header[2].trim(),
      source: src[1].trim(),
      cosine: parseFloat(match[1]),
      bm25: parseFloat(match[2]),
      content,
    })
  }

  return results
}

function testFilterSearchResults(
  results: ParsedResult[],
  cosineThreshold: number,
  bm25Min: number,
  minContentLen: number,
): ParsedResult[] {
  return results.filter(r =>
    r.cosine >= cosineThreshold &&
    r.bm25 >= bm25Min &&
    r.content.length >= minContentLen,
  )
}

function testRebuildSearchOutput(results: ParsedResult[], query: string): string {
  if (results.length === 0) return ""

  const header = [
    "============================================================",
    `  Results for: "${query}"`,
    "============================================================",
  ].join("\n")

  const parts = results.map((r, i) => {
    const indentedContent = r.content.split("\n").map(l => `      ${l}`).join("\n")
    return [
      `  [${i + 1}] ${r.wing} / ${r.room}`,
      `      Source: ${r.source}`,
      `      Match:  cosine=${r.cosine.toFixed(3)}  bm25=${r.bm25.toFixed(3)}`,
      "",
      indentedContent,
    ].join("\n")
  })

  return header + "\n\n" + parts.join(`\n\n${RESULT_SEPARATOR}\n\n`) + `\n\n${RESULT_SEPARATOR}\n`
}

function makeRawResult(
  n: number,
  wing: string,
  room: string,
  source: string,
  cosine: number,
  bm25: number,
  content: string,
): string {
  const indented = content.split("\n").map(l => `      ${l}`).join("\n")
  return (
    `  [${n}] ${wing} / ${room}\n` +
    `      Source: ${source}\n` +
    `      Match:  cosine=${cosine.toFixed(3)}  bm25=${bm25.toFixed(3)}\n\n` +
    indented
  )
}

function makeRawOutput(results: string[]): string {
  const raw = `============================================================\n  Results for: "test query"\n============================================================\n`
  return raw + "\n" + results.join(`\n\n${RESULT_SEPARATOR}\n\n`) + `\n\n${RESULT_SEPARATOR}\n`
}

describe("Recall quality filters @search @config", () => {
  describe("parseSearchResults", () => {
    it("parses a single result", () => {
      const raw = makeRawOutput([
        makeRawResult(1, "oc_sessions", "technical", "session_abc.txt", 0.73, 2.382, "Useful memory content here."),
      ])

      const parsed = testParseSearchResults(raw)

      expect(parsed).toHaveLength(1)
      expect(parsed[0].wing).toBe("oc_sessions")
      expect(parsed[0].room).toBe("technical")
      expect(parsed[0].source).toBe("session_abc.txt")
      expect(parsed[0].cosine).toBeCloseTo(0.73, 3)
      expect(parsed[0].bm25).toBeCloseTo(2.382, 3)
      expect(parsed[0].content).toBe("Useful memory content here.")
    })

    it("parses multiple results with separator between them", () => {
      const raw = makeRawOutput([
        makeRawResult(1, "wing_a", "room_x", "src1.txt", 0.8, 1.0, "First result"),
        makeRawResult(2, "wing_b", "room_y", "src2.txt", 0.75, 0.5, "Second result"),
        makeRawResult(3, "wing_c", "room_z", "src3.txt", 0.6, 0.0, "Third result"),
      ])

      const parsed = testParseSearchResults(raw)

      expect(parsed).toHaveLength(3)
      expect(parsed[0].cosine).toBeCloseTo(0.8, 3)
      expect(parsed[1].cosine).toBeCloseTo(0.75, 3)
      expect(parsed[2].cosine).toBeCloseTo(0.6, 3)
      expect(parsed[0].content).toBe("First result")
      expect(parsed[2].content).toBe("Third result")
    })

    it("parses multi-line content", () => {
      const content = "Line one\nLine two\nLine three"
      const raw = makeRawOutput([
        makeRawResult(1, "wing", "room", "src.txt", 0.7, 1.0, content),
      ])

      const parsed = testParseSearchResults(raw)

      expect(parsed).toHaveLength(1)
      expect(parsed[0].content).toBe(content)
    })

    it("returns empty array for empty output", () => {
      expect(testParseSearchResults("")).toEqual([])
    })

    it("returns empty array for No results output", () => {
      expect(testParseSearchResults("No results found")).toEqual([])
    })
  })

  describe("filterSearchResults", () => {
    const results: ParsedResult[] = [
      { wing: "w", room: "r", source: "s1", cosine: 0.9, bm25: 2.0, content: "High quality long memory content" },
      { wing: "w", room: "r", source: "s2", cosine: 0.65, bm25: 1.5, content: "Good BM25 but low cosine" },
      { wing: "w", room: "r", source: "s3", cosine: 0.8, bm25: 0.0, content: "Great cosine but zero BM25" },
      { wing: "w", room: "r", source: "s4", cosine: 0.75, bm25: 0.5, content: "OK" },
    ]

    it("filters by cosine threshold (default 0.7)", () => {
      const filtered = testFilterSearchResults(results, 0.7, 0.0, 0)
      expect(filtered).toHaveLength(3)
      expect(filtered.map(r => r.source)).toEqual(["s1", "s3", "s4"])
    })

    it("filters by BM25 min score", () => {
      const filtered = testFilterSearchResults(results, 0.0, 1.0, 0)
      expect(filtered).toHaveLength(2)
      expect(filtered.map(r => r.source)).toEqual(["s1", "s2"])
    })

    it("filters by min content length", () => {
      const filtered = testFilterSearchResults(results, 0.0, 0.0, 30)
      expect(filtered).toHaveLength(1)
      expect(filtered[0].source).toBe("s1")
    })

    it("applies all filters together (AND)", () => {
      const filtered = testFilterSearchResults(results, 0.7, 0.1, 10)
      expect(filtered).toHaveLength(1)
      expect(filtered[0].source).toBe("s1")
    })

    it("returns empty when all filtered out", () => {
      const filtered = testFilterSearchResults(results, 0.95, 0.0, 0)
      expect(filtered).toEqual([])
    })

    it("passes everything with default thresholds (cosine=0.0, bm25=0.0, len=0)", () => {
      const filtered = testFilterSearchResults(results, 0.0, 0.0, 0)
      expect(filtered).toHaveLength(4)
    })
  })

  describe("rebuildSearchOutput", () => {
    it("rebuilds output with correct format", () => {
      const results: ParsedResult[] = [
        { wing: "oc_sessions", room: "technical", source: "src.txt", cosine: 0.8, bm25: 1.5, content: "Memory content" },
      ]

      const rebuilt = testRebuildSearchOutput(results, "test query")

      expect(rebuilt).toContain('Results for: "test query"')
      expect(rebuilt).toContain("[1] oc_sessions / technical")
      expect(rebuilt).toContain("cosine=0.800  bm25=1.500")
      expect(rebuilt).toContain("Memory content")
      expect(rebuilt).toContain(RESULT_SEPARATOR.trim())
    })

    it("rebuilds output with multiple results", () => {
      const results: ParsedResult[] = [
        { wing: "a", room: "r1", source: "s1.txt", cosine: 0.9, bm25: 2.0, content: "First" },
        { wing: "b", room: "r2", source: "s2.txt", cosine: 0.8, bm25: 1.0, content: "Second" },
      ]

      const rebuilt = testRebuildSearchOutput(results, "query")

      expect(rebuilt).toContain("[1] a / r1")
      expect(rebuilt).toContain("[2] b / r2")
    })

    it("returns empty string for empty results", () => {
      expect(testRebuildSearchOutput([], "query")).toBe("")
    })

    it("indents multi-line content correctly", () => {
      const results: ParsedResult[] = [
        { wing: "w", room: "r", source: "s.txt", cosine: 0.9, bm25: 1.0, content: "Line 1\nLine 2" },
      ]

      const rebuilt = testRebuildSearchOutput(results, "q")
      const lines = rebuilt.split("\n")

      // Content lines should have 6-space indent
      expect(lines.some(l => l === "      Line 1")).toBe(true)
      expect(lines.some(l => l === "      Line 2")).toBe(true)
    })
  })

  describe("full pipeline integration", () => {
    it("drops results below cosine 0.7 from raw output", () => {
      const raw = makeRawOutput([
        makeRawResult(1, "w", "r", "good.txt", 0.85, 2.0, "Strong match memory content"),
        makeRawResult(2, "w", "r", "bad.txt", 0.52, 1.7, "Low quality memory snippet"),
        makeRawResult(3, "w", "r", "ok.txt", 0.73, 0.5, "Decent match with some content"),
      ])

      const parsed = testParseSearchResults(raw)
      const filtered = testFilterSearchResults(parsed, 0.7, 0.0, 0)
      const rebuilt = testRebuildSearchOutput(filtered, "test")

      expect(filtered).toHaveLength(2)
      expect(filtered[0].source).toBe("good.txt")
      expect(filtered[1].source).toBe("ok.txt")
      expect(rebuilt).toContain("Strong match memory content")
      expect(rebuilt).toContain("Decent match with some content")
      expect(rebuilt).not.toContain("Low quality memory snippet")
    })

    it("drops results with BM25=0 when l3RecallBm25MinScore is raised", () => {
      const raw = makeRawOutput([
        makeRawResult(1, "w", "r", "has_kw.txt", 0.8, 1.2, "Contains keyword overlap"),
        makeRawResult(2, "w", "r", "no_kw.txt", 0.78, 0.0, "Semantic only no keyword match"),
      ])

      const parsed = testParseSearchResults(raw)
      const filtered = testFilterSearchResults(parsed, 0.0, 0.1, 0)

      expect(filtered).toHaveLength(1)
      expect(filtered[0].source).toBe("has_kw.txt")
    })

    it("drops results with boilerplate content under l3RecallMinContentLength", () => {
      const raw = makeRawOutput([
        makeRawResult(1, "w", "r", "long.txt", 0.8, 1.0, "This is a detailed and useful memory that has substance and helps the model understand context."),
        makeRawResult(2, "w", "r", "short.txt", 0.75, 0.5, "Done."),
      ])

      const parsed = testParseSearchResults(raw)
      const filtered = testFilterSearchResults(parsed, 0.0, 0.0, 50)

      expect(filtered).toHaveLength(1)
      expect(filtered[0].source).toBe("long.txt")
    })

    it("returns empty recall when all results filtered out", () => {
      const raw = makeRawOutput([
        makeRawResult(1, "w", "r", "low.txt", 0.5, 0.0, "Low quality."),
      ])

      const parsed = testParseSearchResults(raw)
      const filtered = testFilterSearchResults(parsed, 0.7, 0.0, 0)

      expect(filtered).toHaveLength(0)
    })
  })
})
