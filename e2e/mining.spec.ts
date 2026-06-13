import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createTestEnv, type TestEnv } from "./helpers/env.js"
import { opencodeRun, opencodeDB, mempalaceSearch } from "./helpers/cli.js"
import { writeFile, open, mkdir } from "fs/promises"
import { join } from "path"

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

  it("retries mining on lock contention @retry", async () => {
    const ts = () => new Date().toISOString().slice(11, 19)
    console.log(`[${ts()}] START retry test`)
    const { createHash } = await import("crypto")
    const { realpathSync } = await import("fs")
    const canonicalPalace = realpathSync(env!.palace)
    const palaceHash = createHash("sha256").update(canonicalPalace).digest("hex").slice(0, 16)
    const lockDir = join(env!.home, ".mempalace", "locks")
    await mkdir(lockDir, { recursive: true })
    
    const lockFile = join(lockDir, `mine_palace_${palaceHash}.lock`)
    console.log(`[${ts()}] lockFile=${lockFile}`)
    
    const { exec } = await import("child_process")
    const lockProcess = exec(`flock -x "${lockFile}" sleep 300`, {
      env: { ...process.env, HOME: env!.home }
    })
    
    lockProcess.on("error", (err) => console.log(`[${ts()}] lockProcess error: ${err}`))
    
    await new Promise(r => setTimeout(r, 2000))
    console.log(`[${ts()}] flock acquired`)
    
    await writeFile(lockFile, `${lockProcess.pid} holder-test`)
    console.log(`[${ts()}] wrote PID ${lockProcess.pid}`)

    try {
      const uniqueMsg = "Retry test message " + Date.now()
      console.log(`[${ts()}] starting opencodeRun...`)
      const runPromise = opencodeRun(env!, uniqueMsg, { delayAfter: 10, timeout: 60000 })
      const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error("TIMEOUT")), 120000))
      await Promise.race([runPromise, timeoutPromise])
      console.log(`[${ts()}] opencodeRun completed`)
      
      const { readFile } = await import("fs/promises")
      const logFile = join(env!.home, "opencode-mempalace.log")
      
      await new Promise(r => setTimeout(r, 8000))
      console.log(`[${ts()}] checking log...`)

      const logContent = await readFile(logFile, "utf-8")
      console.log(`[${ts()}] log length: ${logContent.length}`)
      expect(logContent).toContain("Queued, retrying")

      console.log(`[${ts()}] killing lock process...`)
      lockProcess.kill()
      await new Promise(r => setTimeout(r, 10000))
      console.log(`[${ts()}] checking search result...`)

      const searchResult = await mempalaceSearch(env!, uniqueMsg)
      expect(searchResult).toContain(uniqueMsg)
      console.log(`[${ts()}] SUCCESS`)
    } finally {
      lockProcess.kill()
    }
  }, 70000)
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
