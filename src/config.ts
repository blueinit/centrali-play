export type Bindings = {
  PUBLIC_BASE_URL?: string
  UPSTASH_REDIS_REST_URL?: string
  UPSTASH_REDIS_REST_TOKEN?: string
}

export function parseOrigin(value: string | undefined): string {
  if (
    !value ||
    !/^https?:\/\/(\[[^\]]+\]|[^\s/?#:@\\]+)(:\d+)?\/?$/.test(value)
  ) {
    throw new Error('Invalid origin configuration')
  }

  const url = new URL(value)
  const loopback = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
  if (url.protocol !== 'https:' && !loopback) {
    throw new Error('HTTPS required')
  }

  return url.origin
}

export function sessionConfig(env: Bindings) {
  const publicOrigin = parseOrigin(env.PUBLIC_BASE_URL)
  const redisOrigin = parseOrigin(env.UPSTASH_REDIS_REST_URL)
  const redisToken = env.UPSTASH_REDIS_REST_TOKEN
  if (!redisToken || /[\s\x00-\x1f\x7f]/.test(redisToken)) {
    throw new Error('Invalid Redis credential configuration')
  }

  return { publicOrigin, redisOrigin, redisToken }
}

export type SessionConfig = ReturnType<typeof sessionConfig>
