const SESSION_ID_BYTES = 16
const CAPABILITY_TOKEN_BYTES = 32

function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  )
}

function randomToken(bytes: number): string {
  return hex(crypto.getRandomValues(new Uint8Array(bytes)))
}

export function generateSessionTokens() {
  return {
    id: randomToken(SESSION_ID_BYTES),
    captureToken: randomToken(CAPABILITY_TOKEN_BYTES),
    readToken: randomToken(CAPABILITY_TOKEN_BYTES),
  }
}

export async function tokenDigest(token: string): Promise<string> {
  const bytes = new TextEncoder().encode(token)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return hex(new Uint8Array(digest))
}
