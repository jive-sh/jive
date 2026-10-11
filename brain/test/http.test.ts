import { describe, expect, test } from "bun:test"
import { Context, Effect, Layer } from "effect"
import { HttpServer } from "effect/http"
import { appLayer } from "../src/app.ts"

/** Start the app on an ephemeral port and run `body` against its base URL. */
const withApp = <A>(body: (url: string) => Promise<A>, embedder: "fake" | "local" = "fake"): Promise<A> =>
  Effect.runPromise<A, unknown>(
    Effect.scoped(
      Effect.gen(function* () {
        const ctx = yield* Layer.build(appLayer({ port: 0, hostname: "127.0.0.1", dataDir: "memory://", embedder, adminKey: "admin-secret" }))
        const address = Context.get(ctx, HttpServer.HttpServer).address as unknown as { port: number }
        return yield* Effect.promise(() => body(`http://127.0.0.1:${address.port}`))
      }),
    ) as Effect.Effect<A, unknown, never>,
  )

const post = (url: string, path: string, body: unknown, key?: string) =>
  fetch(`${url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}) },
    body: typeof body === "string" ? body : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }))

describe("http", () => {
  test("auth, errors, admin, round trip, and health", async () => {
    const r = await withApp(async (url) => {
      const noAuth = await post(url, "/v1/search", { text: "x" })
      const adminWithBadKey = await post(url, "/admin/v1/listWriters", {}, "nope")
      const reg = await post(url, "/admin/v1/registerWriter", { writerId: "w1", allowedBases: ["imported"] }, "admin-secret")
      const key = reg.body.apiKey as string
      const badJson = await post(url, "/v1/write", "{not json", key)
      const badShape = await post(url, "/v1/write", { rationale: "x", facts: [{ nope: 1 }] }, key)
      const unknown = await post(url, "/v1/nope", {}, key)
      const written = await post(url, "/v1/write", {
        rationale: "seed",
        entities: [{ id: "customer/acme", type: "customer", name: "Acme", aliases: [] }],
        facts: [{ subject: "customer/acme", predicate: "tier", value: "gold", basis: "imported", sources: [{ ref: "crm:1", version: "1" }] }],
      }, key)
      const entity = await post(url, "/v1/getEntity", { id: "customer/acme" }, key)
      const missing = await post(url, "/v1/getEntity", { id: "customer/none" }, key)
      const health = await fetch(`${url}/health`).then((x) => x.json())
      return { noAuth, adminWithBadKey, reg, badJson, badShape, unknown, written, entity, missing, health }
    })
    expect(r.noAuth).toEqual({ status: 401, body: { error: { code: "UNAUTHENTICATED", message: expect.any(String) } } })
    expect(r.adminWithBadKey.status).toBe(401)
    expect(r.reg.status).toBe(200)
    expect(r.badJson.status).toBe(400)
    expect(r.badJson.body.error.code).toBe("INVALID_INPUT")
    expect(r.badShape.body.error.code).toBe("INVALID_INPUT")
    expect(r.unknown.status).toBe(404)
    expect(r.written.status).toBe(200)
    expect(r.entity.body.about[0].fact.value).toBe("gold")
    expect(r.missing).toEqual({ status: 200, body: null })
    expect(r.health).toEqual({ ok: true, pendingEmbeddings: expect.any(Number) })
  }, 60_000)
})

describe("responsiveness", () => {
  test("requests are served while the embedding worker drains a large backlog", async () => {
    const r = await withApp(async (url) => {
      const reg = await post(url, "/admin/v1/registerWriter", { writerId: "w1", allowedBases: ["imported"] }, "admin-secret")
      const key = reg.body.apiKey as string
      const entities = [{ id: "x/e", type: "x", name: "E", aliases: [] }]
      for (let b = 0; b < 1; b++) {
        await post(url, "/v1/write", {
          rationale: "bulk",
          entities,
          facts: Array.from({ length: 600 }, (_, i) => ({
            subject: "x/e", predicate: `p${b}-${i}`, value: `value ${b} ${i}`, basis: "imported", sources: [{ ref: "s", version: "1" }],
          })),
        }, key)
      }
      await Bun.sleep(3000) // let the worker get into its backlog
      const started = performance.now()
      const health = await fetch(`${url}/health`, { signal: AbortSignal.timeout(5000) }).then((x) => x.json())
      return { ms: performance.now() - started, pending: health.pendingEmbeddings as number }
    }, "local")
    expect(r.pending).toBeGreaterThan(0)
    expect(r.ms).toBeLessThan(1000) // starvation stalls for seconds; 1 s tolerates a loaded machine
  }, 60_000)
})
