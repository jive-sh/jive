import * as e from "effect";
import * as os from "node:os";
import * as path from "node:path";
import { implementing, type EffectGen } from "effective-modules";
import { OSPlatform } from "jive-abstract-library";
import { modules } from "@/modules";
import type { ConnectedYubiKey } from "@/modules/yubikey/interface";
import type { ISsh } from "./interface";
import { SshKey } from "./ssh-key";

const SSH_KEYGEN_COMMAND = "ssh-keygen";

export class SshImpl extends implementing(modules.ssh).uses(e.FileSystem.FileSystem, OSPlatform, modules.yubikey) implements ISsh {
  private readonly localSshDirectory = path.join(os.homedir(), ".ssh");

  *restoreResidentSshKeys(inDirectory: string): EffectGen<SshKey[]> {
    yield* this.ensureResidentKeySupport();
    yield* this.ensureDirectory(inDirectory);

    const restoreExitCode = yield* this.runSshKeygen(["-K"], inDirectory);
    if (restoreExitCode !== 0) {
      return [];
    }
    return yield* this.loadKeysFromDirectory(inDirectory);
  }

  *listLocalSshKeys(): EffectGen<{ pathsScanned: string[]; keys: SshKey[] }> {
    return {
      pathsScanned: [this.localSshDirectory],
      keys: yield* this.loadKeysFromDirectory(this.localSshDirectory),
    };
  }

  *createSshKey(email: string, inDirectory: string, onYubikey?: ConnectedYubiKey): EffectGen<SshKey> {
    yield* this.ensureDirectory(inDirectory);

    const targetPath =
      onYubikey ?
        path.join(inDirectory, `id_ed25519_sk_${onYubikey.serial}`) :
        path.join(inDirectory, "id_ed25519");

    if (onYubikey) {
      yield* this.ensureResidentKeySupport();
      const yubikey = this.dependencies.yubikey;

      const connectedYubiKeys = yield* yubikey.listConnectedDevices();
      if (!connectedYubiKeys.some(connectedYubiKey => connectedYubiKey.serial === onYubikey.serial)) {
        return yield* e.Effect.die(`YubiKey ${onYubikey.serial} is not currently connected`);
      }
      if (connectedYubiKeys.length > 1) {
        yield* e.Effect.logError(
          `Multiple YubiKeys are connected. Disconnect all but serial ${onYubikey.serial} before creating a resident SSH key.`,
        );
        return yield* e.Effect.die("multiple YubiKeys connected during resident SSH key creation");
      }

      const pinConfigured = yield* yubikey.ensurePinConfigured(onYubikey.serial);
      if (!pinConfigured) {
        return yield* e.Effect.die(`YubiKey ${onYubikey.serial} is not ready for resident SSH keys`);
      }

      const createExitCode = yield* this.runSshKeygen(
        ["-t", "ed25519-sk", "-O", "resident", "-C", email, "-f", targetPath, "-N", ""],
        inDirectory,
      );
      if (createExitCode !== 0) {
        return yield* e.Effect.die(`failed to create resident SSH key on YubiKey ${onYubikey.serial}`);
      }
    } else {
      const createExitCode = yield* this.runSshKeygen(
        ["-t", "ed25519", "-C", email, "-f", targetPath, "-N", ""],
        inDirectory,
      );
      if (createExitCode !== 0) {
        return yield* e.Effect.die("failed to create local SSH key");
      }
    }

    return yield* e.pipe(
      SshKey.make(targetPath),
      e.Effect.provideService(e.FileSystem.FileSystem, this.getDependency(e.FileSystem.FileSystem)),
      e.Effect.orDie,
    );
  }

  /** macOS's own /usr/bin/ssh-keygen cannot make or restore resident keys, so a full OpenSSH must come first on PATH. */
  private *ensureResidentKeySupport(): EffectGen<void> {
    const { os: platform } = yield* this.dependencies.OSPlatform.getCurrentPlatform();
    if (platform !== "darwin") {
      return;
    }
    const maybeSshKeygen = yield* this.dependencies.OSPlatform.findExecutable(SSH_KEYGEN_COMMAND);
    if (e.Option.isSome(maybeSshKeygen) && maybeSshKeygen.value !== "/usr/bin/ssh-keygen") {
      return;
    }
    yield* e.Effect.logError(
      "macOS /usr/bin/ssh-keygen does not support the resident-key workflow Jive needs. Install full OpenSSH and retry.",
    );
    return yield* e.Effect.die("resident SSH keys require a full OpenSSH install");
  }

  private *ensureDirectory(targetPath: string): EffectGen<void> {
    yield* e.Effect.orDie(this.getDependency(e.FileSystem.FileSystem).makeDirectory(targetPath, { recursive: true }));
  }

  private *loadKeysFromDirectory(directoryPath: string): EffectGen<SshKey[]> {
    const fileSystem = this.getDependency(e.FileSystem.FileSystem);
    const entries = yield* e.pipe(
      fileSystem.readDirectory(directoryPath),
      e.Effect.catchTag("PlatformError", () => e.Effect.succeed([] as string[])),
    );

    const keys: SshKey[] = [];
    for (const entry of entries.sort()) {
      if (!entry.endsWith(".pub")) {
        continue;
      }
      const maybeKey = yield* e.pipe(
        SshKey.make(path.join(directoryPath, entry.slice(0, -".pub".length))),
        e.Effect.provideService(e.FileSystem.FileSystem, fileSystem),
        e.Effect.option,
      );
      if (e.Option.isSome(maybeKey)) {
        keys.push(maybeKey.value);
      }
    }
    return keys;
  }

  private *runSshKeygen(args: ReadonlyArray<string>, inDirectory: string): EffectGen<number> {
    const { exitCode } = yield* e.Effect.orDie(e.Effect.gen(() => this.dependencies.OSPlatform.spawnProcess({
      command: SSH_KEYGEN_COMMAND,
      args,
      cwd: inDirectory,
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    })));
    return exitCode;
  }
}
