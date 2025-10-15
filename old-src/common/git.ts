import * as child_process from 'node:child_process';
import * as fs from 'fs';

export function inGitRepository(): boolean {
  try {
    // This command checks if the .git directory exists in the current directory
    child_process.execSync(
      `git rev-parse --is-inside-work-tree`, 
      {stdio: ['pipe', 'ignore', 'ignore']}
    );
    return true;
  } catch (error) {
    console.log('is inside work tree error', error);
    return false;
  }
}

export function gitOriginRemote(): string {
  const remoteOriginUrl = child_process.execSync('git config --get remote.origin.url').toString().trim();
  return remoteOriginUrl;
}

export function gitRepoRoot(): string {
  return child_process.execSync(`git rev-parse --show-toplevel`).toString().trim();
}

export function gitChangedFiles(): string[] {
  const gitDiffOutput = child_process.execSync(
    `git diff --name-only HEAD~1`,
    {stdio: ['pipe', 'pipe', 'ignore']}
  ).toString();
  const changedFiles = gitDiffOutput.split("\n");
  return changedFiles;
}

export function getCommitSHA() {
  return child_process.execSync(`git rev-parse HEAD`).toString().trim();
}

export function setGHAOutput(k: string, v: string) {
  const ghaOutputFile = process.env['GITHUB_OUTPUT'] ?? "/dev/null";
  const outputLine = `${k}=${v}`;
  console.log(`Writing '${outputLine}' to '${ghaOutputFile}'`)
  fs.appendFileSync(ghaOutputFile, outputLine);
}
