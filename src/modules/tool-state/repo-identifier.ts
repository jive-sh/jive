import * as e from "effect";
import * as path from "node:path";
import { BadArgumentError, modules } from "@/modules";

export class RepoIdentifier {
  public constructor(
    public readonly org: string,
    public readonly repo: string
  ) {}
  public packageName() {
    return `${this.orgName()}/${this.repo}`;
  }
  public orgName() {
    return `@${this.org}`;
  }
  public equals(other: RepoIdentifier) {
    return other.packageName() === this.packageName();
  }
  public static fromRelativePath(relativePath: string): e.Effect.Effect<RepoIdentifier, BadArgumentError> {
    if (!relativePath.startsWith("@")) {
      return e.Effect.fail(new BadArgumentError({
        argument: "relative path",
        reason: "repo relative path must start with @"
      }));
    }
    if (relativePath.split("/").length !== 2) {
      return e.Effect.fail(new BadArgumentError({
        argument: "relative path",
        reason: "repo relative path must have exactly one '/' char"
      }));
    }
    const [orgName, repo] = relativePath.split("/") as [string, string];
    if (!repo) {
      return e.Effect.fail(new BadArgumentError({
        argument: "relative path",
        reason: "repo relative path cannot have empty repo directory"
      }));
    }
    const org = orgName.substring(1);
    return e.Effect.succeed(new RepoIdentifier(org, repo));
  }
}
