import { buildDSLFromRequest, buildSimpleUsageDSL, buildFeatureUsageDSL, type DataRequest } from '~/server/utils/pendoDslBuilder'

interface BuildDSLRequest {
  request: DataRequest
  appId: number
}

export default defineEventHandler(async (event) => {
  try {
    let input: BuildDSLRequest | null = null
    
    try {
      input = await readBody<BuildDSLRequest>(event)
    } catch (parseError: any) {
      console.error('[build-dsl] Failed to parse request body:', parseError)
      throw createError({
        statusCode: 400,
        message: 'Invalid request body'
      })
    }
    
    console.log('[build-dsl] Received request:', JSON.stringify(input, null, 2))
    
    if (!input || !input.appId) {
      console.error('[build-dsl] Missing appId or input')
      throw createError({
        statusCode: 400,
        message: 'Request and appId are required'
      })
    }
    
    if (!input.request) {
      console.error('[build-dsl] Missing request object')
      throw createError({
        statusCode: 400,
        message: 'Request object is required'
      })
    }

    let dsl: string
    
    try {
      dsl = buildDSLFromRequest(input.request, input.appId)
    } catch (buildError: any) {
      console.error('[build-dsl] buildDSLFromRequest failed:', buildError)
      // Fallback to simple usage query
      const days = input.request.window?.days || 30
      dsl = buildSimpleUsageDSL(input.appId, days)
      console.log('[build-dsl] Using fallback simple usage DSL')
    }
    
    console.log('[build-dsl] Generated DSL:', dsl.substring(0, 200))
    
    return {
      dsl,
      request: input.request
    }
  } catch (error: any) {
    console.error('[build-dsl] Error:', error)
    throw createError({
      statusCode: 500,
      message: `Failed to build DSL: ${error.message || 'Unknown error'}`
    })
  }
})
