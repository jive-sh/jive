import { Ok, Err, type Result } from './result';
import { z } from 'zod';

const SECRET_CACHE: Map<string, string> = new Map();

// This works since neither Apps nor Secrets in Hashicorp Vault may contain period chars
function getCacheKey(namespace: string, secret: string) {
  return `${namespace}.${secret}`;
}

export enum GetSecretError {
  MissingHCPEnvVars = 'MissingHCPEnvVars',
  FailedToAuthenticate = 'FailedToAuthenticate',
  FailedToFetchSecrets = 'FailedToFetchSecrets',
  NoSuchSecret = 'NoSuchSecret'
}

const HCPSecretSchema = z.object({
  name: z.string(),
  type: z.literal('kv'),
  latest_version: z.number(),
  created_at: z.string(), // i.e. 2025-02-13T08:47:46.580218Z
  created_by_id: z.string(),
  sync_status: z.object({}),
  static_version: z.object({
    version: z.number(),
    value: z.string(),
    created_at: z.string(),
    created_by_id: z.string()
  }).strict()
}).strict();

const HCPSecretsResponseSchema = z.object({
  secrets: z.array(HCPSecretSchema),
  pagination: z.object({
    next_page_token: z.string(),
    previous_page_token: z.string()
  })
});

type AccessTokenResponse = {
  access_token: string;
  token_type: string;
  expires_in: number;
}

export function getSecretsNamespaceFromPackageName(packageName: string): string {
  const [scope, name] = packageName.split('/');
  // const safeScope = scope.replaceAll('@', '').replaceAll('.', '-') + '-';
  // Technically this could cause conflict between non scoped and scoped packages.
  // Long term we want to move to K8s External Secrets Operator and using the K8s API to fetch secrets.
  // I'm leaning towards allowing the conflict and having the service / secret namespace based on the package/repo name only.
  // This way I can have a clean dir structure and my apps folder and libs folder can contain some repos from other orgs easily.
  // The scope just impacts the owning org / package regitry it's published to. If someone wants to change that, they just change
  // the git org / package scope.
  return name.replaceAll('.', '-').toLocaleLowerCase();
}

export async function getSecret(namespace: string, secret: string): Promise<Result<string, GetSecretError>> {
  const cacheKey = getCacheKey(namespace, secret);
  if (SECRET_CACHE.has(cacheKey)) {
    console.log(`cache hit for ${cacheKey}`);
    return Ok({value: SECRET_CACHE.get(cacheKey)!});
  }
  const secretsResult = await listSecrets(namespace);
  if (!secretsResult.success) return secretsResult;
  const secrets = secretsResult.value;
  if (!SECRET_CACHE.has(cacheKey)) {
    return Err({
      error: GetSecretError.NoSuchSecret,
      reason: `HCP has secrets ${secrets.join(', ')}. ${secret} is not present`
    });
  }
  return Ok({value: SECRET_CACHE.get(cacheKey)!});
}

export async function listSecrets(namespace: string): Promise<Result<string[], GetSecretError>> {
  const CLIENT_ID_ENV_VAR = 'HCP_CLIENT_ID';
  const CLIENT_SECRET_ENV_VAR = 'HCP_CLIENT_SECRET';
  const ORG_ID_ENV_VAR = 'HCP_ORG_ID';
  const PROJECT_ID_ENV_VAR = 'HCP_PROJECT_ID';
  const maybeClientId = getEnvVar(CLIENT_ID_ENV_VAR);
  const maybeClientSecret = getEnvVar(CLIENT_SECRET_ENV_VAR);
  const maybeOrgId = getEnvVar(ORG_ID_ENV_VAR);
  const maybeProjectId = getEnvVar(PROJECT_ID_ENV_VAR);
  if (!maybeClientId.success) {
    return Err({
      error: GetSecretError.MissingHCPEnvVars,
      reason: `Missing ${CLIENT_ID_ENV_VAR} env var: ${maybeClientId.reason}`
    });
  }
  if (!maybeClientSecret.success) {
    return Err({
      error: GetSecretError.MissingHCPEnvVars,
      reason: `Missing ${CLIENT_SECRET_ENV_VAR} env var: ${maybeClientSecret.reason}`
    });
  }
  if (!maybeOrgId.success) {
    return Err({
      error: GetSecretError.MissingHCPEnvVars,
      reason: `Missing ${ORG_ID_ENV_VAR} env var: ${maybeOrgId.reason}`
    });
  }
  if (!maybeProjectId.success) {
    return Err({
      error: GetSecretError.MissingHCPEnvVars,
      reason: `Missing ${PROJECT_ID_ENV_VAR} env var: ${maybeProjectId.reason}`
    });
  }
  const clientId = maybeClientId.value;
  const clientSecret = maybeClientSecret.value;
  const orgId = maybeOrgId.value;
  const projectId = maybeProjectId.value;
  let hcpAPIToken: AccessTokenResponse;
  try {
    hcpAPIToken = (await (await fetch(
      "https://auth.idp.hashicorp.com/oauth2/token",
      {
        method: "POST",
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({
          client_id: clientId,
          client_secret: clientSecret,
          grant_type: 'client_credentials',
          audience: 'https://api.hashicorp.cloud'
        })
      }
    )).json()) as AccessTokenResponse;
  } catch(e) {
    const error = e as Error;
    return Err({
      error: GetSecretError.FailedToAuthenticate,
      reason: error.message
    });
  }
  // TODO: handle pagination
  const secretsResponse = (await (await fetch(
    `https://api.cloud.hashicorp.com/secrets/2023-11-28/organizations/${orgId}/projects/${projectId}/apps/${namespace}/secrets:open`, {
    headers: {
      'Authorization': `Bearer ${hcpAPIToken.access_token}`,
    }
  })).json());
  const secretsResult = HCPSecretsResponseSchema.safeParse(secretsResponse);
  if (!secretsResult.success) {
    return Err({
      error: GetSecretError.FailedToFetchSecrets,
      reason: `Got HCP JSON of "${JSON.stringify(secretsResponse)}". Parse error of ${secretsResult.error.toString()}`
    });
  }
  const { secrets } = HCPSecretsResponseSchema.parse(secretsResponse);
  const secretsInResponse: string[] = [];
  for (const secret of secrets) {
    // TODO: handle other than static values.
    const value = secret.static_version.value;
    SECRET_CACHE.set(getCacheKey(namespace, secret.name), value);
    secretsInResponse.push(secret.name)
  }
  return Ok({ value: secretsInResponse });
}

export enum GetEnvVarError {
  MissingEnvVar = 'MissingEnvVar'
}

export function getEnvVar(envVar: string): Result<string, GetEnvVarError> {
  const envVarVal = process.env[envVar];
  if (!envVarVal) {
    return Err({error: GetEnvVarError.MissingEnvVar, reason: `${envVar} is not defined on process.env`});
  }
  return Ok({value: envVarVal});
}

/**

HCP_API_TOKEN=$(curl --location "https://auth.idp.hashicorp.com/oauth2/token" \
--header "Content-Type: application/x-www-form-urlencoded" \
--data-urlencode "client_id=$HCP_CLIENT_ID" \
--data-urlencode "client_secret=$HCP_CLIENT_SECRET" \
--data-urlencode "grant_type=client_credentials" \
--data-urlencode "audience=https://api.hashicorp.cloud" | jq -r .access_token)


 */

/**

curl \
--location "https://api.cloud.hashicorp.com/secrets/2023-11-28/organizations/a9195297-dd8c-49ad-b09c-a5a8fcaea71b/projects/8991525c-55ce-4e4f-b4eb-90b80a909624/apps/cmds-chaine/secrets:open" \
--request GET \
--header "Authorization: Bearer $HCP_API_TOKEN" | jq

 */