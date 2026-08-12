import { createRequire } from 'node:module'

// Resolved eagerly so the Nitro trace below has a concrete entry file to follow.
const pendoSdkEntry = createRequire(import.meta.url).resolve('pendo-server-sdk')

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
  nitro: {
    externals: {
      /**
       * `pendo-server-sdk` is CommonJS whose dist files require each other
       * without file extensions (`require("./core")`). Bundling it rewrites
       * those into extensionless ESM imports that Node's loader rejects, so
       * `pendoTracing.ts` loads it via `createRequire` instead — see the note
       * there. Keeping it external stops a future static `import` from
       * re-inlining it and breaking the build again.
       */
      external: ['pendo-server-sdk'],
      /**
       * A `createRequire` call is invisible to Nitro's static tracer, so the
       * package would be left out of `.output/server/node_modules` entirely and
       * production would die on first request. Pointing the tracer at the entry
       * file pulls the SDK and its `@opentelemetry/*` deps into the output.
       */
      traceInclude: [pendoSdkEntry]
    }
  },
  runtimeConfig: {
    repoRoot: process.env.REPO_ROOT || '../../',
    anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    azureOpenAiApiKey: process.env.AZURE_OPENAI_API_KEY || '',
    azureOpenAiEndpoint: process.env.AZURE_OPENAI_ENDPOINT || '',
    azureOpenAiApiVersion: process.env.AZURE_OPENAI_API_VERSION || '2024-10-21',
    /**
     * Pendo Agent Analytics — where this app reports its OWN agent
     * conversations (prompts, answers, generations, tool calls).
     *
     * Deliberately EMPTY by default, and it must stay that way. A shipped app id
     * and agent id would make every clone of this repo export its users'
     * conversations into whichever subscription those literals belong to,
     * without anyone opting in. With both blank the app treats tracing as off
     * and every helper degrades to a pass-through.
     *
     * Configure it per workspace in `Admin → Pendo Integration → Agent
     * Analytics`, or set PENDO_AGENT_* for a whole deployment. `apiKey` is a
     * Pendo *Public App ID* (the value a browser Pendo snippet carries), not a
     * secret API token — but it still names a real subscription, so it belongs
     * in configuration rather than in source.
     */
    pendoAgent: {
      apiKey: process.env.PENDO_AGENT_API_KEY || '',
      agentId: process.env.PENDO_AGENT_ID || '',
      endpoint: process.env.PENDO_AGENT_ENDPOINT || 'https://app.pendo.io',
      enabled: process.env.PENDO_AGENT_TRACING !== 'false',
      // Strips email/phone/SSN from event content before export.
      redact: process.env.PENDO_AGENT_REDACT === 'true',
      // Dendo has no end-user login; see resolveTurnIdentity() in pendoTracing.ts.
      defaultVisitorId: process.env.PENDO_AGENT_VISITOR_ID || '',
      defaultAccountId: process.env.PENDO_AGENT_ACCOUNT_ID || ''
    },
    public: {}
  }
})
