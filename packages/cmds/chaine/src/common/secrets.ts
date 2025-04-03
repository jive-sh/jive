export enum Secrets {
  KUBECONFIG = "KUBECONFIG"
}

export function getSecretsNamespaceFromPackageName(packageName: string): string {
  const [scope, name] = packageName.split('/');
  return name.replaceAll('.', '-');
}
