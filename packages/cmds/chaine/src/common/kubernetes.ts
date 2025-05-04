import * as k8s from '@kubernetes/client-node';
import { Err, Ok, type Result } from './result';
import { Secrets, getCLISecret } from './secrets';
import { default as isValidDomain } from 'is-valid-domain';

function isValidUrlPath(path: string): boolean {
  return typeof path === 'string' &&
    path.startsWith('/') &&
    !path.includes(' ') &&
    !/[\0]/.test(path) &&
    encodeURI(path) === path;
}

export enum GetClientError {
  FailedToGetKubeConfig = 'FailedToGetKubeConfig',
  FailedToReadNamespace = 'FailedToReadNamespace'
}

export enum DeployServiceError {
  MissingPackage = 'MissingPackage'
}

export enum Namespaces {
  development = 'development', // Shared dev env
  // TODO: add gama or staging env?
  preview = 'preview', // Like onebox
  production = 'production',
}

export type RoutingConfig = {
  [domain: string]: {
    [pathPrefix: string]: string; // Path to service name
  }
}

export enum ProvisionIngressError {
  MalformedRoutingConfig = 'MalformedRoutingConfig',
  ReadError = 'ReadError',
  ReplaceError = 'ReplaceError',
  CreateError = 'CreateError'
}

export class KubernetesClient {
  private static INSTANCE: KubernetesClient | undefined = undefined; 

  private readonly coreApi: k8s.CoreV1Api;
  private readonly appsApi: k8s.AppsV1Api;
  private readonly netApi: k8s.NetworkingV1Api;
  private namespacesInitialized: boolean;

  private constructor(kubeconfigStr: string) {
    const kubeconfig = new k8s.KubeConfig();
    kubeconfig.loadFromString(kubeconfigStr);
    this.coreApi = kubeconfig.makeApiClient(k8s.CoreV1Api);
    this.appsApi = kubeconfig.makeApiClient(k8s.AppsV1Api);
    this.netApi = kubeconfig.makeApiClient(k8s.NetworkingV1Api);
    this.namespacesInitialized = false;
  }

  public static async getInstance(): Promise<Result<KubernetesClient, GetClientError>> {
    if (KubernetesClient.INSTANCE === undefined) {
      const kubeconfigResult = await getCLISecret(Secrets.KUBECONFIG);
      if (!kubeconfigResult.success) {
        return Err({
          error: GetClientError.FailedToGetKubeConfig,
          reason: `Failed to get ${Secrets.KUBECONFIG}: ${kubeconfigResult.error}; ${kubeconfigResult.reason}`
        });
      }
      KubernetesClient.INSTANCE = new KubernetesClient(kubeconfigResult.value);
    }
    const client = KubernetesClient.INSTANCE;
    if (!client.namespacesInitialized) {
      for (const namespace of Object.values(Namespaces)) {
        const namespaceResult = await client.provisionNamespace(namespace);
        if (!namespaceResult.success) return namespaceResult;
      }
      client.namespacesInitialized = true;
    }
    return Ok({ value: client });
  }

  private async provisionNamespace(namespace: Namespaces): Promise<Result<true, GetClientError.FailedToReadNamespace>> {
    try {
      await this.coreApi.readNamespace({name: namespace});
    } catch (e) {
      const error = e as Error;
      if (error instanceof k8s.ApiException) {
        const reason = JSON.parse(error.body).reason;
        if (reason === 'NotFound') {
          await this.coreApi.createNamespace({ body: { metadata: { name: namespace } } });
        } else {
          return Err({
            error: GetClientError.FailedToReadNamespace,
            reason: `Was ApiException, however wrong reason. ` + error.message,
          });
        }
      } else {
        return Err({
          error: GetClientError.FailedToReadNamespace,
          reason: error.message
        });
      }
    }
    return Ok({ value: true });
  }

  public async provisionService(namespace: Namespaces, service: string) {

  }

  public async provisionIngress(namespace: Namespaces, routingConfig: RoutingConfig): Promise<Result<true, ProvisionIngressError>> {
    // We only want one ingress / LB service per cluster. These are expensive
    const ingressName = 'cluster-ingress';

    // Validate
    for (const fqdn in routingConfig) {
      if (!isValidDomain(fqdn)) {
        return Err({
          error: ProvisionIngressError.MalformedRoutingConfig,
          reason: `'${fqdn}' is not a valid fqdn`
        });
      }
      for (const pathPrefix in routingConfig[fqdn]) {
        if (!isValidUrlPath(pathPrefix)) {
          return Err({
            error: ProvisionIngressError.MalformedRoutingConfig,
            reason: `Path prefix '${pathPrefix}' for fqdn '${fqdn}' is invalid`
          });
        }
      }
    }
    const ingressManifest: k8s.V1Ingress = {
      apiVersion: 'networking.k8s.io/v1',
      kind: 'Ingress',
      metadata: {
        name: ingressName,
        namespace,
        annotations: {
          'kubernetes.io/ingress.class': 'nginx',
          'cert-manager.io/cluster-issuer': 'letsencrypt-prod',
        },
      },
      spec: {
        tls: Object.keys(routingConfig).map(fqdn => ({
          hosts: [fqdn],
          secretName: `${fqdn.replaceAll('.', '-')}-tls`
        })),
        rules: Object.entries(routingConfig).map(([fqdn, pathRouting]) => ({
          host: fqdn,
          http: {
            paths: Object.entries(pathRouting).map(([pathPrefix, service]) => ({
              path: pathPrefix,
              pathType: 'Prefix',
              backend: {
                service: {
                  name: service,
                  port: { number: 80 }
                }
              }
            }))
          }
        }))
      },
    };
    
    let ingress: k8s.V1Ingress;
    let created = false;
    try {
      ingress = await this.netApi.readNamespacedIngress({ name: ingressName, namespace });
    } catch (e: any) {
      if (e.response?.statusCode === 404) {
        try {
          ingress = await this.netApi.createNamespacedIngress({ namespace, body: ingressManifest });
          created = true;
        } catch (e2: any) {
          return Err({
            error: ProvisionIngressError.CreateError,
            reason: JSON.stringify(e2)
          });
        }
      } else {
        return Err({
          error: ProvisionIngressError.ReadError,
          reason: JSON.stringify(e)
        });
      }
    }

    if (!created) {
      try {
        await this.netApi.replaceNamespacedIngress({ name: ingressName, namespace, body: ingressManifest });
      } catch (e: any) {
        return Err({
          error: ProvisionIngressError.ReplaceError,
          reason: JSON.stringify(e)
        });
      }
    }

    return Ok({ value: true });
  }

}
