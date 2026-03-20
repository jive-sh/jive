import * as e from "effect";
import * as modules from "@/modules";
import { NotLoggedInError } from "./interface";
import { type GithubWriteToken } from "@/modules/github/interface";
import { selectSshKey } from "./ssh-key-selection";
import { warnOnInaccessibleRepos } from "./warn-on-inaccessible-repos";

export const AuthImpl = e.Layer.effect(modules.IAuth, e.Effect.gen(function*() {
  const git = yield* modules.IGit;
  const github = yield* modules.IGitHub;
  const toolState = yield* modules.IToolState;
  const ssh = yield* modules.ISsh;
  const yubikey = yield* modules.IYubiKey;

  const tokenUnusable = e.Effect.gen(function*() {
    const maybeUserState = yield* toolState.readCurrentUserState;
    const usable = yield* e.pipe(
      maybeUserState,
      e.Option.match({
        onNone: () => e.Effect.succeed(false),
        onSome: e.flow(
          userState => userState.accessTokenState,
          github.resolveAccessToken,
          e.Effect.option,
          e.Effect.map(e.Option.isSome),
        )
      }),
    );
    return !usable;
  });

  const getWriteTokenIfMissing = e.Effect.fn(function*(username: string, maybeWriteToken: e.Option.Option<GithubWriteToken>) {
    if (e.Option.isSome(maybeWriteToken)) return maybeWriteToken.value;
    const {writeToken} = yield* github.oauthLogin(username);
    return writeToken;
  });

  return {
    assertLoggedIn: e.Effect.fn(function*() {
      yield* toolState.assertInWorkspace;
      const maybeCurrentUserState = yield* toolState.readCurrentUserState;
      if (e.Option.isNone(maybeCurrentUserState)) {
        return yield* modules.BadPreconditionsError.fromNotLoggedInError(new NotLoggedInError({}));
      }
      const currentUserState = maybeCurrentUserState.value;
      const {accessToken} = yield* e.pipe(
        github.resolveAccessToken(currentUserState.accessTokenState),
        e.Effect.catchTag("UnableToRefreshAccessTokenError", err => modules.BadPreconditionsError.fromNotLoggedInError(new NotLoggedInError({
          reason: err.expired ?
            e.Option.isSome(currentUserState.accessTokenState.expiration) ?
              "access token and refresh tokens expired" :
              "access token expired w/ no refresh token"
              :
            "failed to refresh access token"
        })))
      );
      if (e.Option.isNone(currentUserState.sshKey)) {
        return yield* modules.BadPreconditionsError.fromNotLoggedInError(new NotLoggedInError({reason: "no ssh key found"}));
      }
      const sshKey = currentUserState.sshKey.value;
      const registeredSshKey = yield* github.sshKeyExists(accessToken, sshKey);
      if (!registeredSshKey.authn || !registeredSshKey.signing) {
        return yield* modules.BadPreconditionsError.fromNotLoggedInError(new NotLoggedInError({
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
    }, e.flow(
      e.Effect.catchTag("NotInWorkspaceError", modules.BadPreconditionsError.fromNotInWorkspaceError)
    ))(),
    ensureLoggedIn: e.Effect.fn(function*({chooseNewUser}) {
      yield* toolState.assertInWorkspace;
      if (chooseNewUser || (yield* tokenUnusable)) {
        yield* toolState.clearCurrentUserState;
      }
      const {user, maybeWriteToken} = yield* e.pipe(
        toolState.readCurrentUserState,
        e.Effect.flatMap(e.Option.match({
          onSome: user => e.Effect.succeed({
            user,
            maybeWriteToken: e.Option.none()
          }),
          onNone: e.Effect.fn(function*() {
            const {accessTokenState, writeToken, email, username} = yield* github.oauthLogin();
            const newUserState = yield* toolState.setUser({email, username, accessToken: accessTokenState});
            return {user: newUserState, maybeWriteToken: e.Option.some(writeToken)};
          })
        })
      ));
      const {accessToken} = yield* e.pipe(
        github.resolveAccessToken(user.accessTokenState),
        e.Effect.catchTag("UnableToRefreshAccessTokenError", err => e.Effect.dieMessage("IMPOSSIBLE TOKEN UNREFRESHABLE DESPITE PRIOR CLEAR"))
      );
      const sshKey = yield* toolState.usingTempDirectory(e.Effect.fn(function*(tempPath) {
        const sshKey = yield* e.pipe(
          selectSshKey(user.email, tempPath),
          e.Effect.catchTag("CreateSshKeyOnYubikeyError", e.Effect.fn(function*({reason}) {
            yield* e.Effect.logError(`Failed to create ssh key on yubikey (${reason})`);
            return yield* e.Effect.die(undefined);
          })),
          e.Effect.provideService(modules.ISsh, ssh),
          e.Effect.provideService(modules.IYubiKey, yubikey)
        );
        // We need to move the ssh key from the temp folder to the current user location before the temp folder is cleared
        const {newUserState} = yield* toolState.setSshKey(sshKey);
        return yield* e.pipe(
          newUserState.sshKey,
          e.Option.match({
            onNone: () => e.Effect.dieMessage("IMPOSSIBLE TO NOT HAVE SSH KEY SET"),
            onSome: newKey => e.Effect.succeed(newKey)
          })
        );
      }))
      const registeredSshKey = yield* github.sshKeyExists(accessToken, sshKey);
      if (!registeredSshKey.authn || !registeredSshKey.signing) {
        yield* github.setSshKey(yield* getWriteTokenIfMissing(user.username, maybeWriteToken), sshKey);
      }
      // We want to warn the user of all repos which they don't have access to
      yield* e.pipe(
        warnOnInaccessibleRepos(accessToken),
        e.Effect.provideService(modules.IGit, git),
        e.Effect.provideService(modules.IGitHub, github),
      );
      return {
        email: user.email,
        username: user.username,
        githubAccessToken: accessToken,
        sshKey
      };
    }, e.flow(
      e.Effect.catchTag("NotInWorkspaceError", modules.BadPreconditionsError.fromNotInWorkspaceError)
    ))
  };
}));
