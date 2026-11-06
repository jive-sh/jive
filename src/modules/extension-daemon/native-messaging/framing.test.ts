import { describe, expect, test } from "bun:test";
import { EXTENSION_PUBLIC_KEY } from "../protocol";
import { extensionIdOf } from "./extension-id";
import { encodeFrame, FrameReader } from "./framing";

describe("native messaging frames", () => {
  test("a frame is the UTF-8 length, little-endian, then the JSON", () => {
    const frame = encodeFrame(`{"a":"é"}`);
    expect([...frame.slice(0, 4)]).toEqual([10, 0, 0, 0]);
    expect(new TextDecoder().decode(frame.slice(4))).toBe(`{"a":"é"}`);
  });

  test("frames split across chunks, or several in one chunk, come out whole and in order", () => {
    const bytes = new Uint8Array([...encodeFrame(`{"n":1}`), ...encodeFrame(`{"n":2}`), ...encodeFrame(`{"n":3}`)]);
    const reader = new FrameReader();
    const texts = [...reader.push(bytes.slice(0, 3)), ...reader.push(bytes.slice(3, 20)), ...reader.push(bytes.slice(20))];
    expect(texts).toEqual([`{"n":1}`, `{"n":2}`, `{"n":3}`]);
  });
});

describe("the extension's id", () => {
  test("is 32 letters from a to p, derived from its public key", () => {
    expect(extensionIdOf(EXTENSION_PUBLIC_KEY)).toMatch(/^[a-p]{32}$/);
  });
});
