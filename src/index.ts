import { execSync } from "child_process"
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, appendFileSync } from "fs"
import { homedir } from "os"
import { join, basename, resolve } from "path"
import { createHash } from "crypto"
import type { Plugin } from "@opencode-ai/plugin"

const HOME = process.env.HOME || homedir()
const VENV_PYTHON = process.env.MEMPALACE_PYTHON ?? join(HOME, ".local/share/pipx/venvs/mempalace/bin/python3")
const MEMPALACE_BIN = process.env.MEMPALACE_BIN_PATH ?? join(HOME, ".local/bin/mempalace")
const OPENCODE_DB = process.env.OPENCODE_DB_PATH ?? join(HOME, ".local/share/opencode/opencode.db")
const PLUGIN_CONFIG = process.env.MEMPALACE_PLUGIN_CONFIG ?? join(HOME, ".mempalace/plugin-config.json")
const IDENTITY_FILE = process.env.MEMPALACE_IDENTITY_FILE ?? join(HOME, ".mempalace/identity.txt")
const OUT_DIR = "/tmp/oc-sessions"
const TMP_SCRIPT = "/tmp/oc-plugin-query.py"
const LOG_FILE = process.env.MEMPALACE_LOG_FILE ?? "/tmp/opencode-mempalace.log"
const DEBUG = !!process.env.OPENCODE_MEMPALACE_DEBUG

// Configurable defaults (overridable via plugin-config.json)
let maxSearchChars = 900
let maxWakeUpChars = 900
let maxSearchResults = 3
let searchDebounceMs = 3000
let minQueryLength = 15
let scopeSearchToWing = false
let currentWing = ""

function log(msg: string) {
  if (!DEBUG) return
  const ts = new Date().toISOString()
  try { appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`) } catch {}
}

interface QueueItem {
  sessionId: string
  filePath: string
  retries: number
}

const MAX_RETRIES = 3
const RETRY_DELAY_MS = 2000
let miningQueue: QueueItem[] = []
let miningLock = false
let wakeupDone = false
let wakeUpCache: string | null = null
let showToast: ((msg: string, variant?: "info" | "success" | "error") => void) | null = null
let lastSearchTs = 0
let lastSearchResult = ""

function runPython(code: string): string {
  writeFileSync(TMP_SCRIPT, code)
  try {
    return execSync(`${VENV_PYTHON} ${TMP_SCRIPT}`, { encoding: "utf-8", timeout: 10000, killSignal: "SIGKILL" }).trim()
  } finally {
    try { unlinkSync(TMP_SCRIPT) } catch {}
  }
}

function hasText(parts: any[]): string {
  return parts
    .filter((p: any) => p?.type === "text" && p?.text?.trim())
    .map((p: any) => p.text.trim())
    .join("\n")
}

function isAutoInjectEnabled(configPath: string): boolean {
  try {
    const raw = readFileSync(configPath, "utf-8")
    return !!(JSON.parse(raw) as any)?.autoInjectContext
  } catch {
    return false
  }
}

function getWingFromPath(path: string): string {
  if (!path || path === "/") return "wing_general"
  const base = basename(path)
  const sanitized = base.toLowerCase().replace(/[^a-z0-9]/g, "-")
  if (!sanitized || sanitized === "-") return "wing_general"
  return `wing_${sanitized}`
}

function buildWingFlag(): string {
  if (!scopeSearchToWing || !currentWing) return ""
  return ` --wing "${currentWing.replace(/"/g, '\\"')}"`
}

function readIdentity(): string {
  if (!existsSync(IDENTITY_FILE)) return ""
  try { return readFileSync(IDENTITY_FILE, "utf-8").trim() } catch { return "" }
}

function mempalaceSearch(query: string): string {
  const now = Date.now()
  if (query.trim().length < minQueryLength) return ""
  if (now - lastSearchTs < searchDebounceMs) return lastSearchResult
  lastSearchTs = now
  try {
    const out = execSync(`${MEMPALACE_BIN} search "${query.replace(/"/g, '\\"')}" --results ${maxSearchResults}${buildWingFlag()}`, {
      encoding: "utf-8",
      timeout: 15000,
    }).trim()
    if (!out || out.includes("No results")) { lastSearchResult = ""; return "" }
    lastSearchResult = out.slice(0, maxSearchChars)
    return lastSearchResult
  } catch {
    lastSearchResult = ""
    return ""
  }
}

function mempalaceWakeUp(): string {
  if (wakeUpCache !== null) return wakeUpCache
  try {
    const out = execSync(`${MEMPALACE_BIN} wake-up${buildWingFlag()}`, {
      encoding: "utf-8",
      timeout: 15000,
    }).trim()
    if (!out || out.startsWith("No palace")) { wakeUpCache = ""; return "" }
    const l1Index = out.indexOf("\n## L1")
    wakeUpCache = l1Index >= 0 ? out.slice(l1Index + 1) : out
    wakeUpCache = wakeUpCache.slice(0, maxWakeUpChars)
    return wakeUpCache
  } catch {
    wakeUpCache = ""
    return ""
  }
}

function runMineSync(filePath: string, buildWingFlag: () => string): { success: boolean; retry: boolean; error?: string } {
  const configPath = join(process.env.HOME || homedir(), ".mempalace", "config.json")
  const execEnv = { ...process.env, MEMPALACE_CONFIG: configPath, HOME: process.env.HOME || homedir() }
  
  const cmd = `${MEMPALACE_BIN} mine "${filePath}" --mode convos${buildWingFlag()}`
  log(`running: ${cmd}`)

  // Use execSync (synchronous, blocking) so the Node.js process stays alive
  // until the mining attempt completes or times out. This is critical because
  // the parent (opencode run) exits when the event hook returns, killing async
  // timers/callbacks. execSync blocks and guarantees completion within the timeout.
  try {
    const stdout = execSync(cmd, {
      encoding: "utf-8",
      timeout: 3000,
      killSignal: "SIGKILL",
      env: execEnv,
    })
    log("mine success")
    return { success: true, retry: false }
  } catch (err: any) {
    log(`mine exec error: ${err.message?.slice(0, 100)} killed=${err.killed} signal=${err.signal}`)
    const stderr = err.stderr || ""
    const fullMsg = (err.message + stderr).toLowerCase()

    if (err.killed || err.signal || fullMsg.includes("held by") || fullMsg.includes("locked") || fullMsg.includes("contention") || fullMsg.includes("timeout")) {
      log("lock contention detected, will retry")
      return { success: false, retry: true }
    }
    return { success: false, retry: false, error: err.message }
  }
}

function processQueue(): void {
  if (miningLock || miningQueue.length === 0) return

  const item = miningQueue.shift()!
  miningLock = true
  
  log(`processing queue item ${item.sessionId} (retry ${item.retries})`)

  const result = runMineSync(item.filePath, buildWingFlag)
  miningLock = false

  if (result.retry) {
    if (item.retries < MAX_RETRIES) {
      item.retries++
      miningQueue.unshift(item)
      log("Queued, retrying")
      if (showToast) showToast(`Mining queued, retrying...`, "info")
      setTimeout(() => processQueue(), RETRY_DELAY_MS)
    } else {
      log(`mine failed after ${MAX_RETRIES} attempts`)
      if (showToast) showToast(`Erreur sync: mining failed after 3 attempts`, "error")
      try { unlinkSync(item.filePath) } catch {}
      setTimeout(() => processQueue(), 100)
    }
    return
  }

  if (!result.success) {
    log(`mine error: ${result.error}`)
    if (showToast) showToast(`Erreur sync: ${result.error?.slice(0, 50)}`, "error")
    try { unlinkSync(item.filePath) } catch {}
  } else {
    try { unlinkSync(item.filePath) } catch {}
    if (showToast) showToast(`Session sauvegardée`, "success")
    log("mine done")
  }

  setTimeout(() => processQueue(), 100)
}

async function mineSingleSession(sessionId: string): Promise<void> {
  const existingIndex = miningQueue.findIndex(q => q.sessionId === sessionId)
  // ... rest of the python query logic ...


const msgs = runPython(`
import sqlite3, json
db = sqlite3.connect(${JSON.stringify(OPENCODE_DB)})
rows = db.execute("""
SELECT m.id, m.time_created, m.data FROM message m
WHERE m.session_id = ${JSON.stringify(sessionId)}
ORDER BY m.time_created
""").fetchall()
texts = []
for (mid, mts, mdata_raw) in rows:
  try: mdata = json.loads(mdata_raw)
  except: mdata = {}
  role = mdata.get("role", "unknown")
  for (pdata_raw,) in db.execute("SELECT data FROM part WHERE message_id = ? ORDER BY time_created", (mid,)).fetchall():
      try:
          pdata = json.loads(pdata_raw)
          if pdata.get("type") == "text" and pdata.get("text","").strip():
              texts.append({"role": role, "text": pdata.get("text").strip(), "ts": mts})
      except: pass
db.close()
print(json.dumps(texts))
`)

let msgList: Array<{ role: string; text: string; ts: number }>
try { msgList = JSON.parse(msgs) } catch { return Promise.resolve() }
if (!msgList || msgList.length < 1) {
  log(`no messages found for session ${sessionId}`)
  return Promise.resolve()
}

const label = sessionId.slice(0, 8)
const lines: string[] = [
  `# Session ${sessionId}`,
  `Date: ${new Date().toISOString().slice(0, 10)}`,
  `Session: ${sessionId}`,
  "",
]
for (const m of msgList) {
  const ts = m.ts ? new Date(m.ts).toISOString().slice(11, 19) : ""
  lines.push(`## ${m.role.toUpperCase()} — ${ts}`)
  lines.push("")
  lines.push(m.text)
  lines.push("")
}

const content = lines.join("\n").trim()
if (!content) return Promise.resolve()

mkdirSync(OUT_DIR, { recursive: true })
const contentHash = createHash("sha256").update(content).digest("hex").slice(0, 12)
const fname = `session_${label}_${contentHash}.txt`
const filePath = join(OUT_DIR, fname)
writeFileSync(filePath, content + "\n")

if (existingIndex >= 0) {
  log(`replacing stale queue item for ${sessionId}`)
  try { unlinkSync(miningQueue[existingIndex].filePath) } catch {}
  miningQueue[existingIndex] = { sessionId, filePath, retries: 0 }
  return Promise.resolve()
}

if (miningLock) {
  log(`mining locked, queueing session ${sessionId}`)
  miningQueue.push({ sessionId, filePath, retries: 0 })
  log("Queued, retrying")
  return
}

miningLock = true
log(`mining session ${sessionId}`)

const result = runMineSync(filePath, buildWingFlag)
miningLock = false

if (result.retry) {
  miningQueue.push({ sessionId, filePath, retries: 1 })
  log("Queued, retrying")
  if (showToast) showToast(`Mining queued, retrying...`, "info")
  setTimeout(() => processQueue(), RETRY_DELAY_MS)
} else if (!result.success) {
  log(`mine error: ${result.error}`)
  if (showToast) showToast(`Erreur sync: ${result.error?.slice(0, 50)}`, "error")
  try { unlinkSync(filePath) } catch {}
} else {
  try { unlinkSync(filePath) } catch {}
  if (showToast) (showToast as any)(`Session sauvegardée`, "success")
  log("mine done")
}

setTimeout(() => processQueue(), 100)
}

export default (async (input: any) => {
  const home = homedir()
  const pluginConfigPath = process.env.MEMPALACE_PLUGIN_CONFIG ?? join(home, ".mempalace/plugin-config.json")
  const workspaceDirRaw = input.worktree || input.directory || process.cwd()
  const resolvedDir = resolve(workspaceDirRaw)
  currentWing = getWingFromPath(resolvedDir)

  mkdirSync(OUT_DIR, { recursive: true })
  const autoInject = isAutoInjectEnabled(pluginConfigPath)
  const identity = readIdentity()
  try {
    const raw = JSON.parse(readFileSync(pluginConfigPath, "utf-8"))
    if (typeof raw?.maxMempalaceSearchChars === "number" && raw.maxMempalaceSearchChars > 0) maxSearchChars = raw.maxMempalaceSearchChars
    if (typeof raw?.maxWakeUpChars === "number" && raw.maxWakeUpChars > 0) maxWakeUpChars = raw.maxWakeUpChars
    if (typeof raw?.maxSearchResults === "number" && raw.maxSearchResults > 0) maxSearchResults = raw.maxSearchResults
    if (typeof raw?.searchDebounceMs === "number" && raw.searchDebounceMs > 0) searchDebounceMs = raw.searchDebounceMs
    if (typeof raw?.minQueryLength === "number" && raw.minQueryLength > 0) minQueryLength = raw.minQueryLength
    if (typeof raw?.scopeSearchToWing === "boolean") scopeSearchToWing = raw.scopeSearchToWing
  } catch {}

  try {
    if (input?.client?.tui?.showToast) {
      showToast = (msg: string, variant: "info" | "success" | "error" = "info") => {
        input.client.tui.showToast({ body: { title: "MemPalace", message: msg, variant, duration: 2500 } })
          .catch((err: any) => log(`toast err: ${err.message || err}`))
      }
    }
  } catch (e) {}

  log(`loaded (autoInject: ${autoInject}, maxSearchChars: ${maxSearchChars}, maxWakeUpChars: ${maxWakeUpChars}, maxSearchResults: ${maxSearchResults}, searchDebounceMs: ${searchDebounceMs}, minQueryLength: ${minQueryLength}, scopeSearchToWing: ${scopeSearchToWing})`)

  return {
    "chat.message": async (input: any, output: any) => {
      const role = (output.message as any)?.role
      if (role !== "user") return
      const text = hasText(output.parts || [])
      if (!text) return
      const sessionId = input?.sessionID || input?.sessionId || (input as any).client?.session?.id || (input as any).client?.sessionID

      if (autoInject) {
        const prefixTexts: string[] = []
        if (!wakeupDone) {
          wakeupDone = true
          if (identity) {
            prefixTexts.push(`[MemPalace Identity]\n${identity}\n[/MemPalace Identity]`)
          }
          const wakeUp = mempalaceWakeUp()
          if (wakeUp) {
            prefixTexts.push(`[MemPalace L1]\n${wakeUp}\n[/MemPalace L1]`)
          }
        }
        const memories = mempalaceSearch(text)
        if (memories) {
          prefixTexts.push(`[MemPalace Recall]\n${memories}\n[/MemPalace Recall]`)
        }
        if (prefixTexts.length > 0) {
          firstTextPart: for (const part of output.parts) {
            if (part?.type === "text" && typeof part.text === "string") {
              part.text = prefixTexts.join("\n\n") + "\n\n" + part.text
              break firstTextPart
            }
          }
          log(`injected ${prefixTexts.length} context blocks`)
        }
      }

      if (!sessionId) { log("user msg - no sessionId, skipping mine"); return }
      log(`user msg - recorded sessionId ${sessionId}`)
    },

    event: async (input: any) => {
      const { event, sessionID } = input || {}
      if (event?.type !== "session.idle") return
      const sid = sessionID || (event as any)?.sessionID || (event as any)?.properties?.sessionID || (input as any)?.sessionID || (event as any)?.sessionId || (event as any)?.properties?.sessionId || (input as any)?.sessionId
      if (!sid) { log(`idle event - no sessionId (event.type=${event?.type}, inputKeys=${Object.keys(input || {}).join(",")}), skipping mine`); return }
      log(`idle event - mine session ${sid}`)
      await mineSingleSession(sid)
    },
  }
}) satisfies Plugin
