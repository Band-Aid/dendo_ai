    c# AggDSL Examples Index

This directory contains real-world examples of Pendo Aggregation DSL queries, organized by use case.

## Categories

### Basic Event Queries
- `events__daily_counts__last30d__app1234567890123456__top5.dsl` - Daily event volumes, top 5 by count
- `events__total_events_by_appid__last30d__top10.dsl` - Total events grouped by appId
- `events__daily_events_error_deadclicks__last30d__app1234567890123456__top5.dsl` - Error and dead click events

### Feature Events
- `feature_events__top10_by_events__last30d__app_neg123456.dsl` - Top features by event volume
- `feature_events__recent_select_fields__last1d.dsl` - Recent feature events with select fields
- `feature_retention_top5.dsl` - Feature retention analysis

### Visitor/User Metrics
- `total_count_of_visitors_past_7_days.dsl` - Count unique identified visitors over time period (uses reduce for unique counts)

### Funnels
- `funnel_page_to_feature_conversion.dsl` - Page to feature conversion funnel with completion metrics

### Product Engagement Score (PES)
- `pes__basic__last30d__app1234567890123456.dsl` - Basic PES calculation
- `pes__segment_core_events__last30d__app_neg123456.dsl` - PES for specific segment with core events
- `pes_score_30d.dsl` - 30-day PES score

### Session Replays (Recording Metadata)
- `session_replays__basic__last30d__app_neg323232.dsl` - Basic session replay query
- `session_replays__frustration_full__last30d__app_neg123456__limit50__min300s.dsl` - High frustration sessions
- `session_replays__top_broken_sessions__last30d__app_neg323232__top5.dsl` - Sessions with highest error counts
- `session_replays__top_error_sessions_events__last30d__app_neg323232__top5.dsl` - Top error sessions
- `session_replays__top_frustration_sessions_metadata__last30d__app1234567890123456__top5.dsl` - Top frustration with metadata
- `session_replays__candidate_list_filtered__last30d__top100_recent.dsl` - Filtered candidate session list

### Recording Metadata Details
- `recording_metadata__sessions__last30d__app1234567890123456__top5_by_recordings.dsl` - Sessions with most recordings
- `recording_metadata__broken_distribution__last30d__app1234567890123456__top10.dsl` - Distribution of broken elements
- `recording_metadata__rows_for_session__last30d__app1234567890123456__session_session_example_1.dsl` - Specific session details

### Combining Sources (merge / spawn)
- `merge__visitors_pageA_not_pageB__last30d.dsl` - Cohort join: visitors of page A who never visited page B (top-level merge; inner stages use `|`)
- `spawn__merge_inside_branch__cohort_join__last30d.dsl` - Merge nested inside a spawn branch (branch stages use `||`, but the merge block's inner stages flip back to `|`)

### Advanced Queries
- `recording_replay__aggregation_fork__app1234567890123456.dsl` - Fork-based aggregation for replays
- `recording_replay__aggregation_rawjson_fork__app1234567890123456.dsl` - Raw JSON fork aggregation
- `agentic_events__prompts__last30d__app1234567890123456__with_response.dsl` - Agentic event tracking

### Product Areas
- `product_areas__usage_pages_features__last7d.dsl` - Product area usage across pages and features

### Utility
- `days_active_avg.dsl` - Average days active calculation
- `map_featureid_with_name` - Feature ID to name mapping

## Usage Patterns

### Query Intent Mapping

**When user asks about:**
- "event volume", "traffic", "activity" → Use `events__*` examples
- "features", "feature usage", "most used features" → Use `feature_events__*` examples
- "visitors", "users", "active users", "unique visitors", "MAU", "WAU", "DAU", "user count", "audience size" → Use `total_count_of_visitors_past_7_days.dsl` as pattern
- "conversion", "funnel", "drop-off" → Use `funnel_*` examples
- "engagement score", "PES" → Use `pes__*` examples
- "session replays", "frustration", "errors in sessions" → Use `session_replays__*` or `recording_metadata__*` examples
- "retention", "repeat usage" → Use `*_retention_*` examples
- "did X but not Y", "also visited", "who overlaps", "cohort join", "combine two sources" → Use `merge__*` / `spawn__*` examples (and read the prefix rules in SKILL.md first)
- "product areas", "navigation patterns" → Use `product_areas__*` examples

### Time Range Patterns
- `last1d` - Last 1 day
- `last7d` - Last 7 days
- `last30d` - Last 30 days (most common)
- Custom date ranges using `TIMESERIES period=dayRange first=... count=...`

### App ID Patterns
- Positive IDs: `app1234567890123456` - Real production apps
- Negative IDs: `app_neg123456`, `app_neg323232` - Test/demo apps
- Use `appId=-323232` format in actual queries

## Integration with Agent

These examples should be dynamically loaded based on user query keywords:
- Detect query intent from user question
- Load 1-3 most relevant example files
- Inject into system prompt as reference examples
- Agent copies patterns exactly, modifying only parameters (appId, dates, filters)
