/** bge-small-en-v1.5 inference with ONNX Runtime WebAssembly. Runs inside an embedding thread. */
import { Tokenizer } from "@huggingface/tokenizers"
import * as ort from "onnxruntime-web/wasm"
import { modelAssets } from "./assets.ts"

const MAX_TOKENS = 512

const normalize = (v: ArrayLike<number>): number[] => {
  let n = 0
  for (let i = 0; i < v.length; i++) n += v[i]! * v[i]!
  n = Math.sqrt(n) || 1
  return Array.from(v, (x) => x / n)
}

export const loadModel = async () => {
  const assets = await modelAssets()
  ort.env.wasm.numThreads = 1
  ort.env.wasm.wasmBinary = assets.ortWasm
  const tokenizer = new Tokenizer(assets.tokenizer, assets.tokenizerConfig)
  const session = await ort.InferenceSession.create(assets.model)

  return async (texts: ReadonlyArray<string>): Promise<number[][]> => {
    if (texts.length === 0) return []
    const encoded = texts.map((t) => {
      const ids = tokenizer.encode(t).ids
      return ids.length <= MAX_TOKENS ? ids : [...ids.slice(0, MAX_TOKENS - 1), ids[ids.length - 1]!]
    })
    const width = Math.max(...encoded.map((ids) => ids.length))
    const ids = new BigInt64Array(texts.length * width)
    const mask = new BigInt64Array(texts.length * width)
    encoded.forEach((row, b) =>
      row.forEach((id, i) => {
        ids[b * width + i] = BigInt(id)
        mask[b * width + i] = 1n
      }),
    )
    const out = await session.run({
      input_ids: new ort.Tensor("int64", ids, [texts.length, width]),
      attention_mask: new ort.Tensor("int64", mask, [texts.length, width]),
      token_type_ids: new ort.Tensor("int64", new BigInt64Array(texts.length * width), [texts.length, width]),
    })
    const hidden = out[session.outputNames[0]!]!
    const data = hidden.data as Float32Array
    const dims = hidden.dims[2]!
    // bge uses the [CLS] token's hidden state as the sentence embedding.
    return texts.map((_, b) => normalize(data.subarray(b * width * dims, b * width * dims + dims)))
  }
}
