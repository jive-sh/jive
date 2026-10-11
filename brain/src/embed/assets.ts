/** The embedding model and ONNX Runtime's WebAssembly, embedded in the executable. Fetch with `bun run fetch-model`. TypeScript types the JSON imports as their contents; with `type: "file"` Bun gives paths. */
// @ts-ignore Bun file import
import ortWasmPath from "../../node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm" with { type: "file" }
// @ts-ignore Bun file import
import modelPath from "../../models/bge-small-en-v1.5/onnx/model_quantized.onnx" with { type: "file" }
// @ts-ignore Bun file import
import tokenizerPath from "../../models/bge-small-en-v1.5/tokenizer.json" with { type: "file" }
// @ts-ignore Bun file import
import tokenizerConfigPath from "../../models/bge-small-en-v1.5/tokenizer_config.json" with { type: "file" }

export const modelAssets = async () => ({
  ortWasm: await Bun.file(ortWasmPath).arrayBuffer(),
  model: new Uint8Array(await Bun.file(modelPath).arrayBuffer()),
  tokenizer: await Bun.file(tokenizerPath as unknown as string).json(),
  tokenizerConfig: await Bun.file(tokenizerConfigPath as unknown as string).json(),
})
