import { readdir, exists, readFile } from "node:fs/promises";
import { MONOREPO_ROOT } from './paths';
import * as path from "node:path";
import { type Result, Ok, Err } from './result';
import { log } from "./log";

export const COMPANY_NAME = 'chaine'
export const ORG_NAME = `@${COMPANY_NAME}`;

export enum ProjectType {
  Command = "cmd",
  Library = "lib",
  Service = "svc"
}

export const ProjectTypeToFolder: {[projectType in ProjectType]: string} = {
  [ProjectType.Command]: 'commands',
  [ProjectType.Library]: 'libraries',
  [ProjectType.Service]: 'services'
}

export function getPrefix(projectType: ProjectType): string {
  return `${ORG_NAME}-${projectType}/`;
}

export function getProjectType(packageName: string): Result<ProjectType, null> {
  const projectTypes = Object.values(ProjectType);
  for (const projectType of projectTypes) {
    const prefix = getPrefix(projectType);
    if (packageName.startsWith(prefix)) {
      return Ok({value: projectType});
    }
  }
  return Err({error: null, reason: `'${packageName}' does not conform to the package naming convention`});
}

export type Projects = {
  [projectType in ProjectType]: Set<string>;
}

let cacheInitialized = false;
let cache: Projects = blankCache();

function blankCache(): Projects {
  return Object.fromEntries(Object.values(ProjectType).map(pt => [pt, new Set()])) as Projects;
}

enum PackageNameErrors {
  NoPackageJson = 'NoPackageJson',
  InvalidJson = 'InvalidJson',
  InvalidName = 'InvalidName',
  MismatchedProjectType = 'MismatchedProjectType'
}

async function getPackageName(dir: string): Promise<Result<{name: string, type: ProjectType}, PackageNameErrors>> {
  const packageJsonPath = path.resolve(dir, 'package.json');
  function shortenPath(longPath: string) {
    return longPath.substring(MONOREPO_ROOT.length);
  }
  if (!(await exists(packageJsonPath))) {
    return Err({error: PackageNameErrors.NoPackageJson, reason: `No such file ${shortenPath(packageJsonPath)}`});
  }
  const contents = (await readFile(packageJsonPath)).toString();
  let packageJson;
  try {
    packageJson = JSON.parse(contents);
  } catch (e) {
    const error = e as Error;
    return Err({error: PackageNameErrors.InvalidJson, reason: error.message});
  }
  const name = packageJson.name as string | undefined;
  if (!name) {
    return Err({
      error: PackageNameErrors.InvalidName,
      reason: `No name field present in ${shortenPath(packageJsonPath)}`
    });
  }
  const maybeProjectType = await getProjectType(name);
  if (!maybeProjectType.success) {
    return Err({
      error: PackageNameErrors.InvalidName,
      reason: maybeProjectType.reason
    });
  }
  const prefix = getPrefix(maybeProjectType.value);
  const expectedName = name.substring(prefix.length);
  const lastDirSegment = dir.split('/').pop();
  if (expectedName !== lastDirSegment) {
    return Err({
      error: PackageNameErrors.InvalidName,
      reason: `dir is '${lastDirSegment}' so expected package name of '${prefix}${lastDirSegment}' but found '${name}'`
    });
  }
  return Ok({value: {name, type: maybeProjectType.value}});
}

export async function getProjects(invalidateCache = false): Promise<Projects> {
  if (invalidateCache) cacheInitialized = false;
  if (cacheInitialized) return cache;
  cache = blankCache();
  const badPackages: Record<string, Err<PackageNameErrors>> = {}; // package name to problem
  for (const projectType of Object.values(ProjectType)) {
    const dirname = ProjectTypeToFolder[projectType];
    const projectTypePath = path.resolve(MONOREPO_ROOT, dirname);
    const children = await readdir(projectTypePath);
    for (const child of children) {
      const childPath = path.resolve(projectTypePath, child);
      const maybeName = await getPackageName(childPath);
      const shortenedPath = childPath.substring(MONOREPO_ROOT.length);
      if (!maybeName.success) {
        badPackages[shortenedPath] = maybeName;
      } else if (maybeName.value.type !== projectType) {
        badPackages[shortenedPath] = Err({
          error: PackageNameErrors.MismatchedProjectType,
          reason: `Expected project type '${projectType}' but name '${maybeName.value.name}' in package.json suggests type of '${maybeName.value.type}'`
        });
      } else {
        cache[projectType].add(maybeName.value.name);
      }
    }
  }
  let atLeastOneBadPackage = false;
  for (const badPackage in badPackages) {
    atLeastOneBadPackage = true;
    log(`${badPackage}: ${badPackages[badPackage].reason}`);
  }
  if (atLeastOneBadPackage) {
    process.exit();
  }
  cacheInitialized = true;
  return cache;
}
