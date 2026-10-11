/** Starts a real brain (from ../brain sources) on a free port with a temp data dir. */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export interface TestBrain {
  url: string
  adminKey: string
  register: (writerId: string, bases?: string[]) => Promise<string>
  stop: () => Promise<void>
}

export const startBrain = async (): Promise<TestBrain> => {
  const dir = mkdtempSync(join(tmpdir(), "brain-caller-test-"))
  const port = 20000 + Math.floor(Math.random() * 20000)
  const adminKey = "test-admin-key"
  const proc = Bun.spawn(["bun", "run", `${import.meta.dir}/../../brain/src/main.ts`], {
    env: { ...process.env, BRAIN_PORT: String(port), BRAIN_DATA_DIR: dir, BRAIN_EMBEDDER: "none", BRAIN_ADMIN_KEY: adminKey },
    stdout: "ignore",
    stderr: "pipe",
  })
  const url = `http://127.0.0.1:${port}`
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${url}/health`)).ok) break
    } catch {}
    await Bun.sleep(100)
  }
  return {
    url,
    adminKey,
    register: async (writerId, bases = ["compiler-derived", "imported", "human-asserted", "model-inferred"]) => {
      const r = await fetch(`${url}/admin/v1/registerWriter`, {
        method: "POST",
        headers: { authorization: `Bearer ${adminKey}` },
        body: JSON.stringify({ writerId, allowedBases: bases }),
      })
      return ((await r.json()) as { apiKey: string }).apiKey
    },
    stop: async () => {
      proc.kill()
      await proc.exited
      rmSync(dir, { recursive: true, force: true })
    },
  }
}

/** Run brain-caller from source. */
export const cli = async (args: string[], env: Record<string, string>, stdin?: string) => {
  const proc = Bun.spawn(["bun", "run", `${import.meta.dir}/../src/main.ts`, ...args], {
    env: { ...process.env, ...env },
    stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited])
  return { stdout, stderr, code }
}
