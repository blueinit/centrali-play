export type Bindings = {
  SESSION_ADMISSION_SCOPE?: string
  SESSIONS_PER_HOUR?: string
  SESSIONS_PER_DAY?: string
  MAX_ACTIVE_SESSIONS?: string
  CAPTURE_PER_MINUTE?: string
  CAPTURE_PER_SESSION?: string
  READ_PER_MINUTE?: string
  READ_PER_SESSION?: string
  DISABLE_SESSION_CREATION?: string
  DISABLE_STORAGE_ROUTES?: string
  PUBLIC_BASE_URL?: string
  UPSTASH_REDIS_REST_URL?: string
  UPSTASH_REDIS_REST_TOKEN?: string
}

export type RedisConfig = {
  redisOrigin: string
  redisToken: string
}

export type SessionConfig = RedisConfig & { publicOrigin: string }

// Check the original shape before URL parsing can normalize paths such as /../.
const ORIGIN_SHAPE = /^https?:\/\/[^/?#\s\\]+\/?$/
const LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]']

export function parseOrigin(value: string | undefined): string {
  if (!value || !ORIGIN_SHAPE.test(value) || value.includes('@')) {
    throw new Error('Invalid origin configuration')
  }

  const url = new URL(value)
  const loopback = LOOPBACK_HOSTS.includes(url.hostname)
  if (url.protocol !== 'https:' && !loopback) {
    throw new Error('HTTPS required')
  }

  return url.origin
}

function parseRedisToken(value: string | undefined): string {
  if (!value || /[\s\x00-\x1f\x7f]/.test(value)) {
    throw new Error('Invalid Redis credential configuration')
  }
  return value
}

export function sessionConfig(env: Bindings): SessionConfig {
  return {
    publicOrigin: parseOrigin(env.PUBLIC_BASE_URL),
    redisOrigin: parseOrigin(env.UPSTASH_REDIS_REST_URL),
    redisToken: parseRedisToken(env.UPSTASH_REDIS_REST_TOKEN),
  }
}
