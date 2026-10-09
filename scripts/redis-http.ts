// Development/test bridge only: never expose it or point it at application data.
import { createServer } from 'node:http'
import { createClient } from 'redis'

export const LOCAL_REDIS_TOKEN = 'local-development-only'

export async function startRedisHttp(
  redisUrl = 'redis://127.0.0.1:6380',
  port = 0,
) {
  const target = new URL(redisUrl)
  if (
    target.protocol !== 'redis:' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(target.hostname)
  ) {
    throw new Error('The development bridge requires loopback Redis')
  }

  const client = createClient({
    url: redisUrl,
    socket: { reconnectStrategy: false, connectTimeout: 2_000 },
  })
  // Errors are handled through command promises; never print Redis credentials.
  client.on('error', () => {})
  await client.connect()

  const server = createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json')
    response.setHeader('Cache-Control', 'no-store')
    if (
      request.method !== 'POST' ||
      request.url !== '/' ||
      request.headers.origin
    ) {
      response.writeHead(400).end(JSON.stringify({ error: 'invalid_request' }))
      return
    }
    if (request.headers.authorization !== `Bearer ${LOCAL_REDIS_TOKEN}`) {
      response.writeHead(401).end(JSON.stringify({ error: 'unauthorized' }))
      return
    }

    try {
      const chunks: Buffer[] = []
      let size = 0
      for await (const chunk of request) {
        size += chunk.length
        if (size > 32_768) {
          response.writeHead(413).end(JSON.stringify({ error: 'too_large' }))
          return
        }
        chunks.push(chunk)
      }
      const command: unknown = JSON.parse(
        Buffer.concat(chunks).toString('utf8'),
      )
      if (
        !Array.isArray(command) ||
        command.length === 0 ||
        !command.every(
          (value) => typeof value === 'string' || typeof value === 'number',
        )
      ) {
        response
          .writeHead(400)
          .end(JSON.stringify({ error: 'invalid_request' }))
        return
      }
      const result = await client.sendCommand(command.map(String))
      response.end(JSON.stringify({ result }))
    } catch {
      response.writeHead(503).end(JSON.stringify({ error: 'redis_error' }))
    }
  })

  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, '127.0.0.1', resolve)
    })
  } catch (error) {
    client.destroy()
    throw error
  }
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('No local address')

  return {
    port: address.port,
    async close() {
      await new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections()
      })
      client.destroy()
    },
  }
}

if (import.meta.main) {
  try {
    const bridge = await startRedisHttp(process.env.REDIS_TEST_URL, 8079)
    console.log(
      `Development Redis HTTP bridge: http://127.0.0.1:${bridge.port}`,
    )
    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
      process.once(signal, () => void bridge.close())
    }
  } catch {
    console.error(
      'Cannot start the development bridge. Start local Redis first.',
    )
    process.exitCode = 1
  }
}
