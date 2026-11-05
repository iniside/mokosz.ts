import { useSyncExternalStore } from 'react'

const PARAM = 'c'
const CHANGE = 'mokosz:conversation'

function subscribe(onChange: () => void): () => void {
  window.addEventListener('popstate', onChange)
  window.addEventListener(CHANGE, onChange)
  return () => {
    window.removeEventListener('popstate', onChange)
    window.removeEventListener(CHANGE, onChange)
  }
}

function read(): string | null {
  return new URLSearchParams(window.location.search).get(PARAM)
}

export function useConversationId(): string | null {
  return useSyncExternalStore(subscribe, read)
}

export function setConversationId(id: string | null): void {
  if (id === read()) return
  const url = new URL(window.location.href)
  if (id) url.searchParams.set(PARAM, id)
  else url.searchParams.delete(PARAM)
  window.history.pushState(null, '', url)
  window.dispatchEvent(new Event(CHANGE))
}
