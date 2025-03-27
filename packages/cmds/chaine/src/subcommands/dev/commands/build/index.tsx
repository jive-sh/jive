import * as React from 'react';
import { getProjectPath, ProjectType } from '../../../../common/projects';
import { Text } from 'ink';
import { Exit } from '../../../../common/exit';
import { buildApp } from './app';

const BuildImpls: {
  [projectType in ProjectType]: 
    (props: {projectPath: string; packageName: string;}) => void
} = {
  [ProjectType.Application]: buildApp,
  // TODO: implement
  [ProjectType.Command]: buildApp,
  [ProjectType.Library]: buildApp,
  [ProjectType.Service]: buildApp
}

export const Build: React.FC<{packageName: string, projectType: ProjectType}> = ({packageName, projectType}) => {
  const [done, setDone] = React.useState(false);
  const maybeProjectPath = getProjectPath(packageName);
  React.useEffect(() => {
    if (!maybeProjectPath.success) return;
    const {path, type} = maybeProjectPath.value;
    BuildImpls[type]({projectPath: path, packageName});
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
