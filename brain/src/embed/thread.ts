/** Embedding thread: keeps model inference off the thread that serves HTTP and runs PGlite. */
import { loadModel } from "./model.ts"

declare const self: Worker
const embed = loadModel()

self.onmessage = async (event: MessageEvent<{ id: number; texts: string[] }>) => {
  const { id, texts } = event.data
  try {
    postMessage({ id, vectors: await (await embed)(texts) })
  } catch (error) {
    postMessage({ id, error: String(error) })
  }
}
