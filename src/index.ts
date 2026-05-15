import { execSync } from "child_process"
import { existsSync, readFileSync, writeFileSync, mkdirSync, rmSync, unlinkSync, rmdirSync } from "fs"
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
const MINE_SCRIPT = "/tmp/oc-mine-query.py"

let lastSyncTime = 0
let pendingSync = false

function runPython(code: string): string {
  writeFileSync(MINE_SCRIPT, code)
  const result = execSync(`${VENV_PYTHON} ${MINE_SCRIPT}`, { encoding: "utf-8", timeout: 30000 }).trim()
  unlinkSync(MINE_SCRIPT)
  return result
}

function queryDB(dbPath: string, sql: string): any[] {
  const safeSql = JSON.stringify(sql)
  const result = runPython(`
import sqlite3, json
db = sqlite3.connect(${JSON.stringify(dbPath)})
r = db.execute(${safeSql}).fetchall()
db.close()
print(json.dumps(r))
`)
  return JSON.parse(result)
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

function isCodeSnippet(text: string): boolean {
  if (!text || text.length < 15) return true
  const codeIndicators = [/^\s*[{}\[\]()]=/, /^\s*(?:if|return|function|def|class|import|const|let|var)\b/, /^\s*\/\//, /^\s*#\s/, /^\s*\*/, /^\s*</]
  if (codeIndicators.some((re) => re.test(text))) return true
  const symbolRatio = (text.match(/[^a-zA-Z0-9\s]/g) || []).length / text.length
  return symbolRatio > 0.3
}

function categorize(text: string): string {
  if (!text) return "developer"
  const lower = text.toLowerCase()
  for (const [wing, keywords] of Object.entries(WING_KEYWORDS)) {
    if (keywords.some((kw) => lower.includes(kw))) return wing
  }
  return "developer"
}

function getLastSyncMs(): number {
  if (!existsSync(STATE_FILE)) return 0
  return JSON.parse(readFileSync(STATE_FILE, "utf-8")).last_sync_ms || 0
}

function saveState(lastSyncMs: number) {
  writeFileSync(STATE_FILE, JSON.stringify({ last_sync_ms: lastSyncMs }))
}

function sync(): void {
  if (pendingSync) return
  pendingSync = true
  try {
    doSync()
  } catch (e) {
    console.error("[opencode-mempalace] sync error:", e)
  } finally {
    pendingSync = false
  }
}

function doSync(): void {
  if (!existsSync(OPENCODE_DB)) return

  const lastSync = getLastSyncMs()

  const maxMsg = queryDB(OPENCODE_DB, "SELECT MAX(m.time_created) FROM message m")
  const maxMsgTs = maxMsg?.[0]?.[0]
  if (!maxMsgTs || maxMsgTs <= lastSync) return

  const sessions = queryDB(
    OPENCODE_DB,
    `SELECT DISTINCT s.id, s.title, p.worktree, s.directory, s.slug, s.time_created, s.time_updated
     FROM session s LEFT JOIN project p ON s.project_id = p.id
     INNER JOIN message m ON m.session_id = s.id
     WHERE m.time_created > ${lastSync}
     ORDER BY s.time_created`,
  ) as any[][]

  if (sessions.length === 0) {
    saveState(maxMsgTs)
    return
  }

  const categories: Record<string, string[]> = {}
  const now = Date.now()

  for (const sess of sessions) {
    const [sessId, title, worktree, directory, slug, tsCreated] = sess
    const label = (slug || "").replace("/", "_") || (sessId || "").slice(0, 12)
    const proj = ((worktree || directory || "/").split("/").filter(Boolean).pop()) || "global"
    const ts = tsCreated ? new Date(tsCreated / 1000).toISOString().slice(0, 19).replace("T", " ") : ""
    const prefix = ts ? `${ts.slice(0, 10)}_${proj}_${(sessId || "").slice(0, 8)}_${label}` : `${proj}_${(sessId || "").slice(0, 8)}_${label}`

    const messages = queryDB(
      OPENCODE_DB,
      `SELECT m.id, m.time_created, m.data FROM message m WHERE m.session_id = ${JSON.stringify(sessId)} ORDER BY m.time_created`,
    ) as any[][]

    const deltaMessages = messages.filter((m) => m[1] > lastSync)
    if (deltaMessages.length === 0) continue

    const bodyLines: string[] = [
      `# ${title || label}`,
      `Date: ${ts || "N/A"}`,
      `Project: ${worktree || directory || "N/A"}`,
      `Session: ${sessId}`,
      "",
    ]

    for (const [msgId, msgTs, msgDataRaw] of deltaMessages) {
      let msgData: any = {}
      try {
        msgData = JSON.parse(msgDataRaw || "{}")
      } catch {}
      const role = msgData.role || "unknown"

      const parts = queryDB(
        OPENCODE_DB,
        `SELECT data FROM part WHERE message_id = ${JSON.stringify(msgId)} ORDER BY time_created`,
      ) as any[][]

      const texts: string[] = []
      for (const [pdataRaw] of parts) {
        try {
          const pdata = JSON.parse(pdataRaw || "{}")
          if (pdata.type === "text" && pdata.text?.trim()) {
            texts.push(pdata.text.trim())
          }
        } catch {}
      }

      if (texts.length === 0) continue

      bodyLines.push(`## ${role.toUpperCase()} — ${msgTs ? new Date(msgTs / 1000).toISOString().slice(11, 19) : ""}`)
      bodyLines.push("")
      bodyLines.push(...texts)
      bodyLines.push("")
    }

    const content = bodyLines.join("\n").trim()
    if (!content) continue

    const wing = categorize(content)
    const contentHash = createHash("sha256").update(content).digest("hex").slice(0, 12)
    const fname = `delta_${prefix}_${contentHash}.txt`
    const wingDir = join(OUT_DIR, wing)
    mkdirSync(wingDir, { recursive: true })
    writeFileSync(join(wingDir, fname), content + "\n")

    if (!categories[wing]) categories[wing] = []
    categories[wing].push(fname)
  }

  if (Object.keys(categories).length === 0) {
    saveState(maxMsgTs)
    return
  }

  for (const [wing, files] of Object.entries(categories)) {
    const wingDir = join(OUT_DIR, wing)
    execSync(`${MEMPALACE_BIN} --palace ${HOME}/opencode-memory mine ${wingDir} --mode convos --extract general --wing ${wing}`, {
      encoding: "utf-8",
      timeout: 120000,
    })
    for (const f of files) {
      rmSync(join(wingDir, f))
    }
    rmdirSync(wingDir)
  }

  extractKG(maxMsgTs)
  saveState(maxMsgTs)
}

function extractKG(sinceTs: number): void {
  try {
  const since = sinceTs ? new Date(sinceTs / 1000).toISOString().slice(0, 10) : "2026-01-01"

  const raw = runPython(`
from mempalace.config import MempalaceConfig
import chromadb, json, re
config = MempalaceConfig()
client = chromadb.PersistentClient(path=config.palace_path)
collection = client.get_collection(config.collection_name)
docs = collection.get(limit=5000, include=["metadatas", "documents"])
result = []
for did, meta, doc in zip(docs.get("ids",[]), docs.get("metadatas",[]), docs.get("documents",[])):
    if not meta or not doc: continue
    room = meta.get("room","") or ""
    if room not in ("decision","milestone","problem","preference","emotional"): continue
    date = doc.split("Date: ")[1][:10] if "Date: " in doc else ""
    if not date: continue
    if date < ${JSON.stringify(since)}: continue
    lower = doc.lower()
    patterns = ${JSON.stringify(KG_PATTERNS)}
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
    for (const [subj, pred, obj] of rows) {
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
    inserts.push(`INSERT OR IGNORE INTO triples (id, subject, predicate, object, valid_from, confidence, extracted_at)
VALUES ('${id}', 'user', '${f.type}', '${safeText}', '${f.date}', 1.0, datetime('now'))`)
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
print("OK")
`)
  } catch (e) {
    console.error("[opencode-mempalace] KG error:", e)
  }
}

export default (async () => {
  // Ensure OUT_DIR exists
  mkdirSync(OUT_DIR, { recursive: true })

  return {
    "chat.message": async () => {
      const now = Date.now()
      if (now - lastSyncTime < 5000) return
      lastSyncTime = now
      sync()
    },
  }
}) satisfies Plugin
