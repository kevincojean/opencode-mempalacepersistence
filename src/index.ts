import { execFileSync } from "child_process"
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, appendFileSync, statSync, readdirSync } from "fs"
import { homedir } from "os"
import { join, basename, resolve } from "path"
import { createHash } from "crypto"
import type { Plugin } from "@opencode-ai/plugin"
import { loadPluginConfig, type PluginConfig } from "./config.js"
import { stripInjectedPrompts as stripOmoPrompts } from "./plugins/oh-my-openagent.js"

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
const DIAG_LOG = "/tmp/mempalace-diag.log"

function diagLog(msg: string) {
  if (!config?.fileLogging) return
  try { appendFileSync(DIAG_LOG, `[${new Date().toISOString()}] ${msg}\n`) } catch {}
}

let config: PluginConfig
let currentWing = ""
let lastProjectFilesMine = 0
const minedProjectFiles = new Map<string, number>()

function log(msg: string) {
  if (!DEBUG || !config?.fileLogging) return
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
const wakeupDoneSessions = new Set<string>()
let wakeUpCache: string | null = null
let showToast: ((msg: string, variant?: "info" | "success" | "error") => void) | null = null
let lastSearchTs = 0
let lastSearchResult = ""

function runPython(code: string): string {
  writeFileSync(TMP_SCRIPT, code)
  try {
    return execFileSync(VENV_PYTHON, [TMP_SCRIPT], { encoding: "utf-8", timeout: 10000, killSignal: "SIGKILL" }).trim()
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

function isCommandOnly(text: string): boolean {
  return /^\s*\//.test(text.trim())
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

function buildWingArgs(): string[] {
  if (!config.scopeSearchToWing || !currentWing) return []
  return ["--wing", currentWing]
}

const MAX_QUERY_CHARS = 200

function extractSearchQuery(text: string): string {
  let cleaned = text
  if (config.plugins.ohMyOpenAgent.stripInjectedPrompts) {
    cleaned = stripOmoPrompts(cleaned)
  }
  cleaned = cleaned.replace(/\s+/g, " ").trim()
  if (cleaned.length > MAX_QUERY_CHARS) {
    const truncated = cleaned.slice(0, MAX_QUERY_CHARS)
    const lastSpace = truncated.lastIndexOf(" ")
    return lastSpace > MAX_QUERY_CHARS * 0.5 ? truncated.slice(0, lastSpace) : truncated
  }
  return cleaned
}

function readIdentity(): string {
  if (!existsSync(IDENTITY_FILE)) return ""
  try { return readFileSync(IDENTITY_FILE, "utf-8").trim() } catch { return "" }
}

interface ParsedResult {
  wing: string
  room: string
  source: string
  cosine: number
  bm25: number
  content: string
}

const RESULT_SEPARATOR = "  ────────────────────────────────────────────────────────"

function parseSearchResults(output: string): ParsedResult[] {
  const blocks = output.split(RESULT_SEPARATOR)
  const results: ParsedResult[] = []

  for (let bi = 0; bi < blocks.length; bi++) {
    const block = blocks[bi]
    if (!block.trim()) continue
    const lines = block.split("\n")
    let idx = 0

    // For first block, skip header lines (=== lines + "Results for:" line + blank)
    if (bi === 0) {
      while (idx < lines.length && (
        lines[idx].trim() === "" ||
        lines[idx].startsWith("===") ||
        lines[idx].includes("Results for:")
      )) idx++
    }

    // Skip leading blank lines
    while (idx < lines.length && lines[idx].trim() === "") idx++
    if (idx >= lines.length) continue

    const header = lines[idx].trim().match(/\[\d+\]\s+(.+?)\s*\/\s*(.+)/)
    if (!header) continue
    idx++

    while (idx < lines.length && lines[idx].trim() === "") idx++
    const src = lines[idx].trim().match(/Source:\s+(.+)/)
    if (!src) continue
    idx++

    while (idx < lines.length && lines[idx].trim() === "") idx++
    const match = lines[idx].trim().match(/cosine=([\d.]+)\s+bm25=([\d.]+)/)
    if (!match) continue
    idx++

    while (idx < lines.length && lines[idx].trim() === "") idx++
    const content = lines.slice(idx).map(l => l.replace(/^ {6}/, "")).join("\n").trim()

    results.push({
      wing: header[1].trim(),
      room: header[2].trim(),
      source: src[1].trim(),
      cosine: parseFloat(match[1]),
      bm25: parseFloat(match[2]),
      content,
    })
  }

  return results
}

function filterSearchResults(results: ParsedResult[]): ParsedResult[] {
  return results.filter(r =>
    r.cosine >= config.l2RecallCosineSimilarityThreshold &&
    r.bm25 >= config.l2RecallBm25Threshold &&
    r.content.length >= config.l2RecallMinContentLength
  )
}

function rebuildSearchOutput(results: ParsedResult[]): string {
  if (results.length === 0) return ""
  return results
    .map((r, i) => `[${i + 1}] ${r.wing}/${r.room} (cos:${r.cosine.toFixed(3)} bm25:${r.bm25.toFixed(3)})\n${r.content}`)
    .join("\n---\n")
}

function mempalaceSearch(rawText: string): string {
  const now = Date.now()
  if (rawText.trim().length < config.minQueryLength) {
    diagLog(`L2 SEARCH SKIP: query too short (${rawText.length} < ${config.minQueryLength})`)
    return ""
  }
  if (now - lastSearchTs < config.searchDebounceMs) {
    diagLog(`L2 SEARCH SKIP: debounced (${now - lastSearchTs}ms < ${config.searchDebounceMs}ms)`)
    return lastSearchResult
  }
  lastSearchTs = now
  const query = extractSearchQuery(rawText)
  if (!query || query.length < 5) {
    diagLog(`L2 SEARCH SKIP: extracted query empty/too short`)
    return ""
  }
  const args = ["search", query, "--results", String(config.maxSearchResults), ...buildWingArgs()]
  diagLog(`L2 SEARCH CMD: ${MEMPALACE_BIN} ${args.join(" ")}`)
  try {
    const out = execFileSync(MEMPALACE_BIN, args, {
      encoding: "utf-8",
      timeout: 15000,
    }).trim()
    diagLog(`L2 SEARCH RAW OUTPUT: ${out.slice(0, 200)}...`)
    if (!out || out.includes("No results")) {
      diagLog(`L2 SEARCH: no results`)
      lastSearchResult = ""; return ""
    }

    const parsed = parseSearchResults(out)
    diagLog(`L2 SEARCH PARSED: ${parsed.length} results`)
    const filtered = filterSearchResults(parsed)
    diagLog(`L2 SEARCH FILTERED: ${filtered.length} results (thresholds: cosine>=${config.l2RecallCosineSimilarityThreshold}, bm25>=${config.l2RecallBm25Threshold}, len>=${config.l2RecallMinContentLength})`)
    if (filtered.length === 0) {
      if (parsed.length > 0 && showToast) {
        showToast("Recall: skipped (cosine/BM25 thresholds).", "info")
      }
      lastSearchResult = ""
      return ""
    }

    const rebuilt = rebuildSearchOutput(filtered)
    lastSearchResult = rebuilt.slice(0, config.maxSearchChars)
    diagLog(`L2 SEARCH SUCCESS: injecting ${lastSearchResult.length} chars`)
    return lastSearchResult
  } catch (err: any) {
    diagLog(`L2 SEARCH ERROR: ${err.message?.slice(0, 100)}`)
    if (showToast) {
      const hint = config.fileLogging ? "check logs" : "enable fileLogging in plugin-config.json"
      showToast(`Recall error: ${hint}`, "error")
    }
    lastSearchResult = ""
    return ""
  }
}

function filterWakeUpLines(output: string): string {
  const { cosineSimilarityThreshold, bm25Threshold, minContentLength } = config.l1RecallCustomWakeUp
  if (cosineSimilarityThreshold <= 0 && bm25Threshold <= 0) return output
  const lines = output.split("\n")
  const result: string[] = []
  for (const line of lines) {
    const m = line.match(/Match:\s*cosine=([\d.]+)\s+bm25=([\d.]+)/)
    if (m) {
      const cosine = parseFloat(m[1])
      const bm25 = parseFloat(m[2])
      if (cosine < cosineSimilarityThreshold || bm25 < bm25Threshold) {
        continue
      }
      result.push(line.replace(/Match:\s*cosine=[\d.]+\s+bm25=[\d.]+/, "").trimEnd())
    } else {
      result.push(line)
    }
  }
  let filtered = result.join("\n")
  if (minContentLength > 0) {
    filtered = filtered.split("\n").filter(l => l.trim().length >= minContentLength).join("\n")
  }
  return filtered
}

function mempalaceCustomWakeUp(): string {
  const projectName = currentWing.replace(/^wing_/, "").replace(/-/g, " ")
  const query = projectName && projectName !== "general" ? projectName : "project context"
  const l1ResultCount = Math.max(config.maxSearchResults * 3, 15)
  const args = ["search", query, "--results", String(l1ResultCount), ...buildWingArgs()]
  try {
    const out = execFileSync(MEMPALACE_BIN, args, {
      encoding: "utf-8", timeout: 15000,
    }).trim()
    if (!out || out.includes("No results")) { wakeUpCache = ""; return "" }
    const parsed = parseSearchResults(out)
    const { cosineSimilarityThreshold, bm25Threshold, minContentLength } = config.l1RecallCustomWakeUp
    const filtered = parsed.filter(r =>
      r.cosine >= cosineSimilarityThreshold &&
      r.bm25 >= bm25Threshold &&
      r.content.length >= minContentLength
    )
    if (filtered.length === 0) { wakeUpCache = ""; return "" }
    wakeUpCache = rebuildSearchOutput(filtered).slice(0, config.maxWakeUpChars)
    return wakeUpCache
  } catch {
    if (showToast) {
      const hint = config.fileLogging ? "check logs" : "enable fileLogging in plugin-config.json"
      showToast(`Recall error: wake-up failed (${hint})`, "error")
    }
    wakeUpCache = ""
    return ""
  }
}

function mempalaceWakeUp(): string {
  if (wakeUpCache !== null) return wakeUpCache
  if (config.l1RecallCustomWakeUp.enabled) return mempalaceCustomWakeUp()
  try {
    const args = ["wake-up", ...buildWingArgs()]
    const out = execFileSync(MEMPALACE_BIN, args, {
      encoding: "utf-8",
      timeout: 15000,
    }).trim()
    if (!out || out.startsWith("No palace")) { wakeUpCache = ""; return "" }
    const l1Index = out.indexOf("\n## L1")
    const rawL1 = l1Index >= 0 ? out.slice(l1Index + 1) : out
    wakeUpCache = rawL1
      .split("\n")
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith("===") && !line.startsWith("---"))
      .map(line => line.replace(/\s*\([^)]+\.[a-z0-9]+\)$/i, ""))
      .join("\n")
    wakeUpCache = filterWakeUpLines(wakeUpCache)
    wakeUpCache = wakeUpCache.slice(0, config.maxWakeUpChars)
    return wakeUpCache
  } catch {
    if (showToast) {
      const hint = config.fileLogging ? "check logs" : "enable fileLogging in plugin-config.json"
      showToast(`Recall error: wake-up failed (${hint})`, "error")
    }
    wakeUpCache = ""
    return ""
  }
}

function runMineSync(filePath: string, buildWingArgs: () => string[]): { success: boolean; retry: boolean; error?: string } {
  const configPath = join(process.env.HOME || homedir(), ".mempalace", "config.json")
  const execEnv = { ...process.env, MEMPALACE_CONFIG: configPath, HOME: process.env.HOME || homedir() }
  
  const args = ["mine", filePath, "--mode", "convos", ...buildWingArgs()]
  if (config.mineExtractGeneral) args.push("--extract", "general")
  log(`running: ${MEMPALACE_BIN} ${args.join(" ")}`)

  try {
    execFileSync(MEMPALACE_BIN, args, {
      encoding: "utf-8",
      timeout: 3000,
      killSignal: "SIGKILL",
      env: execEnv,
      stdio: "pipe"
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

  const result = runMineSync(item.filePath, buildWingArgs)
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

const result = runMineSync(filePath, buildWingArgs)
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

function mineProjectFiles(projectDir: string): void {
  if (config.autoMinedFiles.length === 0) return
  const now = Date.now()
  if (now - lastProjectFilesMine < config.autoMinedFilesDelayMs) return
  lastProjectFilesMine = now

  const toMine: string[] = []

  if (config.autoMineFilesCaseSensitive) {
    for (const fname of config.autoMinedFiles) {
      const fpath = join(projectDir, fname)
      if (existsSync(fpath)) {
        const mtime = statSync(fpath).mtimeMs
        const prev = minedProjectFiles.get(fpath) || 0
        if (mtime > prev) {
          toMine.push(fpath)
          minedProjectFiles.set(fpath, mtime)
        }
      }
    }
  } else {
    let dirFiles: string[]
    try { dirFiles = readdirSync(projectDir) } catch { return }
    const lowerToActual = new Map<string, string>()
    for (const f of dirFiles) {
      const key = f.toLowerCase()
      if (!lowerToActual.has(key)) lowerToActual.set(key, f)
    }
    for (const fname of config.autoMinedFiles) {
      const actualName = lowerToActual.get(fname.toLowerCase())
      if (actualName) {
        const fpath = join(projectDir, actualName)
        const mtime = statSync(fpath).mtimeMs
        const prev = minedProjectFiles.get(fpath) || 0
        if (mtime > prev) {
          toMine.push(fpath)
          minedProjectFiles.set(fpath, mtime)
        }
      }
    }
  }

  if (toMine.length === 0) return

  const tmpDir = "/tmp/oc-project-files"
  mkdirSync(tmpDir, { recursive: true })
  for (const f of toMine) {
    writeFileSync(join(tmpDir, basename(f)), readFileSync(f, "utf-8"))
  }

  if (showToast) showToast(`Projet: mining ${toMine.map(f => basename(f)).join(", ")}`, "info")
  try {
    const args = ["mine", tmpDir, "--mode", "projects", ...buildWingArgs()]
    execFileSync(MEMPALACE_BIN, args, { encoding: "utf-8", timeout: 10000, killSignal: "SIGKILL", stdio: "pipe" })
    log(`mined project files (${toMine.map(f => basename(f)).join(", ")})`)
  } catch (err: any) {
    log(`mine project files error: ${err.message?.slice(0, 100)}`)
  }
}

export default (async (input: any) => {
  const home = homedir()
  const pluginConfigPath = process.env.MEMPALACE_PLUGIN_CONFIG ?? join(home, ".mempalace/plugin-config.json")
  const workspaceDirRaw = input.worktree || input.directory || process.cwd()
  const resolvedDir = resolve(workspaceDirRaw)
  currentWing = getWingFromPath(resolvedDir)
  wakeUpCache = null

  mkdirSync(OUT_DIR, { recursive: true })
  config = loadPluginConfig(pluginConfigPath)
  const autoInject = isAutoInjectEnabled(pluginConfigPath)
  const identity = readIdentity()

  try {
    if (input?.client?.tui?.showToast) {
      showToast = (msg: string, variant: "info" | "success" | "error" = "info") => {
        input.client.tui.showToast({ body: { title: "MemPalace", message: msg, variant, duration: 2500 } })
          .catch((err: any) => log(`toast err: ${err.message || err}`))
      }
    }
  } catch (e) {}

  if (config.fileLogging) {
    showToast?.("fileLogging is ON — may slow things down with many disk writes. Turn it off if you don't need it.", "info")
  }

  log(`loaded (autoInject: ${autoInject}, skipCommands: ${config.skipCommands}, maxSearchChars: ${config.maxSearchChars}, maxWakeUpChars: ${config.maxWakeUpChars}, maxSearchResults: ${config.maxSearchResults}, searchDebounceMs: ${config.searchDebounceMs}, minQueryLength: ${config.minQueryLength}, scopeSearchToWing: ${config.scopeSearchToWing}, l1CustomWakeUp: ${JSON.stringify(config.l1RecallCustomWakeUp)}, l2CosThresh: ${config.l2RecallCosineSimilarityThreshold}, l2Bm25Thresh: ${config.l2RecallBm25Threshold}, l2MinLen: ${config.l2RecallMinContentLength}, mineExtractGeneral: ${config.mineExtractGeneral}, autoMinedFiles: ${JSON.stringify(config.autoMinedFiles)}, caseSensitive: ${config.autoMineFilesCaseSensitive}, autoMinedDelay: ${config.autoMinedFilesDelayMs}, plugins: ${JSON.stringify(config.plugins)})`)
  diagLog(`PLUGIN INIT: autoInject=${autoInject}, wing=${currentWing}, dir=${resolvedDir}`)

  return {
    "chat.message": async (input: any, output: any) => {
      diagLog(`CHAT.MESSAGE HOOK FIRED: outputKeys=${Object.keys(output || {}).join(",")}, hasMessage=${!!output?.message}, hasParts=${!!output?.parts}, partsLen=${output?.parts?.length || 0}`)
      const role = (output.message as any)?.role
      diagLog(`CHAT.MESSAGE ROLE: role=${role}, messageType=${typeof output?.message}`)
      if (role !== "user") {
        diagLog(`CHAT.MESSAGE SKIP: role is not 'user'`)
        return
      }
      const text = hasText(output.parts || [])
      if (!text) {
        diagLog(`CHAT.MESSAGE SKIP: no text in parts`)
        return
      }
      diagLog(`CHAT.MESSAGE TEXT: len=${text.length}, preview=${text.slice(0, 50)}...`)

      if (config.skipCommands && isCommandOnly(text)) {
        diagLog(`CHAT.MESSAGE SKIP: command-only message (skipCommands enabled)`)
        return
      }

      const sessionId = input?.sessionID || input?.sessionId || (input as any).client?.session?.id || (input as any).client?.sessionID

      if (autoInject) {
        diagLog(`CHAT.MESSAGE AUTOINJECT: starting injection`)
        const prefixTexts: string[] = []
        if (sessionId && !wakeupDoneSessions.has(sessionId)) {
          wakeupDoneSessions.add(sessionId)
          if (identity) {
            prefixTexts.push(`[MemPalace Identity]\n${identity}\n[/MemPalace Identity]`)
          }
          const wakeUp = mempalaceWakeUp()
          if (wakeUp) {
            const l1Title = config.scopeSearchToWing && currentWing ? `[MemPalace L1 : ${currentWing}]` : `[MemPalace L1]`
            prefixTexts.push(`${l1Title}\n${wakeUp}\n[/MemPalace L1]`)
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
          diagLog(`CHAT.MESSAGE INJECTED: ${prefixTexts.length} blocks`)
        }
      } else {
        diagLog(`CHAT.MESSAGE AUTOINJECT DISABLED`)
      }

      if (!sessionId) { log("user msg - no sessionId, skipping mine"); diagLog(`CHAT.MESSAGE NO SESSION ID`); return }
      log(`user msg - recorded sessionId ${sessionId}`)
      diagLog(`CHAT.MESSAGE DONE: sessionId=${sessionId}`)
    },

    event: async (input: any) => {
      const { event, sessionID } = input || {}
      if (event?.type !== "session.idle") return
      diagLog(`EVENT SESSION.IDLE: processing`)
      const sid = sessionID || (event as any)?.sessionID || (event as any)?.properties?.sessionID || (input as any)?.sessionID || (event as any)?.sessionId || (event as any)?.properties?.sessionId || (input as any)?.sessionId
      if (!sid) { log(`idle event - no sessionId (event.type=${event?.type}, inputKeys=${Object.keys(input || {}).join(",")}), skipping mine`); return }
      log(`idle event - mine session ${sid}`)
      diagLog(`EVENT MINING: sessionId=${sid}`)
      await mineSingleSession(sid)
      diagLog(`EVENT MINING DONE`)
      if (config.autoMinedFiles.length > 0) {
        setTimeout(() => mineProjectFiles(resolvedDir), config.autoMinedFilesDelayMs)
      }
    },
  }
}) satisfies Plugin
