import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

export const DEFAULT_SYSTEM_PROMPT = `You are a helpful product intelligence assistant that helps answer questions about product metrics, features, and analytics.`

let cachedSkillDoc: string | null = null
let cachedSpecSheet: string | null = null
let cachedSessionReplayExamples: string | null = null
let cachedExampleIndex: any | null = null

async function loadSkillDoc(): Promise<string> {
  if (cachedSkillDoc) return cachedSkillDoc
  
  try {
    const path = resolve(process.cwd(), '../../.github/skills/pendo-agg/SKILL.md')
    cachedSkillDoc = await readFile(path, 'utf-8')
    console.log('[agentPrompts] Loaded SKILL.md successfully')
    return cachedSkillDoc
  } catch (err) {
    console.error('[agentPrompts] Failed to load SKILL.md:', err)
    return ''
  }
}

async function loadSpecSheet(): Promise<string> {
  if (cachedSpecSheet) return cachedSpecSheet
  
  try {
    const path = resolve(process.cwd(), '../../Pendo Aggregation Spec Sheet (Project Truth).md')
    cachedSpecSheet = await readFile(path, 'utf-8')
    console.log('[agentPrompts] Loaded Spec Sheet successfully')
    return cachedSpecSheet
  } catch (err) {
    console.error('[agentPrompts] Failed to load Spec Sheet:', err)
    return ''
  }
}

async function loadSessionReplayExamples(): Promise<string> {
  if (cachedSessionReplayExamples) return cachedSessionReplayExamples
  
  try {
    const path = resolve(process.cwd(), '../../examples/SESSION_REPLAY_EXAMPLES.md')
    cachedSessionReplayExamples = await readFile(path, 'utf-8')
    console.log('[agentPrompts] Loaded SESSION_REPLAY_EXAMPLES.md successfully')
    return cachedSessionReplayExamples
  } catch (err) {
    console.error('[agentPrompts] Failed to load SESSION_REPLAY_EXAMPLES.md:', err)
    return ''
  }
}

async function loadExampleIndex(): Promise<any> {
  if (cachedExampleIndex) return cachedExampleIndex
  
  try {
    const path = resolve(process.cwd(), '../../examples/index.json')
    const content = await readFile(path, 'utf-8')
    cachedExampleIndex = JSON.parse(content)
    console.log('[agentPrompts] Loaded example index successfully')
    return cachedExampleIndex
  } catch (err) {
    console.error('[agentPrompts] Failed to load example index:', err)
    return { categories: {} }
  }
}

async function loadDSLExample(filename: string): Promise<string> {
  try {
    const path = resolve(process.cwd(), `../../examples/${filename}`)
    const content = await readFile(path, 'utf-8')
    return content
  } catch (err) {
    console.error(`[agentPrompts] Failed to load example ${filename}:`, err)
    return ''
  }
}

async function loadRelevantDSLExamples(question?: string): Promise<string> {
  if (!question) return ''
  
  const questionLower = question.toLowerCase()
  const index = await loadExampleIndex()
  
  // Find matching categories
  const matchedCategories: string[] = []
  for (const [category, config] of Object.entries<any>(index.categories)) {
    const keywords = config.keywords || []
    if (keywords.some((kw: string) => questionLower.includes(kw.toLowerCase()))) {
      matchedCategories.push(category)
    }
  }
  
  if (matchedCategories.length === 0) return ''
  
  // Load up to 3 examples from matched categories
  const exampleFiles: string[] = []
  for (const category of matchedCategories.slice(0, 2)) { // Max 2 categories
    const config = index.categories[category]
    if (config.examples && config.examples.length > 0) {
      exampleFiles.push(config.examples[0]) // Take first example from each category
    }
  }
  
  if (exampleFiles.length === 0) return ''
  
  // Load the actual example files
  const examples = await Promise.all(exampleFiles.map(f => loadDSLExample(f)))
  const validExamples = examples.filter(e => e.length > 0)
  
  if (validExamples.length === 0) return ''
  
  console.log('[agentPrompts] Loaded relevant DSL examples:', exampleFiles.join(', '))
  
  return validExamples.map((example, idx) => 
    `### Example ${idx + 1}: ${exampleFiles[idx]}\n\`\`\`\n${example}\n\`\`\``
  ).join('\n\n')
}

export const PENDO_ANALYST_PROMPT = `You are a Forward-Deployed Agent (FDA) - an expert product intelligence assistant specializing in Pendo analytics and product data analysis.

# Your Primary Capability

You have ONE tool: **run_pendo_aggregation** - use it to query real product usage data from Pendo.

# Critical Rules

**ALWAYS use run_pendo_aggregation when users ask about data:**
- User activity, engagement, or behavior
- Feature usage or adoption
- Time-based metrics
- Account/visitor statistics
- ANY question requiring actual product data

**DO NOT:**
- Ask users "where is the data?" or "which database?" - YOU have direct access via the tool
- Suggest they check analytics dashboards - YOU can get the data directly
- Give hypothetical answers when data is available
- Tell users to set \`PENDO_API_KEY\` / \`PENDO_INTEGRATION_KEY\` environment variables or edit a \`.env\` file. The Pendo integration key is configured in **Admin Settings → Pendo** — this is the only source of truth. When auth errors (401/403) come back from the aggregation tool, direct users to verify the integration key in Admin Settings → Pendo, not to env vars.

**Required Parameter:**
- Every aggregation MUST include \`appId\` (typically a negative integer like \`appId=-323232\`)
- If the appId is provided in the Configuration section below, always use it — do NOT ask the user for it

# Tool Usage Flow

1. Understand the user's question
2. If appId is unknown, ask for it
3. The user may ask you to find a segmenr or account or visitor. Ask for clarification if needed, but you can also use the following tools to find segment but not for account or visitor:
   - \`lookup_pendo_segments(segmentName="...")\`
4. Write DSL query following the complete grammar in the documentation below
5. Call run_pendo_aggregation with your DSL
6. Interpret and explain the results
7. Provide data-driven insights
8. **When you have collected all necessary data and provided your analysis, YOU MUST output "DONE" on a new line** - this signals completion

**CRITICAL EXECUTION RULE:**
- You can run as many aggregations as needed to fully answer the question
- When you have all the data you need and have written your final analysis, write "DONE" on its own line
- Outputting "DONE" stops further data collection - only do it when your answer is complete
- If you need more data to answer the question thoroughly, continue making tool calls

# Critical DSL Rules

**Pipeline Stages ALWAYS start with pipe |:**
- ✅ CORRECT: \`| filter segment("segmentId")\`
- ❌ WRONG: \`WHERE segment("segmentId")\` (no WHERE keyword exists!)
- ✅ CORRECT: \`| group by field fields { ... }\`
- ❌ WRONG: \`GROUP BY field\` (missing pipe!)

**Segment Filtering:**
- Use \`lookup_pendo_segments\` tool FIRST to get segment ID
- Then use: \`| filter segment("segmentId")\`
- NEVER use \`WHERE\` - it doesn't exist in this DSL

**Session Replays:**
- Use \`| sessionReplays { limit=50, frustration=[...] }\` pipeline stage
- OR use \`FROM event([source=recordingMetadata,...])\` with proper grouping
- ❌ NEVER use \`FROM sessionReplay(...)\` - this source does NOT exist!
- ❌ NEVER use \`FILTER\` without pipe - it MUST be \`| filter\`
- See Session Replay Examples section below for complete patterns

**Common Mistakes to AVOID:**
- ❌ \`FILTER segment(...)\` - NO! Use \`| filter segment(...)\`
- ❌ \`| sort by field desc\` - NO! Use \`| sort -field\` (minus for descending)
- ❌ \`WHERE ...\` - NO! This keyword does not exist in AggDSL!

# Response Format

When executing aggregations, structure your response:
1. Brief explanation of what you're querying
2. Execute the tool (the DSL will be shown automatically)
3. Analyze the returned data
4. Provide actionable insights based on actual numbers

**Table Formatting Rules:**
- ALWAYS use proper markdown table syntax with pipes: \`| Column 1 | Column 2 |\`
- Include header separator: \`|----------|----------|\`
- Escape or remove any tabs, newlines, or special characters in data values
- If a data value is missing or null, show \`-\` or \`0\` instead of leaving it blank
- Ensure every row has the same number of columns
- Example:
  \`\`\`markdown
  | Rank | Feature Name | Count |
  |------|-------------|-------|
  | 1    | Dashboard   | 1,234 |
  | 2    | Reports     | 987   |
  | 3    | Settings    | -     |
  \`\`\`

Keep responses concise and data-driven.`

/**
 * Determine which example files to load based on query keywords
 */
function detectRelevantExamples(question?: string): { loadSessionReplay: boolean } {
  if (!question) {
    return { loadSessionReplay: false }
  }
  
  const lowerQuestion = question.toLowerCase()
  
  // Session replay keywords
  const sessionReplayKeywords = [
    'session replay', 'sessionreplay', 'session recording', 'recording',
    'replay', 'replays', 'session',
    'frustration', 'rage click', 'dead click', 'error click',
    'recordingsessionid', 'recordingmetadata'
  ]
  
  const loadSessionReplay = sessionReplayKeywords.some(keyword => 
    lowerQuestion.includes(keyword)
  )
  
  return { loadSessionReplay }
}

export async function getAgentSystemPrompt(
  agent: any, 
  includeSkillDoc: boolean = true,
  question?: string,
  orgId = 'default'
): Promise<string> {
  // Start with custom system prompt if provided, otherwise use default
  // NOTE: Even with custom prompts, we still append documentation below
  let prompt = (agent.systemPrompt && agent.systemPrompt.trim()) 
    ? agent.systemPrompt 
    : PENDO_ANALYST_PROMPT
  
  // ALWAYS include core documentation (SKILL.md + Spec Sheet)
  // Conditionally load examples based on query keywords
  if (includeSkillDoc) {
    // Determine which examples to load
    const { loadSessionReplay } = detectRelevantExamples(question)
    
    console.log('[agentPrompts] Question:', question?.substring(0, 100))
    console.log('[agentPrompts] Load session replay examples:', loadSessionReplay)
    
    // Always load core docs
    const loaders: Promise<string>[] = [
      loadSkillDoc(),
      loadSpecSheet()
    ]
    
    // Conditionally load session replay examples
    if (loadSessionReplay) {
      loaders.push(loadSessionReplayExamples())
      console.log('[agentPrompts] Loading session replay examples based on query')
    }
    
    // ALWAYS load relevant DSL examples from the examples directory
    loaders.push(loadRelevantDSLExamples(question))
    
    const docs = await Promise.all(loaders)
    const [skillDoc, specSheet, sessionReplayExamples, dslExamples] = [
      docs[0],
      docs[1],
      loadSessionReplay ? docs[2] : undefined,
      loadSessionReplay ? docs[3] : docs[2]
    ]
    
    console.log('[agentPrompts] Loaded SKILL.md:', skillDoc.length, 'chars')
    console.log('[agentPrompts] Loaded Spec Sheet:', specSheet.length, 'chars')
    console.log('[agentPrompts] Loaded Session Replay Examples:', sessionReplayExamples?.length || 0, 'chars')
    console.log('[agentPrompts] Loaded DSL Examples:', dslExamples?.length || 0, 'chars')
    
    if (skillDoc) {
      prompt += `\n\n# Workflow Reference (SKILL.md)\n\n${skillDoc}`
    }
    
    if (specSheet) {
      prompt += `\n\n# Complete DSL Grammar (Pendo Aggregation Spec Sheet)\n\n${specSheet}`
    }
    
    // Add relevant DSL examples from the examples directory
    if (dslExamples && dslExamples.length > 0) {
      prompt += `\n\n# Relevant Query Examples\n\nThese are real-world examples from the knowledge base. Study their patterns and adapt them to the user's request:\n\n${dslExamples}\n\n⚠️ IMPORTANT: Copy these patterns EXACTLY, only changing:\n- appId values\n- Time ranges (TIMESERIES first/count)\n- Filter conditions (segment names, feature IDs, etc.)\n- Field names in group by and select clauses\n\nDO NOT modify the structural syntax (pipes, function calls, operators).`
    }
    
    if (sessionReplayExamples) {
      prompt += `\n\n# Session Replay Query Examples\n\n${sessionReplayExamples}\n\n⚠️ CRITICAL SESSION REPLAY RULES:\n1. There is NO source called "sessionReplay" - use "recordingMetadata" instead\n2. ALL pipeline stages MUST start with pipe | including filter, group, sort, limit\n3. NEVER use "FILTER" or "WHERE" - always use "| filter"\n4. For sorting: use "| sort -field" (minus for descending), NOT "sort by field desc"\n5. You MUST copy the exact patterns from the examples above - DO NOT modify the syntax\n\nValid patterns ONLY:\n- PIPELINE approach: PIPELINE | sessionReplays { limit=50, frustration=[...] }\n- Source approach: FROM event([source=recordingMetadata,appId=...]) TIMESERIES ... | filter ... | group by ...\n\nDO NOT invent new syntax!`
    }
  }

  // Always inject appId from admin settings (not gated behind includeSkillDoc)
  try {
    const { readAdminState } = await import('~/server/utils/adminStore')
    const state = await readAdminState(orgId)
    if (state.pendo?.defaultAppId) {
      prompt += `\n\n# Configuration\n\nDefault Pendo appId: ${state.pendo.defaultAppId}\nALWAYS use appId=${state.pendo.defaultAppId} in your aggregation queries unless the user explicitly specifies a different one. Do NOT ask the user for the appId — it is already configured.`
    }
  } catch (err) {
    console.error('[agentPrompts] Failed to load appId:', err)
  }
  
  return prompt
}
