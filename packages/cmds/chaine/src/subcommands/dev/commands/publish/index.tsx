import * as React from 'react';
import { getProjectPath, ProjectType } from '../../../../common/projects';
import { Exit } from '../../../../common/exit';
import { Text } from 'ink';
import * as path from 'path';
import { run } from '../../../../common/run';
import * as fs from 'fs';

export const Publish: React.FC<{packageName: string, projectType: ProjectType}> = ({packageName, projectType}) => {
  const [done, setDone] = React.useState(false);
  const maybeProjectPath = getProjectPath(packageName);
  React.useEffect(() => {
    if (!maybeProjectPath.success) return;
    const { path: projectPath, type } = maybeProjectPath.value;
    const buildPath = path.resolve(projectPath, 'build');
    run('ls -la', buildPath);
    console.log(fs.readdirSync(buildPath));
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
