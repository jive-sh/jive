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
  public toString() {
    return this.packageName();
  }
}
