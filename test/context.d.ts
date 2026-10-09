import 'vitest'

declare module 'vitest' {
  interface ProvidedContext {
    redisHttpPort: number
  }
}
