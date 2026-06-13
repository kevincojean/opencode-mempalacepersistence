import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createTestEnv, type TestEnv } from "./helpers/env.js"
import { opencodeRun } from "./helpers/cli.js"

const FIXTURE_CONFIG = "opencode.jsonc"
let env: TestEnv | undefined

describe("Plugin initialization @init @config", () => {
  beforeAll(async () => {
    env = await createTestEnv({
      autoInjectContext: true,
      identity: "I am Test User, an automated test agent.",
      opencodeConfigPath: FIXTURE_CONFIG,
    })
  })

  afterAll(async () => {
    await env?.destroy()
  })

  it("loads without errors when opencode run starts", async () => {
    const result = await opencodeRun(env!, "Hello")
    expect(result.events.length).toBeGreaterThan(0)
  })

  it("assigns a session ID to every run", async () => {
    const result = await opencodeRun(env!, "Session ID test")
    expect(result.sessionID).toBeDefined()
    expect(result.sessionID).toMatch(/^ses_/)
  })
})

describe("Plugin respects autoInjectContext: false @init", () => {
  let envDisabled: TestEnv | undefined

  beforeAll(async () => {
    envDisabled = await createTestEnv({
      autoInjectContext: false,
      identity: "I am Test User, an automated test agent.",
      opencodeConfigPath: FIXTURE_CONFIG,
    })
  })

  afterAll(async () => {
    await envDisabled?.destroy()
  })

  it("does not inject identity or recall blocks when auto-inject is disabled", async () => {
    const result = await opencodeRun(envDisabled!, "What can you tell me about context injection?")
    expect(result.events.length).toBeGreaterThan(0)
    expect(result.exitCode).toBeLessThanOrEqual(1)
  })
})
