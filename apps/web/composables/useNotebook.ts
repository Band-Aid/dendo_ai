import { ref, computed } from 'vue'
import type { Notebook, NotebookCell, NotebookWithCells } from '~/types/notebook'
import { useApi } from '~/composables/useApi'

export function useNotebook(orgId: () => string) {
  const { apiFetch } = useApi()
  const notebooks = ref<Notebook[]>([])
  const current = ref<NotebookWithCells | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)

  function headers() {
    return { 'x-org-id': orgId() }
  }

  async function loadNotebooks() {
    loading.value = true
    error.value = null
    try {
      notebooks.value = await apiFetch('/api/notebooks', { headers: headers() })
    } catch (err: any) {
      error.value = err.message
    } finally {
      loading.value = false
    }
  }

  async function loadNotebook(id: string) {
    loading.value = true
    error.value = null
    try {
      current.value = await apiFetch(`/api/notebooks/${id}`, { headers: headers() })
    } catch (err: any) {
      error.value = err.message
    } finally {
      loading.value = false
    }
  }

  async function createNotebook(title: string, description?: string): Promise<Notebook> {
    const nb: Notebook = await apiFetch('/api/notebooks', {
      method: 'POST',
      headers: headers(),
      body: { title, description }
    })
    notebooks.value.unshift(nb)
    return nb
  }

  async function updateNotebook(
    id: string,
    patch: {
      title?: string
      description?: string
      default_segment_id?: string | null
      default_segment_name?: string | null
    }
  ) {
    const updated = await apiFetch(`/api/notebooks/${id}`, {
      method: 'PATCH',
      headers: headers(),
      body: patch
    })
    if (current.value?.id === id) {
      current.value = { ...current.value, ...updated }
    }
    const idx = notebooks.value.findIndex(n => n.id === id)
    if (idx > -1) notebooks.value[idx] = { ...notebooks.value[idx], ...updated }
    return updated
  }

  async function deleteNotebook(id: string) {
    await apiFetch(`/api/notebooks/${id}`, { method: 'DELETE', headers: headers() })
    notebooks.value = notebooks.value.filter(n => n.id !== id)
    if (current.value?.id === id) current.value = null
  }

  /**
   * NOTE the parameter order: `afterCellId` (position) comes BEFORE
   * `sourceCellId` (ownership) — the inverse of the server-side `addCell` in
   * notebookStore.ts. They are easy to transpose and both take a plain cell
   * id, so a swap is silent: passing a source id in the `afterCellId` slot
   * still positions the cell plausibly while `source_cell_id` stays null.
   * That exact bug left every query-run result cell unlinked from its query.
   */
  async function addCell(
    notebookId: string,
    cellType: string,
    content: string,
    metaJson: Record<string, unknown> = {},
    afterCellId?: string | null,
    sourceCellId?: string | null
  ): Promise<NotebookCell> {
    const cell: NotebookCell = await apiFetch(`/api/notebooks/${notebookId}/cells`, {
      method: 'POST',
      headers: headers(),
      body: {
        cell_type: cellType,
        content,
        meta_json: metaJson,
        after_cell_id: afterCellId ?? null,
        source_cell_id: sourceCellId ?? null
      }
    })
    if (current.value?.id === notebookId) {
      insertCellIntoList(current.value.cells, cell)
    }
    return cell
  }

  async function updateCell(
    notebookId: string,
    cellId: string,
    patch: {
      content?: string
      meta_json?: Record<string, unknown>
      source_cell_id?: string | null
    }
  ): Promise<NotebookCell> {
    const cell: NotebookCell = await apiFetch(`/api/notebooks/${notebookId}/cells/${cellId}`, {
      method: 'PATCH',
      headers: headers(),
      body: patch
    })
    if (current.value?.id === notebookId) {
      const idx = current.value.cells.findIndex(c => c.id === cellId)
      if (idx > -1) current.value.cells[idx] = cell
    }
    return cell
  }

  async function deleteCell(notebookId: string, cellId: string) {
    await apiFetch(`/api/notebooks/${notebookId}/cells/${cellId}`, {
      method: 'DELETE',
      headers: headers()
    })
    if (current.value?.id === notebookId) {
      current.value.cells = current.value.cells.filter(c => c.id !== cellId)
    }
  }

  async function moveCell(notebookId: string, cellId: string, afterCellId: string | null) {
    const cell: NotebookCell = await apiFetch(`/api/notebooks/${notebookId}/cells/${cellId}/move`, {
      method: 'POST',
      headers: headers(),
      body: { after_cell_id: afterCellId }
    })
    if (current.value?.id === notebookId) {
      current.value.cells = current.value.cells.filter(c => c.id !== cellId)
      insertCellIntoList(current.value.cells, cell)
    }
    return cell
  }

  function injectCell(cell: NotebookCell) {
    if (!current.value) return
    const existing = current.value.cells.findIndex(c => c.id === cell.id)
    if (existing > -1) {
      current.value.cells[existing] = cell
    } else {
      insertCellIntoList(current.value.cells, cell)
    }
  }

  function insertCellIntoList(cells: NotebookCell[], cell: NotebookCell) {
    const insertAt = cells.findIndex(c => c.position > cell.position)
    if (insertAt === -1) {
      cells.push(cell)
    } else {
      cells.splice(insertAt, 0, cell)
    }
  }

  const sortedCells = computed(() => {
    if (!current.value) return []
    return [...current.value.cells].sort((a, b) => a.position - b.position)
  })

  return {
    notebooks,
    current,
    loading,
    error,
    sortedCells,
    loadNotebooks,
    loadNotebook,
    createNotebook,
    updateNotebook,
    deleteNotebook,
    addCell,
    updateCell,
    deleteCell,
    moveCell,
    injectCell
  }
}
