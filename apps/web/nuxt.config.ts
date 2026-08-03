export default defineNuxtConfig({
  ssr: false,
  compatibilityDate: '2026-05-23',
  devServer: {
    host: 'localhost',
    port: 3000
  },
  devtools: { enabled: false },
  vite: {
    server: {
      hmr: {
        protocol: 'ws',
        host: 'localhost',
        port: 3000,
        clientPort: 3000
      },
      watch: {
        ignored: ['**/.nuxt/**', '**/.data/**', '**/node_modules/**']
      }
    }
  },
  css: ['ant-design-vue/dist/reset.css', '~/assets/css/main.css'],
  runtimeConfig: {
    repoRoot: process.env.REPO_ROOT || '../../',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    azureOpenAiApiKey: process.env.AZURE_OPENAI_API_KEY || '',
    azureOpenAiEndpoint: process.env.AZURE_OPENAI_ENDPOINT || '',
    azureOpenAiApiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-10-21',
    public: {}
  }
})
