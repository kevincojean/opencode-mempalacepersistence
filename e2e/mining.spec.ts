import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { createTestEnv, type TestEnv } from "./helpers/env.js"
import { opencodeRun, opencodeDB, mempalaceSearch } from "./helpers/cli.js"
import { writeFile, open, mkdir, readFile } from "fs/promises"
import { spawn } from "child_process"
import { openSync, closeSync } from "fs"
import net from "net"
import { join } from "path"

const FIXTURE_CONFIG = "opencode.jsonc"

async function waitForLog(logFile: string, needle: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const content = await readFile(logFile, "utf-8")
      if (content.includes(needle)) return true
    } catch {}
    await new Promise(r => setTimeout(r, 500))
  }
  return false
}

function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolve) => {
    const attempt = () => {
      if (Date.now() > deadline) return resolve(false)
      const sock = net.connect(port, "127.0.0.1")
      sock.once("connect", () => { sock.destroy(); resolve(true) })
      sock.once("error", () => { sock.destroy(); setTimeout(attempt, 300) })
    }
    attempt()
  })
}

function killProcessGroup(pid: number | undefined): void {
  if (!pid) return
  try { process.kill(-pid, "SIGKILL") } catch {}
  try { process.kill(pid, "SIGKILL") } catch {}
}

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

    // detached: own process group, so the group kill below releases the flock even though the `sleep` child holds the lock fd.
    // Must be a direct spawn: `exec`'s shell runs in a different group, so the kill misses it and the lock stays held (verified empirically).
    const lockProcess = spawn("flock", ["-x", lockFile, "sleep", "120"], {
      env: { ...process.env, HOME: env!.home },
      detached: true,
      stdio: "ignore",
    })

    lockProcess.on("error", (err) => console.log(`[${ts()}] lockProcess error: ${err}`))

    await new Promise(r => setTimeout(r, 2000))
    console.log(`[${ts()}] flock acquired`)

    await writeFile(lockFile, `${lockProcess.pid} holder-test`)
    console.log(`[${ts()}] wrote PID ${lockProcess.pid}`)

    const uniqueMsg = "Retry test message " + Date.now()
    const logFile = join(env!.home, "opencode-mempalace.log")

    const servePort = 40000 + Math.floor(Math.random() * 5000)
    const serveUrl = `http://127.0.0.1:${servePort}`
    const serveLogFd = openSync(join(env!.home, "serve.log"), "w")
    const serveProcess = spawn("opencode", ["serve", "--port", String(servePort)], {
      env: { ...process.env, HOME: env!.home, ...env!.pluginEnv },
      detached: true,
      stdio: ["ignore", serveLogFd, serveLogFd],
    })
    serveProcess.on("error", (err) => console.log(`[${ts()}] serveProcess error: ${err}`))
    console.log(`[${ts()}] serve pid=${serveProcess.pid} port=${servePort}`)

    try {
      const ready = await waitForPort(servePort, 30000)
      console.log(`[${ts()}] serve ready: ${ready}`)
      expect(ready).toBe(true)

      console.log(`[${ts()}] starting attach run...`)
      const clientRun = opencodeRun(env!, uniqueMsg, {
        additionalArgs: ["--attach", serveUrl],
        timeout: 180000,
      })
      clientRun.catch(() => {})

      // the mine runs server-side after the response; the client returns before the retry cycle completes.
      // the first response is slow (~60s): the sandbox HOME has no npm cache, so the test provider package installs on first use
      const queued = await waitForLog(logFile, "Queued, retrying", 120000)
      console.log(`[${ts()}] queued detected: ${queued}`)
      expect(queued).toBe(true)

      console.log(`[${ts()}] killing lock process...`)
      killProcessGroup(lockProcess.pid)

      const mined = await waitForLog(logFile, "mine done", 60000)
      console.log(`[${ts()}] mine done: ${mined}`)
      if (!mined) {
        try {
          const content = await readFile(logFile, "utf-8")
          console.log(`[${ts()}] LOG TAIL:\n${content.split("\n").slice(-30).join("\n")}`)
        } catch {}
      }
      expect(mined).toBe(true)

      await clientRun
      console.log(`[${ts()}] client run completed`)

      await new Promise(r => setTimeout(r, 3000))
      console.log(`[${ts()}] checking search result...`)

      const searchResult = await mempalaceSearch(env!, uniqueMsg)
      expect(searchResult).toContain(uniqueMsg)
      console.log(`[${ts()}] SUCCESS`)
    } finally {
      killProcessGroup(serveProcess.pid)
      killProcessGroup(lockProcess.pid)
      closeSync(serveLogFd)
    }
  }, 240000)
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
