/**
 * Chrome native messaging's wire format: each message is UTF-8 JSON preceded by its length as a 32-bit unsigned
 * integer in native byte order, which is little-endian on every platform Chrome supports
 * (https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging#native-messaging-host-protocol).
 */

/** Chrome refuses a message from a host larger than 1 MB. */
export const MAX_HOST_MESSAGE_BYTES = 1024 * 1024;

export function encodeFrame(json: string): Uint8Array {
  const body = new TextEncoder().encode(json);
  const frame = new Uint8Array(4 + body.byteLength);
  new DataView(frame.buffer).setUint32(0, body.byteLength, true);
  frame.set(body, 4);
  return frame;
}

/** Splits a byte stream into whole frames' JSON texts, keeping a partial frame for the next chunk. */
export class FrameReader {
  private buffered = new Uint8Array(0);

  push(chunk: Uint8Array): ReadonlyArray<string> {
    const joined = new Uint8Array(this.buffered.byteLength + chunk.byteLength);
    joined.set(this.buffered, 0);
    joined.set(chunk, this.buffered.byteLength);
    const texts: Array<string> = [];
    let offset = 0;
    while (joined.byteLength - offset >= 4) {
      const length = new DataView(joined.buffer, joined.byteOffset + offset, 4).getUint32(0, true);
      if (joined.byteLength - offset - 4 < length) break;
      texts.push(new TextDecoder().decode(joined.subarray(offset + 4, offset + 4 + length)));
      offset += 4 + length;
    }
    this.buffered = joined.slice(offset);
    return texts;
  }
}
