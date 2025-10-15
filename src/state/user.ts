import { Effect } from "effect";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { CLI_STATE_DIR } from "@/common/paths";

const USER_STATE_FILE = join(CLI_STATE_DIR, "users.json");

export type UserState = {
  readonly users: ReadonlyArray<string>;
  readonly activeUser: string | null;
};

const EMPTY_USER_STATE: UserState = {
  users: [],
  activeUser: null
};

const readUserStateFromDisk = () =>
  Effect.tryPromise({
    try: () => readFile(USER_STATE_FILE, "utf8"),
    catch: (error) => error as NodeJS.ErrnoException
  });

const parseUserState = (input: unknown): UserState => {
  if (typeof input !== "object" || input === null) {
    throw new Error("User state must be an object.");
  }

  const record = input as Record<string, unknown>;
  const users = record.users;
  const activeUser = record.activeUser;

  if (!Array.isArray(users) || users.some((value) => typeof value !== "string")) {
    throw new Error("User state 'users' must be an array of strings.");
  }

  return {
    users,
    activeUser: typeof activeUser === "string" ? activeUser : null
  };
};

export const loadUserState = readUserStateFromDisk().pipe(
  Effect.flatMap((contents) =>
    Effect.try({
      try: () => parseUserState(JSON.parse(contents)),
      catch: (error) => error as Error
    })
  ),
  Effect.catchAll((error) => {
    if (isNodeError(error) && error.code === "ENOENT") {
      return Effect.succeed(EMPTY_USER_STATE);
    }
    return Effect.fail(error);
  })
);

const isNodeError = (error: unknown): error is NodeJS.ErrnoException =>
  typeof error === "object" && error !== null && "code" in error;
