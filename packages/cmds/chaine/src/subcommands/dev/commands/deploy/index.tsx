import * as React from 'react';
import { Text } from 'ink';
import { getProjectPath, ProjectType } from '../../../../common/projects';
import { Exit } from '../../../../common/exit';
import * as path from 'path';
import * as fs from 'fs';
import * as k8s from '@kubernetes/client-node';
import { getSecret } from '../../../../common/secrets-fetcher';
import { getSecretsNamespaceFromPackageName, Secrets } from '../../../../common/secrets';
import { name as cliPackageName } from '../../../../../package.json';

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
      const secretsNamespace = getSecretsNamespaceFromPackageName(cliPackageName);
      const maybeKubeConfig = await getSecret(secretsNamespace, Secrets.KUBECONFIG);
      if (!maybeKubeConfig.success) {
        console.log(`Failed to get ${Secrets.KUBECONFIG}: ${maybeKubeConfig.error}; ${maybeKubeConfig.reason}`);
        setDone(true);
        return;
      }
      const kubeconfig = maybeKubeConfig.value;
      console.log('kubeconfig:');
      console.log(kubeconfig);
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