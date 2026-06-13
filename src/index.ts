import { execSync, exec } from "child_process"
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, appendFileSync } from "fs"
import { homedir } from "os"
import { join, basename, resolve } from "path"
import { createHash } from "crypto"
import type { Plugin } from "@opencode-ai/plugin"

const HOME = homedir()
const VENV_PYTHON = process.env.MEMPALACE_PYTHON ?? join(HOME, ".local/share/pipx/venvs/mempalace/bin/python3")
const MEMPALACE_BIN = process.env.MEMPALACE_BIN_PATH ?? join(HOME, ".local/bin/mempalace")
const OPENCODE_DB = process.env.OPENCODE_DB_PATH ?? join(HOME, ".local/share/opencode/opencode.db")
const PLUGIN_CONFIG = process.env.MEMPALACE_PLUGIN_CONFIG ?? join(HOME, ".mempalace/plugin-config.json")
const IDENTITY_FILE = process.env.MEMPALACE_IDENTITY_FILE ?? join(HOME, ".mempalace/identity.txt")
const OUT_DIR = "/tmp/oc-sessions"
const TMP_SCRIPT = "/tmp/oc-plugin-query.py"
const DEBUG = !!process.env.OPENCODE_MEMPALACE_DEBUG
const LOG_FILE = "/tmp/opencode-mempalace.log"
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

let miningLock = false
let wakeupDone = false
let wakeUpCache: string | null = null
let showToast: ((msg: string, variant?: "info" | "success" | "error") => void) | null = null
let lastSearchTs = 0
let lastSearchResult = ""

function runPython(code: string): string {
  writeFileSync(TMP_SCRIPT, code)
  try {
    return execSync(`${VENV_PYTHON} ${TMP_SCRIPT}`, { encoding: "utf-8", timeout: 30000 }).trim()
  } finally {
    unlinkSync(TMP_SCRIPT)
  }
}

function hasText(parts: any[]): string {
  return parts
    .filter((p: any) => p?.type === "text" && p?.text?.trim())
    .map((p: any) => p.text.trim())
    .join("\n")
}

function isAutoInjectEnabled(): boolean {
  try {
    const raw = readFileSync(PLUGIN_CONFIG, "utf-8")
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
    // Strip the Wake-up header and L0 identity portion — keep only L1+ sections
    const l1Index = out.indexOf("\n## L1")
    wakeUpCache = l1Index >= 0 ? out.slice(l1Index + 1) : out
    wakeUpCache = wakeUpCache.slice(0, maxWakeUpChars)
    return wakeUpCache
  } catch {
    wakeUpCache = ""
    return ""
  }
}

function mineSingleSession(sessionId: string): void {
  if (miningLock) return

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
  try { msgList = JSON.parse(msgs) } catch { return }
  if (!msgList || msgList.length < 2) return

  const label = sessionId.slice(0, 8)
  const lines: string[] = [
    `# Session ${sessionId}`,
    `Date: ${new Date().toISOString().slice(0, 10)}`,
    `Session: ${sessionId}`,
    "",
  ]
  for (const m of msgList) {
    const ts = m.ts ? new Date(m.ts).toISOString().slice(11, 19) : ""
    lines.push(`## ${m.role.toUpperCase()} \u2014 ${ts}`)
    lines.push("")
    lines.push(m.text)
    lines.push("")
  }

  const content = lines.join("\n").trim()
  if (!content) return

  mkdirSync(OUT_DIR, { recursive: true })
  const contentHash = createHash("sha256").update(content).digest("hex").slice(0, 12)
  const fname = `session_${label}_${contentHash}.txt`
  const filePath = join(OUT_DIR, fname)
  writeFileSync(filePath, content + "\n")

  miningLock = true
  log(`mining session ${sessionId}`)

  exec(`${MEMPALACE_BIN} mine "${filePath}" --mode convos${buildWingFlag()}`, {
    encoding: "utf-8",
    timeout: 30000,
  }, (err) => {
    miningLock = false
    if (err) {
      log(`mine err: ${err.message}`)
      if (showToast) showToast(`Erreur sync: ${err.message.slice(0, 50)}`, "error")
      return
    }
    try { unlinkSync(filePath) } catch {}
    if (showToast) showToast(`Session sauvegardée`, "success")
    log("mine done")
  })
}

export default (async (input: any) => {
  const workspaceDirRaw = input.worktree || input.directory || process.cwd()
  const resolvedDir = resolve(workspaceDirRaw)
  currentWing = getWingFromPath(resolvedDir)

  mkdirSync(OUT_DIR, { recursive: true })
  const autoInject = isAutoInjectEnabled()
  const identity = readIdentity()
  try {
    const raw = JSON.parse(readFileSync(PLUGIN_CONFIG, "utf-8"))
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
      const sessionId = input?.sessionID

      // --- L0 (identity) + L1 (wake-up) + query recall injection ---
      if (autoInject) {
        const prefixTexts: string[] = []

        if (!wakeupDone) {
          wakeupDone = true
          if (identity) {
            prefixTexts.push(`[MemPalace Identity]\n${identity}\n[/MemPalace Identity]`)
          }
          // L1 — project context from mempalace wake-up (once per session, cached)
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

      // --- Mining ---
      if (!sessionId) { log("user msg - no sessionId, skipping mine"); return }
      log(`user msg - mine session ${sessionId}`)
      setTimeout(() => mineSingleSession(sessionId), 2000)
    },

    event: async ({ event }: any) => {
      if (event?.type !== "session.idle") return
      log("idle event ignored (mining done per-message)")
    },
  }
}) satisfies Plugin
