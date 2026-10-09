import { Hono } from 'hono'
import type { Bindings } from './config'
import { createSession } from './sessions'
import { captureRequest } from './captures'

const app = new Hono<{ Bindings: Bindings }>()

app.get('/health', (c) => {
  c.header('Cache-Control', 'no-store')
  return c.json({ status: 'ok' })
})

app.post('/sessions', createSession)
app.all('/capture/:captureToken', captureRequest)

app.notFound((c) => c.json({ error: 'not_found' }, 404))

export default app
