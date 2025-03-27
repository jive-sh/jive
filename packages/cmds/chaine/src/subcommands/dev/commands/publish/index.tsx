import * as React from 'react';
import { getProjectPath, ProjectType } from '../../../../common/projects';
import { Exit } from '../../../../common/exit';
import { Text } from 'ink';
import * as path from 'path';
import { run } from '../../../../common/run';
import { getCommitSHA } from '../../../../common/git';
import * as fs from 'fs';

export const Publish: React.FC<{packageName: string, projectType: ProjectType}> = ({packageName, projectType}) => {
  const [done, setDone] = React.useState(false);
  const maybeProjectPath = getProjectPath(packageName);
  React.useEffect(() => {
    if (!maybeProjectPath.success) return;
    const { path: projectPath, type } = maybeProjectPath.value;
    const buildPath = path.resolve(projectPath, 'build');
    const packageJSONPath = path.resolve(buildPath, 'package.json');
    const packageJSON = JSON.parse(fs.readFileSync(packageJSONPath).toString());
    const {name, tarball} = packageJSON;
    const scope = name.split('/')[0];
    const registry = 'npm.pkg.github.com';
    run(`npx pnpm set ${scope}:registry=https://${registry}`, buildPath);
    run(`npx pnpm set //${registry}/:_authToken=$\{PUBLISH_AUTH_TOKEN\}`, buildPath);
    run(`npx pnpm publish ${tarball} --tag ${getCommitSHA()}`, buildPath);
    setDone(true);
  }, []);
  if (!maybeProjectPath.success) {
    return <Text>
      Invalid package name {packageName}: {maybeProjectPath.reason}
      <Exit />
    </Text>
  }
  return <>
    {done && <Exit />}
  </>
}
