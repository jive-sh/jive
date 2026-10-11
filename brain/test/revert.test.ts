import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { revertWriter } from "../src/admin.ts"
import { getFact } from "../src/kg/read.ts"
import { sourceChanged } from "../src/kg/sources.ts"
import { viewsOf } from "../src/kg/views.ts"
import { write } from "../src/kg/write.ts"
import { ent, runDb, src, writer } from "./support.ts"

describe("revertWriter", () => {
  test("restores pre-cutoff revisions, retracts later creations, reverts entities and source reports", async () => {
    const r = await runDb(Effect.gen(function* () {
      const w = yield* writer("w1")
      const other = yield* writer("w2")
      const f1 = (yield* write(w, {
        rationale: "before",
        entities: [ent("customer/acme", "Acme")],
        facts: [{ subject: "customer/acme", predicate: "tier", value: "gold", basis: "imported", sources: [src("crm:acme", "1")] }],
      })).facts[0]!
      const g = (yield* write(other, { rationale: "other", facts: [{ subject: "customer/acme", predicate: "region", value: "west", basis: "imported", sources: [src("crm:acme", "1")] }] })).facts[0]!
      yield* Effect.sleep("20 millis")
      const since = new Date().toISOString()
      yield* Effect.sleep("20 millis")
      yield* write(w, {
        rationale: "after",
        entities: [ent("customer/acme", "ACME Wrong")],
        facts: [
          { id: f1.id, revision: f1.revision, subject: "customer/acme", predicate: "tier", value: "bronze", basis: "imported", sources: [src("crm:acme", "1")] },
          { subject: "customer/acme", predicate: "churned", value: true, basis: "imported", sources: [src("crm:acme", "1")] },
        ],
      })
      yield* sourceChanged(w, { ref: "crm:acme", version: "2" })
      const staleBefore = (yield* viewsOf([g.id]))[0]!.stale
      const result = yield* revertWriter({ writerId: "w1", since })
      const sql = yield* SqlClient.SqlClient
      const created = yield* sql<{ id: string }>`select id from facts where predicate = 'churned'`
      const name = (yield* sql<{ name: string }>`select name from entities where id = 'customer/acme'`)[0]!.name
      const actor = (yield* sql<{ actor: string }>`select actor from writes where kind = 'revertWriter'`)[0]!.actor
      return {
        result,
        f1: (yield* getFact({ id: f1.id }))!.view.fact,
        churned: (yield* getFact({ id: created[0]!.id }))!.view.fact,
        name,
        actor,
        staleBefore,
        staleAfter: (yield* viewsOf([g.id]))[0]!.stale,
      }
    }))
    expect(r.f1.value).toBe("gold")
    expect(r.f1.writer).toBe("w1")
    expect(r.churned.status).toBe("retracted")
    expect(r.churned.retractedReason).toBe("reverted")
    expect(r.name).toBe("Acme")
    expect(r.actor).toBe("admin")
    expect(r.staleBefore).toBe(true)
    expect(r.staleAfter).toBe(false)
    expect(r.result).toEqual({ restoredFacts: 1, retractedFacts: 1, restoredEntities: 1, revertedSourceReports: 1 })
  }, 30_000)
})
