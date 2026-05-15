import { execSync } from "child_process"
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, rmdirSync, unlinkSync } from "fs"
import { homedir } from "os"
import { join } from "path"
import { createHash } from "crypto"
import type { Plugin } from "@opencode-ai/plugin"

const HOME = homedir()
const VENV_PYTHON = join(HOME, ".local/share/pipx/venvs/mempalace/bin/python3")
const MEMPALACE_BIN = join(HOME, ".local/bin/mempalace")
const STATE_FILE = join(HOME, ".mempalace/sync_state.json")
const KG_DB = join(HOME, ".mempalace/knowledge_graph.sqlite3")
const OUT_DIR = "/tmp/oc-sessions"
const TMP_SCRIPT = "/tmp/oc-plugin-query.py"

let lastSyncTime = 0
let pendingSync = false
let turnBuffer: Array<{ role: string; text: string; ts: number }> = []
let currentSessionId = ""
let currentTitle = ""
let lastUserTs = 0

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

function extractText(parts: any[]): string {
  return parts
    .filter((p: any) => p.type === "text" && "text" in p && p.text?.trim())
    .map((p: any) => p.text.trim())
    .join("\n")
}

function formatTurn(entries: Array<{ role: string; text: string; ts: number }>): string {
  const lines: string[] = [
    `# ${currentTitle || "OpenCode session"}`,
    `Session: ${currentSessionId || "unknown"}`,
    "",
  ]
  for (const e of entries) {
    const ts = e.ts ? new Date(e.ts).toISOString().slice(11, 19) : ""
    lines.push(`## ${e.role.toUpperCase()} — ${ts}`)
    lines.push("")
    lines.push(e.text)
    lines.push("")
  }
  return lines.join("\n").trim()
}

function getLastSyncMs(): number {
  if (!existsSync(STATE_FILE)) return 0
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf-8")).last_sync_ms || 0
  } catch {
    return 0
  }
}

function saveState(lastSyncMs: number) {
  writeFileSync(STATE_FILE, JSON.stringify({ last_sync_ms: lastSyncMs }))
}

function syncTurn(): void {
  if (pendingSync || turnBuffer.length < 2) return
  pendingSync = true
  try {
    doSyncTurn()
  } catch (e) {
    console.error("[opencode-mempalace] sync error:", e)
  } finally {
    pendingSync = false
  }
}

function doSyncTurn(): void {
  const content = formatTurn(turnBuffer)
  if (!content) return

  const contentHash = createHash("sha256").update(content).digest("hex").slice(0, 12)
  const wing = categorize(content)
  const prefix = new Date().toISOString().slice(0, 10) + "_global_turn"
  const fname = `turn_${prefix}_${contentHash}.txt`
  const wingDir = join(OUT_DIR, wing)
  mkdirSync(wingDir, { recursive: true })
  writeFileSync(join(wingDir, fname), content + "\n")

  execSync(
    `${MEMPALACE_BIN} --palace ${HOME}/opencode-memory mine ${wingDir} --mode convos --extract general --wing ${wing}`,
    { encoding: "utf-8", timeout: 120000 },
  )

  rmSync(join(wingDir, fname))
  rmdirSync(wingDir)

  saveState(Date.now())
  extractKG()
}

function extractKG(): void {
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
    matched = False
    for pat in room_patterns:
        if pat in lower:
            matched = True
            break
    if not matched: continue
    snippet = ""
    for line in doc.strip().split("\\n")[:5]:
        line = line.strip()
        if line and not line.startswith("#") and not line.startswith("//") and not re.match(r"^\d+\\.", line):
            if len(line) > 20 and len(re.findall(r"[^a-zA-Z0-9\\s]", line)) / len(line) <= 0.3:
                snippet = line[:120]
                break
    if snippet:
        result.append([date, room, snippet])
print(json.dumps(result))
`)

    let newFacts: Array<{ date: string; type: string; text: string }> = []
    try {
      newFacts = JSON.parse(raw).map((r: any[]) => ({ date: r[0], type: r[1], text: r[2] }))
    } catch {
      return
    }

    if (newFacts.length === 0) return

    const existing = runPython(`
import sqlite3, json
db = sqlite3.connect(${JSON.stringify(KG_DB)})
rows = db.execute("SELECT subject, predicate, object FROM triples WHERE subject='user'").fetchall()
db.close()
print(json.dumps(rows))
`)

    let existingSet = new Set<string>()
    try {
      const rows: any[][] = JSON.parse(existing)
      for (const [, pred, obj] of rows) {
        existingSet.add(`${pred}::${obj}`)
      }
    } catch {}

    const inserts: string[] = []
    for (const f of newFacts) {
      const key = `${f.type}::${f.text}`
      if (existingSet.has(key)) continue
      existingSet.add(key)
      const id = `t_user_${f.type}_${createHash("sha256").update(f.text).digest("hex").slice(0, 12)}`
      const safeText = f.text.replace(/'/g, "''")
      inserts.push(
        `INSERT OR IGNORE INTO triples (id, subject, predicate, object, valid_from, confidence, extracted_at)
VALUES ('${id}', 'user', '${f.type}', '${safeText}', '${f.date}', 1.0, datetime('now'))`,
      )
    }

    if (inserts.length === 0) return

    runPython(`
import sqlite3
db = sqlite3.connect(${JSON.stringify(KG_DB)})
for sql in ${JSON.stringify(inserts)}:
    try:
        db.execute(sql)
    except: pass
db.commit()
db.close()
`)
  } catch (e) {
    console.error("[opencode-mempalace] KG error:", e)
  }
}

export default (async () => {
  mkdirSync(OUT_DIR, { recursive: true })

  return {
    "chat.message": async (_input, output) => {
      const role = output.message.role
      if (role !== "user" && role !== "assistant") return

      const text = extractText(output.parts)
      if (!text) return

      if (role === "user") {
        if (turnBuffer.length > 0) {
          syncTurn()
        }
        turnBuffer.length = 0
        currentSessionId = output.message.sessionID
        currentTitle = (output.message as any).summary?.title || currentTitle
        lastUserTs = (output.message as any).time?.created || Date.now()
      }

      turnBuffer.push({ role, text, ts: Date.now() })
    },
  }
}) satisfies Plugin
