export const MAX_BODY_BYTES = 65_536
export const MAX_HEADER_BYTES = 16_384
export const MAX_HEADERS = 64
export const MAX_QUERY_BYTES = 4_096
const BODY_TIMEOUT_MS = 5_000
const REDACTED_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
])

export class CaptureInputError extends Error {
  constructor(
    public readonly status: 400 | 408 | 413,
    public readonly code: string,
  ) {
    super(code)
  }
}

export type CaptureInput = {
  version: 1
  method: string
  query: string
  headers: [string, string][]
  body: { encoding: 'base64'; data: string; byteLength: number }
}

type CaptureMetadata = Omit<CaptureInput, 'body'>

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

export function captureHeaders(headers: Headers): [string, string][] {
  const entries = Array.from(headers.entries())
  const bytes = entries.reduce(
    (sum, [name, value]) => sum + byteLength(name) + byteLength(value),
    0,
  )
  if (entries.length > MAX_HEADERS || bytes > MAX_HEADER_BYTES) {
    throw new CaptureInputError(413, 'payload_too_large')
  }
  return entries.filter(([name]) => !REDACTED_HEADERS.has(name.toLowerCase()))
}

export function captureQuery(url: string): string {
  // URL.search drops a trailing empty '?'; preserve its encoded representation.
  const withoutFragment = url.split('#', 1)[0]!
  const start = withoutFragment.indexOf('?')
  const query = start === -1 ? '' : withoutFragment.slice(start)
  if (byteLength(query) > MAX_QUERY_BYTES)
    throw new CaptureInputError(413, 'payload_too_large')
  return query
}

async function collectBytes(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): Promise<Uint8Array> {
  const chunks: Uint8Array[] = []
  let size = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > MAX_BODY_BYTES)
      throw new CaptureInputError(413, 'payload_too_large')
    if (value.byteLength > 0) chunks.push(value)
  }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    bytes.set(chunk, offset)
    offset += chunk.byteLength
  }
  return bytes
}

export async function captureBody(
  body: ReadableStream<Uint8Array> | null,
  timeoutMs = BODY_TIMEOUT_MS,
) {
  if (!body) return new Uint8Array()
  const reader = body.getReader()
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new CaptureInputError(408, 'request_timeout')),
      timeoutMs,
    )
  })
  try {
    return await Promise.race([collectBytes(reader), deadline])
  } catch (error) {
    if (error instanceof CaptureInputError) throw error
    throw new CaptureInputError(400, 'invalid_request')
  } finally {
    clearTimeout(timer)
    void reader.cancel().catch(() => {})
  }
}

function encodeBody(bytes: Uint8Array): CaptureInput['body'] {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return {
    encoding: 'base64',
    data: btoa(binary),
    byteLength: bytes.byteLength,
  }
}

export function captureMetadata(request: Request): CaptureMetadata {
  return {
    version: 1,
    method: request.method,
    query: captureQuery(request.url),
    headers: captureHeaders(request.headers),
  }
}

export async function captureInput(
  request: Request,
  metadata: CaptureMetadata,
): Promise<CaptureInput> {
  const bytes = await captureBody(request.body)
  return { ...metadata, body: encodeBody(bytes) }
}
