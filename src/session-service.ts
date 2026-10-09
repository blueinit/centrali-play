import type { SessionConfig } from './config'
import { storeSession } from './session-store'
import { generateSessionTokens, tokenDigest } from './tokens'

const MAX_CREATION_ATTEMPTS = 3

export type CreatedSession = {
  id: string
  captureUrl: string
  readToken: string
  expiresAt: string
}

async function createSessionAttempt(
  config: SessionConfig,
): Promise<CreatedSession | null> {
  const tokens = generateSessionTokens()
  const [captureTokenHash, readTokenHash] = await Promise.all([
    tokenDigest(tokens.captureToken),
    tokenDigest(tokens.readToken),
  ])
  const expiresAt = await storeSession(config, {
    id: tokens.id,
    captureTokenHash,
    readTokenHash,
  })
  if (expiresAt === null) return null

  return {
    id: tokens.id,
    captureUrl: `${config.publicOrigin}/capture/${tokens.captureToken}`,
    readToken: tokens.readToken,
    expiresAt: new Date(expiresAt * 1_000).toISOString(),
  }
}

export async function createNewSession(
  config: SessionConfig,
): Promise<CreatedSession> {
  for (let attempt = 0; attempt < MAX_CREATION_ATTEMPTS; attempt++) {
    const session = await createSessionAttempt(config)
    if (session !== null) return session
  }
  throw new Error('Session creation attempts exhausted')
}
