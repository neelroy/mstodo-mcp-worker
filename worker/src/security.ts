// Small crypto and HTML helpers for the sign-in flow.

const enc = new TextEncoder()

export function randomToken(bytes = 32): string {
  const b = crypto.getRandomValues(new Uint8Array(bytes))
  return b64url(b)
}

export function b64url(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let s = ""
  for (const x of bytes) s += String.fromCharCode(x)
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

export async function sha256(input: string): Promise<string> {
  return b64url(await crypto.subtle.digest("SHA-256", enc.encode(input)))
}

/** PKCE S256 challenge for a verifier. */
export const pkceChallenge = sha256

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ])
}

/** value.signature, so a cookie can be trusted when it comes back. */
export async function sign(value: string, secret: string): Promise<string> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), enc.encode(value))
  return `${b64url(enc.encode(value))}.${b64url(sig)}`
}

export async function verify(signed: string | undefined, secret: string): Promise<string | null> {
  if (!signed) return null
  const [v, s] = signed.split(".")
  if (!v || !s) return null
  try {
    const value = new TextDecoder().decode(fromB64url(v))
    const ok = await crypto.subtle.verify("HMAC", await hmacKey(secret), fromB64url(s), enc.encode(value))
    return ok ? value : null
  } catch {
    return null
  }
}

function fromB64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4))
  return Uint8Array.from(bin, (c) => c.charCodeAt(0))
}

/** Constant-time string comparison. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  let r = 0
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return r === 0
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!)
}
