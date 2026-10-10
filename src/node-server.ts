import { createServer } from 'node:http'
import { getRequestListener } from '@hono/node-server'
import app from './index'
import { nodeConfig } from './node-config'

export function startNodeServer(config: ReturnType<typeof nodeConfig>) {
  const server = createServer(
    {
      maxHeaderSize: 16_384,
      requestTimeout: 10_000,
      headersTimeout: 10_000,
      keepAliveTimeout: 5_000,
    },
    getRequestListener((request) => app.fetch(request, config.bindings)),
  )
  server.listen(config.port, config.hostname)
  return server
}
