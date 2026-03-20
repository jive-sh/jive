import * as e from "effect";
import * as ep from "@effect/platform";
import * as os from "node:os";
import * as path from "node:path";
import * as modules from "@/modules";
import { ISsh, type SshKey } from "./interface";
import { SshKey as SshKeyImpl } from "./ssh-key";

export const SshImpl = e.Layer.effect(ISsh, e.Effect.gen(function*() {
  const fileSystem = yield* ep.FileSystem.FileSystem;
  const hostShell = yield* modules.IHostShell;
  const yubikey = yield* modules.IYubiKey;
  const localSshDirectory = path.join(os.homedir(), ".ssh");
  const hostEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );

  const ensureDirectory = e.Effect.fn(function*(targetPath: string) {
    yield* e.pipe(
      fileSystem.makeDirectory(targetPath, { recursive: true }),
      e.Effect.catchTag("BadArgument", "SystemError", error => e.Effect.die(error)),
    );
  });

  const ensureResidentKeySupport = e.Effect.gen(function*() {
    if (hostShell.platform._tag !== "MacOs") {
      return;
    }
    if (sshKeygen.path !== "/usr/bin/ssh-keygen") {
      return;
    }
    yield* e.Effect.logError(
      "macOS /usr/bin/ssh-keygen does not support the resident-key workflow Jive needs. Install full OpenSSH and retry.",
    );
    return yield* e.Effect.dieMessage("resident SSH keys require a full OpenSSH install");
  });

  const loadKeysFromDirectory = e.Effect.fn(function*(directoryPath: string) {
    const entries = yield* e.pipe(
      fileSystem.readDirectory(directoryPath),
      e.Effect.catchTag("BadArgument", "SystemError", () => e.Effect.succeed([] as string[])),
    );

    const keys: SshKey[] = [];
    for (const entry of entries.sort()) {
      if (!entry.endsWith(".pub")) {
        continue;
      }
      const maybeKey = yield* e.pipe(
        SshKeyImpl.make(path.join(directoryPath, entry.slice(0, -".pub".length))),
        e.Effect.provideService(ep.FileSystem.FileSystem, fileSystem),
        e.Effect.map(key => e.Option.some(key)),
        e.Effect.catchTag("MalformedKeyError", () => e.Effect.succeed(e.Option.none<SshKey>())),
      );
      if (e.Option.isSome(maybeKey)) {
        keys.push(maybeKey.value);
      }
    }
    return keys;
  });

  const runSshKeygen = e.Effect.fn(function*(args: readonly string[], runInDir: string) {
    const { exitCode } = yield* e.pipe(
      hostShell.runInheritIO({
        args,
        runInDir,
        env: hostEnv,
      })(sshKeygen),
      e.Effect.catchTag("BadArgument", "SystemError", error => e.Effect.die(error)),
    );
    return exitCode;
  });

  return {
    restoreResidentSshKeys: e.Effect.fn(function*(inDirectory: string) {
      yield* ensureResidentKeySupport;
      yield* ensureDirectory(inDirectory);

      const restoreExitCode = yield* runSshKeygen(["-K"], inDirectory);
      if (restoreExitCode !== 0) {
        return [] as SshKey[];
      }
      return yield* loadKeysFromDirectory(inDirectory);
    }),
    listLocalSshKeys: e.Effect.fn(function*() {
      return {
        pathsScanned: [localSshDirectory],
        keys: yield* loadKeysFromDirectory(localSshDirectory),
      };
    }),
    createSshKey: e.Effect.fn(function*(email: string, inDirectory: string, onYubikey) {
      yield* ensureDirectory(inDirectory);

      const targetPath =
        onYubikey ?
          path.join(inDirectory, `id_ed25519_sk_${onYubikey.serial}`) :
          path.join(inDirectory, "id_ed25519");

      if (onYubikey) {
        yield* ensureResidentKeySupport;

        const connectedYubiKeys = yield* yubikey.listConnectedDevices;
        if (!connectedYubiKeys.some(connectedYubiKey => connectedYubiKey.serial === onYubikey.serial)) {
          return yield* e.Effect.dieMessage(`YubiKey ${onYubikey.serial} is not currently connected`);
        }
        if (connectedYubiKeys.length > 1) {
          yield* e.Effect.logError(
            `Multiple YubiKeys are connected. Disconnect all but serial ${onYubikey.serial} before creating a resident SSH key.`,
          );
          return yield* e.Effect.dieMessage("multiple YubiKeys connected during resident SSH key creation");
        }

        const pinConfigured = yield* yubikey.ensurePinConfigured(onYubikey.serial);
        if (!pinConfigured) {
          return yield* e.Effect.dieMessage(`YubiKey ${onYubikey.serial} is not ready for resident SSH keys`);
        }

        const createExitCode = yield* runSshKeygen(
          ["-t", "ed25519-sk", "-O", "resident", "-C", email, "-f", targetPath, "-N", ""],
          inDirectory,
        );
        if (createExitCode !== 0) {
          return yield* e.Effect.dieMessage(`failed to create resident SSH key on YubiKey ${onYubikey.serial}`);
        }
      } else {
        const createExitCode = yield* runSshKeygen(
          ["-t", "ed25519", "-C", email, "-f", targetPath, "-N", ""],
          inDirectory,
        );
        if (createExitCode !== 0) {
          return yield* e.Effect.dieMessage("failed to create local SSH key");
        }
      }

      return yield* e.pipe(
        SshKeyImpl.make(targetPath),
        e.Effect.provideService(ep.FileSystem.FileSystem, fileSystem),
        e.Effect.catchTag("MalformedKeyError", error => e.Effect.die(error)),
      );
    }),
  };
}));
