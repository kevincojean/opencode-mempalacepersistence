import { execSync, exec } from "child_process"
import { existsSync, readFileSync, writeFileSync, mkdirSync, unlinkSync, appendFileSync } from "fs"
import { homedir } from "os"
import { join } from "path"
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
const MAX_INJECT_CHARS = 900
const MAX_SEARCH_RESULTS = 3
const SEARCH_DEBOUNCE_MS = 3000
const MIN_QUERY_LENGTH = 15

function log(msg: string) {
  if (!DEBUG) return
  const ts = new Date().toISOString()
  try { appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`) } catch {}
}

let miningLock = false
let wakeupDone = false
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

function readIdentity(): string {
  if (!existsSync(IDENTITY_FILE)) return ""
  try { return readFileSync(IDENTITY_FILE, "utf-8").trim() } catch { return "" }
}

function mempalaceSearch(query: string): string {
  const now = Date.now()
  if (query.trim().length < MIN_QUERY_LENGTH) return ""
  if (now - lastSearchTs < SEARCH_DEBOUNCE_MS) return lastSearchResult
  lastSearchTs = now
  try {
    const out = execSync(`${MEMPALACE_BIN} search "${query.replace(/"/g, '\\"')}" --results ${MAX_SEARCH_RESULTS}`, {
      encoding: "utf-8",
      timeout: 15000,
    }).trim()
    if (!out || out.includes("No results")) { lastSearchResult = ""; return "" }
    lastSearchResult = out.slice(0, MAX_INJECT_CHARS)
    return lastSearchResult
  } catch {
    lastSearchResult = ""
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

  exec(`${MEMPALACE_BIN} mine "${filePath}" --mode convos`, {
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
  mkdirSync(OUT_DIR, { recursive: true })
  const autoInject = isAutoInjectEnabled()
  const identity = readIdentity()

  try {
    if (input?.client?.tui?.showToast) {
      showToast = (msg: string, variant: "info" | "success" | "error" = "info") => {
        input.client.tui.showToast({ body: { title: "MemPalace", message: msg, variant, duration: 2500 } })
          .catch((err: any) => log(`toast err: ${err.message || err}`))
      }
    }
  } catch (e) {}

  log(`loaded (autoInjectContext: ${autoInject})`)

  return {
    "chat.message": async (input: any, output: any) => {
      const role = (output.message as any).role
      if (role !== "user") return
      const text = hasText(output.parts || [])
      if (!text) return
      const sessionId = input?.sessionID
      if (!sessionId) { log("user msg - no sessionId, skipping mine"); return }
      log(`user msg - mine session ${sessionId}`)
      setTimeout(() => mineSingleSession(sessionId), 2000)
    },

    "experimental.chat.messages.transform": async (_input: any, output: any) => {
      if (!autoInject) return
      if (!output?.messages?.length) return

      const lastUser = [...output.messages].reverse().find((m: any) => m.info?.role === "user")
      if (!lastUser) return

      const query = hasText(lastUser.parts || [])
      if (!query) return

      const injectParts: any[] = []

      if (!wakeupDone) {
        wakeupDone = true
        if (identity) {
          injectParts.push({
            id: `mp-identity-${Date.now()}`,
            type: "text",
            synthetic: true,
            text: `[MemPalace Identity]\n${identity}\n[/MemPalace Identity]`,
          })
        }
      }

      const memories = mempalaceSearch(query)
      if (memories) {
        injectParts.push({
          id: `mp-recall-${Date.now()}`,
          type: "text",
          synthetic: true,
          text: `[MemPalace Recall]\n${memories}\n[/MemPalace Recall]`,
        })
      }

      if (injectParts.length > 0) {
        lastUser.parts.push(...injectParts)
        log(`injected ${injectParts.length} context blocks`)
        if (showToast) {
          const parts: string[] = []
          if (injectParts.some(p => String(p.id || "").startsWith("mp-identity"))) parts.push("identité")
          if (injectParts.some(p => String(p.id || "").startsWith("mp-recall"))) parts.push("mémoire")
          showToast(`Injection: ${parts.join(" + ")}`)
        }
      }
    },

    event: async ({ event }: any) => {
      if (event?.type !== "session.idle") return
      log("idle event ignored (mining done per-message)")
    },
  }
}) satisfies Plugin
