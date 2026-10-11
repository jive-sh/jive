/** Text embeddings (design rev 4 §6.3): bge-small-en-v1.5 via ONNX Runtime WebAssembly, on worker threads. */
import { availableParallelism } from "node:os"
import { Context, Effect, Layer } from "effect"

export const DIMS = 384
export const QUERY_PREFIX = "Represent this sentence for searching relevant passages: "

export class Embedder extends Context.Service<
  Embedder,
  {
    /** False when embedding is switched off; search then uses exact and full-text matching only. */
    readonly enabled: boolean
    /** How many texts' worth of work can run at once; the worker sizes batches by it. */
    readonly parallelism: number
    readonly embedDocs: (texts: ReadonlyArray<string>) => Effect.Effect<number[][]>
    readonly embedQuery: (text: string) => Effect.Effect<number[]>
  }
>()("brain/Embedder") {
  /** `threadUrl`: the embedding thread's module. Compiled executables must pass one resolved from the entry file. */
  static readonly Local = (threadUrl: string = new URL("./thread.ts", import.meta.url).href): Layer.Layer<Embedder> =>
    Layer.effect(Embedder)(Effect.suspend(() => makeLocal(threadUrl)))
  static readonly Fake: Layer.Layer<Embedder> = Layer.succeed(Embedder)({
    enabled: true,
    parallelism: 1,
    embedDocs: (texts) => Effect.succeed(texts.map(fakeVector)),
    embedQuery: (text) => Effect.succeed(fakeVector(text)),
  })
  static readonly None: Layer.Layer<Embedder> = Layer.succeed(Embedder)({
    enabled: false,
    parallelism: 1,
    embedDocs: (texts) => Effect.succeed(texts.map(() => [])),
    embedQuery: () => Effect.succeed([]),
  })
}

const normalize = (v: ArrayLike<number>): number[] => {
  let n = 0
  for (let i = 0; i < v.length; i++) n += v[i]! * v[i]!
  n = Math.sqrt(n) || 1
  return Array.from(v, (x) => x / n)
}

/** Bag-of-words hashing into 384 buckets: deterministic, for tests. */
const fakeVector = (text: string): number[] => {
  const v = new Array<number>(DIMS).fill(0)
  for (const word of text.toLowerCase().match(/[a-z0-9]+/g) ?? []) v[Number(BigInt(Bun.hash(word)) % BigInt(DIMS))]! += 1
  return normalize(v.some((x) => x !== 0) ? v : [1, ...v.slice(1)])
}

/** A pool of embedding threads; texts are split across threads and embedded in parallel. */
const makeLocal = (threadUrl: string) => Effect.gen(function* () {
  const size = Math.max(1, Number(process.env["BRAIN_EMBED_THREADS"] ?? Math.min(8, Math.max(1, Math.floor(availableParallelism() / 2)))))
  const threads = yield* Effect.acquireRelease(
    Effect.sync(() => Array.from({ length: size }, () => new Worker(threadUrl))),
    (ws) => Effect.sync(() => ws.forEach((w) => w.terminate())),
  )
  const pending = new Map<number, { resolve: (v: number[][]) => void; reject: (e: Error) => void }>()
  const failAll = (error: Error) => {
    for (const p of pending.values()) p.reject(error)
    pending.clear()
  }
  for (const t of threads) {
    t.onerror = (e: ErrorEvent) => {
      console.error(`embedding thread failed: ${e.message}`)
      failAll(new Error(`embedding thread failed: ${e.message}`))
    }
    t.onmessage = (e: MessageEvent<{ id: number; vectors?: number[][]; error?: string }>) => {
      const p = pending.get(e.data.id)
      pending.delete(e.data.id)
      if (e.data.error !== undefined) p?.reject(new Error(e.data.error))
      else p?.resolve(e.data.vectors!)
    }
  }
  // With more than one thread, the first is kept for questions so a search never waits behind the backlog.
  const queryThread = threads[0]!
  const docThreads = threads.length > 1 ? threads.slice(1) : threads
  let nextId = 0
  let nextThread = 0
  const onThread = (thread: Worker, texts: string[]) =>
    new Promise<number[][]>((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      thread.postMessage({ id, texts })
    })

  const run = (texts: ReadonlyArray<string>) =>
    Effect.tryPromise(async () => {
      if (texts.length === 0) return []
      const per = Math.ceil(texts.length / docThreads.length)
      const parts = Array.from({ length: Math.ceil(texts.length / per) }, (_, i) => texts.slice(i * per, (i + 1) * per))
      return (await Promise.all(parts.map((p) => onThread(docThreads[nextThread++ % docThreads.length]!, p)))).flat()
    }).pipe(Effect.orDie)

  return Embedder.of({
    enabled: true,
    parallelism: docThreads.length,
    embedDocs: run,
    embedQuery: (text) =>
      Effect.tryPromise(() => onThread(queryThread, [QUERY_PREFIX + text])).pipe(Effect.orDie, Effect.map((v) => v[0]!)),
  })
})
