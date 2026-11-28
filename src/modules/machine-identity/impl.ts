import * as e from "effect";
import { implementing, type EffectGen } from "effective-modules";
import { OSPlatform } from "jive-abstract-library";
import { hostname } from "node:os";
import * as path from "node:path";
import { jiveHomePaths } from "@/jive-home";
import { modules } from "@/modules";
import { MachineKeyUnavailable, type IMachineIdentity, type MachineDescription } from "./interface";

/**
 * The key in an owner-only file in the jive home (`machine-key.json`), as PKCS #8: what every operating system can
 * hold. The Secure Enclave on a Mac and a TPM elsewhere, where the key can't be read out, are planned behind this
 * same interface.
 */

const StoredKey = e.Schema.Struct({ privateKeyPkcs8: e.Schema.NonEmptyString, publicKey: e.Schema.NonEmptyString });
const decodeStoredKey = e.Schema.decodeUnknownOption(e.Schema.fromJsonString(StoredKey));
const ALGORITHM = { name: "ECDSA", namedCurve: "P-256" } as const;

const toBase64Url = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

interface LoadedKey {
  readonly privateKey: CryptoKey;
  readonly publicKey: string;
}

export class FileMachineIdentityImpl extends implementing(modules.machineIdentity).uses(OSPlatform, e.FileSystem.FileSystem) implements IMachineIdentity {
  /** One creation at a time, so two first requests in one process never write two keys. */
  private readonly loading = e.Semaphore.makeUnsafe(1);
  private readonly loaded = e.Ref.makeUnsafe(e.Option.none<LoadedKey>());

  *describe(): EffectGen<MachineDescription, MachineKeyUnavailable> {
    const { publicKey } = yield* this.key();
    return { publicKey, keyStorage: "file", osName: yield* this.osName() };
  }

  *sign(message: string): EffectGen<string, MachineKeyUnavailable> {
    const { privateKey } = yield* this.key();
    const signature = yield* e.Effect.tryPromise({
      try: () => crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, new TextEncoder().encode(message)),
      catch: (cause) => new MachineKeyUnavailable({ detail: `could not sign with the machine key: ${String(cause)}` }),
    });
    return toBase64Url(new Uint8Array(signature));
  }

  private *key(): EffectGen<LoadedKey, MachineKeyUnavailable> {
    const self = this;
    return yield* e.Semaphore.withPermits(this.loading, 1)(e.Effect.gen(function* () {
      const cached = yield* e.Ref.get(self.loaded);
      if (e.Option.isSome(cached)) return cached.value;
      const key = yield* self.readOrCreate();
      yield* e.Ref.set(self.loaded, e.Option.some(key));
      return key;
    }));
  }

  private *readOrCreate(): EffectGen<LoadedKey, MachineKeyUnavailable> {
    const fs = this.getDependency(e.FileSystem.FileSystem);
    const { machineKeyFile } = jiveHomePaths(yield* this.dependencies.OSPlatform.getHomeDirectory());
    const maybeStored = e.Option.flatMap(yield* e.Effect.option(fs.readFileString(machineKeyFile)), decodeStoredKey);
    if (e.Option.isSome(maybeStored)) {
      const stored = maybeStored.value;
      const privateKey = yield* e.Effect.tryPromise({
        try: () => crypto.subtle.importKey("pkcs8", Buffer.from(stored.privateKeyPkcs8, "base64url"), ALGORITHM, false, ["sign"]),
        catch: (cause) => new MachineKeyUnavailable({ detail: `${machineKeyFile} does not hold a P-256 key: ${String(cause)}` }),
      });
      return { privateKey, publicKey: stored.publicKey };
    }
    const pair = yield* e.Effect.tryPromise({
      try: () => crypto.subtle.generateKey(ALGORITHM, true, ["sign", "verify"]),
      catch: (cause) => new MachineKeyUnavailable({ detail: `could not create a machine key: ${String(cause)}` }),
    });
    const exported = yield* e.Effect.tryPromise({
      try: async () => ({
        privateKeyPkcs8: toBase64Url(new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey))),
        publicKey: toBase64Url(new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))),
      }),
      catch: (cause) => new MachineKeyUnavailable({ detail: `could not export the new machine key: ${String(cause)}` }),
    });
    // Written beside the target and renamed over it, owner-only, so no other user reads it and no reader sees half of it.
    const staging = `${machineKeyFile}.${process.pid}.tmp`;
    yield* e.pipe(
      e.Effect.gen(function* () {
        yield* fs.makeDirectory(path.dirname(machineKeyFile), { recursive: true, mode: 0o700 });
        yield* fs.writeFileString(staging, `${JSON.stringify(exported)}\n`, { mode: 0o600 });
        yield* fs.chmod(staging, 0o600);
        yield* fs.rename(staging, machineKeyFile);
      }),
      e.Effect.mapError((error) => new MachineKeyUnavailable({ detail: `could not save the machine key to ${machineKeyFile}: ${error.message}` })),
    );
    return { privateKey: pair.privateKey, publicKey: exported.publicKey };
  }

  /** macOS's Computer Name (`scutil --get ComputerName`), which is what a person calls the Mac; elsewhere the host name. */
  private *osName(): EffectGen<string> {
    if (process.platform === "darwin") {
      const named = yield* e.Effect.result(e.Effect.gen(() => this.dependencies.OSPlatform.spawnProcess({
        command: "/usr/sbin/scutil",
        args: ["--get", "ComputerName"],
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      })));
      if (e.Result.isSuccess(named) && named.success.exitCode === 0 && named.success.stdout.trim() !== "") return named.success.stdout.trim();
    }
    return hostname();
  }
}
