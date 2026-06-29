import { Option, Effect, pipe } from "effect";
import { modules } from "@/modules";
import { BadArgumentError, BadPreconditionsError } from "@/errors";
import { NotLoggedInError, type CurrentUser, type IAuth } from "./interface";
import { type GithubWriteToken } from "@/modules/github/interface";
import { selectSshKey } from "./ssh-key-selection";
import { warnOnInaccessibleRepos } from "./warn-on-inaccessible-repos";
import { effunct, Implementing } from "effective-modules";

export class AuthImpl extends Implementing(modules.auth).Uses(modules.git, modules.github, modules.toolState, modules.ssh, modules.yubikey) implements IAuth {
  *assertLoggedIn(): Effect.fn.Return<CurrentUser, BadArgumentError | BadPreconditionsError> {
    const { toolState, github } = this.dependencies;
    yield* pipe(
      toolState.assertInWorkspace,
      Effect.catchTag("NotInWorkspaceError", BadPreconditionsError.fromNotInWorkspaceError)
    );
    const maybeCurrentUserState = yield* toolState.readCurrentUserState;
    if (Option.isNone(maybeCurrentUserState)) {
      return yield* BadPreconditionsError.fromNotLoggedInError(new NotLoggedInError({}));
    }
    const currentUserState = maybeCurrentUserState.value;
    const {accessToken} = yield* github.resolveAccessToken(currentUserState);
    if (Option.isNone(currentUserState.sshKey)) {
      return yield* BadPreconditionsError.fromNotLoggedInError(new NotLoggedInError({reason: "no ssh key found"}));
    }
    const sshKey = currentUserState.sshKey.value;
    const registeredSshKey = yield* github.sshKeyExists(accessToken, sshKey);
    if (!registeredSshKey.authn || !registeredSshKey.signing) {
      return yield* BadPreconditionsError.fromNotLoggedInError(new NotLoggedInError({
        reason: `ssh key ${sshKey.name} is missing from github ${[
          !registeredSshKey.authn ? "auth keys" : "",
          !registeredSshKey.signing ? "signing keys" : "",
        ].filter(Boolean).join(" and ")}`,
      }));
    }
    // For validating that the yubikey is plugged in which contains the chosen ssh-key, we let this failure 
    // happen when user tries to sign something (otherwise, to check the yubikey, it would require user PIN).
    // We don't want that since assertLogin is used in cases where we are doing non-signin behaviors.
    return {
      username: currentUserState.username,
      email: currentUserState.email,
      githubAccessToken: accessToken,
      sshKey
    };
  }

  *ensureLoggedIn({ chooseNewUser }: { chooseNewUser: boolean }): Effect.fn.Return<CurrentUser, BadArgumentError | BadPreconditionsError> {
    const { toolState, github } = this.dependencies;
    yield* pipe(
      toolState.assertInWorkspace,
      Effect.catchTag("NotInWorkspaceError", BadPreconditionsError.fromNotInWorkspaceError)
    );
    if (chooseNewUser || (yield* effunct(this.tokenUnusable)())) {
      yield* Effect.log(`Starting fresh session`);
      yield* toolState.clearCurrentUserState;
    }
    const {user, maybeWriteToken} = yield* pipe(
      toolState.readCurrentUserState,
      Effect.flatMap(Option.match({
        onSome: user => Effect.succeed({
          user,
          maybeWriteToken: Option.none()
        }),
        onNone: Effect.fn(function*() {
          const {accessTokenState, writeToken, email, username} = yield* github.oauthLogin();
          const newUserState = yield* toolState.setUser({email, username, accessToken: accessTokenState});
          return {user: newUserState, maybeWriteToken: Option.some(writeToken)};
        })
      })
    ));
    const {accessToken} = yield* github.resolveAccessToken(user);
    const { context } = this;
    const sshKey = yield* toolState.usingTempDirectory(Effect.fn(function*(tempPath) {
      const sshKey = yield* pipe(
        effunct(selectSshKey)(user.email, tempPath),
        Effect.catchTag("CreateSshKeyOnYubikeyError", Effect.fn(function*({reason}) {
          yield* Effect.logError(`Failed to create ssh key on yubikey (${reason})`);
          return yield* Effect.die(undefined);
        })),
        Effect.provide(context)
      );
      // We need to move the ssh key from the temp folder to the current user location before the temp folder is cleared
      const {newUserState} = yield* toolState.setSshKey(sshKey);
      return yield* pipe(
        newUserState.sshKey,
        Option.match({
          onNone: () => Effect.dieMessage("IMPOSSIBLE TO NOT HAVE SSH KEY SET"),
          onSome: newKey => Effect.succeed(newKey)
        })
      );
    }))
    const registeredSshKey = yield* github.sshKeyExists(accessToken, sshKey);
    if (!registeredSshKey.authn || !registeredSshKey.signing) {
      yield* github.setSshKey(yield* this.getWriteTokenIfMissing(user.username, maybeWriteToken), sshKey);
    }
    // We want to warn the user of all repos which they don't have access to
    yield* e.pipe(
      warnOnInaccessibleRepos(accessToken),
      e.Effect.provide(context)
    );
    return {
      email: user.email,
      username: user.username,
      githubAccessToken: accessToken,
      sshKey
    };
  }
  private *tokenUnusable(): GenEffect<boolean> {
    const maybeUserState = yield* this.dependencies.toolState.readCurrentUserState;
    const usable = yield* e.pipe(
      maybeUserState,
      e.Option.match({
        onNone: () => e.Effect.succeed(false),
        onSome: e.flow(
          effunct(this.dependencies.github.resolveAccessToken),
          e.Effect.tapErrorTag("BadArgumentError", e.Effect.fn(function*({argument, reason}) {
            yield* e.Effect.log(`Existing access token is unusable due to invalid ${argument}: ${reason}`);
          })),
          e.Effect.option,
          e.Effect.map(e.Option.isSome),
        )
      }),
    );
    return !usable;
  }

  private *getWriteTokenIfMissing(username: string, maybeWriteToken: e.Option.Option<GithubWriteToken>): GenEffect<GithubWriteToken> {
    if (e.Option.isSome(maybeWriteToken)) return maybeWriteToken.value;
    const {writeToken} = yield* this.dependencies.github.oauthLogin(username);
    return writeToken;
  }
}
