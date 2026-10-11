/**
 * PGlite's WebAssembly, data bundle, and pgvector extension, embedded with Bun's
 * file imports so `bun build --compile` includes them in the executable.
 */
import { tmpdir } from "node:os"
import { join } from "node:path"
// @ts-ignore Bun file import
import pgliteWasmPath from "../../node_modules/@electric-sql/pglite/dist/pglite.wasm" with { type: "file" }
// @ts-ignore Bun file import
import initdbWasmPath from "../../node_modules/@electric-sql/pglite/dist/initdb.wasm" with { type: "file" }
// @ts-ignore Bun file import
import pgliteDataPath from "../../node_modules/@electric-sql/pglite/dist/pglite.data" with { type: "file" }
// @ts-ignore Bun file import
import vectorBundlePath from "../../node_modules/@electric-sql/pglite-pgvector/dist/vector.tar.gz" with { type: "file" }

// PGlite reads extension bundles with node:fs, which can't see Bun's embedded
// files, so the bundle is copied to a content-addressed temp file once.
const materialize = async (embedded: string, suffix: string): Promise<URL> => {
  const bytes = new Uint8Array(await Bun.file(embedded).arrayBuffer())
  const out = join(tmpdir(), `brain-${Bun.hash(bytes).toString(16)}${suffix}`)
  if (!(await Bun.file(out).exists())) await Bun.write(out, bytes)
  return new URL(`file://${out}`)
}

export const pgliteOptions = async () => {
  const vectorBundle = await materialize(vectorBundlePath, ".tar.gz")
  return {
    pgliteWasmModule: await WebAssembly.compile(await Bun.file(pgliteWasmPath).arrayBuffer()),
    initdbWasmModule: await WebAssembly.compile(await Bun.file(initdbWasmPath).arrayBuffer()),
    fsBundle: Bun.file(pgliteDataPath),
    extensions: {
      vector: {
        name: "vector",
        setup: async (_pg: unknown, emscriptenOpts: unknown) => ({ emscriptenOpts, bundlePath: vectorBundle }),
      },
    },
  }
}
