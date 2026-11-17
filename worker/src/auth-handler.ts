// Browser-facing sign-in routes. OAuthProvider sends everything that is not
// /mcp, /token or /register here.
//
// Flow: Claude -> /authorize (consent page) -> Entra sign-in -> /callback
//       -> completeAuthorization -> back to Claude with an auth code.
//
// Protections:
// - Consent page per MCP client, so a malicious client registered through
//   dynamic client registration cannot silently obtain a grant.
// - CSRF token on the consent form.
// - The Entra `state` is single-use (KV, 10 min) and bound to this browser
//   by a cookie holding its hash.
// - PKCE between the Worker and Entra.
// - Optional allowlist of MCP client redirect URIs.

import type { AuthRequest } from "@cloudflare/workers-oauth-provider"
import { Hono, type Context } from "hono"
import { getCookie, setCookie, deleteCookie } from "hono/cookie"
import { authorizeUrl, exchangeCode, getProfile, propsFromTokens } from "./entra"
import { escapeHtml, pkceChallenge, randomToken, safeEqual, sha256, sign, verify } from "./security"

const app = new Hono<{ Bindings: Env }>()

const STATE_COOKIE = "__Host-mstodo_state"
const CSRF_COOKIE = "__Host-mstodo_csrf"
const APPROVED_COOKIE = "__Host-mstodo_approved"
const STATE_TTL = 600 // seconds

const cookieOpts = { path: "/", secure: true, httpOnly: true, sameSite: "Lax" as const }

app.get("/", (c) =>
  c.html(
    page(
      "Microsoft To Do MCP",
      `<p>This is a remote MCP server for Microsoft To Do.</p>
<p>Add <code>${escapeHtml(new URL("/mcp", c.req.url).toString())}</code> as a custom connector in Claude.</p>`,
    ),
  ),
)

// Step 1: Claude sends the user here. Show a consent page unless this
// browser already approved this client.
app.get("/authorize", async (c) => {
  let req: AuthRequest
  try {
    req = await c.env.OAUTH_PROVIDER.parseAuthRequest(c.req.raw)
  } catch (e) {
    return c.html(page("Invalid request", `<p>${escapeHtml(String(e))}</p>`), 400)
  }
  const client = await c.env.OAUTH_PROVIDER.lookupClient(req.clientId)
  if (!client) return c.html(page("Unknown client", "<p>This MCP client is not registered.</p>"), 400)

  if (!redirectAllowed(c.env, req.redirectUri)) {
    return c.html(page("Client not allowed", "<p>This MCP client is not on the server's allowlist.</p>"), 403)
  }

  if (await isApproved(c, req.clientId)) return redirectToEntra(c, req)

  const csrf = randomToken()
  setCookie(c, CSRF_COOKIE, csrf, { ...cookieOpts, maxAge: STATE_TTL })
  const pending = randomToken()
  await c.env.OAUTH_KV.put(`authreq:${pending}`, JSON.stringify(req), { expirationTtl: STATE_TTL })

  const name = escapeHtml(client.clientName || "An MCP client")
  const redirect = escapeHtml(req.redirectUri)
  return c.html(
    page(
      "Allow access to Microsoft To Do?",
      `<p><strong>${name}</strong> wants to read and manage your Microsoft To Do tasks.</p>
<p class="muted">It will return to <code>${redirect}</code> after you sign in.</p>
<form method="post" action="/authorize">
  <input type="hidden" name="csrf" value="${csrf}">
  <input type="hidden" name="pending" value="${pending}">
  <button type="submit">Continue to Microsoft sign-in</button>
</form>`,
    ),
  )
})

// Step 2: the user approved.
app.post("/authorize", async (c) => {
  const form = await c.req.formData()
  const csrf = String(form.get("csrf") ?? "")
  const pending = String(form.get("pending") ?? "")
  const cookie = getCookie(c, CSRF_COOKIE) ?? ""
  if (!csrf || !safeEqual(csrf, cookie))
    return c.html(page("Expired", "<p>Please start the connection again.</p>"), 400)
  deleteCookie(c, CSRF_COOKIE, cookieOpts)

  const raw = await c.env.OAUTH_KV.get(`authreq:${pending}`)
  if (!raw) return c.html(page("Expired", "<p>Please start the connection again.</p>"), 400)
  await c.env.OAUTH_KV.delete(`authreq:${pending}`)
  const req = JSON.parse(raw) as AuthRequest

  await approve(c, req.clientId)
  return redirectToEntra(c, req)
})

// Step 3: Entra redirects back here.
app.get("/callback", async (c) => {
  const error = c.req.query("error")
  if (error) {
    return c.html(page("Sign-in failed", `<p>${escapeHtml(c.req.query("error_description") ?? error)}</p>`), 400)
  }
  const state = c.req.query("state") ?? ""
  const code = c.req.query("code") ?? ""
  const bound = getCookie(c, STATE_COOKIE) ?? ""
  deleteCookie(c, STATE_COOKIE, cookieOpts)
  if (!state || !code || !bound || !safeEqual(await sha256(state), bound)) {
    return c.html(page("Sign-in failed", "<p>This sign-in was not started in this browser. Please try again.</p>"), 400)
  }

  const raw = await c.env.OAUTH_KV.get(`state:${state}`)
  if (!raw) return c.html(page("Expired", "<p>Sign-in took too long. Please try again.</p>"), 400)
  await c.env.OAUTH_KV.delete(`state:${state}`)
  const { req, codeVerifier } = JSON.parse(raw) as { req: AuthRequest; codeVerifier: string }

  try {
    const tokens = await exchangeCode(c.env, { code, redirectUri: callbackUrl(c), codeVerifier })
    const profile = await getProfile(tokens.access_token)
    const props = propsFromTokens(tokens, profile)

    const { redirectTo } = await c.env.OAUTH_PROVIDER.completeAuthorization({
      request: req,
      userId: profile.id,
      metadata: { label: profile.name || profile.email },
      scope: req.scope,
      props,
    })
    console.log(`Authorized user ${profile.id} for client ${req.clientId}`)
    return c.redirect(redirectTo, 302)
  } catch (e) {
    console.error(`Callback failed: ${e instanceof Error ? e.message : e}`)
    return c.html(page("Sign-in failed", `<p>${escapeHtml(e instanceof Error ? e.message : String(e))}</p>`), 502)
  }
})

async function redirectToEntra(c: Context<{ Bindings: Env }>, req: AuthRequest) {
  const state = randomToken()
  const codeVerifier = randomToken(48)
  await c.env.OAUTH_KV.put(`state:${state}`, JSON.stringify({ req, codeVerifier }), { expirationTtl: STATE_TTL })
  setCookie(c, STATE_COOKIE, await sha256(state), { ...cookieOpts, maxAge: STATE_TTL })
  const url = authorizeUrl(c.env, {
    redirectUri: callbackUrl(c),
    state,
    codeChallenge: await pkceChallenge(codeVerifier),
  })
  return c.redirect(url, 302)
}

function callbackUrl(c: Context): string {
  return new URL("/callback", c.req.url).toString()
}

function redirectAllowed(env: Env, redirectUri: string): boolean {
  const list = (env.ALLOWED_REDIRECT_URIS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
  return list.length === 0 || list.includes(redirectUri)
}

async function approvedList(c: Context<{ Bindings: Env }>): Promise<string[]> {
  const v = await verify(getCookie(c, APPROVED_COOKIE), c.env.COOKIE_ENCRYPTION_KEY)
  try {
    return v ? (JSON.parse(v) as string[]) : []
  } catch {
    return []
  }
}

async function isApproved(c: Context<{ Bindings: Env }>, clientId: string) {
  return (await approvedList(c)).includes(clientId)
}

async function approve(c: Context<{ Bindings: Env }>, clientId: string) {
  const list = [...new Set([...(await approvedList(c)), clientId])].slice(-20)
  setCookie(c, APPROVED_COOKIE, await sign(JSON.stringify(list), c.env.COOKIE_ENCRYPTION_KEY), {
    ...cookieOpts,
    maxAge: 60 * 60 * 24 * 365,
  })
}

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body{font:16px/1.5 system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1f2328;background:#fff}
h1{font-size:1.4rem}.muted{color:#59636e;font-size:.9rem}code{word-break:break-all}
button{font:inherit;padding:.6rem 1rem;border-radius:6px;border:0;background:#0f6cbd;color:#fff;cursor:pointer}
@media (prefers-color-scheme:dark){body{background:#0d1117;color:#e6edf3}.muted{color:#9198a1}}
</style></head><body><h1>${escapeHtml(title)}</h1>${body}</body></html>`
}

export default app
