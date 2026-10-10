import type { Bindings } from './config'
import { sessionConfig } from './config'
import { shutdownConfig } from './storage-controls'
import { sessionLimits } from './session-limits'

export function nodeConfig(env: Record<string, string | undefined>) {
  const bindings: Bindings = {}
  for (const name of [
    'PUBLIC_BASE_URL',
    'UPSTASH_REDIS_REST_URL',
    'UPSTASH_REDIS_REST_TOKEN',
    'DISABLE_SESSION_CREATION',
    'DISABLE_STORAGE_ROUTES',
    'CAPTURE_PER_MINUTE',
    'CAPTURE_PER_SESSION',
    'READ_PER_MINUTE',
    'READ_PER_SESSION',
  ] as const) {
    if (env[name] !== undefined) bindings[name] = env[name]
  }
  sessionConfig(bindings)
  shutdownConfig(bindings)
  sessionLimits(bindings)
  const port = env.PORT ?? '3000'
  if (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65_535)
    throw new Error('Invalid port configuration')
  const hostname = env.HOST ?? '127.0.0.1'
  if (!['127.0.0.1', '0.0.0.0', '::1', '::'].includes(hostname))
    throw new Error('Invalid listen configuration')
  return { bindings, port: Number(port), hostname }
}
