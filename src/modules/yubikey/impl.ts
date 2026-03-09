import * as e from "effect";
import * as modules from "@/modules";
import { REQUIRED_OPENSSH_COMMANDS } from "@/modules/auth/openssh";
import type { AuthHostShell } from "@/modules/auth/host-shell";
import {
  createResidentJiveKey,
  listConnectedYubiKeys,
  listResidentJiveKeys,
  loadResidentJiveKeyIntoAgent,
} from "@/modules/auth/yubikey";

export const YubiKeyImpl = e.Layer.effect(modules.IYubiKey, e.Effect.gen(function*() {
  const hostShell = yield* modules.IHostShell;

  const authHostShell: AuthHostShell = {
    commandExists: hostShell.commandExists,
    missingCommands: hostShell.missingCommands,
    run: (command) =>
      hostShell.run(command).pipe(
        e.Effect.map((result) => e.Option.some(result)),
        e.Effect.catchAll(() => e.Effect.succeed(e.Option.none())),
      ),
  };

  return {
    requiredCLICommands: [...REQUIRED_OPENSSH_COMMANDS],
    listConnectedDevices: listConnectedYubiKeys(),
    listResidentJiveKeys: listResidentJiveKeys(authHostShell),
    createResidentJiveKey: (name) => createResidentJiveKey(authHostShell, name),
    loadResidentJiveKeyIntoAgent: (target) => loadResidentJiveKeyIntoAgent(authHostShell, target),
  };
}));
