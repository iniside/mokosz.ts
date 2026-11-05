import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import {
  ApiError,
  createConversation,
  fetchRunError,
  getConversation,
  postMessage,
  type Conversation,
  type Lang,
  type Turn,
} from '@/lib/api'
import type { OpenCitation } from '@/features/chat/Answer'
import { CitationPanel } from '@/features/chat/CitationPanel'
import { Composer } from '@/features/chat/Composer'
import { EmptyState } from '@/features/chat/EmptyState'
import { MessageList } from '@/features/chat/MessageList'
import { setConversationId, useConversationId } from '@/features/chat/url'
import { useRunStream } from '@/features/chat/useRunStream'

interface Loaded {
  id: string
  conversation: Conversation | null
  error: ApiError | null
}

function asApiError(error: unknown): ApiError {
  if (error instanceof ApiError) return error
  return new ApiError(0, error instanceof Error ? error.message : String(error))
}

function useConversation(id: string | null) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [version, setVersion] = useState(0)

  useEffect(() => {
    if (!id) return
    const controller = new AbortController()
    getConversation(id, controller.signal).then(
      (conversation) => setLoaded({ id, conversation, error: null }),
      (error: unknown) => {
        if (controller.signal.aborted) return
        const failure = asApiError(error)
        setLoaded((prev) => ({
          id,
          conversation: prev?.id === id ? prev.conversation : null,
          error: failure,
        }))
      },
    )
    return () => controller.abort()
  }, [id, version])

  const reload = useCallback(() => setVersion((v) => v + 1), [])
  const current = id && loaded?.id === id ? loaded : null
  const conversation = current?.conversation ?? null
  const failure = current?.error ?? null
  return {
    conversation,
    error: conversation ? null : failure,
    reloadError: conversation ? failure : null,
    reload,
  }
}

function useRunErrors(turns: Turn[]) {
  const [errors, setErrors] = useState<Record<string, string | null>>({})
  const requested = useRef(new Set<string>())

  const record = useCallback((runId: string, message: string | null) => {
    requested.current.add(runId)
    setErrors((current) => ({ ...current, [runId]: message }))
  }, [])

  useEffect(() => {
    const missing = turns.filter(
      (turn) => turn.status === 'failed' && !requested.current.has(turn.run_id),
    )
    for (const turn of missing) {
      requested.current.add(turn.run_id)
      fetchRunError(turn.run_id).then(
        (message) => setErrors((current) => ({ ...current, [turn.run_id]: message })),
        () => setErrors((current) => ({ ...current, [turn.run_id]: null })),
      )
    }
  }, [turns])

  return [errors, record] as const
}

function sendErrorMessage(error: ApiError): string {
  if (error.status === 409)
    return 'A run is already active in this conversation. Wait for it to finish.'
  if (error.status === 404)
    return 'This conversation no longer exists. Start a new one from the top bar.'
  if (error.unreachable)
    return 'The API is unreachable. Start it with npx mokosz serve, then send again.'
  return error.message
}

function LoadError({ error, onRetry }: { error: ApiError; onRetry: () => void }) {
  const missing = error.status === 404 || error.status === 422
  return (
    <div role="alert" className="max-w-xl border-l-2 border-destructive/70 py-1 pl-5">
      <h1 className="font-serif text-2xl text-foreground">
        {missing
          ? 'This conversation does not exist.'
          : error.unreachable
            ? 'The API is unreachable.'
            : 'The conversation could not be loaded.'}
      </h1>
      <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
        {missing ? (
          'The link may point to a conversation from another database. Start a new conversation instead.'
        ) : error.unreachable ? (
          <>
            Start it with <code className="font-mono text-foreground/80">npx mokosz serve</code> and
            try again.
          </>
        ) : (
          error.message
        )}
      </p>
      <div className="mt-5 flex gap-2">
        {!missing && (
          <Button variant="outline" onClick={onRetry}>
            Try again
          </Button>
        )}
        <Button variant={missing ? 'outline' : 'ghost'} onClick={() => setConversationId(null)}>
          New conversation
        </Button>
      </div>
    </div>
  )
}

function LoadingTurns() {
  return (
    <div
      className="grid grid-cols-[3rem_minmax(0,1fr)] gap-x-6 pt-2"
      aria-label="Loading the conversation"
    >
      <Skeleton className="h-3 w-6" />
      <div className="space-y-3">
        <Skeleton className="h-6 w-3/5" />
        <div className="space-y-2.5 pt-6">
          <Skeleton className="h-3.5 w-11/12" />
          <Skeleton className="h-3.5 w-4/5" />
          <Skeleton className="h-3.5 w-2/3" />
        </div>
      </div>
    </div>
  )
}

interface Pending {
  conversationId: string | null
  question: string
  runId: string | null
}

export function ChatScreen() {
  const id = useConversationId()
  const { conversation, error, reloadError, reload } = useConversation(id)
  const turns = conversation?.turns ?? []
  const last = turns.at(-1)
  const activeRunId = last?.status === 'running' ? last.run_id : null

  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [sendError, setSendError] = useState<{
    conversationId: string | null
    message: string
  } | null>(null)
  const [pending, setPending] = useState<Pending | null>(null)
  const [citation, setCitation] = useState<OpenCitation | null>(null)
  const opener = useRef<HTMLElement | null>(null)
  const openCitation = useCallback((next: OpenCitation) => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null
    setCitation(next)
  }, [])
  const [runErrors, recordRunError] = useRunErrors(turns)

  const onRunEnd = useCallback(
    (runId: string, message: string | null) => {
      if (message !== null) recordRunError(runId, message)
      reload()
    },
    [recordRunError, reload],
  )
  const stream = useRunStream(activeRunId, onRunEnd)

  const pendingShown =
    pending && pending.conversationId === id && !turns.some((turn) => turn.run_id === pending.runId)
      ? pending.question
      : null
  const busy =
    sending ||
    activeRunId !== null ||
    pendingShown !== null ||
    (id !== null && !conversation && !error)

  const send = async (text: string) => {
    const question = text.trim()
    if (!question || busy) return
    setSending(true)
    setSendError(null)
    setPending({ conversationId: id, question, runId: null })
    let target = id
    try {
      target ??= (await createConversation()).id
      const { run_id } = await postMessage(target, question)
      setPending({ conversationId: target, question, runId: run_id })
      setDraft('')
      if (target === id) reload()
      else setConversationId(target)
    } catch (caught) {
      const failure = asApiError(caught)
      setPending(null)
      setDraft(question)
      setSendError({ conversationId: target, message: sendErrorMessage(failure) })
      if (target !== id) setConversationId(target)
      else if (failure.status === 409) reload()
    } finally {
      setSending(false)
    }
  }

  const scroller = useRef<HTMLDivElement>(null)
  const progress = `${turns.length}:${last?.status}:${stream.visits.length}:${pendingShown ?? ''}`
  useLayoutEffect(() => {
    const element = scroller.current
    if (!element) return
    const smooth = !window.matchMedia('(prefers-reduced-motion: reduce)').matches
    element.scrollTo({ top: element.scrollHeight, behavior: smooth ? 'smooth' : 'auto' })
  }, [progress])

  const showEmpty =
    pendingShown === null && (id === null || (conversation?.turns.length === 0 && !error))
  let status: string | null = null
  if (sending) status = 'Sending…'
  else if (activeRunId || pendingShown !== null)
    status = 'Answering… the run keeps going if you reload or leave.'

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[56rem] px-8 pt-10 pb-12">
          {showEmpty && <EmptyState onAsk={(text) => void send(text)} disabled={busy} />}
          {id !== null && error && <LoadError error={error} onRetry={reload} />}
          {id !== null && reloadError && (
            <div
              role="alert"
              className="mb-6 flex items-center gap-3 border-l-2 border-destructive/70 py-1 pl-4 text-sm text-muted-foreground"
            >
              <span>
                {reloadError.unreachable
                  ? 'The API is unreachable.'
                  : 'The conversation could not be refreshed.'}{' '}
                Showing the last loaded version.
              </span>
              <Button variant="outline" size="sm" onClick={reload}>
                Try again
              </Button>
            </div>
          )}
          {id !== null && !conversation && !error && pendingShown === null && <LoadingTurns />}
          {!showEmpty && (conversation || pendingShown !== null) && !error && (
            <MessageList
              turns={turns}
              activeRunId={activeRunId}
              pending={pendingShown}
              stream={stream}
              runErrors={runErrors}
              openKey={citation?.key ?? null}
              onOpen={openCitation}
            />
          )}
        </div>
      </div>
      <Composer
        value={draft}
        onChange={setDraft}
        onSend={(text) => void send(text)}
        disabled={busy || (id !== null && error !== null)}
        disabledHint={
          error
            ? 'Reload the conversation or start a new one'
            : 'Wait for the current answer to finish…'
        }
        status={status}
        error={sendError && sendError.conversationId === id ? sendError.message : null}
      />
      <CitationPanel
        open={citation}
        onLangChange={(lang: Lang) =>
          setCitation((current) => (current ? { ...current, lang } : current))
        }
        onClose={() => setCitation(null)}
        returnFocus={opener}
      />
    </div>
  )
}
