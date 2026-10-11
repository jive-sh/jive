import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cli, startBrain, type TestBrain } from "./support.ts"

let brain: TestBrain
let env: Record<string, string>
let other: Record<string, string>
let repo: string
const git = (...args: string[]) => Bun.$`git -C ${repo} -c user.name=t -c user.email=t@t ${args}`.quiet()

beforeAll(async () => {
  brain = await startBrain()
  env = { BRAIN_URL: brain.url, BRAIN_KEY: await brain.register("workflow/code-indexer", ["compiler-derived"]) }
  other = { BRAIN_URL: brain.url, BRAIN_KEY: await brain.register("claude/reader", ["human-asserted"]) }
  repo = mkdtempSync(join(tmpdir(), "ingest-repo-"))
  cpSync(`${import.meta.dir}/fixtures/sample`, repo, { recursive: true, filter: (p) => !p.endsWith("index.scip") })
  await Bun.$`git -C ${repo} init -q`
  await git("add", "-A")
  await git("commit", "-qm", "init")
}, 60_000)
afterAll(async () => {
  await brain.stop()
  rmSync(repo, { recursive: true, force: true })
})

const ingest = async (...extra: string[]) => {
  const r = await cli(["ingest-code", repo, "--repo", "dat/sample", ...extra], env)
  if (r.code !== 0) throw new Error(r.stderr)
  return JSON.parse(r.stdout)
}

describe("ingest-code", () => {
  test("first run creates facts; a second run on the same commit writes nothing", async () => {
    const first = await ingest()
    expect(first.facts.created).toBeGreaterThan(10)
    expect(first.facts.updated + first.facts.retracted).toBe(0)
    const second = await ingest()
    expect(second.facts).toEqual({ desired: first.facts.desired, created: 0, updated: 0, retracted: 0, unchanged: first.facts.desired })
    expect(second.sourceChanged).toBe(0)
    expect(second.batches).toBe(0)
  }, 120_000)

  test("editing a file reports it changed, updates its facts, and makes other writers' facts on it stale", async () => {
    const blob = (await Bun.$`git -C ${repo} rev-parse HEAD:src/rate.ts`.text()).trim()
    const note = await cli(["write"], other, JSON.stringify({
      rationale: "note",
      facts: [{
        subject: "file/dat/sample/src/rate.ts", predicate: "reviewed-by", value: "alex", basis: "human-asserted",
        sources: [{ ref: "git:dat/sample:src/rate.ts", version: blob }],
      }],
    }))
    const noteId = JSON.parse(note.stdout).facts[0].id
    writeFileSync(join(repo, "src/rate.ts"), (await Bun.file(join(repo, "src/rate.ts")).text()).replace("100) / 100", "1000) / 1000"))
    await git("commit", "-qam", "precision")
    const third = await ingest()
    expect(third.sourceChanged).toBe(1)
    expect(third.facts.updated).toBeGreaterThan(0)
    expect(third.facts.created).toBe(0)
    const view = JSON.parse((await cli(["get-fact", noteId], other)).stdout).view
    expect(view.stale).toBe(true)
  }, 120_000)

  test("deleting a file retracts its facts; small batches still complete", async () => {
    rmSync(join(repo, "src/a b.ts"))
    await git("commit", "-qam", "remove")
    const fourth = await ingest()
    expect(fourth.facts.retracted).toBeGreaterThan(0)
    expect(fourth.sourceChanged).toBe(1)
    const left = JSON.parse((await cli(["list-facts", "--source-ref", "git:dat/sample:src/a b.ts"], env)).stdout)
    expect(left.items).toHaveLength(0)
    const r = await cli(["ingest-code", repo, "--repo", "dat/sample-batched", "--batch-size", "2"], env)
    const batched = JSON.parse(r.stdout)
    expect(batched.batches).toBe(Math.ceil(batched.facts.created / 2))
    expect(batched.batches).toBeGreaterThan(1)
  }, 120_000)
})

describe("ingest-code on a monorepo", () => {
  test("a repo without a root tsconfig.json indexes every project that has one, with repo-relative paths", async () => {
    const mono = mkdtempSync(join(tmpdir(), "ingest-mono-"))
    cpSync(`${import.meta.dir}/fixtures/monorepo`, mono, { recursive: true })
    await Bun.$`git -C ${mono} init -q && git -C ${mono} -c user.name=t -c user.email=t@t add -A && git -C ${mono} -c user.name=t -c user.email=t@t commit -qm init`.quiet()
    const r = await cli(["ingest-code", mono, "--repo", "dat/mono"], env)
    rmSync(mono, { recursive: true, force: true })
    expect(r.code).toBe(0)
    const out = JSON.parse(r.stdout)
    expect(out.files).toBe(2)
    const refs = JSON.parse((await cli(["list-facts", "--source-ref-prefix", "git:dat/mono:", "--predicate", "code:in-repo"], env)).stdout)
    expect(refs.items.map((v: { fact: { subject: string } }) => v.fact.subject).sort()).toEqual([
      "file/dat/mono/apps/api/src/handler.ts",
      "file/dat/mono/libs/shared/src/greet.ts",
    ])
  }, 120_000)
})
