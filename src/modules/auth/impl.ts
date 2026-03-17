import * as e from "effect";
import * as modules from "@/modules";
import { loadCredentials } from "./credentials";
import { type CurrentUser, NotLoggedInError } from "./interface";
import {
  type AuthGitService,
  ensureLoggedIn as ensureLoggedInInternal,
  login as loginInternal,
} from "./service";

export const AuthImpl = e.Layer.effect(modules.IAuth, e.Effect.gen(function*() {
  const git = (yield* modules.IGit) as unknown as AuthGitService;
  const github = yield* modules.IGitHub;
  const hostShell = yield* modules.IHostShell;
  const ssh = yield* modules.ISsh;
  const toolState = yield* modules.IToolState;
  const yubiKey = yield* modules.IYubiKey;
  const currentUserFromCredentials = (credentials: {
    readonly email: string;
    readonly gitUserName: string;
    readonly githubUsername: string;
    readonly readOnlyToken: string;
  }): CurrentUser => ({
    preferredEmail: e.Option.some(credentials.email),
    userName: credentials.gitUserName || credentials.githubUsername || credentials.email,
    userEmail: credentials.email,
    readonlyToken: credentials.readOnlyToken,
  });
  const dependencies = {
    git,
    github,
    hostShell: {
      hasCommand: e.Effect.fn(function*(command: string) {
        return yield* hostShell.getCommand(command).pipe(
          e.Effect.as(true),
          e.Effect.catchTag("CommandNotFoundError", () => e.Effect.succeed(false)),
        );
      }),
    },
    ssh,
    toolState,
    yubiKey,
  };

  return {
    assertLoggedIn: e.Effect.gen(function*() {
      const credentials = yield* loadCredentials(toolState);
      if (e.Option.isNone(credentials)) {
        return yield* e.Effect.fail(new NotLoggedInError());
      }

      return currentUserFromCredentials(credentials.value);
    }),
    ensureLoggedIn: (opts: { chooseNewUser: boolean }) => e.Effect.gen(function*() {
      yield* (opts.chooseNewUser ? loginInternal(dependencies) : ensureLoggedInInternal(dependencies));

      const credentials = yield* loadCredentials(toolState);
      if (e.Option.isNone(credentials)) {
        return yield* e.Effect.fail(new NotLoggedInError());
      }

      return currentUserFromCredentials(credentials.value);
    }) as e.Effect.Effect<CurrentUser>,
  };
}));
