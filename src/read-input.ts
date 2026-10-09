import { hasRequestBody } from './body'

const MAX_QUERY_BYTES = 128
const MAX_CURSOR_COMPONENT = (1n << 64n) - 1n
export const INITIAL_CURSOR = '0-0'

export class ReadRequestError extends Error {
  constructor(
    public readonly status: 400 | 401 | 404,
    public readonly code: string,
  ) {
    super(code)
  }
}

export type ReadInput = {
  id: string
  readToken: string
  after: string
  head: boolean
}

export function isCursor(value: string): boolean {
  if (!/^(0|[1-9]\d{0,19})-(0|[1-9]\d{0,19})$/.test(value)) return false
  return value.split('-').every((part) => BigInt(part) <= MAX_CURSOR_COMPONENT)
}

export function compareCursors(left: string, right: string): number {
  const [leftTime, leftSequence] = left.split('-').map(BigInt)
  const [rightTime, rightSequence] = right.split('-').map(BigInt)
  if (leftTime !== rightTime) return leftTime! < rightTime! ? -1 : 1
  if (leftSequence === rightSequence) return 0
  return leftSequence! < rightSequence! ? -1 : 1
}

function bearerToken(headers: Headers): string {
  const match = /^Bearer +([a-f0-9]{64})$/i.exec(
    headers.get('Authorization') ?? '',
  )
  // Scheme casing is flexible; token casing is part of its canonical encoding.
  if (!match || !/^[a-f0-9]{64}$/.test(match[1]!))
    throw new ReadRequestError(401, 'unauthorized')
  return match[1]!
}

function readCursor(url: string): string {
  const parsed = new URL(url)
  if (new TextEncoder().encode(parsed.search).byteLength > MAX_QUERY_BYTES)
    throw new ReadRequestError(400, 'invalid_request')
  const parameters = parsed.searchParams
  if (
    [...parameters.keys()].some((name) => name !== 'after') ||
    parameters.getAll('after').length > 1
  ) {
    throw new ReadRequestError(400, 'invalid_request')
  }
  const after = parameters.get('after') ?? INITIAL_CURSOR
  if (!isCursor(after)) throw new ReadRequestError(400, 'invalid_request')
  return after
}

export async function readInput(
  request: Request,
  id: string | undefined,
): Promise<ReadInput> {
  if (!id || !/^[a-f0-9]{32}$/.test(id))
    throw new ReadRequestError(404, 'not_found')
  const readToken = bearerToken(request.headers)
  const after = readCursor(request.url)
  try {
    if (await hasRequestBody(request)) throw new Error('Unexpected body')
  } catch {
    throw new ReadRequestError(400, 'invalid_request')
  }
  return { id, readToken, after, head: request.method === 'HEAD' }
}
