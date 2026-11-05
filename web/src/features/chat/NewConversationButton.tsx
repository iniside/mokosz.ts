import { PlusIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { setConversationId, useConversationId } from '@/features/chat/url'

export function NewConversationButton() {
  const id = useConversationId()
  return (
    <Button variant="outline" disabled={id === null} onClick={() => setConversationId(null)}>
      <PlusIcon data-icon="inline-start" />
      New conversation
    </Button>
  )
}
