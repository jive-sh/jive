/** Downloads the pinned embedding model into models/ and verifies its hashes. Run: bun run fetch-model */
import { mkdirSync } from "node:fs"

const REVISION = "ea104dacec62c0de699686887e3f920caeb4f3e3"
const BASE = `https://huggingface.co/Xenova/bge-small-en-v1.5/resolve/${REVISION}`
const DIR = `${import.meta.dir}/../models/bge-small-en-v1.5`
const FILES: Record<string, string> = {
  "onnx/model_quantized.onnx": "6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4",
  "tokenizer.json": "d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66",
  "tokenizer_config.json": "9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3",
}

mkdirSync(`${DIR}/onnx`, { recursive: true })
for (const [path, sha] of Object.entries(FILES)) {
  const out = `${DIR}/${path}`
  const sum = async () => new Bun.CryptoHasher("sha256").update(await Bun.file(out).arrayBuffer()).digest("hex")
  if ((await Bun.file(out).exists()) && (await sum()) === sha) continue
  const res = await fetch(`${BASE}/${path}`)
  if (!res.ok) throw new Error(`download ${path}: HTTP ${res.status}`)
  await Bun.write(out, await res.arrayBuffer())
  if ((await sum()) !== sha) throw new Error(`hash mismatch for ${path}`)
  console.log(`fetched ${path}`)
}
console.log(`model ready in ${DIR}`)
