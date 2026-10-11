import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { cli, startBrain, type TestBrain } from "./support.ts"

let brain: TestBrain
let env: Record<string, string>
beforeAll(async () => {
  brain = await startBrain()
  env = { BRAIN_URL: brain.url, BRAIN_KEY: await brain.register("claude/test") }
}, 60_000)
afterAll(() => brain.stop())

const batch = {
  rationale: "seed",
  entities: [{ id: "service/rate-engine", type: "service", name: "Rate Engine", aliases: ["RE"] }],
  facts: Array.from({ length: 3 }, (_, i) => ({
    subject: "service/rate-engine", predicate: `p${i}`, value: `v${i}`, basis: "imported", sources: [{ ref: "doc:1", version: "1" }],
  })),
}

describe("brain-caller", () => {
  test("write reads a batch from stdin and prints the result as JSON", async () => {
    const r = await cli(["write"], env, JSON.stringify(batch))
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout).facts).toHaveLength(3)
  }, 30_000)

  test("search joins its words and returns entities and facts", async () => {
    const r = await cli(["search", "RE"], env)
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout).entities.map((e: { id: string }) => e.id)).toEqual(["service/rate-engine"])
  }, 30_000)

  test("get-entity prints the entity with its facts", async () => {
    const r = await cli(["get-entity", "service/rate-engine"], env)
    expect(JSON.parse(r.stdout).about).toHaveLength(3)
  }, 30_000)

  test("list-facts --all follows cursors", async () => {
    const r = await cli(["list-facts", "--subject", "service/rate-engine", "--limit", "1", "--all"], env)
    expect(r.code).toBe(0)
    expect(JSON.parse(r.stdout).items).toHaveLength(3)
  }, 30_000)

  test("errors print the service's error JSON on stderr and exit 1", async () => {
    const r = await cli(["write"], env, JSON.stringify({ rationale: "bad", facts: [{ subject: "nobody/x", predicate: "p", value: 1, basis: "imported", sources: [{ ref: "a", version: "1" }] }] }))
    expect(r.code).toBe(1)
    expect(JSON.parse(r.stderr).error.code).toBe("INVALID_INPUT")
  }, 30_000)

  test("a bad key is reported as UNAUTHENTICATED", async () => {
    const r = await cli(["search", "x"], { ...env, BRAIN_KEY: "wrong" })
    expect(r.code).toBe(1)
    expect(JSON.parse(r.stderr).error.code).toBe("UNAUTHENTICATED")
  }, 30_000)

  test("admin list-writers uses the admin key", async () => {
    const r = await cli(["admin", "list-writers"], { ...env, BRAIN_ADMIN_KEY: brain.adminKey })
    expect(JSON.parse(r.stdout).map((w: { writerId: string }) => w.writerId)).toContain("claude/test")
  }, 30_000)
})

describe("transport errors", () => {
  test("a non-JSON error response is reported as JSON with a code, not [object Object]", async () => {
    const server = Bun.serve({ port: 0, fetch: () => new Response("<html>bad gateway</html>", { status: 502 }) })
    const r = await cli(["search", "x"], { BRAIN_URL: `http://127.0.0.1:${server.port}`, BRAIN_KEY: "k" })
    server.stop()
    expect(r.code).toBe(1)
    const err = JSON.parse(r.stderr).error
    expect(err.code).toBe("INTERNAL")
    expect(err.message).toContain("bad gateway")
  }, 30_000)
})

describe("--brief", () => {
  test("search --brief prints one line per entity and fact", async () => {
    const r = await cli(["search", "RE", "--brief"], env)
    expect(r.code).toBe(0)
    const lines = r.stdout.trim().split("\n")
    expect(lines[0]).toBe("entity service/rate-engine (service) Rate Engine; aliases: RE")
  }, 30_000)

  test("get-entity --brief prints the entity, predicate counts, and one line per fact with its id and source", async () => {
    const r = await cli(["get-entity", "service/rate-engine", "--brief"], env)
    const lines = r.stdout.trim().split("\n")
    expect(lines[0]).toBe("entity service/rate-engine (service) Rate Engine; aliases: RE")
    expect(lines[1]).toMatch(/^about: p\d=1, p\d=1, p\d=1$/)
    expect(lines.some((l) => /^f_\S+ Rate Engine \| p0 \| v0 \[doc:1@1\]$/.test(l))).toBe(true)
  }, 30_000)
})

describe("write --dry-run", () => {
  test("validates a batch without writing it", async () => {
    const dry = { rationale: "dry", entities: [{ id: "service/dry-run-only", type: "service", name: "Dry", aliases: [] }] }
    const r = await cli(["write", "--dry-run"], env, JSON.stringify(dry))
    expect(JSON.parse(r.stdout).dryRun).toBe(true)
    const after = await cli(["get-entity", "service/dry-run-only"], env)
    expect(after.stdout.trim()).toBe("null")
  }, 30_000)
})
