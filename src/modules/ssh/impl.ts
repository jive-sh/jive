import * as e from "effect";
import * as ep from "@effect/platform";
import * as modules from "../index";
import { ISsh, type SshService } from "./interface";
import type { SshJiveKey } from "./types";
import {
  ensureResidentSshSupport,
  resolveStoredSshKey,
  selectOrCreateLocalSshKey,
  selectOrCreateYubiKeySshKey,
  type SshFileSystem,
  type SshHostShell,
} from "./service";

export const SshImpl = e.Layer.effect(ISsh, e.Effect.gen(function*() {
  const hostShell = yield* modules.IHostShell;
  const fileSystem = yield* ep.FileSystem.FileSystem;

  const sshHostShell: SshHostShell = {
    platform: hostShell.platform,
    getCommand: hostShell.getCommand,
    run: hostShell.run,
    runInheritIO: hostShell.runInheritIO,
  };

  const sshFileSystem: SshFileSystem = {
    exists: fileSystem.exists,
    makeDirectory: (targetPath) => fileSystem.makeDirectory(targetPath, { recursive: true }),
    readDirectory: fileSystem.readDirectory,
    readFileString: fileSystem.readFileString,
    copyFile: fileSystem.copyFile,
    remove: (targetPath) => fileSystem.remove(targetPath, { force: true, recursive: true }),
  };

  return {
    ensureResidentSshSupport: ensureResidentSshSupport(sshHostShell).pipe(
      e.Effect.catchAll(() => e.Effect.succeed(false)),
    ),
    resolveStoredSshKey: (workspaceRoot, relativePrivateKeyPath, source, yubiKeySerial) =>
      resolveStoredSshKey(sshFileSystem, sshHostShell, workspaceRoot, relativePrivateKeyPath, source, yubiKeySerial).pipe(
        e.Effect.catchAll(() => e.Effect.succeed(e.Option.none<SshJiveKey>())),
      ),
    selectOrCreateLocalSshKey: (workspaceRoot, email) =>
      selectOrCreateLocalSshKey(sshFileSystem, sshHostShell, workspaceRoot, email).pipe(
        e.Effect.catchAll(() => e.Effect.succeed(e.Option.none<SshJiveKey>())),
      ),
    selectOrCreateYubiKeySshKey: (workspaceRoot, serial, email) =>
      selectOrCreateYubiKeySshKey(sshFileSystem, sshHostShell, workspaceRoot, serial, email).pipe(
        e.Effect.catchAll(() => e.Effect.succeed(e.Option.none<SshJiveKey>())),
      ),
  } satisfies SshService;
}));
