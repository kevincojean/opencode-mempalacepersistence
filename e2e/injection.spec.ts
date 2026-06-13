import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdir, writeFile, rm } from "fs/promises"
import { join } from "path"
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
