import * as e from "effect";
import * as ep from "@effect/platform";
import { createHash } from "node:crypto";
import * as path from "node:path";

export type MalformedKeyReason = e.Data.TaggedEnum<{
  PrivateKeyMissing: {
    display: string;
  };
  PrivateKeyCheckFailed: {
    display: string;
  };
  PublicKeyMissing: {
    display: string;
  };
  PublicKeyCheckFailed: {
    display: string;
  };
  PublicKeyReadFailed: {
    display: string;
  };
  InvalidPublicKeyFormat: {
    display: string;
  };
}>;
export const MalformedKeyReason = e.Data.taggedEnum<MalformedKeyReason>();

export class MalformedKeyError extends e.Data.TaggedError("MalformedKeyError")<{
  reason: MalformedKeyReason;
  platformError?: ep.Error.PlatformError
}> {}

export class SshKey {
  public readonly name: string;
  public readonly fingerprint: string;
  public readonly pubkey: string;
  public readonly email: string;
  private constructor(
    public readonly location: string,
    pubkey: string,
    email: string,
    fingerprint: string,
  ) {
    this.pubkey = pubkey;
    this.email = email;
    this.fingerprint = fingerprint;
    this.name = this.fingerprint.replace(/^SHA256:/u, "").substring(0, 8);
  }
  public static make(location: string): e.Effect.Effect<SshKey, MalformedKeyError, ep.FileSystem.FileSystem> {
    return e.Effect.gen(function*() {
      const fileSystem = yield* ep.FileSystem.FileSystem;
      const privateKeyPath = path.resolve(location);
      const publicKeyPath = `${privateKeyPath}.pub`;

      const privateKeyExists = yield* e.pipe(
        fileSystem.exists(privateKeyPath),
        e.Effect.catchTag("BadArgument", "SystemError", platformError => new MalformedKeyError({
          reason: MalformedKeyReason.PrivateKeyCheckFailed({
            display: "couldn't access private key file"
          }),
          platformError
        })),
      );
      if (!privateKeyExists) {
        return yield* new MalformedKeyError({
          reason: MalformedKeyReason.PrivateKeyMissing({
            display: "no matching private key file"
          })
        });
      }

      const publicKeyExists = yield* e.pipe(
        fileSystem.exists(publicKeyPath),
        e.Effect.catchTag("BadArgument", "SystemError", platformError => new MalformedKeyError({
          reason: MalformedKeyReason.PublicKeyCheckFailed({
            display: "couldn't access public key file"
          }),
          platformError
        })),
      );
      if (!publicKeyExists) {
        return yield* new MalformedKeyError({
          reason: MalformedKeyReason.PublicKeyMissing({
            display: "public key file does not exist"
          })
        });
      }

      const pubkey = yield* e.pipe(
        publicKeyPath,
        fileSystem.readFileString,
        e.Effect.map(pubkey => pubkey.trim()),
        e.Effect.catchTag("BadArgument", "SystemError", platformError => new MalformedKeyError({
          reason: MalformedKeyReason.PublicKeyReadFailed({
            display: "couldn't read public key file"
          }),
          platformError
        }))
      );
      const pubkeyParts = pubkey.split(/\s+/u);
      const keyBlob = pubkeyParts[1] ?? "";
      if (!keyBlob) return yield* new MalformedKeyError({
        reason: MalformedKeyReason.InvalidPublicKeyFormat({
          display: "invalid public key format"
        })
      });
      const email = pubkeyParts.slice(2).join(" ");

      const fingerprint = `SHA256:${createHash("sha256")
        .update(Buffer.from(keyBlob, "base64"))
        .digest("base64")
        .replace(/=+$/u, "")}`;

      return new SshKey(privateKeyPath, pubkey, email, fingerprint);
    });
  }
}
