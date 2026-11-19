import * as e from "effect";

/**
 * The name and email a workspace's commits carry, git's `user.name` and `user.email`. A workspace has one, kept in its
 * root repository's own git config and copied into every repository jive configures in it; a second persona is a
 * second workspace (Alex, 2026-11-19: "a jive workspace has one git repo. If someone wants multiple personas have
 * multiple jive workspaces").
 */
export interface GitIdentity {
  readonly name: string;
  readonly email: string;
}

/** git ends a name or email at `<`, `>` or a line break, so a value holding one would not survive into a commit. */
const OUTSIDE_A_GIT_IDENT = /[<>\n\r]/;

/** A name and email as typed, trimmed, or why git couldn't put them in a commit. */
export function parseGitIdentity({ name, email }: { readonly name: string; readonly email: string }): e.Result.Result<GitIdentity, string> {
  const identity = { name: name.trim(), email: email.trim() };
  if (identity.name === "" || OUTSIDE_A_GIT_IDENT.test(identity.name)) {
    return e.Result.fail("a git name is not empty and holds no <, > or line break");
  }
  if (!identity.email.includes("@") || OUTSIDE_A_GIT_IDENT.test(identity.email) || /\s/.test(identity.email)) {
    return e.Result.fail("a git email has an @ and holds no spaces, <, > or line break");
  }
  return e.Result.succeed(identity);
}
