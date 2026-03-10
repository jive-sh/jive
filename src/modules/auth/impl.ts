import * as e from "effect";
import * as modules from "../index";
import { signingKeyName } from "./constants";
import { loadCredentials, loadReadOnlyToken } from "./credentials";
import type { AuthHostShell } from "./host-shell";
import { SSH_KEYGEN_COMMAND } from "./openssh";
import {
  ensureLoggedIn as ensureLoggedInInternal,
  login as loginInternal,
  whoami as whoamiInternal,
} from "./service";

export const AuthImpl = e.Layer.effect(modules.IAuth, e.Effect.gen(function*() {
  const git = yield* modules.IGit;
  const github = yield* modules.IGitHub;
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

  const dependencies = { git, github, hostShell: authHostShell, toolState, yubiKey };
  const login = loginInternal(dependencies);
  const ensureLoggedIn = ensureLoggedInInternal(dependencies);
  const whoami = whoamiInternal(dependencies);

  return {
    requiredCLICommands: [SSH_KEYGEN_COMMAND],
    login,
    ensureLoggedIn,
    whoami,
    readOnlyToken: loadReadOnlyToken(toolState),
    activeGitIdentity: e.Effect.gen(function*() {
      yield* ensureLoggedIn;

      const credentials = yield* loadCredentials(toolState);
      if (e.Option.isNone(credentials)) return e.Option.none();

      const currentUser = yield* toolState.readCurrentUserState;
      const residentKeys = yield* yubiKey.listResidentJiveKeys;
      const githubJiveKeys = yield* github.listJiveKeys(credentials.value.readOnlyToken);
      const signingPublicKey = e.Option.isSome(currentUser) && e.Option.isSome(residentKeys) && e.Option.isSome(githubJiveKeys)
        ? residentKeys.value.find((key) =>
          key.name === signingKeyName(credentials.value.email, currentUser.value.yubiKeyId)
          && githubJiveKeys.value.signing.some((entry) =>
            entry.title === key.name && normalizeKeyBody(entry.key) === key.keyBody
          )
        )?.publicKey
        : undefined;

      return e.Option.some({
        userName: credentials.value.gitUserName || credentials.value.email,
        userEmail: credentials.value.email,
        readOnlyAuthPrivateKeyPath: credentials.value.readOnlyAuthPrivateKeyPath,
        signingPublicKey,
      });
    }),
  };
}));

function normalizeKeyBody(key: string): string {
  const parts = key.trim().split(/\s+/);
  if (parts.length < 2) return key.trim();
  return `${parts[0]} ${parts[1]}`;
}
