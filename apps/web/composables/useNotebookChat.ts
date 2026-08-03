import { ref } from 'vue'
import { useApi } from '~/composables/useApi'
import type { ChatMessage } from '~/types/notebook'

export function useNotebookChat(orgId: () => string) {
  const { apiFetch } = useApi()
  const messages = ref<ChatMessage[]>([])
  const loading = ref(false)
  const error = ref<string | null>(null)

  function headers() {
    return { 'x-org-id': orgId() }
  }

  async function loadMessages(notebookId: string) {
    loading.value = true
    error.value = null
    try {
      messages.value = await apiFetch<ChatMessage[]>(
        `/api/notebooks/${notebookId}/chat/list`,
        { headers: headers() }
      )
    } catch (err: any) {
      error.value = err.message
      messages.value = []
    } finally {
      loading.value = false
    }
  }

  function appendMessage(msg: ChatMessage) {
    // De-dupe: if a message with this id is already there, replace.
    const idx = messages.value.findIndex(m => m.id === msg.id)
    if (idx > -1) messages.value[idx] = msg
    else messages.value.push(msg)
  }

  async function clearMessages(notebookId: string) {
    await apiFetch(`/api/notebooks/${notebookId}/chat/clear`, {
      method: 'POST',
      headers: headers()
    })
    messages.value = []
  }

  return { messages, loading, error, loadMessages, appendMessage, clearMessages }
}
