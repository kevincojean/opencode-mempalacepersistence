import { execSync } from "child_process"
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, rmdirSync, unlinkSync, appendFileSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import { createHash } from "crypto"
import type { Plugin } from "@opencode-ai/plugin"

const HOME = homedir()
const VENV_PYTHON = join(HOME, ".local/share/pipx/venvs/mempalace/bin/python3")
const MEMPALACE_BIN = join(HOME, ".local/bin/mempalace")
const OPENCODE_DB = join(HOME, ".local/share/opencode/opencode.db")
const STATE_FILE = join(HOME, ".mempalace/sync_state.json")
const KG_DB = join(HOME, ".mempalace/knowledge_graph.sqlite3")
const OUT_DIR = "/tmp/oc-sessions"
const TMP_SCRIPT = "/tmp/oc-plugin-query.py"
const LOG_FILE = "/tmp/opencode-mempalace.log"

function log(msg: string) {
  const ts = new Date().toISOString()
  try { appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`) } catch {}
}

let pendingSync = false
let turnBuffer: Array<{ role: string; text: string }> = []
let currentSessionId = ""
let lastUserTs = 0
let lastSyncTs = 0

function runPython(code: string): string {
  writeFileSync(TMP_SCRIPT, code)
  try {
    return execSync(`${VENV_PYTHON} ${TMP_SCRIPT}`, { encoding: "utf-8", timeout: 30000 }).trim()
  } finally {
    unlinkSync(TMP_SCRIPT)
  }
}

const WING_KEYWORDS: Record<string, string[]> = {
  creative: ["eurovision", "music", "art", "film", "game", "festival", "song", "concert"],
  family: ["family", "kid", "son", "daughter", "wife", "husband", "parent", "mother", "father"],
  emotions: ["feel", "happy", "sad", "love", "hate", "angry", "fear", "anxiety", "grateful"],
  consciousness: ["think", "mind", "conscious", "self", "identity", "exist", "meaning"],
}

const KG_PATTERNS: Record<string, string[]> = {
  decision: ["ho deciso", "ho scelto", "implementato", "added ", "ho aggiunto", "decided", "chosen", "created", "creato", "modified"],
  milestone: ["completato", "finito", "rilasciato", "deployato", "ho completato", "successo", "funziona", "completed", "done", "deployed"],
  problem: ["problema", "bug", "errore", "issue", "fix", "fixato", "risolto", "solved", "fixed", "error"],
  preference: ["preferisco", "mi piace", "non mi piace", "prefer", "like to", "better"],
  emotional: ["sentimento", "emozione", "frustrato", "contento", "happy", "sad", "feel", "emotion"],
}

function categorize(text: string): string {
  if (!text) return "developer"
  const lower = text.toLowerCase()
  for (const [wing, keywords] of Object.entries(WING_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) return wing
  }
  return "developer"
}

function hasText(parts: any[]): string {
  return parts
    .filter((p: any) => p?.type === "text" && p?.text?.trim())
    .map((p: any) => p.text.trim())
    .join("\n")
}

function formatTurn(): string {
  const lines: string[] = [
    `# OpenCode session`,
    `Date: ${new Date().toISOString().slice(0, 10)}`,
    `Session: ${currentSessionId || "unknown"}`,
    "",
  ]
  for (const e of turnBuffer) {
    lines.push(`## ${e.role.toUpperCase()}`)
    lines.push("")
    lines.push(e.text)
    lines.push("")
  }
  return lines.join("\n").trim()
}

function getAsstText(sessionId: string, sinceMs: number): string {
  const result = runPython(`
import sqlite3, json
db = sqlite3.connect(${JSON.stringify(OPENCODE_DB)})
rows = db.execute("""
  SELECT p.data FROM message m
  JOIN part p ON p.message_id = m.id
  WHERE m.session_id = ? AND m.time_created > ?
  ORDER BY m.time_created
""", (${JSON.stringify(sessionId)}, ${sinceMs})).fetchall()
db.close()
texts = []
for (row,) in rows:
    try:
        pdata = json.loads(row)
        if pdata.get("type") == "text" and pdata.get("text","").strip():
            texts.append(pdata.get("text","").strip())
    except: pass
print(json.dumps(texts))
`)
  try {
    return JSON.parse(result).filter((t: string) => t).join("\n")
  } catch {
    return ""
  }
}

function doSync(): void {
  if (turnBuffer.length < 2) {
    log(`sync skip: buffer too short (${turnBuffer.length})`)
    return
  }
  if (lastSyncTs && Date.now() - lastSyncTs < 3000) {
    log(`sync skip: debounce`)
    return
  }

  const content = formatTurn()
  if (!content) { log("sync skip: empty"); return }

  const contentHash = createHash("sha256").update(content).digest("hex").slice(0, 12)
  const wing = categorize(content)
  const prefix = new Date().toISOString().slice(0, 10)
  const fname = `turn_${prefix}_${contentHash}.txt`
  const wingDir = join(OUT_DIR, wing)

  try {
    mkdirSync(wingDir, { recursive: true })
    writeFileSync(join(wingDir, fname), content + "\n")
    log(`exported ${fname} -> ${wing}`)

    execSync(
      `${MEMPALACE_BIN} --palace ${HOME}/opencode-memory mine ${wingDir} --mode convos --extract general --wing ${wing}`,
      { encoding: "utf-8", timeout: 120000 },
    )
    log(`mined ${wing}`)

    rmSync(join(wingDir, fname))
    rmdirSync(wingDir)
  } catch (e: any) {
    log(`mine error: ${e.message || e}`)
    return
  }

  writeFileSync(STATE_FILE, JSON.stringify({ last_sync_ms: Date.now() }))
  lastSyncTs = Date.now()
  log("sync done")

  // KG extraction
  try {
    const raw = runPython(`
from mempalace.config import MempalaceConfig
import chromadb, json, re
config = MempalaceConfig()
client = chromadb.PersistentClient(path=config.palace_path)
collection = client.get_collection(config.collection_name)
docs = collection.get(limit=5000, include=["metadatas", "documents"])
patterns = ${JSON.stringify(KG_PATTERNS)}
result = []
for did, meta, doc in zip(docs.get("ids",[]), docs.get("metadatas",[]), docs.get("documents",[])):
    if not meta or not doc: continue
    room = meta.get("room","") or ""
    if room not in ("decision","milestone","problem","preference","emotional"): continue
    date = doc.split("Date: ")[1][:10] if "Date: " in doc else ""
    if not date: continue
    lower = doc.lower()
    room_patterns = patterns.get(room, [])
    if not any(pat in lower for pat in room_patterns): continue
    snippet = ""
    for line in doc.strip().split("\\n")[:5]:
        line = line.strip()
        if line and not line.startswith("#") and not line.startswith("//") and not re.match(r"^\\d+\\.", line):
            if len(line) > 20 and len(re.findall(r"[^a-zA-Z0-9\\s]", line)) / len(line) <= 0.3:
                snippet = line[:120]
                break
    if snippet:
        result.append([date, room, snippet])
print(json.dumps(result))
`)
    const newFacts: Array<{ date: string; type: string; text: string }> = []
    try { newFacts.push(...JSON.parse(raw).map((r: any[]) => ({ date: r[0], type: r[1], text: r[2] }))) } catch {}
    if (newFacts.length > 0) {
      const existing = runPython(`
import sqlite3, json
db = sqlite3.connect(${JSON.stringify(KG_DB)})
rows = db.execute("SELECT subject, predicate, object FROM triples WHERE subject='user'").fetchall()
db.close()
print(json.dumps(rows))
`)
      const seen = new Set<string>()
      try { for (const [, p, o] of JSON.parse(existing)) seen.add(`${p}::${o}`) } catch {}
      const inserts: string[] = []
      for (const f of newFacts) {
        const key = `${f.type}::${f.text}`
        if (seen.has(key)) continue
        seen.add(key)
        const id = `t_user_${f.type}_${createHash("sha256").update(f.text).digest("hex").slice(0, 12)}`
        const t = f.text.replace(/'/g, "''")
        inserts.push(`INSERT OR IGNORE INTO triples (id, subject, predicate, object, valid_from, confidence, extracted_at) VALUES ('${id}', 'user', '${f.type}', '${t}', '${f.date}', 1.0, datetime('now'))`)
      }
      if (inserts.length > 0) {
        runPython(`
import sqlite3
db = sqlite3.connect(${JSON.stringify(KG_DB)})
for sql in ${JSON.stringify(inserts)}:
    try: db.execute(sql)
    except: pass
db.commit()
db.close()
`)
        log(`kg: ${inserts.length} new facts`)
      } else {
        log("kg: all facts already exist")
      }
    }
  } catch (e: any) {
    log(`kg error: ${e.message || e}`)
  }
}

export default (async () => {
  mkdirSync(OUT_DIR, { recursive: true })
  log("Plugin loaded — event-based")

  return {
    "chat.message": async (_input, output) => {
      const role = (output.message as any).role
      if (role !== "user") return

      const text = hasText(output.parts || [])
      if (!text) return

      log(`user message (${text.length} chars)`)

      if (turnBuffer.length >= 2) doSync()
      turnBuffer = [{ role: "user", text }]
      currentSessionId = (output.message as any).sessionID || ""
      lastUserTs = Date.now()
    },

    event: async ({ event }: any) => {
      if (event?.type !== "message.updated") return
      const info = event.properties?.info
      if (!info || info.role !== "assistant") return
      if (!info.time?.completed && !info.finish) return

      log(`assistant completed`)

      if (!currentSessionId || !lastUserTs) return

      const asstText = getAsstText(currentSessionId, lastUserTs)
      if (!asstText) { log("no asst text found in db"); return }

      turnBuffer.push({ role: "assistant", text: asstText })
      log(`asst text: ${asstText.length} chars, buffer=${turnBuffer.length}`)

      if (turnBuffer.length >= 2) doSync()
    },
  }
}) satisfies Plugin
