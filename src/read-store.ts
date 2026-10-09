import type { RedisConfig } from './config'
import type { ReadSession } from './read-auth'
import { boundedRedisCommand } from './redis'
import { eventKey } from './capture-store'
import { compareCursors, ReadRequestError } from './read-input'
import {
  MAX_PAGE_EVENTS,
  MAX_READ_REPLY_BYTES,
  MAX_READ_RESPONSE_BYTES,
  READ_EVENTS_SCRIPT,
} from './read-script'
import { parseStoredEvent } from './stored-event'
import type { StoredEvent } from './stored-event'

export type EventPage = {
  events: StoredEvent[]
  nextCursor: string
  hasMore: boolean
  cursorBehindRetention: boolean
  expiresAt: string
}

function deadline(value: unknown): string {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw new Error('Invalid read deadline')
  return new Date(value * 1_000).toISOString()
}

function pageResult(result: unknown, after: string): EventPage {
  if (
    !Array.isArray(result) ||
    result.length !== 5 ||
    result[0] !== 'ok' ||
    ![0, 1].includes(result[2]) ||
    ![0, 1].includes(result[3]) ||
    !Array.isArray(result[4]) ||
    result[4].length > MAX_PAGE_EVENTS
  )
    throw new Error('Invalid read page')
  const events = result[4].map(parseStoredEvent)
  let cursor = after
  for (const event of events) {
    if (compareCursors(event.id, cursor) <= 0)
      throw new Error('Invalid event order')
    cursor = event.id
  }
  if (events.length === 0 && result[3] === 1)
    throw new Error('Read page cannot advance')
  return {
    events,
    nextCursor: cursor,
    hasMore: result[3] === 1,
    cursorBehindRetention: result[2] === 1,
    expiresAt: deadline(result[1]),
  }
}

export function readEventsCommand(
  session: ReadSession,
  after: string,
  head = false,
): (string | number)[] {
  return [
    'EVAL',
    READ_EVENTS_SCRIPT,
    2,
    `play:session:${session.id}`,
    eventKey(session.id),
    session.id,
    session.readTokenHash,
    after,
    head ? 'head' : 'page',
  ]
}

export async function readEventPage(
  config: RedisConfig,
  session: ReadSession,
  after: string,
  head = false,
): Promise<EventPage | null> {
  const result = await boundedRedisCommand(
    config,
    readEventsCommand(session, after, head),
    MAX_READ_REPLY_BYTES,
  )
  if (result === null) throw new ReadRequestError(404, 'not_found')
  if (
    Array.isArray(result) &&
    result.length === 1 &&
    result[0] === 'invalid_cursor'
  )
    throw new ReadRequestError(400, 'invalid_cursor')
  if (head) {
    if (!Array.isArray(result) || result.length !== 2 || result[0] !== 'head')
      throw new Error('Invalid HEAD result')
    deadline(result[1])
    return null
  }
  const page = pageResult(result, after)
  if (
    new TextEncoder().encode(JSON.stringify(page)).byteLength >
    MAX_READ_RESPONSE_BYTES
  )
    throw new Error('Oversized read page')
  return page
}
