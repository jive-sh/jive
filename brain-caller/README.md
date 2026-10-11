# brain-caller

The agent CLI for the [brain](../brain): every KnowledgeGraph method, admin calls, and `ingest-code` (SCIP code ingestion, with `scip-typescript` bundled). One executable; prints JSON.

```bash
bun install && bun run build      # dist/brain-caller
export BRAIN_URL=http://127.0.0.1:8787 BRAIN_KEY=<api key>
dist/brain-caller search who owns the truck posting service
```

How agents should use it: [SKILL.md](SKILL.md).
