<script setup lang="ts">
import { ref, h } from 'vue'
import { FileTextOutlined, CodeOutlined, PlusOutlined, QuestionCircleOutlined } from '@ant-design/icons-vue'
import CellToolbar from './CellToolbar.vue'
import NoteCell from './cells/NoteCell.vue'
import QueryCell from './cells/QueryCell.vue'
import ResultCell from './cells/ResultCell.vue'
import ChartCell from './cells/ChartCell.vue'
import AgentMessageCell from './cells/AgentMessageCell.vue'
import InsightCell from './cells/InsightCell.vue'
import QuestionCell from './cells/QuestionCell.vue'
import { useI18n } from '~/composables/useI18n'
import type { NotebookCell, QueryCell as QueryCellType } from '~/types/notebook'

const { t } = useI18n()

interface Props {
  cells: NotebookCell[]
  runningCellId?: string | null
  /** Chart / result cell ids currently being refreshed (re-running their
   *  stored DSL). Disjoint from `runningCellId` because runs happen on a
   *  *query* cell, but refreshes target the chart or result cell itself. */
  refreshingChartIds?: string[]
  refreshingResultIds?: string[]
  streamingText?: string
  streaming?: boolean
  notebookId: string
  orgId: string
}

const props = defineProps<Props>()
const emit = defineEmits<{
  addCell: [type: 'note' | 'query' | 'question', afterCellId: string | null]
  deleteCell: [cellId: string]
  saveCell: [cellId: string, content: string]
  saveQueryTitle: [cellId: string, title: string]
  runQuery: [cellId: string, dsl: string]
  runQuestion: [cellId: string]
  moveCell: [cellId: string, direction: 'up' | 'down']
  askAboutCell: [cellId: string]
  changeChartType: [cellId: string, type: 'line' | 'bar' | 'donut']
  refreshChart: [cellId: string]
  refreshResult: [cellId: string]
  reorderResultColumns: [cellId: string, order: string[]]
  askInChat: [prompt: string]
  updateChartDsl: [cellId: string, seriesIndex: number | null, dsl: string]
  askChartTweak: [cellId: string]
  updateResultDsl: [cellId: string, dsl: string]
  askResultTweak: [cellId: string]
}>()

const hoveredCell = ref<string | null>(null)
</script>

<template>
  <div class="cell-list">
    <!-- Empty state add button -->
    <div v-if="!cells.length && !streaming" class="empty-state">
      <div class="empty-mark">¶</div>
      <h3 class="empty-title"><em>{{ t('ui.cellList.emptyTitleA') }}</em>{{ t('ui.cellList.emptyTitleB') }}</h3>
      <p class="empty-prompt">{{ t('ui.cellList.emptyBody') }}</p>
      <a-space>
        <a-button :icon="h(FileTextOutlined)" @click="emit('addCell', 'note', null)">{{ t('ui.cellList.addNote') }}</a-button>
        <a-button :icon="h(CodeOutlined)" @click="emit('addCell', 'query', null)">{{ t('ui.cellList.addQuery') }}</a-button>
        <a-button type="primary" :icon="h(QuestionCircleOutlined)" @click="emit('addCell', 'question', null)">{{ t('ui.cellList.addQuestion') }}</a-button>
      </a-space>
    </div>

    <!-- Add-before button (top) -->
    <div v-if="cells.length" class="add-between">
      <a-dropdown>
        <a-button size="small" type="dashed" :icon="h(PlusOutlined)" style="opacity:0.4;" />
        <template #overlay>
          <a-menu>
            <a-menu-item @click="emit('addCell', 'note', null)">
              <component :is="h(FileTextOutlined)" style="margin-right:8px" />{{ t('ui.cellList.addNote') }}
            </a-menu-item>
            <a-menu-item @click="emit('addCell', 'query', null)">
              <component :is="h(CodeOutlined)" style="margin-right:8px" />{{ t('ui.cellList.addQuery') }}
            </a-menu-item>
            <a-menu-item @click="emit('addCell', 'question', null)">
              <component :is="h(QuestionCircleOutlined)" style="margin-right:8px" />{{ t('ui.cellList.addQuestion') }}
            </a-menu-item>
          </a-menu>
        </template>
      </a-dropdown>
    </div>

    <template v-for="cell in cells" :key="cell.id">
      <div
        class="cell-wrapper"
        @mouseenter="hoveredCell = cell.id"
        @mouseleave="hoveredCell = null"
      >
        <div class="cell-body">
          <NoteCell
            v-if="cell.cell_type === 'note'"
            :cell="cell"
            @save="emit('saveCell', cell.id, $event)"
            @ask-about="emit('askAboutCell', cell.id)"
          />
          <QueryCell
            v-else-if="cell.cell_type === 'query'"
            :cell="(cell as QueryCellType)"
            :running="runningCellId === cell.id"
            :notebook-id="notebookId"
            :org-id="orgId"
            @save="emit('saveCell', cell.id, $event)"
            @save-title="(title: string) => emit('saveQueryTitle', cell.id, title)"
            @run="emit('runQuery', cell.id, $event)"
            @ask-in-chat="(prompt: string) => emit('askInChat', prompt)"
          />
          <ResultCell
            v-else-if="cell.cell_type === 'result'"
            :cell="(cell as any)"
            :refreshing="refreshingResultIds?.includes(cell.id) ?? false"
            @ask-about="emit('askAboutCell', cell.id)"
            @refresh="emit('refreshResult', cell.id)"
            @reorder-columns="(order: string[]) => emit('reorderResultColumns', cell.id, order)"
            @update-dsl="(dsl: string) => emit('updateResultDsl', cell.id, dsl)"
            @ask-to-tweak="emit('askResultTweak', cell.id)"
          />
          <ChartCell
            v-else-if="cell.cell_type === 'chart'"
            :cell="(cell as any)"
            :refreshing="refreshingChartIds?.includes(cell.id) ?? false"
            @ask-about="emit('askAboutCell', cell.id)"
            @change-type="(type) => emit('changeChartType', cell.id, type)"
            @refresh="emit('refreshChart', cell.id)"
            @update-dsl="(idx: number | null, dsl: string) => emit('updateChartDsl', cell.id, idx, dsl)"
            @ask-to-tweak="emit('askChartTweak', cell.id)"
          />
          <QuestionCell
            v-else-if="cell.cell_type === 'question'"
            :cell="(cell as any)"
            :running="runningCellId === cell.id"
            @save="emit('saveCell', cell.id, $event)"
            @run="emit('runQuestion', cell.id)"
            @ask-about="emit('askAboutCell', cell.id)"
          />
          <AgentMessageCell
            v-else-if="cell.cell_type === 'agent_message'"
            :cell="(cell as any)"
          />
          <InsightCell
            v-else-if="cell.cell_type === 'insight'"
            :cell="(cell as any)"
          />
        </div>

        <Transition name="toolbar">
          <CellToolbar
            v-if="hoveredCell === cell.id"
            @add-note="emit('addCell', 'note', cell.id)"
            @add-query="emit('addCell', 'query', cell.id)"
            @add-question="emit('addCell', 'question', cell.id)"
            @delete="emit('deleteCell', cell.id)"
            @move-up="emit('moveCell', cell.id, 'up')"
            @move-down="emit('moveCell', cell.id, 'down')"
          />
        </Transition>
      </div>

      <!-- Add between cells -->
      <div class="add-between">
        <a-dropdown trigger="hover">
          <a-button size="small" type="dashed" :icon="h(PlusOutlined)" style="opacity:0;" class="add-btn" />
          <template #overlay>
            <a-menu>
              <a-menu-item @click="emit('addCell', 'note', cell.id)">
                <component :is="h(FileTextOutlined)" style="margin-right:8px" />{{ t('ui.cellList.addNote') }}
              </a-menu-item>
              <a-menu-item @click="emit('addCell', 'query', cell.id)">
                <component :is="h(CodeOutlined)" style="margin-right:8px" />{{ t('ui.cellList.addQuery') }}
              </a-menu-item>
              <a-menu-item @click="emit('addCell', 'question', cell.id)">
                <component :is="h(QuestionCircleOutlined)" style="margin-right:8px" />{{ t('ui.cellList.addQuestion') }}
              </a-menu-item>
            </a-menu>
          </template>
        </a-dropdown>
      </div>
    </template>

  </div>
</template>

<style scoped>
.cell-list {
  display: flex;
  flex-direction: column;
  gap: 0;
  padding: 0;
}
.cell-wrapper {
  position: relative;
  padding: 8px 0;
}
.cell-body {
  border-radius: var(--r-md);
  overflow: hidden;
}
.add-between {
  display: flex;
  justify-content: center;
  height: 18px;
  align-items: center;
}
.add-between:hover .add-btn { opacity: 1 !important; }
.add-between :deep(.ant-btn-dashed) {
  border-color: var(--rule-strong);
  color: var(--muted);
  background: var(--paper);
}
.add-between :deep(.ant-btn-dashed:hover) {
  border-color: var(--accent) !important;
  color: var(--accent) !important;
}

.empty-state {
  text-align: center;
  padding: 64px 24px 48px;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
}
.empty-mark {
  font-family: var(--serif);
  font-weight: 400;
  font-variation-settings: 'opsz' 144, 'SOFT' 100, 'WONK' 1;
  font-style: italic;
  font-size: 96px;
  color: var(--accent-soft);
  line-height: 0.8;
  letter-spacing: -0.04em;
}
.empty-title {
  font-family: var(--serif);
  font-weight: 460;
  font-variation-settings: 'opsz' 36, 'SOFT' 50;
  font-size: 26px;
  letter-spacing: -0.018em;
  line-height: 1.2;
  color: var(--ink);
  margin: 4px 0 0;
}
.empty-title em {
  font-style: italic;
  font-variation-settings: 'opsz' 36, 'SOFT' 100, 'WONK' 1;
  color: var(--accent);
}
.empty-prompt {
  color: var(--ink-2);
  font-size: 15px;
  line-height: 1.55;
  max-width: 400px;
  margin: 0 0 10px;
}

.toolbar-enter-active, .toolbar-leave-active { transition: opacity 0.1s; }
.toolbar-enter-from, .toolbar-leave-to { opacity: 0; }
</style>
