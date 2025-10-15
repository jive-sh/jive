import * as React from 'react';
import { Text } from 'ink';
import { ProjectType } from '../../../../common/projects';
import { Exit } from '../../../../common/exit';

export const NewPackage: React.FC<{packageName: string, projectType: ProjectType}> = ({packageName, projectType}) => {
  return <Text>
    Creating new {projectType} named '{packageName}'
    <Exit />
  </Text>
}
