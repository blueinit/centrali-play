import type { IncomingMessage, ServerResponse } from 'node:http'

export const LOCAL_REDIS_TOKEN = 'local-development-only'
const MAX_COMMAND_BYTES = 262_144

type CommandResult =
  | { command: string[] }
  | { status: 400 | 413; error: 'invalid_request' | 'too_large' }
type ExecuteCommand = (command: string[]) => Promise<unknown>

function sendJson(response: ServerResponse, status: number, body: unknown) {
  response.setHeader('Content-Type', 'application/json')
  response.setHeader('Cache-Control', 'no-store')
  if (status >= 400) response.setHeader('Connection', 'close')
  response.writeHead(status).end(JSON.stringify(body))
}

function requestError(request: IncomingMessage): 400 | 401 | null {
  if (
    request.method !== 'POST' ||
    request.url !== '/' ||
    request.headers.origin
  )
    return 400
  if (request.headers.authorization !== `Bearer ${LOCAL_REDIS_TOKEN}`)
    return 401
  return null
}

function parseCommand(text: string): CommandResult {
  try {
    const data: unknown = JSON.parse(text)
    const valid =
      Array.isArray(data) &&
      data.length > 0 &&
      data.every(
        (value) =>
          typeof value === 'string' ||
          (typeof value === 'number' && Number.isFinite(value)),
      )
    if (valid) return { command: data.map(String) }
  } catch {
    // Malformed JSON is a client error, not a Redis outage.
  }
  return { status: 400, error: 'invalid_request' }
}

async function readCommand(request: IncomingMessage): Promise<CommandResult> {
  const chunks: Buffer[] = []
  let size = 0
  // Preserve the socket long enough to deliver a 413 before closing it.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > MAX_COMMAND_BYTES) return { status: 413, error: 'too_large' }
    chunks.push(chunk)
  }
  return parseCommand(Buffer.concat(chunks).toString('utf8'))
}

export async function handleRedisRequest(
  request: IncomingMessage,
  response: ServerResponse,
  execute: ExecuteCommand,
) {
  const status = requestError(request)
  if (status !== null) {
    sendJson(response, status, {
      error: status === 401 ? 'unauthorized' : 'invalid_request',
    })
    return
  }
  try {
    const parsed = await readCommand(request)
    if ('error' in parsed)
      return sendJson(response, parsed.status, { error: parsed.error })
    const result = await execute(parsed.command)
    sendJson(response, 200, { result })
  } catch {
    sendJson(response, 503, { error: 'redis_error' })
  }
}
