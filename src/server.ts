import type { Server } from 'node:http'
import { nodeConfig } from './node-config'
import { startNodeServer } from './node-server'

function shutdown(server: Server) {
  const deadline = setTimeout(() => {
    server.closeAllConnections()
    process.exit(1)
  }, 10_000)
  deadline.unref()
  server.close((error) => {
    clearTimeout(deadline)
    process.exit(error ? 1 : 0)
  })
}

try {
  const server = startNodeServer(nodeConfig(process.env))
  server.on('error', () => {
    console.error('Server startup or listener failed')
    process.exit(1)
  })
  process.once('SIGINT', () => shutdown(server))
  process.once('SIGTERM', () => shutdown(server))
} catch {
  // Configuration may contain credentials; never print the original error.
  console.error('Invalid server configuration')
  process.exitCode = 1
}
