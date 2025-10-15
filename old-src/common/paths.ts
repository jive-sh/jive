import * as path from 'node:path';
import { gitOriginRemote, gitRepoRoot, inGitRepository } from './git';
import { REPO } from './consts';

if (!inGitRepository()) {
  console.log(`Not in the ${REPO} git repository`);
  process.exit();
}

const remote = gitOriginRemote();
let repo = remote.split(':')[1];
if (repo.endsWith('.git')) {
  repo = repo.substring(0, repo.length - '.git'.length);
}
if (repo.startsWith('//github.com/')) {
  repo = repo.substring('//github.com/'.length);
}
if (repo !== REPO) {
  console.log(`Not in the expected repo '${REPO}' found '${repo}' instead`);
  process.exit();
}

export const MONOREPO_ROOT = path.resolve(gitRepoRoot());

export const PACKAGES_ROOT = path.resolve(MONOREPO_ROOT, 'packages');
