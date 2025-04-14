import * as k8s from '@kubernetes/client-node';
import { Err, Ok, type Result } from './result';
import { getSecretsNamespaceFromPackageName, Secrets } from './secrets';
import { getSecret } from './secrets-fetcher';
import { name as cliPackageName } from '../../package.json';

export enum GetApiClientError {
  FailedToGetKubeConfig = 'FailedToGetKubeConfig',
  FailedToReadNamespace = 'FailedToReadNamespace'
}

export enum K8sNamespaces {
  production = 'production',
  development = 'development'
}

let apiClient: k8s.CoreV1Api | undefined;
export async function getAPIClient(): Promise<Result<k8s.CoreV1Api, GetApiClientError>> {
  if (apiClient !== undefined) {
    return Ok({value: apiClient});
  }
  const kubeconfig = new k8s.KubeConfig();
  const secretsNamespace = getSecretsNamespaceFromPackageName(cliPackageName);
  const maybeKubeConfig = await getSecret(secretsNamespace, Secrets.KUBECONFIG);
  if (!maybeKubeConfig.success) {
    return Err({
      error: GetApiClientError.FailedToGetKubeConfig,
      reason: `Failed to get ${Secrets.KUBECONFIG}: ${maybeKubeConfig.error}; ${maybeKubeConfig.reason}`
    });
  }
  kubeconfig.loadFromString(maybeKubeConfig.value);
  const k8sApi = kubeconfig.makeApiClient(k8s.CoreV1Api);
  for (const namespace of Object.values(K8sNamespaces)) {
    try {
      await k8sApi.readNamespace({name: namespace});
    } catch (e) {
      const error = e as Error;
      if (error instanceof k8s.ApiException) {
        const reason = JSON.parse(error.body).reason;
        if (reason === 'NotFound') {
          await k8sApi.createNamespace({ body: { metadata: { name: namespace } } });
        } else {
          return Err({
            error: GetApiClientError.FailedToReadNamespace,
            reason: `Was ApiException, however wrong reason. ` + error.message,
          });
        }
      } else {
        return Err({
          error: GetApiClientError.FailedToReadNamespace,
          reason: error.message
        });
      }
    }
    
  }
  return Ok({value: k8sApi});
}

//export async function create