import { execa, ExecaError } from "execa"
import { join } from "path"
import { mkdtempSync } from "fs"
import { readFile, rm } from "fs/promises"
import type { TestEnv } from "./env.js"

const OPENCODE = process.env.OPENCODE_BIN ?? "opencode"
const MEMPALACE_BIN = process.env.MEMPALACE_BIN ?? join(process.env.HOME ?? "/usr", ".local/bin/mempalace")

export interface RunResult {
  stdout: string
  stderr: string
  exitCode: number
  sessionID?: string
  events: Record<string, unknown>[]
}

/**
 * Escape a string for use inside a single-quoted POSIX shell string.
 * Replaces each `'` with `'\''` (end-quote, literal quote, re-open-quote).
 */
function shSingleQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

/**
 * Run `opencode run --format json` with the given message in the test environment.
 *
 * Uses `script -q -c ...` under the hood because `opencode run` refuses to emit
 * JSON when stdout is a pipe (Node.js child_process default). `script` provides
 * a pseudo-terminal, satisfying opencode's TTY guard.
 *
 * The script output is captured to a temp file and read back, because
 * `script` on Linux writes terminal session content to a file (not stdout).
 */
export async function opencodeRun(env: TestEnv, message: string, options?: {
  timeout?: number
  additionalArgs?: string[]
  additionalEnv?: Record<string, string>
  delayAfter?: number
}): Promise<RunResult> {
  const cmdParts = [OPENCODE, "run", "--format", "json"]
  if (options?.additionalArgs?.length) {
    cmdParts.push(...options.additionalArgs)
  }
  cmdParts.push(shSingleQuote(message))
  
  let shellCmd = cmdParts.join(" ")
  if (options?.delayAfter) {
    shellCmd = `${shellCmd} && sleep ${options.delayAfter}`
  }

  const tmpDir = mkdtempSync("/tmp/mp-run-")
  const scriptOut = join(tmpDir, "script.out")

  try {
    const result = await execa("script", ["-q", "-c", shellCmd, scriptOut], {
      env: { HOME: env.home, ...env.pluginEnv, ...options?.additionalEnv },
      timeout: options?.timeout ?? 70_000,
      reject: false,
    })

    let terminalOutput = ""
    try {
      terminalOutput = await readFile(scriptOut, "utf-8")
    } catch {
      terminalOutput = result.stdout
    }

    const lines = terminalOutput
      .split("\n")
      .filter((l) => l && !l.startsWith("Script started") && !l.startsWith("Script done"))

    const events = lines
      .map((line) => {
        try {
          return JSON.parse(line) as Record<string, unknown>
        } catch {
          return null
        }
      })
      .filter(Boolean) as Record<string, unknown>[]

    const sessionEvent = events.find((e) => e.sessionID)
    return {
      stdout: terminalOutput,
      stderr: result.stderr,
      exitCode: result.exitCode ?? 0,
      sessionID: (sessionEvent?.sessionID as string | undefined),
      events,
    }
  } catch (err) {
    if (err instanceof ExecaError) {
      return {
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? "",
        exitCode: err.exitCode ?? 1,
        events: [],
      }
    }
    throw err
  } finally {
    await rm(tmpDir, { recursive: true, force: true })
  }
}

/**
 * Run `opencode export <sessionID>` in the test environment.
 */
export async function opencodeExport(env: TestEnv, sessionID: string): Promise<Record<string, unknown> | null> {
  try {
    const result = await execa(OPENCODE, ["export", sessionID], {
      env: { HOME: env.home, ...env.pluginEnv },
      timeout: 15_000,
      reject: false,
    })
    if (result.exitCode !== 0) return null
    return JSON.parse(result.stdout) as Record<string, unknown>
  } catch {
    return null
  }
}

/**
 * Run `opencode db <query> --format json` in the test environment.
 */
export async function opencodeDB(env: TestEnv, sql: string): Promise<Record<string, unknown>[]> {
  try {
    const result = await execa(OPENCODE, ["db", sql, "--format", "json"], {
      env: { HOME: env.home, ...env.pluginEnv },
      timeout: 10_000,
    })
    return JSON.parse(result.stdout) as Record<string, unknown>[]
  } catch {
    return []
  }
}

/**
 * Run `mempalace search` against the test palace.
 */
export async function mempalaceSearch(env: TestEnv, query: string): Promise<string> {
  try {
    const result = await execa(MEMPALACE_BIN, ["search", query, "--results", "5"], {
      env: { MEMPALACE_CONFIG: join(env.home, ".mempalace/config.json") },
      timeout: 15_000,
    })
    return result.stdout
  } catch {
    return ""
  }
}

/**
 * Run `mempalace mine` on a file against the test palace.
 */
export async function mempalaceMine(env: TestEnv, filePath: string): Promise<{ stdout: string; exitCode: number }> {
  try {
    const result = await execa(MEMPALACE_BIN, ["--palace", env.palace, "mine", filePath, "--mode", "convos"], {
      timeout: 30_000,
      reject: false,
    })
    return { stdout: result.stdout, exitCode: result.exitCode }
  } catch {
    return { stdout: "", exitCode: 1 }
  }
}

/**
 * Check if a file exists in the temp /tmp/oc-sessions/ directory.
 * The plugin writes conversation files to /tmp/oc-sessions/ (hardcoded in plugin).
 */
export async function findMinedFiles(env: TestEnv): Promise<string[]> {
  const { readdir } = await import("fs/promises")
  const ocSessionsDir = "/tmp/oc-sessions"
  try {
    const files = await readdir(ocSessionsDir)
    return files.filter((f) => f.startsWith("session_"))
  } catch {
    return []
  }
}
