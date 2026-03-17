import * as e from "effect";
import * as modules from "../index";
import { IYubiKey, type ConnectedYubiKey } from "./interface";

const YKMAN_COMMAND = "ykman" as const;
const PIN_PREFIX = "PIN:" as const;

export const YubiKeyImpl = e.Layer.effect(IYubiKey, e.Effect.gen(function*() {
  const hostShell = yield* modules.IHostShell;

  const run = e.Effect.fn(function*(args: readonly string[]) {
    const verifiedYkman = yield* hostShell.getCommand(YKMAN_COMMAND).pipe(
      e.Effect.map(e.Option.some),
      e.Effect.catchTag("CommandNotFoundError", () => e.Effect.succeed(e.Option.none())),
    );
    if (e.Option.isNone(verifiedYkman)) return e.Option.none<{ exitCode: number; stderr: string; stdout: string }>();

    return yield* hostShell.run({
      args,
      env: {},
    })(verifiedYkman.value).pipe(
      e.Effect.map((result) => e.Option.some(result)),
      e.Effect.catchAll(() => e.Effect.succeed(e.Option.none())),
    );
  });

  return {
    listConnectedDevices: e.Effect.fn(function*() {
      const listed = yield* run(["list"]);
      const serials = yield* run(["list", "--serials"]);

      if (e.Option.isNone(listed) || listed.value.exitCode !== 0) return [] as ConnectedYubiKey[];
      if (e.Option.isNone(serials) || serials.value.exitCode !== 0) return [] as ConnectedYubiKey[];

      const labels = listed.value.stdout
        .split("\n")
        .map((line: string) => line.trim())
        .filter(Boolean);
      const values = serials.value.stdout
        .split("\n")
        .map((line: string) => line.trim())
        .filter(Boolean);

      return values.map((serial: string, index: number) => ({
        serial,
        label: labels[index] ?? `YubiKey ${serial}`,
      }));
    })(),
    ensurePinConfigured: e.Effect.fn(function*(serial: string) {
      yield* e.Effect.log("Checking the selected YubiKey FIDO PIN setup...");

      const info = yield* run(["--device", serial, "fido", "info"]);

      if (e.Option.isNone(info) || info.value.exitCode !== 0) {
        const errorOutput = e.Option.isSome(info) ? info.value.stderr.trim() : "";
        if (errorOutput) {
          yield* e.Effect.logWarning(`Could not inspect the selected YubiKey FIDO status: ${errorOutput}`);
        } else {
          yield* e.Effect.logWarning("Could not inspect the selected YubiKey FIDO status.");
        }
        return false;
      }

      const pinStatus = readPinStatus(info.value.stdout);
      if (pinStatus === "Not set") {
        yield* e.Effect.log("This YubiKey does not have a FIDO PIN yet. Set one now.");

        const verifiedYkman = yield* hostShell.getCommand(YKMAN_COMMAND).pipe(
          e.Effect.map(e.Option.some),
          e.Effect.catchTag("CommandNotFoundError", () => e.Effect.succeed(e.Option.none())),
        );
        if (e.Option.isNone(verifiedYkman)) return false;

        const changed = yield* hostShell.runInheritIO({
          args: ["--device", serial, "fido", "access", "change-pin"],
          env: {},
        })(verifiedYkman.value).pipe(
          e.Effect.map((result) => e.Option.some(result)),
          e.Effect.catchAll(() => e.Effect.succeed(e.Option.none())),
        );

        return e.Option.isSome(changed) && changed.value.exitCode === 0;
      }

      if (pinStatus === "Blocked") {
        yield* e.Effect.logError("The selected YubiKey FIDO PIN is blocked.");
        return false;
      }

      if (pinStatus && pinStatus !== "Disabled" && pinStatus !== "Not supported") return true;

      if (pinStatus) {
        yield* e.Effect.logWarning(`The selected YubiKey cannot be used for resident SSH keys right now: PIN is ${pinStatus}.`);
      } else {
        yield* e.Effect.logWarning("Could not determine whether the selected YubiKey has a FIDO PIN configured.");
      }
      return false;
    }),
  };
}));

function readPinStatus(output: string): string {
  const line = output
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry.startsWith(PIN_PREFIX));

  if (!line) return "";
  return line.slice(PIN_PREFIX.length).trim();
}
