<script setup lang="ts">
import { ref, watch, computed, h } from 'vue'
import { PlusOutlined, DeleteOutlined, ThunderboltOutlined } from '@ant-design/icons-vue'
import { message } from 'ant-design-vue'
import { useApi } from '~/composables/useApi'
import { useOrg } from '~/composables/useOrg'
import { useI18n } from '~/composables/useI18n'
import type { OntologyConcept, ConceptCause, ConceptAction } from '~/types/ontology'

const { t } = useI18n()
const { apiFetch } = useApi()
const { currentOrgId } = useOrg()

interface EntityOption { id: string; kind: string; name: string }

const props = defineProps<{
  open: boolean
  /** null → creating a new concept. */
  concept: OntologyConcept | null
  entities: EntityOption[]
}>()
const emit = defineEmits<{ close: []; saved: [concept: OntologyConcept] }>()

const saving = ref(false)
const name = ref('')
const definition = ref('')
const dslTemplate = ref('')
const kpiColumn = ref('')
const measures = ref<string[]>([])
const causes = ref<ConceptCause[]>([])
const actions = ref<ConceptAction[]>([])
const dslWarning = ref('')

watch(() => props.open, (open) => {
  if (!open) return
  dslWarning.value = ''
  remoteOptions.value = []
  remoteLoading.value = false
  const c = props.concept
  name.value = c?.name ?? ''
  definition.value = c?.definition ?? ''
  dslTemplate.value = c?.dslTemplate ?? ''
  kpiColumn.value = c?.kpiColumn ?? ''
  measures.value = [...(c?.measures ?? [])]
  causes.value = JSON.parse(JSON.stringify(c?.causes ?? []))
  actions.value = JSON.parse(JSON.stringify(c?.actions ?? []))
})

const newId = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

const mapping = ref(false)

interface AutoMapResponse {
  measures: Array<{ id: string; name: string; kind: string }>
  kpiColumn?: string
  dslTemplate?: string
  causes: Array<{ text: string; questionTemplate?: string }>
  actions: Array<{ title: string; description?: string; questionTemplate?: string }>
  llmUsed: boolean
}

/**
 * AI-draft the concept from the problem statement (name + definition):
 * measured objects, KPI (column + canonical DSL), causes, and actions.
 * Fills BLANK fields and merges lists — never overwrites what the user typed.
 */
async function autoMap() {
  if (!name.value.trim()) return
  mapping.value = true
  try {
    const res = await apiFetch<AutoMapResponse>(
      '/api/ontology/map-entities',
      {
        method: 'POST',
        headers: { 'x-org-id': currentOrgId.value },
        body: { name: name.value.trim(), definition: definition.value.trim() }
      }
    )
    const merged = new Set(measures.value)
    let added = 0
    for (const m of res.measures) {
      if (!merged.has(m.id)) { merged.add(m.id); added++ }
    }
    measures.value = [...merged]

    if (res.dslTemplate && !dslTemplate.value.trim()) dslTemplate.value = res.dslTemplate
    if (res.kpiColumn && !kpiColumn.value.trim()) kpiColumn.value = res.kpiColumn

    const existingCauses = new Set(causes.value.map(c => c.text?.trim().toLowerCase()))
    const newCauses = res.causes.filter(c => !existingCauses.has(c.text.trim().toLowerCase()))
    for (const c of newCauses) {
      causes.value.push({ id: newId(), text: c.text, questionTemplate: c.questionTemplate ?? '' })
    }
    const existingActions = new Set(actions.value.map(a => a.title.trim().toLowerCase()))
    const newActions = res.actions.filter(a => !existingActions.has(a.title.trim().toLowerCase()))
    for (const a of newActions) {
      actions.value.push({ id: newId(), title: a.title, description: a.description ?? '', questionTemplate: a.questionTemplate ?? '' })
    }

    if (added + newCauses.length + newActions.length > 0) {
      message.success(t('ui.ontology.autoMapDone', { n: added, c: newCauses.length, a: newActions.length }))
    } else {
      message.info(t('ui.ontology.autoMapNone'))
    }
  } catch (err: any) {
    message.error(err.message || 'Auto-map failed')
  } finally {
    mapping.value = false
  }
}

// --- Live Pendo search ---------------------------------------------------------
// The synced map is truncated (per-kind caps), so the local `entities` prop
// never holds everything. Typing in the measures select also searches Pendo
// live; picked remote entities are sent as `newEntities` on save and the
// server registers them as structural nodes.

interface RemoteEntity {
  id: string
  kind: string
  pendoId: string
  name: string
  appId?: number
  url?: string
  description?: string
  groupId?: string
  groupName?: string
  cached: boolean
}

const remoteOptions = ref<RemoteEntity[]>([])
const remoteLoading = ref(false)
// Every remote entity ever offered, so a selected tag keeps its label after
// the search text (and remoteOptions) moves on. Plain Map — reads happen in
// recomputes already triggered by `measures`/`remoteOptions` changes.
const remoteCatalog = new Map<string, RemoteEntity>()
let searchTimer: ReturnType<typeof setTimeout> | undefined
let searchSeq = 0

function onMeasureSearch(text: string) {
  clearTimeout(searchTimer)
  const q = text.trim()
  const seq = ++searchSeq
  if (q.length < 2) {
    remoteOptions.value = []
    remoteLoading.value = false
    return
  }
  remoteLoading.value = true
  searchTimer = setTimeout(async () => {
    try {
      const res = await apiFetch<{ entities: RemoteEntity[] }>(
        `/api/ontology/entities/search?q=${encodeURIComponent(q)}`,
        { headers: { 'x-org-id': currentOrgId.value } }
      )
      if (seq !== searchSeq) return
      remoteOptions.value = res.entities.filter(e => !e.cached)
      for (const e of remoteOptions.value) remoteCatalog.set(e.id, e)
    } catch {
      // Search is additive over the local options — a failed lookup just
      // means no remote rows, never an error state in the select.
      if (seq === searchSeq) remoteOptions.value = []
    } finally {
      if (seq === searchSeq) remoteLoading.value = false
    }
  }, 300)
}

const measureOptions = computed(() => {
  const known = new Set(props.entities.map(e => e.id))
  const opts = props.entities.map(e => ({
    value: e.id,
    label: `${e.name} (${t(`ui.ontology.legend.${e.kind}`)})`
  }))
  const extra = new Map<string, RemoteEntity>()
  // Selected-but-unsynced first, so their tags always render a name.
  for (const id of measures.value) {
    const r = remoteCatalog.get(id)
    if (r && !known.has(id)) extra.set(id, r)
  }
  for (const r of remoteOptions.value) {
    if (!known.has(r.id)) extra.set(r.id, r)
  }
  for (const r of extra.values()) {
    opts.push({
      value: r.id,
      label: `${r.name} (${t(`ui.ontology.legend.${r.kind}`)} · ${t('ui.ontology.remoteTag')})`
    })
  }
  return opts
})

function addCause() {
  causes.value.push({ id: newId(), text: '', questionTemplate: '' })
}
function addAction() {
  actions.value.push({ id: newId(), title: '', description: '', questionTemplate: '' })
}

async function save() {
  if (!name.value.trim() || !definition.value.trim()) return
  saving.value = true
  dslWarning.value = ''
  const known = new Set(props.entities.map(e => e.id))
  const newEntities = measures.value
    .filter(id => !known.has(id) && remoteCatalog.has(id))
    .map(id => {
      const r = remoteCatalog.get(id)!
      return {
        kind: r.kind,
        pendoId: r.pendoId,
        name: r.name,
        appId: r.appId,
        url: r.url,
        description: r.description,
        groupId: r.groupId,
        groupName: r.groupName
      }
    })
  try {
    const res = await apiFetch<{ concept: OntologyConcept; dslWarning?: string; dslRegenerated?: boolean }>(
      '/api/ontology/concepts',
      {
        method: 'POST',
        headers: { 'x-org-id': currentOrgId.value },
        body: {
          id: props.concept?.id,
          name: name.value.trim(),
          definition: definition.value.trim(),
          dslTemplate: dslTemplate.value.trim() || undefined,
          kpiColumn: kpiColumn.value.trim() || undefined,
          measures: measures.value,
          causes: causes.value.filter(c => c.text?.trim() || c.conceptId),
          actions: actions.value.filter(a => a.title.trim()),
          source: props.concept?.source ?? 'manual',
          newEntities
        }
      }
    )
    // The server rebuilds a machine-derived template when the measures change,
    // so show what was actually stored rather than the stale text still in the
    // box — the drawer stays open on a warning and would otherwise re-submit it.
    if (res.concept.dslTemplate !== undefined || dslTemplate.value) {
      dslTemplate.value = res.concept.dslTemplate ?? ''
    }
    if (res.dslWarning) {
      // Saved anyway — surface the warning so the template gets fixed before
      // the agent starts preferring it.
      dslWarning.value = res.dslWarning
      message.warning(res.dslWarning)
    } else if (res.dslRegenerated) {
      message.success(t('ui.ontology.dslRegenerated'))
    } else {
      message.success(t('ui.ontology.conceptSaved'))
    }
    emit('saved', res.concept)
    if (!res.dslWarning) emit('close')
  } catch (err: any) {
    message.error(err.message || 'Failed to save concept')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <a-drawer
    :open="open"
    :title="concept ? t('ui.ontology.editConcept') : t('ui.ontology.newConcept')"
    width="520"
    @close="emit('close')"
  >
    <div class="ce-form">
      <label class="ce-label">{{ t('ui.ontology.conceptName') }}</label>
      <a-input v-model:value="name" :placeholder="t('ui.ontology.conceptNamePh')" />

      <label class="ce-label">{{ t('ui.ontology.definition') }}</label>
      <a-textarea
        v-model:value="definition"
        :auto-size="{ minRows: 3, maxRows: 8 }"
        :placeholder="t('ui.ontology.definitionPh')"
      />

      <label class="ce-label">{{ t('ui.ontology.dslTemplate') }}</label>
      <a-textarea
        v-model:value="dslTemplate"
        :auto-size="{ minRows: 3, maxRows: 12 }"
        class="ce-dsl"
        spellcheck="false"
        :placeholder="t('ui.ontology.dslTemplatePh')"
      />
      <p v-if="dslWarning" class="ce-warning">{{ dslWarning }}</p>

      <label class="ce-label">{{ t('ui.ontology.kpiColumn') }}</label>
      <a-input v-model:value="kpiColumn" :placeholder="t('ui.ontology.kpiColumnPh')" />

      <div class="ce-list-head">
        <label class="ce-label">{{ t('ui.ontology.measures') }}</label>
        <a-button
          size="small"
          :icon="h(ThunderboltOutlined)"
          :loading="mapping"
          :disabled="!name.trim()"
          @click="autoMap"
        >{{ t('ui.ontology.autoMap') }}</a-button>
      </div>
      <!-- No max-tag-count: collapsed "+N" tags can't be individually removed,
           which made big AI-mapped selections uneditable. 20 max, they wrap. -->
      <a-select
        v-model:value="measures"
        mode="multiple"
        style="width: 100%"
        :placeholder="t('ui.ontology.measuresPh')"
        :options="measureOptions"
        option-filter-prop="label"
        :loading="remoteLoading"
        @search="onMeasureSearch"
      />

      <div class="ce-list-head">
        <label class="ce-label">{{ t('ui.ontology.causes') }}</label>
        <a-button size="small" type="text" :icon="h(PlusOutlined)" @click="addCause" />
      </div>
      <div v-for="(cause, i) in causes" :key="cause.id" class="ce-item">
        <a-input v-model:value="cause.text" :placeholder="t('ui.ontology.causePh')" />
        <a-input v-model:value="cause.questionTemplate" :placeholder="t('ui.ontology.questionTemplatePh')" />
        <a-button size="small" type="text" danger :icon="h(DeleteOutlined)" @click="causes.splice(i, 1)" />
      </div>

      <div class="ce-list-head">
        <label class="ce-label">{{ t('ui.ontology.actions') }}</label>
        <a-button size="small" type="text" :icon="h(PlusOutlined)" @click="addAction" />
      </div>
      <div v-for="(action, i) in actions" :key="action.id" class="ce-item">
        <a-input v-model:value="action.title" :placeholder="t('ui.ontology.actionPh')" />
        <a-input v-model:value="action.questionTemplate" :placeholder="t('ui.ontology.questionTemplatePh')" />
        <a-button size="small" type="text" danger :icon="h(DeleteOutlined)" @click="actions.splice(i, 1)" />
      </div>

      <div class="ce-foot">
        <a-button @click="emit('close')">{{ t('ui.ontology.cancel') }}</a-button>
        <a-button
          type="primary"
          :loading="saving"
          :disabled="!name.trim() || !definition.trim()"
          @click="save"
        >{{ t('ui.ontology.saveConcept') }}</a-button>
      </div>
    </div>
  </a-drawer>
</template>

<style scoped>
.ce-form { display: flex; flex-direction: column; gap: 8px; }
.ce-label {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--muted);
  margin-top: 8px;
}
.ce-dsl :deep(textarea) {
  font-family: var(--mono) !important;
  font-size: 12px !important;
}
.ce-warning {
  font-size: 12px;
  color: var(--accent-deep, #8a3422);
  font-family: var(--mono);
  margin: 2px 0 0;
}
.ce-list-head { display: flex; align-items: center; justify-content: space-between; }
.ce-item {
  display: grid;
  grid-template-columns: 1fr 1fr auto;
  gap: 6px;
  align-items: center;
}
.ce-foot {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
  padding-top: 12px;
  border-top: 1px solid var(--rule, #e5e0d5);
}
</style>
