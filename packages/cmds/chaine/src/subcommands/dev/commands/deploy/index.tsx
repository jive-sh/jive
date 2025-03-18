import * as React from 'react';
import { Text } from 'ink';
import { ProjectType } from '../../../../common/projects';
import { Exit } from '../../../../common/exit';

export const Deploy: React.FC<{packageName: string, projectType: ProjectType}> = ({packageName, projectType}) => {
  return <Text>
    Deploying {projectType} named '{packageName}'
    <Exit />
  </Text>
}
