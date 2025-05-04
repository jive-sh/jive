import { name as cliPackageName } from '../../package.json';
import { getSecret, getSecretsNamespaceFromPackageName } from './secrets-fetcher';

export enum Secrets {
  KUBECONFIG = "KUBECONFIG"
}

export async function getCLISecret(secret: Secrets) {
  const secretsNamespace = getSecretsNamespaceFromPackageName(cliPackageName);
  return getSecret(secretsNamespace, secret);
}
