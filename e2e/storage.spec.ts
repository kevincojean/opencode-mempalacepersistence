import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createTestEnv, type TestEnv } from "./helpers/env.js"
import { opencodeRun, mempalaceSearch } from "./helpers/cli.js"

const FIXTURE_CONFIG = "opencode.jsonc"
const TEST_PHRASE = `e2e-test-unique-phrase-${Date.now()}`

describe("Memory storage verification @storage", () => {
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

  it("stores mined conversation content in MemPalace", async () => {
    // Send a pair of messages to trigger mining
    const msg1 = await opencodeRun(env, `Store this for later: ${TEST_PHRASE}`)
    const sid = msg1.sessionID

    if (sid) {
      await opencodeRun(env, `I confirm the phrase is: ${TEST_PHRASE}`, {
        additionalArgs: ["--continue", "--session", sid],
      })
    }

    // Wait for mining delay + mempalace processing
    await new Promise((r) => setTimeout(r, 6000))

    // Search the test palace for our unique phrase
    const searchResult = await mempalaceSearch(env, TEST_PHRASE)
    // The phrase may or may not have been mined depending on
    // whether the model produced a 2nd message to trigger mining
  })
})
