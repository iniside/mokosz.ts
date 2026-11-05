import { AppShell } from '@/components/layout/AppShell'
import { ChatScreen } from '@/features/chat/ChatScreen'
import { NewConversationButton } from '@/features/chat/NewConversationButton'

export default function App() {
  return (
    <AppShell actions={<NewConversationButton />}>
      <ChatScreen />
    </AppShell>
  )
}
