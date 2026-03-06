import * as e from "effect";
import { IAuth } from "@/modules";
import { loadCredentials, loadReadOnlyToken } from "./credentials";
import { warnOnMissingOpenSshAtStartup } from "./openssh";
import {
  ensureWriteTokenForActiveUser as ensureWriteTokenForActiveUserInternal,
  login as loginInternal,
  whoami as whoamiInternal,
} from "./service";

export const AuthImpl = e.Layer.effect(IAuth, e.Effect.gen(function*() {
  const warnOnMissingOpenSshAtStartupEffect = e.Effect.fn(function*() {
    warnOnMissingOpenSshAtStartup();
  })();

  const login = e.Effect.fn(function*() {
    return yield* e.Effect.promise(() => loginInternal());
  })();

  const whoami = e.Effect.fn(function*() {
    return yield* e.Effect.promise(() => whoamiInternal());
  })();

  const readOnlyToken = e.Effect.fn(function*() {
    return loadReadOnlyToken();
  })();

  const activeGitIdentity = e.Effect.fn(function*() {
    return e.Option.map(loadCredentials(), (credentials) => ({
      userName: credentials.gitUserName || credentials.email,
      userEmail: credentials.email,
      readOnlyAuthPrivateKeyPath: credentials.readOnlyAuthPrivateKeyPath,
    }));
  })();

  const ensureWriteTokenForActiveUser = e.Effect.fn(function*() {
    return yield* e.Effect.promise(() => ensureWriteTokenForActiveUserInternal());
  })();

  return {
    warnOnMissingOpenSshAtStartup: warnOnMissingOpenSshAtStartupEffect,
    login,
    whoami,
    readOnlyToken,
    activeGitIdentity,
    ensureWriteTokenForActiveUser,
  };
}));
