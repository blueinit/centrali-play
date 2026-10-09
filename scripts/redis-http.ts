// Development/test bridge only: never expose it or point it at application data.
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { createClient } from 'redis'
import { handleRedisRequest } from './redis-http-handler.ts'

async function connectRedis(redisUrl: string) {
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
  try {
    await client.connect()
    return client
  } catch (error) {
    client.destroy()
    throw error
  }
}

async function listen(server: Server, port: number): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('No local address')
  return address.port
}

async function closeServer(server: Server) {
  await new Promise<void>((resolve) => {
    server.close(() => resolve())
    server.closeAllConnections()
  })
}

export async function startRedisHttp(
  redisUrl = 'redis://127.0.0.1:6380',
  port = 0,
) {
  const client = await connectRedis(redisUrl)
  const server = createServer(
    (request, response) =>
      void handleRedisRequest(request, response, (command) =>
        client.sendCommand(command),
      ),
  )
  try {
    const actualPort = await listen(server, port)
    return {
      port: actualPort,
      async close() {
        await closeServer(server)
        client.destroy()
      },
    }
  } catch (error) {
    client.destroy()
    throw error
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
