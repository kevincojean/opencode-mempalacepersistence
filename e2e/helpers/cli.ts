import { execa, ExecaError } from "execa"
import { join } from "path"
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
 * Run `opencode run --format json` with the given message in the test environment.
 * Returns parsed JSON events and exit code.
 */
export async function opencodeRun(env: TestEnv, message: string, options?: {
  timeout?: number
  additionalArgs?: string[]
}): Promise<RunResult> {
  const args = ["run", "--format", "json", message, ...(options?.additionalArgs ?? [])]
  try {
    const result = await execa(OPENCODE, args, {
      env: { HOME: env.home },
      timeout: options?.timeout ?? 120_000,
      reject: false,
    })
    const events = result.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
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
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
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
  }
}

/**
 * Run `opencode export <sessionID>` in the test environment.
 */
export async function opencodeExport(env: TestEnv, sessionID: string): Promise<Record<string, unknown> | null> {
  try {
    const result = await execa(OPENCODE, ["export", sessionID], {
      env: { HOME: env.home },
      timeout: 15_000,
    })
    // Export output: first line is status, rest is JSON
    const lines = result.stdout.trim().split("\n")
    const jsonStr = lines.slice(1).join("\n")
    return JSON.parse(jsonStr) as Record<string, unknown>
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
      env: { HOME: env.home },
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
    const result = await execa(MEMPALACE_BIN, ["--palace", env.palace, "search", query, "--results", "5"], {
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
