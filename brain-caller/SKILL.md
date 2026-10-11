---
name: brain
description: Look things up in, and write sourced facts to, the project brain (the Jive Knowledge Graph) with the brain-caller CLI. Use before answering questions about DAT's code, services, teams, processes, incidents, or decisions, and when you learn something durable worth recording.
---

# Using the brain

The brain holds sourced facts about one project: code structure (from compilers), and what documents, messages, and agents have said about systems, teams, processes, and decisions. Every fact cites its evidence. Facts can be **stale** (their evidence changed since they were written) or **contradicted** by other facts; both stay visible so you can judge.

`brain-caller` prints JSON. Set the connection once per shell:

```bash
export BRAIN_URL=http://127.0.0.1:8787 BRAIN_KEY=$(cat ~/.brain/keys/<your-writer>.key)
```

## Reading

| You want | Command |
|---|---|
| Anything about a topic, by meaning or exact name | `brain-caller search <words…> [--limit n]` |
| Everything about one entity | `brain-caller get-entity <id>` |
| Why a fact is believed; what rests on it; what disputes it | `brain-caller get-fact <id> [--history]` |
| Facts by filter | `brain-caller list-facts [--subject id] [--object id] [--predicate p] [--writer w] [--source-ref r] [--source-ref-prefix p] [--stale-only] [--all]` |
| How things connect (callers, owners, dependencies) | `brain-caller neighbors <id> [--direction out\|in\|both] [--depth 1-3] [--predicate p]…` |

Tips:

- Add `--brief` to `search`, `get-entity`, `get-fact`, `list-facts`, and `neighbors` for one line per fact (`<factId> <subject> | <predicate> | <object or value> [<ref>@<version> <locator>] "<quote>"`, with STALE / DISPUTED / RETRACTED flags). Use JSON when you need every field.
- Start with `search`. `entities` are exact name/alias matches; `facts` are ranked by text and meaning. Each fact view includes `subjectName` and `objectName`.
- `get-entity` returns one fact of each predicate first and `aboutPredicates` counts. When a count is larger than what you see, page with `list-facts --subject <id> --predicate <p> --all`.
- Entity ID conventions: `team/<name>`, `repo/dat/<repo>`, `file/dat/<repo>/<path>`, `service/…`, `system/…`, `topic/<kafka-topic>`, `person/<first-last>`, `process/…`, `incident/…`, `decision/…`, `jira/<KEY-123>`, `doc/confluence-<pageId>`. Code symbols are `scip:scip-typescript npm <package> . <path>/<Symbol>…`.
- Code questions: find the symbol with `search <Name>`; "what calls X" is `neighbors <id> --direction in --predicate code:references`; "where is X defined" is its `code:defined-in` fact (the source `locator` has the line range and `quote` has the line).
- Always cite: each fact's `sources` give `ref` (e.g. `confluence:3440017568`, `git:dat/<repo>:<path>`), `quote`, and `locator`. Mention when a fact is `stale` or has `contradictedBy`.

## Writing

Write only durable, sourced knowledge. One `write` call is one atomic batch:

```bash
brain-caller write batch.json   # or pipe JSON on stdin
```

```json
{
  "rationale": "why you are writing this",
  "entities": [{ "id": "service/one-web-bff", "type": "service", "name": "One Web BFF", "aliases": ["BFF"] }],
  "facts": [{
    "subject": "service/one-web-bff", "predicate": "calls", "object": "repo/dat/freight-posting-service",
    "basis": "imported",
    "sources": [{ "ref": "confluence:2448262143", "version": "2022-04-28", "quote": "exact text from the source", "locator": "section" }]
  }]
}
```

Rules:

- `search` before creating an entity; reuse existing IDs. If two IDs mean the same thing, write a `same-as` fact.
- `basis`: `imported` (stated by the source), `model-inferred` (your conclusion; add `basedOn` the facts it rests on), `human-asserted` (a person told you). `compiler-derived` is reserved for the code indexer.
- Quotes are verbatim. No phone numbers, emails, or addresses.
- When a source changed, call `brain-caller source-changed <ref> <new-version>` before writing facts that cite the new version. Fix your own stale facts: `list-facts --writer <you> --stale-only`.
- Disagreeing with an existing fact? Write your fact with `"contradicts": ["<fact id>"]`. Don't retract other writers' facts (you can't).

## Code

`brain-caller ingest-code <repo-dir> --repo <org>/<repo>` (with a key registered for `compiler-derived`) indexes a git checkout with SCIP and syncs its code facts. Re-run it after commits; unchanged files are skipped and changed files mark dependent facts stale.
