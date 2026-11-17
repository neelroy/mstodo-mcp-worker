// Microsoft Entra ID (Azure AD) OAuth helpers: authorize URL, code exchange,
// refresh and the signed-in user's profile. Delegated permissions only.

export const DEFAULT_GRAPH_SCOPES = "openid profile offline_access User.Read Tasks.ReadWrite"

/** What the Worker keeps (encrypted, by workers-oauth-provider) for each grant. */
export interface Props extends Record<string, unknown> {
  /** Entra object ID of the signed-in user */
  userId: string
  name: string
  email: string
  /** Microsoft Graph access token */
  accessToken: string
  /** Entra refresh token, used to renew accessToken */
  refreshToken: string
  /** accessToken expiry, epoch milliseconds */
  expiresAt: number
}

interface EntraTokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  scope?: string
  token_type: string
}

export function scopes(env: Env): string {
  return (env.GRAPH_SCOPES || DEFAULT_GRAPH_SCOPES).trim()
}

function base(env: Env): string {
  return `https://login.microsoftonline.com/${encodeURIComponent(env.ENTRA_TENANT_ID)}/oauth2/v2.0`
}

export function authorizeUrl(env: Env, opts: { redirectUri: string; state: string; codeChallenge: string }): string {
  const url = new URL(`${base(env)}/authorize`)
  url.searchParams.set("client_id", env.ENTRA_CLIENT_ID)
  url.searchParams.set("response_type", "code")
  url.searchParams.set("response_mode", "query")
  url.searchParams.set("redirect_uri", opts.redirectUri)
  url.searchParams.set("scope", scopes(env))
  url.searchParams.set("state", opts.state)
  url.searchParams.set("code_challenge", opts.codeChallenge)
  url.searchParams.set("code_challenge_method", "S256")
  return url.toString()
}

async function tokenRequest(env: Env, params: Record<string, string>): Promise<EntraTokenResponse> {
  const body = new URLSearchParams({
    client_id: env.ENTRA_CLIENT_ID,
    client_secret: env.ENTRA_CLIENT_SECRET,
    scope: scopes(env),
    ...params,
  })
  const res = await fetch(`${base(env)}/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  })
  if (!res.ok) {
    // Entra errors carry an error code and description, never tokens
    const err = (await res.json().catch(() => ({}))) as { error?: string; error_description?: string }
    throw new Error(
      `Entra token request failed (${res.status}): ${err.error ?? "unknown"} ${err.error_description ?? ""}`.trim(),
    )
  }
  return (await res.json()) as EntraTokenResponse
}

export async function exchangeCode(
  env: Env,
  opts: { code: string; redirectUri: string; codeVerifier: string },
): Promise<EntraTokenResponse> {
  return tokenRequest(env, {
    grant_type: "authorization_code",
    code: opts.code,
    redirect_uri: opts.redirectUri,
    code_verifier: opts.codeVerifier,
  })
}

/** Renew the Graph access token. Returns updated props. */
export async function refresh(env: Env, props: Props): Promise<Props> {
  const t = await tokenRequest(env, { grant_type: "refresh_token", refresh_token: props.refreshToken })
  return {
    ...props,
    accessToken: t.access_token,
    // Entra may rotate the refresh token
    refreshToken: t.refresh_token ?? props.refreshToken,
    expiresAt: Date.now() + t.expires_in * 1000,
  }
}

export async function getProfile(accessToken: string): Promise<{ id: string; name: string; email: string }> {
  const res = await fetch("https://graph.microsoft.com/v1.0/me?$select=id,displayName,mail,userPrincipalName", {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  })
  if (!res.ok) throw new Error(`Could not read your Microsoft profile (${res.status})`)
  const me = (await res.json()) as { id: string; displayName?: string; mail?: string; userPrincipalName?: string }
  return { id: me.id, name: me.displayName ?? "", email: me.mail ?? me.userPrincipalName ?? "" }
}

export function propsFromTokens(t: EntraTokenResponse, profile: { id: string; name: string; email: string }): Props {
  if (!t.refresh_token) throw new Error("Entra did not return a refresh token; check the offline_access scope")
  return {
    userId: profile.id,
    name: profile.name,
    email: profile.email,
    accessToken: t.access_token,
    refreshToken: t.refresh_token,
    expiresAt: Date.now() + t.expires_in * 1000,
  }
}
