import * as fs from "fs";
import * as path from "path";
import * as e from "effect";
import { authKeyName } from "./constants";
import type { AuthHostShell } from "./host-shell";
import { parsePublicKey } from "./key-format";
import { runOpenSshCommand } from "./openssh";
import type { LocalAuthKey } from "./types";
import type { HostShellCommand } from "../host-shell/interface";

export const loadReadOnlyAuthKey = (
  privateKeyPath: string,
  publicKeyPath: string,
): e.Effect.Effect<e.Option.Option<LocalAuthKey>> =>
  e.Effect.gen(function*() {
    if (!privateKeyPath || !publicKeyPath) return e.Option.none();
    if (!fs.existsSync(privateKeyPath) || !fs.existsSync(publicKeyPath)) return e.Option.none();

    const publicKey = yield* e.Effect.sync(() => fs.readFileSync(publicKeyPath, "utf8").trim());
    const parsed = parsePublicKey(publicKey);
    if (e.Option.isNone(parsed)) {
      yield* e.Effect.logWarning(`Existing auth key was not parseable: ${publicKeyPath}.`);
      return e.Option.none();
    }

    return e.Option.some({
      name: parsed.value.comment,
      publicKey,
      keyBody: parsed.value.keyBody,
      privateKeyPath,
      publicKeyPath,
    });
  });

export const createReadOnlyAuthKey = (
  hostShell: AuthHostShell,
  privateKeyPath: string,
  publicKeyPath: string,
  email: string,
): e.Effect.Effect<e.Option.Option<LocalAuthKey>> =>
  e.Effect.gen(function*() {
    const keyName = authKeyName(email);

    yield* e.Effect.sync(() => {
      fs.mkdirSync(path.dirname(privateKeyPath), { recursive: true });
      removeIfPresent(privateKeyPath);
      removeIfPresent(publicKeyPath);
    });

    const command: HostShellCommand & { readonly command: "ssh-keygen" } = {
      command: "ssh-keygen",
      args: ["-t", "ed25519", "-C", keyName, "-f", privateKeyPath, "-N", ""],
      cwd: e.Option.none(),
      env: {},
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
      shell: e.Option.none(),
    };

    const generated = yield* runOpenSshCommand(hostShell, command);

    if (e.Option.isNone(generated) || generated.value.exitCode !== 0 || !fs.existsSync(publicKeyPath)) {
      yield* e.Effect.logWarning(`Could not create read-only auth key ${keyName}.`);
      return e.Option.none();
    }

    const publicKey = yield* e.Effect.sync(() => fs.readFileSync(publicKeyPath, "utf8").trim());
    const parsed = parsePublicKey(publicKey);
    if (e.Option.isNone(parsed)) {
      yield* e.Effect.logWarning(`Generated auth key was not parseable: ${publicKeyPath}.`);
      return e.Option.none();
    }

    return e.Option.some({
      name: keyName,
      publicKey,
      keyBody: parsed.value.keyBody,
      privateKeyPath,
      publicKeyPath,
    });
  });

function removeIfPresent(targetPath: string): void {
  if (fs.existsSync(targetPath)) {
    fs.rmSync(targetPath, { force: true });
  }
}
