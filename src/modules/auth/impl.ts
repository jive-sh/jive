import * as e from "effect";
import * as modules from "@/modules";
import { loadCredentials, loadReadOnlyToken } from "@/modules/auth/credentials";
import type { AuthHostShell } from "@/modules/auth/host-shell";
import { SSH_KEYGEN_COMMAND } from "@/modules/auth/openssh";
import { currentBrowserOpenCommand } from "@/modules/auth/oauth";
import {
  ensureWriteTokenForActiveUser as ensureWriteTokenForActiveUserInternal,
  login as loginInternal,
  whoami as whoamiInternal,
} from "@/modules/auth/service";

export const AuthImpl = e.Layer.effect(modules.IAuth, e.Effect.gen(function*() {
  const git = yield* modules.IGit;
  const hostShell = yield* modules.IHostShell;
  const toolState = yield* modules.IToolState;
  const yubiKey = yield* modules.IYubiKey;

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
    requiredCLICommands: [currentBrowserOpenCommand(), SSH_KEYGEN_COMMAND],
    login: loginInternal({ git, hostShell: authHostShell, toolState, yubiKey }),
    whoami: whoamiInternal({ git, hostShell: authHostShell, toolState, yubiKey }),
    readOnlyToken: loadReadOnlyToken(toolState),
    activeGitIdentity: e.pipe(
      loadCredentials(toolState),
      e.Effect.map((credentials) =>
        e.Option.map(credentials, (value) => ({
          userName: value.gitUserName || value.email,
          userEmail: value.email,
          readOnlyAuthPrivateKeyPath: value.readOnlyAuthPrivateKeyPath,
        }))
      ),
    ),
    ensureWriteTokenForActiveUser: ensureWriteTokenForActiveUserInternal({
      git,
      hostShell: authHostShell,
      toolState,
      yubiKey,
    }),
  };
}));
