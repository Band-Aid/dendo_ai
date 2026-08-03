/**
 * Build Pendo Aggregation DSL queries from natural language requests
 */

export interface DataRequest {
  id: string
  metric: string
  population: 'users' | 'accounts' | 'events'
  dsl?: string  // Agent-generated DSL query
  segments?: string[]
  window?: { type: 'relative' | 'absolute'; days?: number; start?: string; end?: string }
  breakdowns?: string[]
  notes?: string
}

export function buildSimpleUsageDSL(appId: number, days: number = 30): string {
  return `FROM event([source=events, appId=${appId}])
TIMESERIES period=dayRange first=now() count=-${days}
| group by visitorId fields {
    eventCount=sum(numEvents)
  }`
}

export function buildFeatureUsageDSL(appId: number, featureIds: string[] = [], days: number = 30): string {
  const featureFilter = featureIds.length > 0 
    ? `, featureId=[${featureIds.map(id => `"${id}"`).join(', ')}]`
    : ''
  
  return `FROM event([source=featureEvents, appId=${appId}${featureFilter}])
TIMESERIES period=dayRange first=now() count=-${days}
| group by featureId fields {
    visitors=count(visitorId),
    events=sum(numEvents),
    avgPerVisitor=avg(numEvents)
  }`
}

export function buildSegmentComparisonDSL(
  appId: number,
  segmentIds: string[],
  metric: 'feature_usage' | 'retention' | 'engagement',
  days: number = 30
): string {
  // Simple event count by visitor for segment comparison
  return `FROM event([source=events, appId=${appId}])
TIMESERIES period=dayRange first=now() count=-${days}
| group by visitorId fields {
    eventCount=sum(numEvents),
    dayCount=count(day)
  }`
}

export function buildRetentionAnalysisDSL(appId: number, cohortDays: number = 90, retentionWindow: number = 30): string {
  // Simple visitor activity over time for retention analysis
  return `FROM event([source=events, appId=${appId}])
TIMESERIES period=dayRange first=now() count=-${cohortDays}
| group by visitorId fields {
    firstDay=min(day),
    lastDay=max(day),
    totalEvents=sum(numEvents),
    activeDays=count(day)
  }`
}

/**
 * Build DSL based on data request from agent
 */
export function buildDSLFromRequest(request: DataRequest, appId: number): string {
  const days = request.window?.days || 30
  const metric = request.metric.toLowerCase()
  const notes = (request.notes || '').toLowerCase()
  const combined = `${metric} ${notes}`

  // Feature usage ranking
  if (combined.includes('feature') && (combined.includes('usage') || combined.includes('using') || combined.includes('popular'))) {
    return buildFeatureUsageDSL(appId, [], days)
  }
  
  // Retention analysis
  if (combined.includes('retention') || combined.includes('churn')) {
    return buildRetentionAnalysisDSL(appId, days, 30)
  }
  
  // Segment comparison
  if (combined.includes('segment') || combined.includes('cohort') || (request.segments && request.segments.length > 0)) {
    return buildSegmentComparisonDSL(appId, request.segments || [], 'engagement', days)
  }

  // Default: simple usage analysis
  return buildSimpleUsageDSL(appId, days)
}

/**
 * Format aggregation results for display
 */
export function formatAggregationResults(data: any): string {
  if (!data || !data.results) {
    return 'No results returned from aggregation.'
  }

  const results = data.results
  if (!Array.isArray(results) || results.length === 0) {
    return 'Query executed successfully but returned no data.'
  }

  // Build markdown table
  const keys = Object.keys(results[0])
  const header = `| ${keys.join(' | ')} |`
  const separator = `| ${keys.map(() => '---').join(' | ')} |`
  const rows = results.slice(0, 10).map(row => 
    `| ${keys.map(k => row[k] ?? 'null').join(' | ')} |`
  )

  let output = `**Results:** ${results.length} rows\n\n${header}\n${separator}\n${rows.join('\n')}`
  
  if (results.length > 10) {
    output += `\n\n*Showing first 10 of ${results.length} rows*`
  }

  return output
}
