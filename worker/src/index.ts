// Remote Microsoft To Do MCP server on Cloudflare Workers.
//
//   /mcp       MCP over Streamable HTTP (needs a bearer token from /token)
//   /authorize, /callback   browser sign-in through Microsoft Entra ID
//   /token, /register, /.well-known/*   OAuth 2.1, handled by OAuthProvider
//
// Each user signs in with their own Microsoft account. Their Graph tokens
// are stored encrypted by OAuthProvider and never sent to the MCP client;
// the client gets its own token for this Worker only.

import OAuthProvider from "@cloudflare/workers-oauth-provider"
import { McpAgent } from "agents/mcp"
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { env } from "cloudflare:workers"
import { registerTodoTools } from "../../src/tools"
import authHandler from "./auth-handler"
import { refresh, type Props } from "./entra"

const VERSION = "1.2.0"
const REFRESH_MARGIN_MS = 5 * 60 * 1000

export class TodoMCP extends McpAgent<Env, unknown, Props> {
  server = new McpServer({ name: "mstodo", version: VERSION })

  async init() {
    registerTodoTools(this.server, {
      userAgent: `microsoft-todo-mcp-server/${VERSION}`,
      getAccessToken: (opts) => this.graphToken(opts?.forceRefresh),
    })

    this.server.tool(
      "auth-status",
      "Show which Microsoft account this connector is signed in as and when its Graph token expires.",
      {},
      { readOnlyHint: true, openWorldHint: false },
      async () => {
        const p = this.props
        if (!p) return { content: [{ type: "text", text: "Not signed in. Reconnect the connector in Claude." }] }
        return {
          content: [
            {
              type: "text",
              text: `Signed in as ${p.name} (${p.email}). Graph token expires ${new Date(p.expiresAt).toISOString()}; it renews automatically.`,
            },
          ],
        }
      },
    )
  }

  /** Current user's Graph token, renewed shortly before it expires. */
  private async graphToken(force = false): Promise<string | null> {
    const p = this.props
    if (!p?.accessToken) return null
    if (!force && p.expiresAt - Date.now() > REFRESH_MARGIN_MS) return p.accessToken
    try {
      const next = await refresh(this.env, p)
      await this.updateProps(next)
      return next.accessToken
    } catch (e) {
      console.error(`Token refresh failed for ${p.userId}: ${e instanceof Error ? e.message : e}`)
      return null
    }
  }
}

export default new OAuthProvider({
  apiRoute: "/mcp",
  apiHandler: TodoMCP.serve("/mcp"),
  defaultHandler: authHandler as any,
  authorizeEndpoint: "/authorize",
  tokenEndpoint: "/token",
  clientRegistrationEndpoint: "/register",
  scopesSupported: ["todo"],
  refreshTokenTTL: 60 * 60 * 24 * 30, // 30 days; Claude refreshes well before this

  // Keep the stored Microsoft tokens fresh whenever Claude refreshes its own
  // token, and match Claude's token lifetime to the Graph token's.
  async tokenExchangeCallback({ grantType, props }) {
    let p = props as Props
    if (grantType === "refresh_token") {
      p = await refresh(env, p) // throws if the Microsoft session was revoked: Claude must reconnect
    }
    const ttl = Math.max(60, Math.floor((p.expiresAt - Date.now()) / 1000) - 60)
    return { newProps: p, accessTokenTTL: ttl }
  },
})
