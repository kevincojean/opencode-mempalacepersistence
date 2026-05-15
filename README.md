# opencode-mempalace

Un plugin per OpenCode che salva automaticamente ogni conversazione in MemPalace e usa la memoria per risponderti meglio. In tempo reale, niente cron, niente script esterni.

> **It just works** — installi, usi OpenCode, il plugin fa tutto da solo.

[![MIT License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

---

## Come funziona in 3 secondi

| Senza plugin | Con plugin |
|---|---|
| Ogni sessione parte da zero | Il modello sa chi sei e cosa hai fatto |
| Devi ripetere contesto | La memoria è automatica |
| Niente Knowledge Graph | Decisioni, milestone, problemi tracciati |

Il modello cerca in MemPalace ad ogni domanda (via AGENTS.md + MCP) e il plugin salva ogni risposta. Un ciclo perfetto.

---

## Installazione

### 1. Plugin (salva le conversazioni)

```json
{
  "plugin": ["opencode-mempalace"]
}
```

Aggiungi questa riga al tuo `~/.config/opencode/opencode.json` e riavvia OpenCode.

### 2. Istruzioni per il modello (usa la memoria)

Crea `~/.config/opencode/AGENTS.md`:

```markdown
# Istruzioni di memoria

Prima di rispondere, cerca sempre in MemPalace usando gli strumenti MCP.

1. **Cerca in MemPalace**: Chiama `mempalace_search` con la domanda dell'utente. Prendi i 5-10 risultati più rilevanti.
2. **Cerca nella Knowledge Graph**: Chiama `mempalace_kg_query` per "user". Filtra tenendo solo i fatti che contengono parole chiave della domanda.
3. **Usa il contesto**: Integra le informazioni trovate nella risposta, citando la fonte quando utile.
```

### 3. Identità (chi sei)

Crea `~/.mempalace/identity.txt`:

```
Sono [nome], uno [ruolo]. Lavoro con [tecnologie]. I miei progetti principali sono [progetti].
```

Viene caricata automaticamente ad ogni sessione via `instructions` in opencode.json.

### 4. Configurazione completa

`~/.config/opencode/opencode.json`:

```json
{
  "model": "opencode/deepseek-v4-flash-free",
  "instructions": ["AGENTS.md", "~/.mempalace/identity.txt"],
  "plugin": ["opencode-mempalace"],
  "mcp": {
    "mempalace": {
      "type": "local",
      "command": ["mempalace-mcp"],
      "enabled": true
    }
  }
}
```

### 5. MemPalace (se non lo hai già)

```bash
# Installa
pipx install mempalace

# Crea il palace
mempalace init ~/opencode-memory

# Configura MCP
mempalace mcp
```

Il comando `mempalace mcp` ti darà il comando esatto per il tuo setup.

---

## Cosa succede dopo l'installazione

```
Tu fai una domanda
  → AGENTS.md dice al modello: "cerca in MemPalace prima"
  → Il modello chiama mempalace_search("domanda") via MCP
  → Trova ricordi rilevanti → risponde meglio

Il modello risponde
  → Il plugin opencode-mempalace rileva la risposta completata
  → Salva la conversazione in MemPalace
  → Estrae fatti per la Knowledge Graph

Alla prossima domanda
  → Il modello trova il ricordo di prima → risposta coerente
  → Il ciclo continua, la memoria cresce
```

---

## Cosa viene salvato

Ad ogni turno (domanda + risposta):

- **Testo** categorizzato per wing (developer, creative, emotions, family, consciousness)
- **Knowledge Graph**: fatti estratti automaticamente
  - `decision` → "ho deciso di usare TypeScript"
  - `milestone` → "completato deploy del backend"
  - `problem` → "errore chromadb: ModuleNotFoundError"
  - `preference` → "preferisco Svelte a React"
  - `emotional` → "frustrato con Docker compose"

---

## Architettura interna

```
                 ┌─────────────────────────┐
                 │     OpenCode             │
                 │                          │
  User msg ─────►│  chat.message hook       │
                 │    ↓                     │
                 │  Interroga DB OpenCode   │
                 │  (messaggi dal lastSync) │
                 │    ↓                     │
                 │  Categorizza per wing    │
                 │    ↓                     │
                 │  Exporta delta → tmp     │
                 │    ↓                     │
                 │  mempalace mine          │
                 │    ↓                     │
                 │  Estrai KG facts         │
                 │    ↓                     │
  Session idle ─►│  session.idle hook       │
                 │  (salva ultimo turno)    │
                 └─────────────────────────┘
                            │
                            ▼
                 ┌─────────────────────────┐
                 │     MemPalace            │
                 │  ~/opencode-memory/      │
                 │  Vector DB + KG SQLite   │
                 └─────────────────────────┘
                            ▲
                            │
                 ┌─────────────────────────┐
                 │  AGENTS.md + MCP         │
                 │  Il modello cerca        │
                 │  in MemPalace ad ogni    │
                 │  domanda                 │
                 └─────────────────────────┘
```

---

## File rilevanti

| File | Cosa fa |
|---|---|
| `~/.config/opencode/opencode.json` | Config OpenCode con plugin + MCP + instructions |
| `~/.config/opencode/AGENTS.md` | Dice al modello di cercare in MemPalace |
| `~/.mempalace/identity.txt` | La tua identità (caricata ad ogni sessione) |
| `~/.mempalace/config.json` | Config MemPalace (path palace, wings, keywords) |
| `~/.mempalace/knowledge_graph.sqlite3` | Knowledge Graph (fatti strutturati) |
| `~/opencode-memory/` | Vector DB di MemPalace (tutti i drawer) |
| `~/.mempalace/sync_state.json` | Stato ultimo sync (plugin + script Python) |

---

## From npm

```json
{
  "plugin": ["opencode-mempalace"]
}
```

## Local development

```json
{
  "plugin": ["/path/to/opencode-mempalace/dist/index.js"]
}
```

---

## License

MIT
