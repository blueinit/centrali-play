import type { Bindings } from './config'
import { sessionConfig } from './config'
import { shutdownConfig } from './storage-controls'

export function nodeConfig(env: Record<string, string | undefined>) {
  const bindings: Bindings = {}
  for (const name of [
    'PUBLIC_BASE_URL',
    'UPSTASH_REDIS_REST_URL',
    'UPSTASH_REDIS_REST_TOKEN',
    'DISABLE_SESSION_CREATION',
    'DISABLE_STORAGE_ROUTES',
  ] as const) {
    if (env[name] !== undefined) bindings[name] = env[name]
  }
  sessionConfig(bindings)
  shutdownConfig(bindings)
  const port = env.PORT ?? '3000'
  if (!/^[1-9][0-9]{0,4}$/.test(port) || Number(port) > 65_535)
    throw new Error('Invalid port configuration')
  const hostname = env.HOST ?? '127.0.0.1'
  if (!['127.0.0.1', '0.0.0.0', '::1', '::'].includes(hostname))
    throw new Error('Invalid listen configuration')
  return { bindings, port: Number(port), hostname }
}
