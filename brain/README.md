# brain

The Jive Knowledge Graph service: one executable that serves the KnowledgeGraph interface over HTTP and stores sourced facts in Postgres. The design is [`../design-session/2026-10-11-jive-knowledge-graph-design-r4.md`](../design-session/2026-10-11-jive-knowledge-graph-design-r4.md).

The executable contains everything: Postgres with pgvector (PGlite), and the `bge-small-en-v1.5` embedding model with its runtime. It makes no network calls.

## Build

```bash
bun install
bun run build        # fetches the pinned model once, then writes dist/brain
```

`bun test` runs the suite. A Linux image builds from the `Dockerfile`.

## Run

```bash
BRAIN_DATA_DIR=~/.brain/dat ./dist/brain
```

| Variable | Default | Meaning |
|---|---|---|
| `BRAIN_PORT` | `8787` | HTTP port |
| `BRAIN_HOST` | `127.0.0.1` | Bind address (`0.0.0.0` in Docker) |
| `BRAIN_DATA_DIR` | `./.brain-data` | Data directory: database in `pg/`, admin key in `admin.key` |
| `BRAIN_DATABASE_URL` | — | Use an external Postgres with `pgvector` instead of the embedded one |
| `BRAIN_ADMIN_KEY` | generated | Admin key; otherwise generated on first start into `<data dir>/admin.key` (mode 0600) |
| `BRAIN_EMBEDDER` | `local` | `none` turns off embedding (search uses exact names and full text) |

One process serves one project. A second process on the same data directory refuses to start.

## First use

Register writers with the admin key, then give each workflow or agent its own API key:

```bash
ADMIN=$(cat ~/.brain/dat/admin.key)
curl -s -XPOST localhost:8787/admin/v1/registerWriter -H "authorization: Bearer $ADMIN" \
  -d '{"writerId":"workflow/code-indexer","allowedBases":["compiler-derived"]}'
```

Agents normally use [`brain-caller`](../brain-caller) rather than HTTP directly.
