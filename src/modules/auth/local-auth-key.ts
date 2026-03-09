import * as fs from "fs";
import * as path from "path";
import * as e from "effect";
import { GITHUB_KEY_PREFIX } from "@/modules/auth/constants";
import type { AuthHostShell } from "@/modules/auth/host-shell";
import { parsePublicKey } from "@/modules/auth/key-format";
import { runOpenSshCommand } from "@/modules/auth/openssh";
import type { HostShellCommand } from "@/modules/host-shell/interface";
import type { LocalAuthKey } from "@/modules/auth/types";

export const createReadOnlyAuthKey = (
  hostShell: AuthHostShell,
  privateKeyPath: string,
  publicKeyPath: string,
  email: string,
): e.Effect.Effect<e.Option.Option<LocalAuthKey>> =>
  e.Effect.gen(function*() {
    const keyName = `${GITHUB_KEY_PREFIX}${email}`;

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
