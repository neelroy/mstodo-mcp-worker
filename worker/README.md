# Microsoft To Do MCP on Cloudflare Workers

A remote, always-on version of this server. Claude connects to it over HTTPS as a custom connector, so it works from web, mobile, desktop and scheduled tasks without a laptop running.

The tools are the same ones the local server uses. Both import them from `src/tools.ts`.

## How it works

```
Claude ──MCP (Streamable HTTP)──▶ Worker /mcp ──Graph API──▶ Microsoft To Do
   │                                 ▲
   └── OAuth 2.1 ──▶ /authorize ──▶ Entra ID sign-in ──▶ /callback
```

- Each person signs in with their own Microsoft account. The server only ever acts as that user, using delegated permissions.
- Claude never receives a Microsoft token. The Worker gives Claude its own token, and keeps the user's Graph tokens encrypted inside the grant through `@cloudflare/workers-oauth-provider`.
- When Claude refreshes its token, the Worker refreshes the Graph token too. The Worker also renews a Graph token that is within 5 minutes of expiring before using it.
- Each session runs in its own Durable Object (`TodoMCP`, from the `agents` SDK).
- Sign-in protections:
  - a consent page for each MCP client
  - a CSRF token on that page
  - a single-use Entra `state` bound to the browser by a cookie
  - PKCE with Entra
  - an allowlist of client redirect URIs (Claude's only, by default)
- Logs record the Graph method, path and status only. Task titles and notes are never logged.

## Deploy

### 1. Entra ID app registration

You can reuse the registration from the local setup or create a new one. In the Azure portal, open **App registrations**, select the app, then:

1. Under **Authentication**, add a **Web** platform redirect URI: `https://<worker-name>.<your-subdomain>.workers.dev/callback`. You'll see the exact hostname after the first deploy. You can come back and add it then.
2. Under **Certificates & secrets**, create a new client secret for the Worker. Keep the local server's secret separate.
3. Under **API permissions**, check that these delegated Microsoft Graph permissions are listed and admin consent is granted:
   - `User.Read`
   - `Tasks.ReadWrite`
   - `offline_access`
   - `openid`
   - `profile`

   The Worker doesn't need the `.Shared` scopes that the local auth server asks for.

Note the **Directory (tenant) ID** and **Application (client) ID**.

### 2. Cloudflare

```bash
pnpm install
npx wrangler login
npx wrangler kv namespace create mstodo-mcp-oauth     # copy the id it prints
```

Edit `worker/wrangler.jsonc`:

- `kv_namespaces[0].id`: the KV id
- `ENTRA_TENANT_ID` and `ENTRA_CLIENT_ID`: from step 1
- `ALLOWED_REDIRECT_URIS`: leave as Claude's callback, or clear it to allow any MCP client

Set the secrets:

```bash
cd worker
npx wrangler secret put ENTRA_CLIENT_SECRET     # the secret from step 1
npx wrangler secret put COOKIE_ENCRYPTION_KEY   # paste the output of: openssl rand -hex 32
```

Deploy:

```bash
pnpm run worker:deploy
```

If you haven't yet, add the `/callback` redirect URI from step 1 now.

### 3. Connect Claude

In Claude, go to **Settings → Connectors → Add custom connector** and enter `https://<your-worker>.workers.dev/mcp`. Then click **Connect**. You'll see the consent page and the Microsoft sign-in.

In a Team or Enterprise organization, only an owner may be able to add custom connectors.

To check it works, ask Claude to run `auth-status`. It reports which account is signed in.

## Develop locally

```bash
cd worker
printf 'ENTRA_CLIENT_SECRET=...\nCOOKIE_ENCRYPTION_KEY=...\n' > .dev.vars   # gitignored
pnpm run worker:dev            # http://localhost:8787
```

For local sign-in to work, add `http://localhost:8787/callback` as a redirect URI on the app registration.

Run `pnpm run worker:typecheck` after changing `wrangler.jsonc`, so the `Env` types are regenerated.

## Configuration reference

| Name | Kind | Purpose |
| --- | --- | --- |
| `ENTRA_TENANT_ID` | var | Tenant the app registration lives in. Sign-in is limited to accounts in this tenant |
| `ENTRA_CLIENT_ID` | var | Application (client) ID |
| `ALLOWED_REDIRECT_URIS` | var | Comma-separated MCP client callbacks allowed to connect. Empty means any |
| `GRAPH_SCOPES` | var, optional | Overrides the default `openid profile offline_access User.Read Tasks.ReadWrite` |
| `ENTRA_CLIENT_SECRET` | secret | Client secret |
| `COOKIE_ENCRYPTION_KEY` | secret | Signs the consent cookie |
| `OAUTH_KV` | KV | OAuth clients, grants, tokens, and short-lived sign-in state |
| `MCP_OBJECT` | Durable Object | One `TodoMCP` instance per MCP session |
