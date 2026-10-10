import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  plugins: [
    cloudflareTest(({ inject }) => ({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          PUBLIC_BASE_URL: 'https://play.example',
          UPSTASH_REDIS_REST_URL: `http://127.0.0.1:${inject('redisHttpPort')}`,
          UPSTASH_REDIS_REST_TOKEN: 'local-development-only',
          SESSION_ADMISSION_SCOPE: inject('admissionScope'),
        },
      },
    })),
  ],
  test: {
    include: ['test/**/*.test.ts'],
    globalSetup: ['test/global-setup.ts'],
  },
})
