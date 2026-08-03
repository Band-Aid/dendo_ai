import { readAdminState } from '~/server/utils/adminStore'

export default defineEventHandler(async (event) => {
  const orgId = event.context.orgId as string
  const adminState = await readAdminState(orgId)
  const { integrationKey, defaultAppId } = adminState.pendo
  
  if (!integrationKey) {
    throw createError({
      statusCode: 400,
      message: 'Pendo integration key not configured. Please set it in Admin settings.'
    })
  }
  
  try {
    // Get query params for filtering
    const query = getQuery(event)
    const limit = parseInt(query.limit as string) || 50
    const search = (query.search as string) || ''
    
    // Call Pendo REST API to get features
    // Scope by appId server-side — the bare endpoint only returns the default
    // app's entities in multi-app subscriptions.
    const url = defaultAppId != null
      ? `https://app.pendo.io/api/v1/feature?appId=${defaultAppId}`
      : 'https://app.pendo.io/api/v1/feature'
    const response = await fetch(url, {
      headers: {
        'x-pendo-integration-key': integrationKey
      }
    })
    
    if (!response.ok) {
      throw new Error(`Pendo API returned ${response.status}: ${response.statusText}`)
    }
    
    const allFeatures = await response.json()
    
    // Filter by default app ID if configured
    let features = allFeatures
    if (defaultAppId !== undefined) {
      features = allFeatures.filter((f: any) => f.appId === defaultAppId)
    }
    
    // Apply search filter if provided
    if (search) {
      const searchLower = search.toLowerCase()
      features = features.filter((f: any) => 
        (f.name || '').toLowerCase().includes(searchLower) ||
        (f.id || '').toLowerCase().includes(searchLower) ||
        (f.group || '').toLowerCase().includes(searchLower)
      )
    }
    
    // Sort by name for consistency
    features.sort((a: any, b: any) => {
      const nameA = (a.name || a.id || '').toLowerCase()
      const nameB = (b.name || b.id || '').toLowerCase()
      return nameA.localeCompare(nameB)
    })
    
    // Apply limit
    const limited = features.slice(0, limit)
    
    // Map to simplified format
    const formatted = limited.map((f: any) => ({
      id: f.id,
      name: f.name || f.id,
      group: f.group || 'Ungrouped',
      appId: f.appId
    }))
    
    return { 
      features: formatted,
      total: features.length,
      showing: formatted.length,
      hasMore: features.length > limit
    }
  } catch (error: any) {
    console.error('Failed to fetch Pendo features:', error)
    throw createError({
      statusCode: 500,
      message: `Failed to fetch Pendo features: ${error.message}`
    })
  }
})
