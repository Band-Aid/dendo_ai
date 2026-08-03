<script setup lang="ts">
import { ref, computed, onMounted, h } from 'vue'
import { SaveOutlined, PlusOutlined, DeleteOutlined } from '@ant-design/icons-vue'
import { message } from 'ant-design-vue'
import { useApi } from '~/composables/useApi'
import { useOrg } from '~/composables/useOrg'
import { useI18n } from '~/composables/useI18n'

const { t } = useI18n()
const { apiFetch } = useApi()
const { currentOrgId } = useOrg()

const loading = ref(false)
const saving = ref(false)

// Saved value (loaded from server, used to detect dirtiness).
const saved = ref('')
// In-progress edits.
const draft = ref('')

interface CustomSkill {
  id: string
  name: string
  triggers: string
  content: string
  enabled: boolean
}

// Snapshot of the skills array as saved on the server. Compared against
// `skillsDraft` to drive the dirty pill / save button.
const savedSkills = ref<CustomSkill[]>([])
const skillsDraft = ref<CustomSkill[]>([])

const MAX_SKILLS = 10
const SKILL_CONTENT_LIMIT = 30000

const dirtyInstructions = computed(() => draft.value.trim() !== saved.value.trim())
const dirtySkills = computed(
  () => JSON.stringify(skillsDraft.value) !== JSON.stringify(savedSkills.value)
)
const dirty = computed(() => dirtyInstructions.value || dirtySkills.value)

const charCount = computed(() => draft.value.length)
const overLimit = computed(() => charCount.value > 8000)
const skillsOverLimit = computed(() =>
  skillsDraft.value.some(s => s.content.length > SKILL_CONTENT_LIMIT)
)
const hasInvalidSkill = computed(() =>
  skillsDraft.value.some(s => !s.name.trim())
)
const canSave = computed(
  () => dirty.value && !overLimit.value && !skillsOverLimit.value && !hasInvalidSkill.value
)

async function load() {
  loading.value = true
  try {
    const res = await apiFetch<{
      agentInstructions?: string
      customSkills?: CustomSkill[]
    }>('/api/admin/settings', {
      headers: { 'x-org-id': currentOrgId.value }
    })
    saved.value = res?.agentInstructions ?? ''
    draft.value = saved.value
    savedSkills.value = res?.customSkills ?? []
    skillsDraft.value = JSON.parse(JSON.stringify(savedSkills.value))
  } catch (err: any) {
    message.error(err.message || 'Failed to load instructions')
  } finally {
    loading.value = false
  }
}

async function save() {
  if (!canSave.value || saving.value) return
  saving.value = true
  try {
    await apiFetch('/api/admin/settings', {
      method: 'POST',
      headers: { 'x-org-id': currentOrgId.value },
      body: {
        agentInstructions: draft.value.trim(),
        customSkills: skillsDraft.value
      }
    })
    saved.value = draft.value.trim()
    draft.value = saved.value
    savedSkills.value = JSON.parse(JSON.stringify(skillsDraft.value))
    message.success(t('ui.setup.savedSuccess'))
  } catch (err: any) {
    message.error(err.message || 'Failed to save')
  } finally {
    saving.value = false
  }
}

function revert() {
  draft.value = saved.value
  skillsDraft.value = JSON.parse(JSON.stringify(savedSkills.value))
}

function addSkill() {
  if (skillsDraft.value.length >= MAX_SKILLS) {
    message.warning(t('ui.setup.skills.maxReached', { max: MAX_SKILLS }))
    return
  }
  skillsDraft.value.push({
    id: `skill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: '',
    triggers: '',
    content: '',
    enabled: true
  })
}

function removeSkill(id: string) {
  skillsDraft.value = skillsDraft.value.filter(s => s.id !== id)
}

/**
 * Per-skill dirtiness check. New (unsaved) skills are always considered dirty
 * so they show an Update button on first creation. Existing skills compare
 * draft to the last server-persisted snapshot keyed by `id`.
 */
function isSkillDirty(skill: CustomSkill): boolean {
  const baseline = savedSkills.value.find(s => s.id === skill.id)
  if (!baseline) return true
  return JSON.stringify(skill) !== JSON.stringify(baseline)
}

/**
 * Per-skill validity — can this specific skill be saved? Same constraints as
 * the global save but scoped to one card so the button stays out of the way
 * when only this skill is the problem.
 */
function canUpdateSkill(skill: CustomSkill): boolean {
  if (saving.value) return false
  if (!skill.name.trim()) return false
  if (skill.content.length > SKILL_CONTENT_LIMIT) return false
  return isSkillDirty(skill)
}

/**
 * Save-everything but show a skill-scoped success message. The POST endpoint
 * takes the full skill array, so we always send the whole draft — there's no
 * partial-update endpoint and trying to fake one would race against other
 * dirty skills.
 */
async function updateSkill(skill: CustomSkill) {
  if (!canUpdateSkill(skill)) return
  if (overLimit.value) {
    message.error(t('ui.setup.skills.fixInstructionsFirst'))
    return
  }
  saving.value = true
  try {
    await apiFetch('/api/admin/settings', {
      method: 'POST',
      headers: { 'x-org-id': currentOrgId.value },
      body: {
        agentInstructions: draft.value.trim(),
        customSkills: skillsDraft.value
      }
    })
    saved.value = draft.value.trim()
    draft.value = saved.value
    savedSkills.value = JSON.parse(JSON.stringify(skillsDraft.value))
    message.success(t('ui.setup.skills.updated', { name: skill.name }))
  } catch (err: any) {
    message.error(err.message || 'Failed to update skill')
  } finally {
    saving.value = false
  }
}

onMounted(load)
</script>

<template>
  <div class="setup-page">
    <header class="setup-masthead">
      <div class="masthead-eyebrow">
        <span class="eyebrow">{{ t('ui.setup.vol') }}</span>
        <span class="rule" />
      </div>
      <div class="masthead-row">
        <h1 class="masthead-title">
          {{ t('ui.setup.titleA') }}<br />
          <em>{{ t('ui.setup.titleB') }}</em>
        </h1>
        <a-button
          type="primary"
          :icon="h(SaveOutlined)"
          :loading="saving"
          :disabled="!canSave"
          size="large"
          @click="save"
        >
          {{ t('ui.setup.save') }}
        </a-button>
      </div>
      <p class="masthead-lede">{{ t('ui.setup.lede') }}</p>
    </header>

    <a-spin :spinning="loading">
      <section class="setup-section">
        <div class="field-row">
          <div class="field-meta">
            <label class="field-label">{{ t('ui.setup.fieldLabel') }}</label>
            <p class="field-help">{{ t('ui.setup.fieldHelp') }}</p>
            <details class="field-examples">
              <summary>{{ t('ui.setup.examplesToggle') }}</summary>
              <ul class="examples-list">
                <li>
                  We charge <span class="mono">$20/seat/month</span> for Pro and
                  <span class="mono">$60/seat/month</span> for Enterprise. Trials are 14 days.
                </li>
                <li>
                  Our North Star is <strong>weekly active accounts (WAA)</strong> — accounts with
                  ≥3 unique visitors active in a 7-day window.
                </li>
                <li>
                  Ignore visitors whose email matches <span class="mono">qa@</span> or
                  <span class="mono">@test.acme.com</span> — they're internal.
                </li>
                <li>
                  When asked about "engagement", default to <span class="mono">numEvents</span>;
                  use <span class="mono">numMinutes</span> only if explicitly asked about session time.
                </li>
                <li>
                  Lead with the headline number, then ≤2 supporting cuts. Skip executive
                  summaries; we read fast.
                </li>
              </ul>
            </details>
          </div>
          <div class="field-input">
            <a-textarea
              v-model:value="draft"
              :auto-size="{ minRows: 14, maxRows: 30 }"
              :placeholder="t('ui.setup.placeholder')"
              spellcheck="true"
              class="instructions-textarea"
            />
            <div class="field-foot">
              <span class="char-count" :class="{ 'char-count--over': overLimit }">
                {{ charCount }} / 8000
              </span>
              <div class="foot-actions">
                <a-button
                  v-if="dirty"
                  size="small"
                  @click="revert"
                >{{ t('ui.setup.revert') }}</a-button>
                <span v-if="dirty" class="dirty-pill">{{ t('ui.setup.unsaved') }}</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      <section class="setup-section setup-section--skills">
        <div class="field-row">
          <div class="field-meta">
            <label class="field-label">{{ t('ui.setup.skills.label') }}</label>
            <p class="field-help">{{ t('ui.setup.skills.help') }}</p>
            <details class="field-examples">
              <summary>{{ t('ui.setup.skills.exampleToggle') }}</summary>
              <div class="examples-body">
                <p>{{ t('ui.setup.skills.exampleIntro') }}</p>
                <ul class="examples-list">
                  <li>{{ t('ui.setup.skills.exampleA') }}</li>
                  <li>{{ t('ui.setup.skills.exampleB') }}</li>
                  <li>{{ t('ui.setup.skills.exampleC') }}</li>
                </ul>
              </div>
            </details>
          </div>
          <div class="field-input">
            <div v-if="skillsDraft.length === 0" class="skills-empty">
              <p>{{ t('ui.setup.skills.empty') }}</p>
              <a-button :icon="h(PlusOutlined)" @click="addSkill">
                {{ t('ui.setup.skills.add') }}
              </a-button>
            </div>

            <div v-else class="skills-list">
              <article
                v-for="skill in skillsDraft"
                :key="skill.id"
                class="skill-card"
                :class="{ 'is-disabled': !skill.enabled }"
              >
                <header class="skill-card-head">
                  <a-input
                    v-model:value="skill.name"
                    :placeholder="t('ui.setup.skills.namePh')"
                    class="skill-name"
                    spellcheck="false"
                  />
                  <a-switch
                    v-model:checked="skill.enabled"
                    size="small"
                    :checked-children="t('ui.setup.skills.on')"
                    :un-checked-children="t('ui.setup.skills.off')"
                  />
                  <a-tooltip :title="t('ui.setup.skills.remove')">
                    <a-button
                      type="text"
                      :icon="h(DeleteOutlined)"
                      size="small"
                      danger
                      @click="removeSkill(skill.id)"
                    />
                  </a-tooltip>
                </header>

                <div class="skill-field">
                  <label class="skill-field-label">{{ t('ui.setup.skills.triggersLabel') }}</label>
                  <a-input
                    v-model:value="skill.triggers"
                    :placeholder="t('ui.setup.skills.triggersPh')"
                    class="skill-triggers"
                  />
                  <p class="skill-field-help">{{ t('ui.setup.skills.triggersHelp') }}</p>
                </div>

                <div class="skill-field">
                  <label class="skill-field-label">{{ t('ui.setup.skills.bodyLabel') }}</label>
                  <a-textarea
                    v-model:value="skill.content"
                    :auto-size="{ minRows: 6, maxRows: 24 }"
                    :placeholder="t('ui.setup.skills.bodyPh')"
                    spellcheck="true"
                    class="skill-body"
                  />
                  <div class="skill-field-foot">
                    <span
                      class="char-count"
                      :class="{ 'char-count--over': skill.content.length > SKILL_CONTENT_LIMIT }"
                    >{{ skill.content.length }} / {{ SKILL_CONTENT_LIMIT }}</span>
                  </div>
                </div>

                <footer class="skill-card-foot">
                  <span v-if="isSkillDirty(skill)" class="skill-dirty-pill">
                    {{ t('ui.setup.skills.unsaved') }}
                  </span>
                  <a-button
                    type="primary"
                    size="small"
                    :loading="saving"
                    :disabled="!canUpdateSkill(skill)"
                    @click="updateSkill(skill)"
                  >
                    {{ t('ui.setup.skills.update') }}
                  </a-button>
                </footer>
              </article>

              <a-button
                v-if="skillsDraft.length < MAX_SKILLS"
                :icon="h(PlusOutlined)"
                class="skill-add-more"
                @click="addSkill"
              >{{ t('ui.setup.skills.add') }}</a-button>
              <p v-else class="skills-cap">
                {{ t('ui.setup.skills.maxReached', { max: MAX_SKILLS }) }}
              </p>
            </div>
          </div>
        </div>
      </section>

      <footer class="setup-footer">
        <span class="eyebrow">{{ t('ui.setup.footEyebrow') }}</span>
        <p>{{ t('ui.setup.footBody') }}</p>
      </footer>
    </a-spin>
  </div>
</template>

<style scoped>
.setup-page {
  max-width: 980px;
  margin: 0 auto;
}

.setup-masthead {
  padding: 16px 0 30px;
  border-bottom: 1px solid var(--rule);
  margin-bottom: 32px;
}
.masthead-eyebrow {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}
.masthead-eyebrow .rule { flex: 1; height: 1px; background: var(--rule); }
.masthead-row {
  display: flex;
  justify-content: space-between;
  align-items: flex-end;
  gap: 28px;
}
.masthead-title {
  font-family: var(--serif);
  font-weight: 420;
  font-variation-settings: 'opsz' 96, 'SOFT' 40;
  font-size: clamp(34px, 4.8vw, 50px);
  line-height: 1.04;
  letter-spacing: -0.025em;
  color: var(--ink);
  margin: 0;
  max-width: 620px;
}
.masthead-title em {
  font-style: italic;
  font-variation-settings: 'opsz' 96, 'SOFT' 100, 'WONK' 1;
  color: var(--accent);
}
.masthead-lede {
  margin: 20px 0 0;
  max-width: 620px;
  font-size: 16px;
  line-height: 1.6;
  color: var(--ink-2);
}

.setup-section { padding: 8px 0 36px; }

.field-row {
  display: grid;
  grid-template-columns: 320px 1fr;
  gap: 40px;
  align-items: start;
}
@media (max-width: 820px) {
  .field-row { grid-template-columns: 1fr; gap: 16px; }
}

.field-meta { display: flex; flex-direction: column; gap: 10px; }
.field-label {
  font-family: var(--sans);
  font-size: 12.5px;
  font-weight: 600;
  color: var(--ink-2);
  letter-spacing: 0.05em;
  text-transform: uppercase;
}
.field-help {
  margin: 0;
  font-size: 14.5px;
  line-height: 1.55;
  color: var(--ink-2);
}
.field-examples {
  margin-top: 6px;
  font-family: var(--sans);
  border-top: 1px solid var(--rule);
  padding-top: 12px;
}
.field-examples summary {
  font-size: 12.5px;
  color: var(--muted);
  cursor: pointer;
  font-style: italic;
  font-family: var(--serif);
  font-variation-settings: 'opsz' 16, 'SOFT' 70;
}
.field-examples summary:hover { color: var(--accent); }
.examples-list {
  margin: 12px 0 0;
  padding: 0 0 0 18px;
  list-style: '— ';
  font-size: 13.5px;
  color: var(--ink-2);
  line-height: 1.6;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.examples-list .mono {
  font-family: var(--mono);
  font-size: 12.5px;
  background: var(--subtle);
  padding: 1px 5px;
  border-radius: 3px;
  border: 1px solid var(--rule);
}

.field-input { display: flex; flex-direction: column; gap: 8px; }
.instructions-textarea :deep(.ant-input) {
  font-family: var(--sans) !important;
  font-size: 15px !important;
  line-height: 1.6 !important;
  padding: 14px 16px !important;
  border-radius: var(--r-md) !important;
}

.field-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  font-size: 12px;
  color: var(--muted);
  font-family: var(--mono);
}
.char-count--over { color: var(--danger); font-weight: 600; }
.foot-actions { display: flex; align-items: center; gap: 10px; }
.dirty-pill {
  font-family: var(--serif);
  font-style: italic;
  font-variation-settings: 'opsz' 14, 'SOFT' 70;
  font-size: 12.5px;
  color: var(--accent-deep);
  background: var(--accent-soft);
  padding: 2px 8px;
  border-radius: var(--r-sm);
  border: 1px solid rgba(168, 65, 43, 0.18);
}

.setup-section--skills {
  border-top: 1px solid var(--rule);
  padding-top: 28px;
  margin-top: 8px;
}
.examples-body p {
  margin: 0 0 8px;
  font-family: var(--serif);
  font-style: italic;
  font-variation-settings: 'opsz' 16, 'SOFT' 70;
  font-size: 13px;
  color: var(--ink-2);
}

.skills-empty {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 14px;
  padding: 22px 24px;
  border: 1px dashed var(--rule);
  border-radius: var(--r-md);
  background: var(--subtle);
}
.skills-empty p {
  margin: 0;
  font-family: var(--serif);
  font-style: italic;
  font-variation-settings: 'opsz' 18, 'SOFT' 70;
  color: var(--ink-2);
  font-size: 14.5px;
}

.skills-list {
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.skill-card {
  border: 1px solid var(--rule);
  border-radius: var(--r-md);
  background: var(--paper);
  padding: 16px 18px 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  transition: border-color 0.15s, opacity 0.15s;
}
.skill-card.is-disabled {
  opacity: 0.62;
  background: var(--subtle);
}

.skill-card-head {
  display: flex;
  align-items: center;
  gap: 12px;
}
.skill-name :deep(.ant-input) {
  font-family: var(--mono) !important;
  font-size: 14px !important;
  font-weight: 600 !important;
  border: none !important;
  background: transparent !important;
  padding: 4px 0 !important;
  border-bottom: 1px solid var(--rule) !important;
  border-radius: 0 !important;
  box-shadow: none !important;
}
.skill-name :deep(.ant-input:focus) {
  border-bottom-color: var(--accent) !important;
}

.skill-field { display: flex; flex-direction: column; gap: 4px; }
.skill-field-label {
  font-family: var(--sans);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--muted);
}
.skill-field-help {
  margin: 2px 0 0;
  font-size: 12px;
  color: var(--muted);
  font-style: italic;
  font-family: var(--serif);
  font-variation-settings: 'opsz' 14, 'SOFT' 70;
}
.skill-field-foot {
  display: flex;
  justify-content: flex-end;
  margin-top: 2px;
}
.skill-triggers :deep(.ant-input) {
  font-family: var(--sans) !important;
  font-size: 13.5px !important;
}
.skill-body :deep(.ant-input) {
  font-family: var(--mono) !important;
  font-size: 12.5px !important;
  line-height: 1.55 !important;
  padding: 12px 14px !important;
  border-radius: var(--r-sm) !important;
}

.skill-card-foot {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 10px;
  padding-top: 8px;
  border-top: 1px dashed var(--rule);
  margin-top: 4px;
}
.skill-dirty-pill {
  font-family: var(--serif);
  font-style: italic;
  font-variation-settings: 'opsz' 14, 'SOFT' 70;
  font-size: 12px;
  color: var(--accent-deep);
  background: var(--accent-soft);
  padding: 2px 8px;
  border-radius: var(--r-sm);
  border: 1px solid rgba(168, 65, 43, 0.18);
}

.skill-add-more {
  align-self: flex-start;
  margin-top: 4px;
}
.skills-cap {
  margin: 4px 0 0;
  font-size: 12px;
  color: var(--muted);
  font-style: italic;
  font-family: var(--serif);
  font-variation-settings: 'opsz' 14, 'SOFT' 70;
}

.setup-footer {
  padding: 24px 0 16px;
  border-top: 1px solid var(--rule);
  margin-top: 16px;
}
.setup-footer p {
  margin: 6px 0 0;
  font-size: 14.5px;
  line-height: 1.6;
  color: var(--ink-2);
  max-width: 640px;
}
</style>
