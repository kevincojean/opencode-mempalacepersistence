import { execSync, exec } from "child_process"
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
const DEBUG = !!process.env.OPENCODE_MEMPALACE_DEBUG
const LOG_FILE = "/tmp/opencode-mempalace.log"

function log(msg: string) {
  if (!DEBUG) return
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
  try { doDbSync() } catch (e) { log("sync err: " + String(e)) }
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
  try { sessionsArr = JSON.parse(sessions) } catch { pendingSync = false; return }
  if (!sessionsArr || sessionsArr.length === 0) { pendingSync = false; return }

  const now = Date.now()
  const exported: Array<{ wing: string; fname: string; dir: string }> = []

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

    exported.push({ wing, fname, dir: wingDir })
  }

  if (exported.length === 0) { pendingSync = false; return }

  // Save state immediately so next sync doesn't re-process
  writeFileSync(STATE_FILE, JSON.stringify({ last_sync_ms: now }))
  lastSyncTs = Date.now()
  pendingSync = false
  log(`queued ${exported.length} files for mining`)

  // Mining async (fire-and-forget, non-blocking)
  for (const { wing, fname, dir: wingDir } of exported) {
    const filePath = join(wingDir, fname)
    exec(`${MEMPALACE_BIN} mine ${wingDir} --mode convos --extract general --wing ${wing}`, {
      encoding: "utf-8",
      timeout: 120000,
    }, (err) => {
      if (err) { log(`mine err ${wing}: ${err.message}`); return }
      rmSync(filePath)
      try { rmdirSync(wingDir) } catch {}
      log(`mined ${wing}`)
      // KG extraction after mining
      try {
        const raw = runPython(`
from mempalace.config import MempalaceConfig
import chromadb, json, re
c = MempalaceConfig()
col = chromadb.PersistentClient(path=c.palace_path).get_collection(c.collection_name)
d = col.get(limit=5000, include=["metadatas","documents"])
p = ${JSON.stringify(KG_PATTERNS)}
r = []
for i,m,doc in zip(d.get("ids",[]), d.get("metadatas",[]), d.get("documents",[])):
  if not m or not doc: continue
  rm = m.get("room","")
  if rm not in ("decision","milestone","problem","preference","emotional"): continue
  da = doc.split("Date: ")[1][:10] if "Date: " in doc else ""
  if not da: continue
  if not any(pat in doc.lower() for pat in p.get(rm,[])): continue
  for ln in doc.strip().split("\\n")[:5]:
    l = ln.strip()
    if l and not l.startswith("#") and len(l) > 20 and len(re.findall(r"[^a-zA-Z0-9\\s]", l))/len(l) <= 0.3:
      r.append([da, rm, l[:120]]); break
print(json.dumps(r))
`)
        const nf: any[] = JSON.parse(raw) || []
        if (nf.length > 0) {
          const ex = runPython(`import sqlite3,json;d=sqlite3.connect(${JSON.stringify(KG_DB)});r=d.execute("SELECT predicate,object FROM triples WHERE subject='user'").fetchall();d.close();print(json.dumps(r))`)
          const seen = new Set<string>()
          try { for (const [p, o] of JSON.parse(ex)) seen.add(p+"::"+o) } catch {}
          const ins: string[] = []
          for (const [d, t, x] of nf) {
            const k = t+"::"+x
            if (seen.has(k)) continue
            seen.add(k)
            ins.push(`INSERT OR IGNORE INTO triples(id,subject,predicate,object,valid_from,confidence,extracted_at) VALUES('t_user_${t}_${createHash("sha256").update(x).digest("hex").slice(0,12)}','user','${t}','${x.replace(/'/g,"''")}','${d}',1.0,datetime('now'))`)
          }
          if (ins.length > 0) {
            runPython(`import sqlite3;db=sqlite3.connect(${JSON.stringify(KG_DB)});[db.execute(s) for s in ${JSON.stringify(ins)}];db.commit();db.close()`)
          }
        }
      } catch {}
    })
  }
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
