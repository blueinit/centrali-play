import { timingSafeEqual } from 'node:crypto'
import type { RedisConfig } from './config'
import { redisCommand } from './redis'
import { ReadRequestError } from './read-input'
import { tokenDigest } from './tokens'

export type ReadSession = { id: string; readTokenHash: string }

function digestBytes(value: string): Uint8Array {
  return Uint8Array.from(value.match(/../g)!, (part) =>
    Number.parseInt(part, 16),
  )
}

function storedReadDigest(raw: unknown, id: string): string | null {
  if (raw === null) return null
  if (typeof raw !== 'string') throw new Error('Invalid session metadata')
  const session = JSON.parse(raw)
  if (
    !session ||
    session.id !== id ||
    typeof session.readTokenHash !== 'string' ||
    !/^[a-f0-9]{64}$/.test(session.readTokenHash) ||
    !Number.isSafeInteger(session.expiresAt)
  ) {
    throw new Error('Invalid session metadata')
  }
  return session.readTokenHash
}

export async function authorizeRead(
  config: RedisConfig,
  id: string,
  token: string,
): Promise<ReadSession> {
  const raw = await redisCommand(config, ['GET', `play:session:${id}`])
  const stored = storedReadDigest(raw, id)
  const readTokenHash = await tokenDigest(token)
  if (
    stored === null ||
    !timingSafeEqual(digestBytes(stored), digestBytes(readTokenHash))
  ) {
    throw new ReadRequestError(404, 'not_found')
  }
  return { id, readTokenHash }
}
