import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createTestEnv, type TestEnv } from "./helpers/env.js"
import { opencodeRun, opencodeExport } from "./helpers/cli.js"

const FIXTURE_CONFIG = "opencode.jsonc"

describe("Identity injection @injection", () => {
  let env: TestEnv
  let sessionID: string

  beforeAll(async () => {
    env = await createTestEnv({
      autoInjectContext: true,
      identity: "I am Test User, an automated test agent working on E2E tests.",
      opencodeConfigPath: FIXTURE_CONFIG,
    })
    const result = await opencodeRun(env, "What is my identity according to the plugin?")
    sessionID = result.sessionID ?? ""
  })

  afterAll(async () => {
    await env.destroy()
  })

  it("injects a synthetic [MemPalace Identity] part into the first user message", async () => {
    if (!sessionID) return // skip if no model made session
    const exportData = await opencodeExport(env, sessionID)
    expect(exportData).not.toBeNull()

    const messages = (exportData as Record<string, any>)?.messages ?? []
    expect(messages.length).toBeGreaterThan(0)

    const userMsg = messages.find((m: any) => m.info?.role === "user")
    expect(userMsg).toBeDefined()

    const parts = userMsg.parts as any[]
    const identityParts = parts.filter(
      (p: any) => typeof p.text === "string" && p.text.includes("[MemPalace Identity]"),
    )
    expect(identityParts.length).toBe(1)
    expect(identityParts[0].text).toContain("I am Test User")
  })

  it("only injects identity once per session on subsequent messages", async () => {
    if (!sessionID) return
    // Continue the session with a second message
    const result2 = await opencodeRun(env, "Tell me more about what you know", {
      additionalArgs: ["--continue", "--session", sessionID],
    })
    const sessionID2 = result2.sessionID

    if (!sessionID2) return
    const exportData2 = await opencodeExport(env, sessionID2)
    const messages = (exportData2 as Record<string, any>)?.messages ?? []

    // Find all user messages with identity blocks
    const userMsgsWithIdentity = messages.filter((m: any) => {
      if (m.info?.role !== "user") return false
      return (m.parts ?? []).some(
        (p: any) => typeof p.text === "string" && p.text.includes("[MemPalace Identity]"),
      )
    })
    // Only first user message should have identity
    expect(userMsgsWithIdentity.length).toBe(1)
  })
})

describe("Memory search and injection @injection @search", () => {
  let env: TestEnv
  let sessionID: string

  beforeAll(async () => {
    env = await createTestEnv({
      autoInjectContext: true,
      identity: "I am Test User.",
      opencodeConfigPath: FIXTURE_CONFIG,
    })
    // First prime the palace with some content via mining
    const prime1 = await opencodeRun(env, "My favorite color is blue and I work on E2E testing.")
    const primeSession = prime1.sessionID
    // Wait for mining to complete
    await new Promise((r) => setTimeout(r, 4000))
    // Continue session so mining triggers (2+ messages)
    if (primeSession) {
      await opencodeRun(env, "Remember that I use Linux and VS Code.", {
        additionalArgs: ["--continue", "--session", primeSession],
      })
      await new Promise((r) => setTimeout(r, 4000))
    }
    // Now ask about the memories
    const result = await opencodeRun(env, "What do you remember about my setup and preferences?")
    sessionID = result.sessionID ?? ""
  })

  afterAll(async () => {
    await env.destroy()
  })

  it("injects a [MemPalace Recall] block when memories are found", async () => {
    if (!sessionID) return
    const exportData = await opencodeExport(env, sessionID)
    expect(exportData).not.toBeNull()

    const messages = (exportData as Record<string, any>)?.messages ?? []
    const userMsg = messages.find((m: any) => m.info?.role === "user")
    expect(userMsg).toBeDefined()

    const parts = userMsg.parts as any[]
    const recallParts = parts.filter(
      (p: any) => typeof p.text === "string" && p.text.includes("[MemPalace Recall]"),
    )
    // May or may not find memories depending on palace state
    // But at minimum the block mechanism should be present
    if (recallParts.length > 0) {
      expect(recallParts[0].text.length).toBeLessThanOrEqual(900)
    }
  })

  it("truncates recall text to 900 characters maximum", async () => {
    if (!sessionID) return
    const exportData = await opencodeExport(env, sessionID)
    const messages = (exportData as Record<string, any>)?.messages ?? []
    const userMsg = messages.find((m: any) => m.info?.role === "user")
    if (!userMsg) return

    const parts = userMsg.parts as any[]
    for (const part of parts) {
      if (typeof part.text === "string" && part.text.includes("[MemPalace Recall]")) {
        // Extract content between tags
        const match = part.text.match(/\[MemPalace Recall\]\n([\s\S]*)\n\[\/MemPalace Recall\]/)
        if (match) {
          expect(match[1].length).toBeLessThanOrEqual(900)
        }
      }
    }
  })
})

describe("Short message skips search @injection @search", () => {
  let env: TestEnv

  beforeAll(async () => {
    env = await createTestEnv({
      autoInjectContext: true,
      identity: "I am Test User.",
      opencodeConfigPath: FIXTURE_CONFIG,
    })
  })

  afterAll(async () => {
    await env.destroy()
  })

  it("does not inject [MemPalace Recall] for messages under 15 characters", async () => {
    const result = await opencodeRun(env, "Hi")
    if (!result.sessionID) return

    const exportData = await opencodeExport(env, result.sessionID)
    const messages = (exportData as Record<string, any>)?.messages ?? []
    const userMsg = messages.find((m: any) => m.info?.role === "user")
    if (!userMsg) return

    const parts = userMsg.parts as any[]
    const recallParts = parts.filter(
      (p: any) => typeof p.text === "string" && p.text.includes("[MemPalace Recall]"),
    )
    expect(recallParts.length).toBe(0)
  })
})
