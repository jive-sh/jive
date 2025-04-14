import * as React from 'react';
import { Text } from 'ink';
import { getProjectPath, ProjectType } from '../../../../common/projects';
import { Exit } from '../../../../common/exit';
import * as path from 'path';
import * as fs from 'fs';
import { getAPIClient } from '../../../../common/kubernetes';

export const Deploy: React.FC<{packageName: string, projectType: ProjectType}> = ({packageName, projectType}) => {
  const [done, setDone] = React.useState(false);
  const maybeProjectPath = getProjectPath(packageName);
  React.useEffect(() => {
    if (!maybeProjectPath.success) return;
    (async () => {
      const { projectPath, projectType } = maybeProjectPath.value;
      const buildPath = path.resolve(projectPath, 'build');
      const packageJSONPath = path.resolve(buildPath, 'package.json');
      const packageJSON = JSON.parse(fs.readFileSync(packageJSONPath).toString());
      const {name, tag} = packageJSON;
      console.log(`deploying '${name}' with tag '${tag}'`);
      const maybeK8sApi = await getAPIClient();
      if (!maybeK8sApi.success) {
        console.log(`Failed to init k8s API due to ${maybeK8sApi.error}: ${maybeK8sApi.reason}`);
        setDone(true);
        return;
      }
      const k8sApi = maybeK8sApi.value;
      k8sApi.createNamespaceDeplo
      setDone(true);
    })();
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

//const kubeConfig = new k8s.KubeConfig();
//kubeConfig.loadFromCluster();