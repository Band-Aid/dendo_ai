import { ref, computed } from 'vue'
import enData from '../locales/en.json'
import jaData from '../locales/ja.json'

type Locale = 'en' | 'ja'
type TranslationObject = Record<string, any>

const currentLocale = ref<Locale>('en')
const translations = ref<Record<Locale, TranslationObject>>({
  en: {},
  ja: {}
})
const isLoaded = ref(false)

// Available locales
export const availableLocales: { code: Locale; name: string; nativeName: string }[] = [
  { code: 'en', name: 'English', nativeName: 'English' },
  { code: 'ja', name: 'Japanese', nativeName: '日本語' }
]

/**
 * Simple i18n composable with minimal dependencies
 * 
 * Usage:
 * const { t, locale, setLocale } = useI18n()
 * 
 * t('workspace.title') // "Notebook"
 * t('workspace.info.result_description', { rows: 5, columns: 3 }) // "Result rows: 5 Columns: 3"
 */
export const useI18n = () => {
  // Load translations from bundled JSON files
  const loadTranslations = () => {
    if (isLoaded.value) return

    try {
      translations.value.en = enData
      translations.value.ja = jaData
      isLoaded.value = true
    } catch (err) {
      console.error('[useI18n] Failed to load translations:', err)
      // Fallback to empty translations
      translations.value.en = {}
      translations.value.ja = {}
      isLoaded.value = true
    }
  }

  // Get nested value from object using dot notation
  const getNestedValue = (obj: any, path: string): any => {
    return path.split('.').reduce((current, key) => current?.[key], obj)
  }

  // Replace placeholders in string (e.g., "{rows}" -> "5")
  const interpolate = (template: string, params?: Record<string, any>): string => {
    if (!params) return template
    
    return Object.entries(params).reduce((result, [key, value]) => {
      return result.replace(new RegExp(`\\{${key}\\}`, 'g'), String(value))
    }, template)
  }

  // Translate function
  const t = (key: string, params?: Record<string, any>): string => {
    if (!isLoaded.value) {
      return key // Return key if not loaded yet
    }

    const locale = currentLocale.value
    const translation = getNestedValue(translations.value[locale], key)
    
    if (translation === undefined) {
      // Fallback to English if key not found in current locale
      if (locale !== 'en') {
        const fallback = getNestedValue(translations.value.en, key)
        if (fallback !== undefined) {
          return interpolate(fallback, params)
        }
      }
      
      console.warn(`[useI18n] Missing translation for key: ${key}`)
      return key
    }

    return interpolate(translation, params)
  }

  // Set locale
  const setLocale = (locale: Locale) => {
    currentLocale.value = locale
    
    // Persist to localStorage
    if (typeof window !== 'undefined') {
      localStorage.setItem('dendo_locale', locale)
    }
  }

  // Auto-detect browser language on first load
  const detectBrowserLocale = (): Locale => {
    if (typeof window === 'undefined') return 'en'
    
    // Check localStorage first
    const saved = localStorage.getItem('dendo_locale')
    if (saved && availableLocales.some(l => l.code === saved)) {
      return saved as Locale
    }
    
    // Detect from browser
    const browserLang = navigator.language.toLowerCase()
    if (browserLang.startsWith('ja')) return 'ja'
    
    return 'en'
  }

  // Initialize — idempotent; safe to call from multiple components
  const init = async () => {
    if (isLoaded.value) return
    currentLocale.value = detectBrowserLocale()
    loadTranslations()
  }

  return {
    t,
    locale: computed(() => currentLocale.value),
    setLocale,
    availableLocales,
    init,
    isLoaded: computed(() => isLoaded.value)
  }
}
