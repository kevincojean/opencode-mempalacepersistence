import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createTestEnv, type TestEnv } from "./helpers/env.js"
import { opencodeRun, opencodeDB } from "./helpers/cli.js"

const FIXTURE_CONFIG = "opencode.jsonc"
const TEST_PHRASE = `e2e-test-unique-phrase-${Date.now()}`

describe("Memory storage verification @storage", () => {
  let env: TestEnv | undefined

  beforeAll(async () => {
    env = await createTestEnv({
      autoInjectContext: true,
      identity: "I am Test User.",
      opencodeConfigPath: FIXTURE_CONFIG,
    })
  })

  afterAll(async () => {
    await env?.destroy()
  })

  it("stores conversation messages in the opencode database", async () => {
    const msg1 = await opencodeRun(env!, `Store this for later: ${TEST_PHRASE}`)
    const sid = msg1.sessionID
    expect(sid).toBeDefined()

    if (sid) {
      await opencodeRun(env!, `I confirm the phrase is: ${TEST_PHRASE}`, {
        additionalArgs: ["--continue", "--session", sid],
      })
    }

    const messages = await opencodeDB(
      env!,
      `SELECT count(*) as cnt FROM message m WHERE m.session_id = '${sid}'`,
    )
    expect(messages.length).toBe(1)
    expect(Number(messages[0].cnt)).toBeGreaterThanOrEqual(2)
  })
})
