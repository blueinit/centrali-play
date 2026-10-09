const REQUEST_BODY_TIMEOUT_MS = 5_000

async function containsBytes(reader: ReadableStreamDefaultReader<Uint8Array>) {
  while (true) {
    const { done, value } = await reader.read()
    if (done) return false
    if (value.byteLength > 0) return true
  }
}

export async function hasRequestBody(
  request: Request,
  timeoutMs = REQUEST_BODY_TIMEOUT_MS,
): Promise<boolean> {
  if (!request.body) return false
  const reader = request.body.getReader()
  let timeoutId: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error('Request body timed out')),
      timeoutMs,
    )
  })

  try {
    return await Promise.race([containsBytes(reader), deadline])
  } finally {
    clearTimeout(timeoutId)
    // Do not wait for cancellation: an untrusted producer can stall that too.
    void reader.cancel().catch(() => {})
  }
}

export async function readLimitedText(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number,
): Promise<string> {
  if (!body) throw new Error('Empty response body')
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let size = 0
  let text = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return text + decoder.decode()
      size += value.byteLength
      if (size > maxBytes) throw new Error('Response body too large')
      text += decoder.decode(value, { stream: true })
    }
  } finally {
    void reader.cancel().catch(() => {})
  }
}
