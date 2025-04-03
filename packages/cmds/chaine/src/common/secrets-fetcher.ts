import { Ok, Err, type Result } from './result';

const SECRET_CACHE: Map<string, string> = new Map();

export enum GetSecretError {
  MissingHCPEnvVars = 'MissingHCPEnvVars',
  FailedToAuthenticate = 'FailedToAuthenticate',
  FailedToFetchSecrets = 'FailedToFetchSecrets',
  NoSuchSecret = 'NoSuchSecret'
}

type AccessTokenResponse = {
  access_token: string;
  token_type: string;
  expires_in: number;
}

export async function getSecret(namespace: string, secret: string): Promise<Result<string, GetSecretError>> {
  // This works since neither Apps nor Secrets in Hashicorp Vault may contain period chars
  const cacheKey = `${namespace}.${secret}`;
  if (SECRET_CACHE.has(cacheKey)) {
    console.log(`cache hit for ${cacheKey}`);
    return Ok({value: SECRET_CACHE.get(cacheKey)!});
  }
  const CLIENT_ID_ENV_VAR = 'HCP_CLIENT_ID';
  const CLIENT_SECRET_ENV_VAR = 'HCP_CLIENT_SECRET';
  const maybeClientId = getEnvVar(CLIENT_ID_ENV_VAR);
  const maybeClientSecret = getEnvVar(CLIENT_SECRET_ENV_VAR);
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
  const clientId = maybeClientId.value;
  const clientSecret = maybeClientSecret.value;
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
  console.log('api token');
  //console.log(hcpAPIToken);
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