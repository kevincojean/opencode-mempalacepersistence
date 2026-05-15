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

function getLastSync(): number {
  if (!existsSync(STATE_FILE)) return 0
  try { return JSON.parse(readFileSync(STATE_FILE, "utf-8")).last_sync_ms || 0 } catch { return 0 }
}

function dbSync(): void {
  if (pendingSync) return
  pendingSync = true
  try { doDbSync(); log("sync ok") } catch (e) { log("sync err: " + String(e)) }
  finally { pendingSync = false }
}

function doDbSync(): void {
  if (lastSyncTs && Date.now() - lastSyncTs < 5000) return

  const lastSync = getLastSync()

  const sessions = runPython(`
import sqlite3, json
db = sqlite3.connect(${JSON.stringify(OPENCODE_DB)})
rows = db.execute("""
  SELECT DISTINCT s.id, s.title, p.worktree, s.directory, s.slug, s.time_created
  FROM session s
  LEFT JOIN project p ON s.project_id = p.id
  INNER JOIN message m ON m.session_id = s.id
  WHERE m.time_created > ${lastSync}
  ORDER BY s.time_created
""").fetchall()
db.close()
print(json.dumps(rows))
`)

  let sessionsArr: any[][]
  try { sessionsArr = JSON.parse(sessions) } catch { return }
  if (!sessionsArr || sessionsArr.length === 0) return

// no-op

  const now = Date.now()
  const exported: Array<{ wing: string; fname: string }> = []

  for (const sess of sessionsArr) {
    const [sessId, title, worktree, directory] = sess
    const label = (title || "").replace(/[^a-zA-Z0-9 _-]/g, "_") || (sessId || "").slice(0, 12)
    const prefix = `${new Date().toISOString().slice(0, 10)}_${label.slice(0, 30)}_${(sessId || "").slice(0, 8)}`

    const msgs = runPython(`
import sqlite3, json
db = sqlite3.connect(${JSON.stringify(OPENCODE_DB)})
rows = db.execute("""
  SELECT m.id, m.time_created, m.data FROM message m
  WHERE m.session_id = ${JSON.stringify(sessId)} AND m.time_created > ${lastSync}
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
    try { msgList = JSON.parse(msgs) } catch { continue }
    if (msgList.length < 2) continue

    const lines: string[] = [
      `# ${title || label}`,
      `Date: ${new Date().toISOString().slice(0, 10)}`,
      `Session: ${sessId}`,
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
    if (!content) continue

    const wing = categorize(content)
    const contentHash = createHash("sha256").update(content).digest("hex").slice(0, 12)
    const fname = `sync_${prefix}_${contentHash}.txt`
    const wingDir = join(OUT_DIR, wing)
    mkdirSync(wingDir, { recursive: true })
    writeFileSync(join(wingDir, fname), content + "\n")
  // no-op

    exported.push({ wing, fname })
  }

  if (exported.length === 0) return

  for (const { wing, fname } of exported) {
    const wingDir = join(OUT_DIR, wing)
    try {
      execSync(
        `${MEMPALACE_BIN} mine ${wingDir} --mode convos --extract general --wing ${wing}`,
        { encoding: "utf-8", timeout: 120000 },
      )
// no-op
      rmSync(join(wingDir, fname))
    } catch (_e2) { log("mine err: " + String(_e2)) }
    try { rmdirSync(wingDir) } catch {}
  }

  writeFileSync(STATE_FILE, JSON.stringify({ last_sync_ms: now }))
  lastSyncTs = Date.now()
// no-op

  // KG
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
    if not any(pat in lower for pat in patterns.get(room,[])): continue
    snippet = ""
    for line in doc.strip().split("\\n")[:5]:
        line = line.strip()
        if line and not line.startswith("#") and not line.startswith("//") and not re.match(r"^\\d+\\.", line):
            if len(line) > 20 and len(re.findall(r"[^a-zA-Z0-9\\s]", line)) / len(line) <= 0.3:
                snippet = line[:120]
                break
    if snippet: result.append([date, room, snippet])
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
// no-op
      } else {}/* no new */
    }
  } catch (_e3) { log("kg err: " + String(_e3)) }
}

export default (async () => {
  mkdirSync(OUT_DIR, { recursive: true })
log("loaded")

  return {
    "chat.message": async (_input, output) => {
      const role = (output.message as any).role
      if (role !== "user") return
      const text = hasText(output.parts || [])
      if (!text) return

log("user msg - queue sync")
      setTimeout(() => dbSync(), 500)
    },

    event: async ({ event }: any) => {
      if (event?.type !== "session.idle") return
log("idle - queue sync")
      setTimeout(() => dbSync(), 3000)
    },
  }
}) satisfies Plugin
