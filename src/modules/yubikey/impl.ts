import * as e from "effect";
import { implementing, type EffectGen } from "effective-modules";
import { OSPlatform, type ProcessResult } from "jive-abstract-library";
import { modules } from "@/modules";
import type { ConnectedYubiKey, IYubiKey } from "./interface";

const YKMAN_COMMAND = "ykman";
const PIN_PREFIX = "PIN:";

export class YubiKeyImpl extends implementing(modules.yubikey).uses(OSPlatform) implements IYubiKey {
  *listConnectedDevices(): EffectGen<ConnectedYubiKey[]> {
    const listedDevices = yield* this.runYkman(["list"]);
    const listedSerials = yield* this.runYkman(["list", "--serials"]);
    if (e.Option.isNone(listedDevices) || listedDevices.value.exitCode !== 0) {
      return [];
    }
    if (e.Option.isNone(listedSerials) || listedSerials.value.exitCode !== 0) {
      return [];
    }

    const displayLines = listedDevices.value.stdout
      .split("\n")
      .map(line => line.trim())
      .filter(Boolean);
    const serialLines = listedSerials.value.stdout
      .split("\n")
      .map(line => line.trim())
      .filter(Boolean);

    return serialLines.map((serial, index) => ({
      serial,
      name: e.Option.fromUndefinedOr(displayLines[index]),
    }));
  }

  *ensurePinConfigured(serial: string): EffectGen<boolean> {
    const info = yield* this.runYkman(["--device", serial, "fido", "info"]);
    if (e.Option.isNone(info) || info.value.exitCode !== 0) {
      const stderr = e.Option.isSome(info) ? info.value.stderr.trim() : "";
      yield* e.Effect.logWarning(stderr || `Could not inspect YubiKey ${serial} FIDO PIN status.`);
      return false;
    }

    const pinStatus = readPinStatus(info.value.stdout);
    if (pinStatus === "Not set") {
      yield* e.Effect.log(`YubiKey ${serial} does not have a FIDO PIN yet. Set one now.`);
      const changed = yield* this.runYkman(["--device", serial, "fido", "access", "change-pin"], "inherit");
      return e.Option.isSome(changed) && changed.value.exitCode === 0;
    }
    if (pinStatus === "Blocked") {
      yield* e.Effect.logError(`The FIDO PIN for YubiKey ${serial} is blocked.`);
      return false;
    }
    if (pinStatus === "Disabled" || pinStatus === "Not supported" || !pinStatus) {
      yield* e.Effect.logWarning(`YubiKey ${serial} cannot be used for resident SSH keys right now (PIN: ${pinStatus || "unknown"}).`);
      return false;
    }

    return true;
  }

  *setDeviceName(_serial: string, _name: string): EffectGen<void> {
    return yield* e.Effect.die("yubikey.setDeviceName is not implemented");
  }

  /** Runs ykman, or warns how to install it and returns none when it is missing or cannot be started. */
  private *runYkman(args: ReadonlyArray<string>, stdio: "pipe" | "inherit" = "pipe"): EffectGen<e.Option.Option<ProcessResult>> {
    const osPlatform = this.dependencies.OSPlatform;
    if (e.Option.isNone(yield* osPlatform.findExecutable(YKMAN_COMMAND))) {
      yield* e.Effect.logWarning(`Install \`${YKMAN_COMMAND}\` and ensure it is on PATH.`);
      return e.Option.none();
    }
    return yield* e.pipe(
      e.Effect.gen(() => osPlatform.spawnProcess({ command: YKMAN_COMMAND, args, stdin: stdio, stdout: stdio, stderr: stdio })),
      e.Effect.option,
    );
  }
}

function readPinStatus(output: string): string {
  const pinLine = output
    .split("\n")
    .map(line => line.trim())
    .find(line => line.startsWith(PIN_PREFIX));
  if (!pinLine) {
    return "";
  }
  return pinLine.slice(PIN_PREFIX.length).trim();
}
