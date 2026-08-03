# i18n (Internationalization) System

## Overview

Minimal, zero-dependency i18n system for Dendo using Vue 3 composables.

## Architecture

```
/locales/          # Translation JSON files
  en.json          # English (default)
  ja.json          # Japanese
  es.json          # Spanish (add as needed)
/composables/
  useI18n.ts       # Core i18n logic
```

## Usage

### 1. In Components

```vue
<script setup>
import { useI18n } from '~/composables/useI18n'

const { t, locale, setLocale } = useI18n()
</script>

<template>
  <!-- Simple translation -->
  <h1>{{ t('workspace.title') }}</h1>
  
  <!-- With interpolation -->
  <p>{{ t('workspace.info.result_description', { rows: 5, columns: 3 }) }}</p>
  
  <!-- Language switcher -->
  <select v-model="locale" @change="setLocale(locale)">
    <option value="en">English</option>
    <option value="ja">日本語</option>
  </select>
</template>
```

### 2. In JavaScript/TypeScript

```typescript
const { t } = useI18n()

// Simple
message.success(t('workspace.messages.query_executed'))

// With parameters
message.info(t('workspace.info.result_description', { rows: data.length, columns: cols.length }))
```

### 3. Key Format

Use dot notation for nested keys:

```json
{
  "workspace": {
    "title": "Notebook",
    "actions": {
      "delete": "Delete"
    }
  }
}
```

Access: `t('workspace.actions.delete')`

### 4. Interpolation

Use `{variable}` syntax in translation strings:

```json
{
  "message": "Found {count} results"
}
```

Usage: `t('message', { count: 5 })` → "Found 5 results"

## Adding New Languages

### Step 1: Create locale file

Copy `en.json` to new file:

```bash
cp locales/en.json locales/es.json
```

### Step 2: Translate all keys

Keep the same structure, translate only the values.

### Step 3: Register in composable

Edit `composables/useI18n.ts`:

```typescript
type Locale = 'en' | 'ja' | 'es'  // Add your locale

export const availableLocales = [
  { code: 'en', name: 'English', nativeName: 'English' },
  { code: 'ja', name: 'Japanese', nativeName: '日本語' },
  { code: 'es', name: 'Spanish', nativeName: 'Español' }  // Add here
]

// Update loadTranslations():
const [enData, jaData, esData] = await Promise.all([
  fetch('/locales/en.json').then(r => r.json()),
  fetch('/locales/ja.json').then(r => r.json()),
  fetch('/locales/es.json').then(r => r.json())  // Add here
])

translations.value.es = esData  // Add here
```

### Step 4: Update auto-detection (optional)

In `detectBrowserLocale()`:

```typescript
const browserLang = navigator.language.toLowerCase()
if (browserLang.startsWith('ja')) return 'ja'
if (browserLang.startsWith('es')) return 'es'  // Add here
return 'en'
```

## Migration Strategy

### Current state:
- System prompts: English only (no translation needed)
- UI strings: Hardcoded

### Migration steps:

1. **Phase 1: Setup** ✅
   - Created locale files
   - Created useI18n composable
   - Added example translations

2. **Phase 2: Migrate UI strings** (In Progress)
   - Replace hardcoded strings with `t()` calls
   - Start with high-impact pages (workspace, admin, home)
   - Pattern:
     ```typescript
     // Before
     message.success('Query executed successfully')
     
     // After
     message.success(t('workspace.messages.query_executed'))
     ```

3. **Phase 3: Add language switcher**
   - Add to admin settings or user menu
   - Persist to localStorage (already implemented)

4. **Phase 4: Community translations**
   - Open PRs for new languages
   - Community can contribute translations

## Best Practices

### 1. **Key Naming**
- Use descriptive, hierarchical keys
- Group by feature/page: `workspace.*`, `admin.*`, `common.*`
- Keep common strings in `common.*` for reuse

### 2. **Message Organization**
```json
{
  "page": {
    "title": "Page Title",
    "actions": {
      "save": "Save",
      "cancel": "Cancel"
    },
    "messages": {
      "success": "Saved successfully",
      "error": "Failed to save"
    },
    "info": {
      "description": "Page description"
    }
  }
}
```

### 3. **Fallback Behavior**
- Missing key → Falls back to English
- Missing in English → Shows key name
- Logs warning in console for debugging

### 4. **Performance**
- Translations loaded once on mount
- Cached in memory
- No runtime cost beyond initial load

## Type Safety (Optional)

For TypeScript autocomplete, generate types from `en.json`:

```typescript
// types/i18n.ts
import en from '../locales/en.json'

type DeepKeys<T> = T extends object
  ? {
      [K in keyof T]: K extends string
        ? T[K] extends object
          ? `${K}.${DeepKeys<T[K]>}`
          : K
        : never
    }[keyof T]
  : never

export type TranslationKey = DeepKeys<typeof en>

// Update useI18n:
const t = (key: TranslationKey, params?: Record<string, any>): string => {
  // ...
}
```

## Testing

Test translation keys exist:

```typescript
import { describe, it, expect } from 'vitest'
import en from '../locales/en.json'
import ja from '../locales/ja.json'

describe('i18n', () => {
  it('should have same keys in all locales', () => {
    const enKeys = getAllKeys(en)
    const jaKeys = getAllKeys(ja)
    expect(enKeys.sort()).toEqual(jaKeys.sort())
  })
})
```

## Language Switcher Component Example

```vue
<script setup lang="ts">
import { useI18n } from '~/composables/useI18n'

const { locale, setLocale, availableLocales } = useI18n()
</script>

<template>
  <a-dropdown>
    <a-button>
      {{ availableLocales.find(l => l.code === locale)?.nativeName }}
    </a-button>
    <template #overlay>
      <a-menu>
        <a-menu-item 
          v-for="loc in availableLocales" 
          :key="loc.code"
          @click="setLocale(loc.code)"
        >
          {{ loc.nativeName }}
        </a-menu-item>
      </a-menu>
    </template>
  </a-dropdown>
</template>
```

## Notes

- **Zero dependencies**: No @nuxtjs/i18n or vue-i18n needed
- **100% client-side**: No SSR complexity
- **Tiny bundle**: ~2KB for composable + JSON size
- **Instant switching**: No page reload needed
- **Browser detection**: Auto-detects user's language
- **Persistent**: Saves preference to localStorage
