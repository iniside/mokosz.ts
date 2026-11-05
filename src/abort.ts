export async function abortable<T>(
  start: () => Promise<T>,
  signal: AbortSignal | undefined,
): Promise<T> {
  signal?.throwIfAborted()
  const pending = start()
  if (signal === undefined) return pending
  pending.catch(() => {})
  const aborted = Promise.withResolvers<never>()
  const onAbort = (): void => aborted.reject(signal.reason)
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([pending, aborted.promise])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}
