/**
 * Conversation memory management for agent sessions
 * Stores message history and tracks whether reference docs have been loaded
 */

interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content?: string
  tool_calls?: any[]
  tool_call_id?: string
  timestamp: number
}

interface ConversationSession {
  messages: Message[]
  skillDocLoaded: boolean
  createdAt: number
  lastAccess: number
}

// In-memory store (could be replaced with Redis/DB for production)
const sessions = new Map<string, ConversationSession>()

// Session timeout: 1 hour
const SESSION_TIMEOUT = 60 * 60 * 1000

// Cleanup interval: every 10 minutes
setInterval(() => {
  const now = Date.now()
  for (const [sessionId, session] of sessions.entries()) {
    if (now - session.lastAccess > SESSION_TIMEOUT) {
      sessions.delete(sessionId)
    }
  }
}, 10 * 60 * 1000)

/**
 * Get or create a conversation session
 */
export function getConversationSession(sessionId: string): ConversationSession {
  let session = sessions.get(sessionId)
  
  if (!session) {
    session = {
      messages: [],
      skillDocLoaded: false,
      createdAt: Date.now(),
      lastAccess: Date.now()
    }
    sessions.set(sessionId, session)
  } else {
    session.lastAccess = Date.now()
  }
  
  return session
}

/**
 * Add a message to the conversation history
 */
export function addMessage(
  sessionId: string,
  role: 'system' | 'user' | 'assistant' | 'tool',
  content?: string,
  extras?: { tool_calls?: any[], tool_call_id?: string }
): void {
  const session = getConversationSession(sessionId)
  const message: Message = {
    role,
    timestamp: Date.now()
  }
  
  if (content !== undefined) {
    message.content = content
  }
  
  if (extras?.tool_calls) {
    message.tool_calls = extras.tool_calls
  }
  
  if (extras?.tool_call_id) {
    message.tool_call_id = extras.tool_call_id
  }
  
  session.messages.push(message)
}

/**
 * Get conversation history for API calls
 * Returns messages in format compatible with LLM providers
 */
export function getConversationHistory(sessionId: string): Array<any> {
  const session = getConversationSession(sessionId)
  return session.messages.map(m => {
    const msg: any = { role: m.role }
    
    if (m.content !== undefined) {
      msg.content = m.content
    }
    
    if (m.tool_calls) {
      msg.tool_calls = m.tool_calls
    }
    
    if (m.tool_call_id) {
      msg.tool_call_id = m.tool_call_id
    }
    
    return msg
  })
}

/**
 * Mark that SKILL.md has been loaded for this session
 */
export function markSkillDocLoaded(sessionId: string): void {
  const session = getConversationSession(sessionId)
  session.skillDocLoaded = true
}

/**
 * Check if SKILL.md has been loaded for this session
 */
export function isSkillDocLoaded(sessionId: string): boolean {
  const session = sessions.get(sessionId)
  return session?.skillDocLoaded || false
}

/**
 * Clear a conversation session
 */
export function clearConversationSession(sessionId: string): void {
  sessions.delete(sessionId)
}

/**
 * Get session stats for debugging
 */
export function getSessionStats() {
  return {
    total: sessions.size,
    sessions: Array.from(sessions.entries()).map(([id, session]) => ({
      id,
      messageCount: session.messages.length,
      skillDocLoaded: session.skillDocLoaded,
      age: Date.now() - session.createdAt,
      lastAccess: Date.now() - session.lastAccess
    }))
  }
}
