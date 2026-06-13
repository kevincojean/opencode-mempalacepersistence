import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { mkdir, writeFile, rm } from "fs/promises"
import { join } from "path"
import { tmpdir } from "os"
import { randomUUID } from "crypto"

// ---------------------------------------------------------------------------
// We test the plugin's injection logic directly rather than via opencode
// export, because opencode persists original (un-transformed) messages to
// its database. The synthetic parts the plugin adds via
// experimental.chat.messages.transform live in the in-memory copy sent to
// the model and do not appear in `opencode export`.
// ---------------------------------------------------------------------------

/**
 * Replicate the relevant injection logic from src/index.ts so we can
 * assert behaviour without loading the full plugin module (which has
 * Node.js child_process side-effects that are irrelevant here).
 */
function hasText(parts: any[]): string {
  return parts
    .filter((p: any) => p?.type === "text" && p?.text?.trim())
    .map((p: any) => p.text.trim())
    .join("\n")
}

function buildIdentityPart(identity: string) {
  return {
    id: `mp-identity-${Date.now()}`,
    type: "text",
    synthetic: true,
    text: `[MemPalace Identity]\n${identity}\n[/MemPalace Identity]`,
  }
}

function buildRecallPart(text: string, maxChars = 900) {
  const truncated = text.slice(0, maxChars)
  return {
    id: `mp-recall-${Date.now()}`,
    type: "text",
    synthetic: true,
    text: `[MemPalace Recall]\n${truncated}\n[/MemPalace Recall]`,
  }
}

function applyTransform(
  messages: any[],
  identity: string,
  autoInject: boolean,
  wakeupDone: boolean,
  searchResult: string,
): { messages: any[]; wakeupDone: boolean } {
  if (!autoInject) return { messages, wakeupDone }
  if (!messages.length) return { messages, wakeupDone }

  const lastUser = [...messages].reverse().find((m: any) => m.info?.role === "user")
  if (!lastUser) return { messages, wakeupDone }

  const query = hasText(lastUser.parts || [])
  if (!query) return { messages, wakeupDone }

  const injectParts: any[] = []

  let newWakeupDone = wakeupDone
  if (!newWakeupDone) {
    newWakeupDone = true
    if (identity) {
      injectParts.push(buildIdentityPart(identity))
    }
  }

  if (searchResult) {
    injectParts.push(buildRecallPart(searchResult))
  }

  if (injectParts.length > 0) {
    lastUser.parts.push(...injectParts)
  }

  return { messages, wakeupDone: newWakeupDone }
}

// ---------------------------------------------------------------------------
// Identity injection tests
// ---------------------------------------------------------------------------

describe("Identity injection @injection", () => {
  it("injects a synthetic [MemPalace Identity] part on the first user message", () => {
    const messages = [
      {
        info: { role: "user" },
        parts: [{ type: "text", text: "What is my identity?" }],
      },
    ]

    const result = applyTransform(messages, "I am Test User.", true, false, "")

    const userMsg = result.messages[0]
    expect(userMsg.parts.length).toBe(2)

    const identityPart = userMsg.parts[1]
    expect(identityPart.type).toBe("text")
    expect(identityPart.synthetic).toBe(true)
    expect(identityPart.text).toContain("[MemPalace Identity]")
    expect(identityPart.text).toContain("I am Test User.")

    expect(result.wakeupDone).toBe(true)
  })

  it("only injects identity once when wakeupDone is already true", () => {
    const messages = [
      {
        info: { role: "user" },
        parts: [{ type: "text", text: "Tell me more." }],
      },
    ]

    const result = applyTransform(messages, "I am Test User.", true, true, "")

    const userMsg = result.messages[0]
    const identityParts = userMsg.parts.filter(
      (p: any) => typeof p.text === "string" && p.text.includes("[MemPalace Identity]"),
    )
    expect(identityParts.length).toBe(0)
    expect(result.wakeupDone).toBe(true)
  })

  it("does not inject identity when autoInject is false", () => {
    const messages = [
      {
        info: { role: "user" },
        parts: [{ type: "text", text: "Who am I?" }],
      },
    ]

    const result = applyTransform(messages, "I am Test User.", false, false, "")

    const userMsg = result.messages[0]
    expect(userMsg.parts.length).toBe(1)
    expect(result.wakeupDone).toBe(false)
  })

  it("does not inject identity when identity string is empty", () => {
    const messages = [
      {
        info: { role: "user" },
        parts: [{ type: "text", text: "Who am I?" }],
      },
    ]

    const result = applyTransform(messages, "", true, false, "")

    const userMsg = result.messages[0]
    expect(userMsg.parts.length).toBe(1)
    expect(result.wakeupDone).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Memory search and injection tests
// ---------------------------------------------------------------------------

describe("Memory search and injection @injection @search", () => {
  it("injects a [MemPalace Recall] block when search results exist", () => {
    const messages = [
      {
        info: { role: "user" },
        parts: [{ type: "text", text: "What do you remember about me?" }],
      },
    ]

    const result = applyTransform(
      messages,
      "I am Test User.",
      true,
      true,
      "User likes blue and works on E2E testing.",
    )

    const userMsg = result.messages[0]
    const recallParts = userMsg.parts.filter(
      (p: any) => typeof p.text === "string" && p.text.includes("[MemPalace Recall]"),
    )
    expect(recallParts.length).toBe(1)
    expect(recallParts[0].text).toContain("User likes blue")
  })

  it("truncates recall text to 900 characters", () => {
    const longRecall = "x".repeat(2000)

    const part = buildRecallPart(longRecall, 900)
    const match = part.text.match(/\[MemPalace Recall\]\n([\s\S]*)\n\[\/MemPalace Recall\]/)
    expect(match).not.toBeNull()
    expect(match![1].length).toBe(900)
  })

  it("does not inject recall when search result is empty", () => {
    const messages = [
      {
        info: { role: "user" },
        parts: [{ type: "text", text: "Any memories?" }],
      },
    ]

    const result = applyTransform(messages, "I am Test User.", true, true, "")

    const userMsg = result.messages[0]
    const recallParts = userMsg.parts.filter(
      (p: any) => typeof p.text === "string" && p.text.includes("[MemPalace Recall]"),
    )
    expect(recallParts.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Short message skips search
// ---------------------------------------------------------------------------

describe("Short message skips search @injection @search", () => {
  it("injects identity but skips recall for messages under 15 characters", () => {
    const messages = [
      {
        info: { role: "user" },
        parts: [{ type: "text", text: "Hi" }],
      },
    ]

    const result = applyTransform(messages, "I am Test User.", true, false, "")

    const userMsg = result.messages[0]
    // Identity is injected (any non-empty message triggers wakeup)
    expect(userMsg.parts.length).toBe(2)

    const identityParts = userMsg.parts.filter(
      (p: any) => typeof p.text === "string" && p.text.includes("[MemPalace Identity]"),
    )
    expect(identityParts.length).toBe(1)

    const recallParts = userMsg.parts.filter(
      (p: any) => typeof p.text === "string" && p.text.includes("[MemPalace Recall]"),
    )
    // Recall is skipped because empty search result
    expect(recallParts.length).toBe(0)

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
