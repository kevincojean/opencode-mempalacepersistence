import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createTestEnv, type TestEnv } from "./helpers/env.js"
import { opencodeRun, opencodeDB } from "./helpers/cli.js"

const FIXTURE_CONFIG = "opencode.jsonc"

describe("Session mining @mining", () => {
  let env: TestEnv | undefined

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

  it("creates a session in the database after running opencode", async () => {
    const result = await opencodeRun(env!, "Store this for mining: the answer is 42.")
    const sid = result.sessionID
    expect(sid).toBeDefined()

    const sessions = await opencodeDB(env!, `SELECT id FROM session WHERE id = '${sid}'`)
    expect(sessions.length).toBe(1)
    expect(sessions[0].id).toBe(sid)
  })

  it("produces messages with correct structure in a multi-turn session", async () => {
    const msg1 = await opencodeRun(env!, "First message " + Date.now())
    const sid = msg1.sessionID
    expect(sid).toBeDefined()

    await opencodeRun(env!, "Second message " + Date.now(), {
      additionalArgs: ["--continue", "--session", sid],
    })

    const messages = await opencodeDB(
      env!,
      `SELECT m.id, m.data FROM message m WHERE m.session_id = '${sid}' ORDER BY m.time_created`,
    )
    expect(messages.length).toBeGreaterThanOrEqual(2)

    for (const msg of messages) {
      const data = JSON.parse(String(msg.data))
      expect(data).toHaveProperty("role")
    }
  })
})

describe("Mining with empty or single-message sessions @mining", () => {
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

  it("creates a session even for a single message", async () => {
    const result = await opencodeRun(env!, "Single message test")
    const sid = result.sessionID
    expect(sid).toBeDefined()

    const rows = await opencodeDB(
      env!,
      `SELECT count(*) as cnt FROM message m WHERE m.session_id = '${sid}'`,
    )
    expect(rows.length).toBe(1)
    expect(Number(rows[0].cnt)).toBeGreaterThan(0)
  })
})
