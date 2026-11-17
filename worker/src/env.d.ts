import type { OAuthHelpers } from "@cloudflare/workers-oauth-provider"

interface Secrets {
  /** Entra app client secret (wrangler secret) */
  ENTRA_CLIENT_SECRET: string
  /** Key for signing cookies (wrangler secret) */
  COOKIE_ENCRYPTION_KEY: string
  /** Optional: space-separated Graph scopes, overrides the default */
  GRAPH_SCOPES?: string
  /** Injected by OAuthProvider into the default handler */
  OAUTH_PROVIDER: OAuthHelpers
}

declare global {
  namespace Cloudflare {
    interface Env extends Secrets {}
  }
  interface Env extends Secrets {}
}

export {}
