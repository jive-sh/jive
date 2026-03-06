import * as e from "effect";
import type { ParsedPublicKey } from "./types";

export function parsePublicKey(publicKey: string): e.Option.Option<ParsedPublicKey> {
  const trimmed = publicKey.trim();
  if (!trimmed) return e.Option.none();

  const parts = trimmed.split(/\s+/);
  if (parts.length < 2) return e.Option.none();

  return e.Option.some({
    keyBody: `${parts[0]} ${parts[1]}`,
    comment: parts.slice(2).join(" "),
  });
}
