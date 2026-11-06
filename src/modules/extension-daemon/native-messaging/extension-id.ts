import { createHash } from "node:crypto";

/**
 * Chrome's id for an extension with this public key: the first 16 bytes of the key's SHA-256, each hex digit
 * written as a letter from `a` (0) to `p` (15).
 */
export function extensionIdOf(publicKeyBase64: string): string {
  const digest = createHash("sha256").update(Buffer.from(publicKeyBase64, "base64")).digest("hex").slice(0, 32);
  return [...digest].map((digit) => String.fromCharCode("a".charCodeAt(0) + Number.parseInt(digit, 16))).join("");
}
