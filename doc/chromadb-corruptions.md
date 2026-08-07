# Warning: Do Not Use ChromaDB with MemPalace for Opencode

**ChromaDB is MemPalace's default vector store. It corrupts its search index immediately when driven by an OpenCode plugin, which renders MemPalace completely useless.**

Use **Qdrant** as the MemPalace backend instead. This project works well with Qdrant. It does not work with ChromaDB.

---

## Why ChromaDB breaks with OpenCode

ChromaDB stores your memories in two layers that must stay in sync:

- **SQLite** - your actual text. Every write lands here immediately and permanently.
- **The HNSW vector index** - what search actually reads. It is only written to disk once every 1000 writes (`sync_threshold` default). Everything before that point lives in memory only.

An OpenCode plugin writes memories in tiny bursts - 1-3 drawers per hook call - and then the process exits. The write count never gets anywhere near 1000, so **the vector index is never persisted to disk**. What happens over time:

1. **Session 1**: 3 memories written. SQLite has them. The HNSW index does not. Search finds nothing, but nothing looks wrong yet.
2. **Every session after**: same pattern. SQLite grows. The on-disk index stays stale or empty.
3. **The gap widens**: `mempalace search` now returns nothing for memories you know exist. ChromaDB reports the index is out of sync with SQLite (e.g. *"HNSW index holds 50,003 elements but SQLite has 199,426 embeddings"* - 75% of memories invisible to search).
4. **Things start hanging**: once the index and SQLite diverge badly, ChromaDB freezes or crashes trying to reconcile them. `mempalace mine` hangs. Searches hang. The palace is now **completely unusable**.
5. **Recovery is expensive**: the only fix is `mempalace repair`, which re-embeds every document from scratch - **hours of repair** - and even then, repairs can produce an index ChromaDB itself cannot load.

## What to do

1. **Set MemPalace to Qdrant**: `backend: qdrant`, `qdrant_url: http://localhost:6333` in `~/.mempalace/config.json` (MemPalace 3.6.0+ ships the Qdrant backend built-in)
2. Run Qdrant in Docker: `docker run -d --name mempalace-qdrant -p 6333:6333 -v ~/.mempalace/qdrant_storage:/qdrant/storage qdrant/qdrant`
3. If migrating an existing ChromaDB palace, keep `chroma.sqlite3` as a backup until the Qdrant palace is verified

**ChromaDB is fine for prototypes. For a memory system you rely on daily, it will corrupt and eat your data. Use Qdrant.**
