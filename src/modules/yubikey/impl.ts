import * as e from "effect";
import * as modules from "@/modules";
import type { VerifiedCommand } from "@/modules/host-shell/interface";
import { IYubiKey, type ConnectedYubiKey } from "./interface";

const YKMAN_COMMAND = "ykman";
const PIN_PREFIX = "PIN:";

export const YubiKeyImpl = e.Layer.effect(IYubiKey, e.Effect.gen(function*() {
  const hostShell = yield* modules.IHostShell;
  const hostEnv = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );

  const getYkman = e.Effect.gen(function*() {
    return yield* e.pipe(
      hostShell.getCommand(YKMAN_COMMAND),
      e.Effect.map(command => e.Option.some(command)),
      e.Effect.catchTag("CommandNotFoundError", error =>
        e.Effect.gen(function*() {
          yield* e.Effect.logWarning(error.installInstructions);
          return e.Option.none<VerifiedCommand>();
        }),
      ),
    );
  });

  const runYkman = e.Effect.fn(function*(args: readonly string[]) {
    const maybeYkman = yield* getYkman;
    if (e.Option.isNone(maybeYkman)) {
      return e.Option.none<{ exitCode: number; stderr: string; stdout: string }>();
    }
    return yield* e.pipe(
      hostShell.run({
        args,
        env: hostEnv,
      })(maybeYkman.value),
      e.Effect.map(result => e.Option.some(result)),
      e.Effect.catchTag("BadArgument", "SystemError", () =>
        e.Effect.succeed(e.Option.none<{ exitCode: number; stderr: string; stdout: string }>()),
      ),
    );
  });

  const runYkmanInteractive = e.Effect.fn(function*(args: readonly string[]) {
    const maybeYkman = yield* getYkman;
    if (e.Option.isNone(maybeYkman)) {
      return false;
    }
    const { exitCode } = yield* e.pipe(
      hostShell.runInheritIO({
        args,
        env: hostEnv,
      })(maybeYkman.value),
      e.Effect.catchTag("BadArgument", "SystemError", error => e.Effect.die(error)),
    );
    return exitCode === 0;
  });

  return {
    listConnectedDevices: e.Effect.gen(function*() {
      const listedDevices = yield* runYkman(["list"]);
      const listedSerials = yield* runYkman(["list", "--serials"]);
      if (e.Option.isNone(listedDevices) || listedDevices.value.exitCode !== 0) {
        return [] as ConnectedYubiKey[];
      }
      if (e.Option.isNone(listedSerials) || listedSerials.value.exitCode !== 0) {
        return [] as ConnectedYubiKey[];
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
        name: displayLines[index] ? e.Option.some(displayLines[index]!) : e.Option.none<string>(),
      }));
    }),
    ensurePinConfigured: e.Effect.fn(function*(serial: string) {
      const info = yield* runYkman(["--device", serial, "fido", "info"]);
      if (e.Option.isNone(info) || info.value.exitCode !== 0) {
        const stderr = e.Option.isSome(info) ? info.value.stderr.trim() : "";
        yield* e.Effect.logWarning(
          stderr || `Could not inspect YubiKey ${serial} FIDO PIN status.`,
        );
        return false;
      }

      const pinStatus = readPinStatus(info.value.stdout);
      if (pinStatus === "Not set") {
        yield* e.Effect.log(`YubiKey ${serial} does not have a FIDO PIN yet. Set one now.`);
        return yield* runYkmanInteractive(["--device", serial, "fido", "access", "change-pin"]);
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
    }),
    setDeviceName: e.Effect.fn(function*(_serial: string, _name: string) {
      return yield* e.Effect.dieMessage("yubikey.setDeviceName is not implemented");
    }),
  };
}));

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
