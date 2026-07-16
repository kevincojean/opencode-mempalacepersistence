import { describe, it, expect, beforeAll, afterAll } from "vitest"
import { execFile, execFileSync } from "child_process"
import { readFileSync, mkdtempSync } from "fs"
import { loadPluginConfig } from "../src/config.js"
import { writeFile } from "fs/promises"
import { join } from "path"

describe("Async non-blocking mine behavior @mining", () => {
  it("event loop remains responsive during async subprocess execution", async () => {
    let timerFired = false
    const start = Date.now()

    const timerPromise = new Promise<number>((resolve) => {
      setTimeout(() => {
        timerFired = true
        resolve(Date.now() - start)
      }, 10)
    })

    const execPromise = new Promise<void>((resolve, reject) => {
      execFile("sleep", ["1"], (err) => {
        if (err) reject(err)
        else resolve()
      })
    })

    const timerFiredAt = await timerPromise
    expect(timerFired).toBe(true)
    expect(timerFiredAt).toBeLessThan(500)

    await execPromise
    const totalTime = Date.now() - start
    expect(totalTime).toBeGreaterThanOrEqual(900)
  })
})

describe("Configurable mine timeout @mining", () => {
  it("defaults mineTimeoutMs to 30000 when config file is missing", () => {
    const tmpDir = mkdtempSync("/tmp/mp-test-")
    const config = loadPluginConfig(join(tmpDir, "nonexistent.json"))
    expect(config.mineTimeoutMs).toBe(30000)
    expect(config.maxRetries).toBe(3)
    expect(config.retryDelayMs).toBe(2000)
  })

  it("respects mineTimeoutMs override in config file", async () => {
    const tmpDir = mkdtempSync("/tmp/mp-test-")
    const configPath = join(tmpDir, "plugin-config.json")
    await writeFile(configPath, JSON.stringify({ mineTimeoutMs: 5000 }))
    const config = loadPluginConfig(configPath)
    expect(config.mineTimeoutMs).toBe(5000)
  })

  it("clamps mineTimeoutMs < 1000 to 30000", async () => {
    const tmpDir = mkdtempSync("/tmp/mp-test-")
    const configPath = join(tmpDir, "plugin-config.json")
    await writeFile(configPath, JSON.stringify({ mineTimeoutMs: 500 }))
    const config = loadPluginConfig(configPath)
    expect(config.mineTimeoutMs).toBe(30000)
  })

  it("preserves default maxRetries and retryDelayMs when only mineTimeoutMs is set", async () => {
    const tmpDir = mkdtempSync("/tmp/mp-test-")
    const configPath = join(tmpDir, "plugin-config.json")
    await writeFile(configPath, JSON.stringify({ mineTimeoutMs: 5000 }))
    const config = loadPluginConfig(configPath)
    expect(config.maxRetries).toBe(3)
    expect(config.retryDelayMs).toBe(2000)
  })

  it("accepts maxRetries and retryDelayMs overrides", async () => {
    const tmpDir = mkdtempSync("/tmp/mp-test-")
    const configPath = join(tmpDir, "plugin-config.json")
    await writeFile(configPath, JSON.stringify({ maxRetries: 5, retryDelayMs: 4000 }))
    const config = loadPluginConfig(configPath)
    expect(config.maxRetries).toBe(5)
    expect(config.retryDelayMs).toBe(4000)
    expect(config.mineTimeoutMs).toBe(30000)
  })

  it("boundary: mineTimeoutMs of exactly 1000 is accepted", async () => {
    const tmpDir = mkdtempSync("/tmp/mp-test-")
    const configPath = join(tmpDir, "plugin-config.json")
    await writeFile(configPath, JSON.stringify({ mineTimeoutMs: 1000 }))
    const config = loadPluginConfig(configPath)
    expect(config.mineTimeoutMs).toBe(1000)
  })
})

describe("Nice -n 10 verification @mining", () => {
  it("nice -n 10 sets the correct priority at OS level", () => {
    const result = execFileSync("nice", ["-n", "10", "sh", "-c", "ps -o nice= -p $$"], {
      encoding: "utf-8",
    }).trim()
    expect(result).toBe("10")
  })

  it("source runMineAsync uses nice -n 10 in execFile call", () => {
    const content = readFileSync("src/index.ts", "utf-8")
    expect(content).toContain('execFile("nice", ["-n", "10", MEMPALACE_BIN')
  })

  it("source mineProjectFiles uses nice -n 10 in execFileSync call", () => {
    const content = readFileSync("src/index.ts", "utf-8")
    expect(content).toContain('execFileSync("nice", ["-n", "10", MEMPALACE_BIN')
  })
})

describe("Inter-process flock lock coordination @mining", () => {
  let lockProcess: import("child_process").ChildProcess | undefined

  afterAll(async () => {
    if (lockProcess) {
      lockProcess.kill()
    }
    await new Promise((r) => setTimeout(r, 500))
  })

  it("serializes concurrent acquisitions: first acquires, second fails, first releases, second acquires @mining", async () => {
    const { createHash } = await import("crypto")
    const { exec, execFileSync } = await import("child_process")
    const { realpathSync } = await import("fs")
    const { mkdir } = await import("fs/promises")
    const { homedir } = await import("os")
    const { join } = await import("path")

    const lockDir = join(homedir(), ".mempalace", "locks")
    await mkdir(lockDir, { recursive: true })

    const tmpPalace = join(homedir(), ".mempalace", "tmp-e2e-palace")
    await mkdir(tmpPalace, { recursive: true })
    const canonicalPalace = realpathSync(tmpPalace)
    const palaceHash = createHash("sha256").update(canonicalPalace).digest("hex").slice(0, 16)
    const lockFile = join(lockDir, `mine_palace_${palaceHash}.lock`)

    function tryAcquireLock(): { acquired: boolean } {
      try {
        execFileSync("flock", ["-n", lockFile, "true"], { stdio: "pipe", timeout: 5000 })
        return { acquired: true }
      } catch {
        return { acquired: false }
      }
    }

    try {
      // Step 1: First "instance" acquires and holds the lock.
      // Uses `exec N>file; flock -x N; exec sleep N` so the shell
      // replaces itself with sleep via exec — the PID stays the same,
      // and kill() closes the fd, releasing the lock.
      // Uses fd 5 for dash compatibility (dash only supports 0-9).
      lockProcess = exec(`exec 5>"${lockFile}"; flock -x 5; exec sleep 300`, {
        env: { ...process.env, HOME: homedir() },
      })

      // Wait for lock acquisition by the subprocess
      await new Promise((r) => setTimeout(r, 2000))

      // Step 2: Second concurrent caller tries to acquire → must fail
      const resultWhileHeld = tryAcquireLock()
      expect(resultWhileHeld.acquired).toBe(false)

      // Step 3: First "instance" releases the lock
      lockProcess.kill()
      lockProcess = undefined
      await new Promise((r) => setTimeout(r, 1000))

      // Step 4: Second caller tries again → must succeed
      const resultAfterRelease = tryAcquireLock()
      expect(resultAfterRelease.acquired).toBe(true)
    } finally {
      if (lockProcess) {
        lockProcess.kill()
        lockProcess = undefined
      }
    }
  }, 30000)
})
