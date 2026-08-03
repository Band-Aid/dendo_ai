<script setup lang="ts">
import { useI18n } from '../composables/useI18n'
import { GlobalOutlined } from '@ant-design/icons-vue'
import { h } from 'vue'
import { onMounted } from 'vue'

const { locale, setLocale, availableLocales, init, isLoaded } = useI18n()

onMounted(async () => {
  if (!isLoaded.value) await init()
})

const handleMenuClick = ({ key }: { key: string }) => {
  setLocale(key as any)
}
</script>

<template>
  <a-dropdown>
    <a-button :icon="h(GlobalOutlined)">
      {{ availableLocales.find(l => l.code === locale)?.nativeName }}
    </a-button>
    <template #overlay>
      <a-menu @click="handleMenuClick">
        <a-menu-item 
          v-for="loc in availableLocales" 
          :key="loc.code"
          :class="{ 'ant-dropdown-menu-item-selected': loc.code === locale }"
        >
          <span>{{ loc.nativeName }}</span>
          <span style="margin-left: 8px; color: #8c8c8c; font-size: 12px;">{{ loc.name }}</span>
        </a-menu-item>
      </a-menu>
    </template>
  </a-dropdown>
</template>
