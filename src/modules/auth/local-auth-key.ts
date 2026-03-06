import * as fs from "fs";
import * as path from "path";
import * as e from "effect";
import { GITHUB_KEY_PREFIX } from "./constants";
import { parsePublicKey } from "./key-format";
import { runOpenSshCommand } from "./openssh";
import type { LocalAuthKey } from "./types";

const yellow = (s: string) => `\x1b[33m${s}\x1b[0m`;
const logWarningSync = (...message: ReadonlyArray<unknown>): void => {
  e.Effect.runSync(e.Effect.logWarning(...message));
};

export function createReadOnlyAuthKey(
  privateKeyPath: string,
  publicKeyPath: string,
  email: string,
): e.Option.Option<LocalAuthKey> {
  const keyName = `${GITHUB_KEY_PREFIX}${email}`;

  fs.mkdirSync(path.dirname(privateKeyPath), { recursive: true });
  removeIfPresent(privateKeyPath);
  removeIfPresent(publicKeyPath);

  const generated = runOpenSshCommand(
    "ssh-keygen",
    ["-t", "ed25519", "-C", keyName, "-f", privateKeyPath, "-N", ""],
    { stdin: "inherit", stdout: "inherit", stderr: "inherit" },
  );

  if (e.Option.isNone(generated) || generated.value.exitCode !== 0 || !fs.existsSync(publicKeyPath)) {
    logWarningSync(yellow(`WARNING: could not create read-only auth key ${keyName}`));
    return e.Option.none();
  }

  const publicKey = fs.readFileSync(publicKeyPath, "utf8").trim();
  const parsed = parsePublicKey(publicKey);
  if (e.Option.isNone(parsed)) {
    logWarningSync(yellow(`WARNING: generated auth key was not parseable: ${publicKeyPath}`));
    return e.Option.none();
  }

  return e.Option.some({
    name: keyName,
    publicKey,
    keyBody: parsed.value.keyBody,
    privateKeyPath,
    publicKeyPath,
  });
}

function removeIfPresent(targetPath: string): void {
  if (fs.existsSync(targetPath)) {
    fs.rmSync(targetPath, { force: true });
  }
}
