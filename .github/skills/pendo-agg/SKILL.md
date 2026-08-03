---
name: pendo-agg
description: >
  Turns a natural-language analytics question into a Pendo Aggregation request, fetches the data, then summarizes and/or charts the results.
  Use this skill whenever the user asks anything about Pendo data: event volume, feature usage, session replays, visitor counts, funnels, PES scores, frustration signals, product engagement, or any query that needs to hit the Pendo aggregation API.
  Also trigger when the user wants to write or debug a Pendo DSL query, even if they don't explicitly say "aggregation".
---

# Pendo Aggregation (DSL → Fetch → Summarize)

This skill turns a natural-language question into a Pendo Aggregation request body, fetches the data from Pendo, then summarizes and/or charts the results.

## Requirements

Environment variables:

- `PENDO_API_KEY` (required): your Pendo integration/API key.
   - Alias supported: `PENDO_INTEGRATION_KEY`.
- `PENDO_AGG_URL` (optional): full HTTPS URL to the aggregation endpoint.
   - Default: `https://app.pendo.io/api/v1/aggregation`.
- `PENDO_API_KEY_HEADER` (optional): header name for the key. Defaults to `x-pendo-integration-key`.

Notes:

- Never print or paste `PENDO_API_KEY` in chat.
- The tools in `tools/pendo/` use only environment variables for secrets.
- If you prefer, create a local `.env` (see `.env.example`). `run_agg.py` will load it if env vars aren't set.

**Before writing DSL**, read the spec: `Pendo Aggregation Spec Sheet (Project Truth).md`

## Tools

### 1) Compile DSL → Aggregation JSON

- Script: `tools/pendo/dsl_compile.py`
- Input: `.dsl` file or stdin
- Output: aggregation JSON body to stdout

Recommended:

- `python -m tools.pendo.dsl_compile query.dsl > body.json`

By default it resolves `now()` to the current epoch-ms (Pendo endpoints require numeric timestamps).

### 2) Validate aggregation JSON

- Script: `tools/pendo/validate.py`
- Input: JSON file or stdin
- Output: exits non-zero on schema issues; prints a short reason.

Recommended:

- `python -m tools.pendo.validate body.json`

### 3) Run aggregation (fetch data)

- Script: `tools/pendo/run_agg.py`
- Input: JSON request body file or DSL file (auto-detected)
- Output: response JSON to stdout

Recommended:

- `python -m tools.pendo.run_agg body.json > result.json`

Retry behavior:

- Attempts up to 5 build+send retries on failure.
- Between attempts it may apply safe rewrites (e.g., resolving `now()` if it slipped through).
- If failures persist, it prints the last error response body so you can adjust the DSL.

### 4) Enrich results with feature / page / track event / guide names

- Script: `tools/pendo/lookup_names.py`
- Input: aggregation result JSON file or stdin
- Output: same JSON with `featureName` / `pageName` / `trackTypeName` / `guideName` fields added alongside any `featureId` / `pageId` / `trackTypeId` / `guideId` fields

Recommended:

- `python -m tools.pendo.lookup_names result.json > result_enriched.json`
- Or inline: `python -m tools.pendo.run_agg query.dsl | python -m tools.pendo.lookup_names - > result_enriched.json`

**Always look up names whenever results contain any of: `featureId`, `pageId`, `trackTypeId`, or `guideId`.** Merge the name fields onto the same result rows as the IDs — never return raw IDs to the user, and never emit the names as a separate side document. The enriched file replaces the raw one for every downstream step (summary, chart, response to the user).

### 5) List / lookup segments

- Script: `tools/pendo/lookup_segments.py`
- Input: Optional search term and appId
- Output: Tab-separated `segmentId<TAB>segmentName` rows (with description on the following line when present)

The Pendo Aggregation API does not expose a `segments` source, so segments must be resolved via the REST API. The script wraps:

```
GET https://app.pendo.io/api/v1/segment
content-type: application/json
x-pendo-integration-key: $PENDO_INTEGRATION_KEY
```

Equivalent curl (useful for debugging or one-off calls outside the skill):

```
curl --location 'https://app.pendo.io/api/v1/segment' \
  --header 'content-type: application/json' \
  --header "x-pendo-integration-key: $PENDO_INTEGRATION_KEY"
```

Examples:

- `python -m tools.pendo.lookup_segments` — **List all segments** (use this whenever you need to discover what segments exist, e.g. before filtering a query by segment).
- `python -m tools.pendo.lookup_segments 'JAPAN'` — Filter by case-insensitive name substring.
- `python -m tools.pendo.lookup_segments 'paying' -323232` — Filter by name and restrict to a specific appId.

Whenever the user's request implies a segment filter (e.g. "for paying customers", "for the JAPAN audience"), list or search segments first to get the ID, then reference it in the DSL.

Once you have the segment ID, use it in your DSL:

```dsl
PIPELINE
| pes {"appId":-323232,"segment":{"id":"SEGMENT_ID_HERE"},"dayCount":-30}
```

Or with FROM queries:

```dsl
FROM event([source=events,appId=-323232])
TIMESERIES period=dayRange first=now() count=30
| segment id="SEGMENT_ID_HERE"
| group by visitorId fields { totalEvents=sum(numEvents) }
```

### 6) Summarize + chart

- Script: `tools/pendo/chart.py`
- Input: result JSON file or stdin
- Output: Markdown summary and an optional Vega-Lite spec for quick visualization.

Recommended:

- `python -m tools.pendo.chart result.json --summary`
- With Vega spec: `python -m tools.pendo.chart result.json --vega --x groupId --y totalEvents > chart.vega.json`

## Stage prefixes in `merge` / `spawn` blocks (get this right the FIRST time)

The single most common DSL error is the wrong stage prefix inside a block. The rules, from the parser:

| Context | Stage prefix |
|---|---|
| Top-level pipeline | `|` |
| Inside a `spawn` branch | `||` |
| Inside a `merge` block — **always**, even when the merge sits inside a spawn branch | `|` |
| `FROM` / `TIMESERIES` / `PIPELINE` / `branch` / `endbranch` lines | no prefix |

The trap: inside a spawn branch every stage is `||` — but the moment a `|| merge fields [...]` block opens, its INNER stages flip back to single `|` until `endmerge`. The merge header itself keeps the prefix of its context (`| merge` at top level, `|| merge` inside a branch).

Getting it wrong fails compilation with exactly:
- `Inside merge block, stages must start with '|' (not '||')`
- `Inside spawn branch, pipeline stages must start with '||'`

**Cohort join at top level** ("visited page A but never page B") — merge joins the inner query's rows onto the outer rows by the listed fields; a missing match leaves the mapped field null:

```dsl
FROM event([source=pageEvents, pageId="PAGE_A_ID", appId=-323232])
TIMESERIES period=dayRange first=dateAdd(startOfPeriod("daily", now()), -30, "days") count=30
| identified visitorId
| group by visitorId fields { pageAEvents=sum(numEvents) }
| merge fields [visitorId] mappings { pageBEvents=pageBEvents }
FROM event([source=pageEvents, pageId="PAGE_B_ID", appId=-323232])
TIMESERIES period=dayRange first=dateAdd(startOfPeriod("daily", now()), -30, "days") count=30
| identified visitorId
| group by visitorId fields { pageBEvents=sum(numEvents) }
endmerge
| filter isNull(pageBEvents)
```

Use `| filter !isNull(pageBEvents)` instead for "visited A AND B". See `examples/merge__visitors_pageA_not_pageB__last30d.dsl`.

**Merge inside a spawn branch** — note `||` on the branch's own stages (including the `|| merge` header and the `|| filter` after `endmerge`), but single `|` on every stage inside the merge block:

```dsl
PIPELINE
| spawn
branch
FROM event([source=pageEvents, pageId="PAGE_A_ID", appId=-323232])
TIMESERIES period=dayRange first=dateAdd(startOfPeriod("daily", now()), -30, "days") count=30
|| identified visitorId
|| group by visitorId fields { pageAEvents=sum(numEvents) }
|| merge fields [visitorId] mappings { pageBEvents=pageBEvents }
FROM event([source=pageEvents, pageId="PAGE_B_ID", appId=-323232])
TIMESERIES period=dayRange first=dateAdd(startOfPeriod("daily", now()), -30, "days") count=30
| identified visitorId
| group by visitorId fields { pageBEvents=sum(numEvents) }
endmerge
|| filter isNull(pageBEvents)
endbranch
| endspawn
| limit 100
```

See `examples/spawn__merge_inside_branch__cohort_join__last30d.dsl`. Both examples compile as written — copy the skeleton, change only sources, ids, and fields. Prefer the simple top-level merge; only reach for `spawn` when you genuinely need to union several parallel pipelines into one row stream.

## Agent workflow

1. Ask clarifying questions only if required fields are unknown (e.g., appId, product area definition).

2. **Map user intent to examples** — Open `examples/INDEX.md` and find the 1–3 most relevant example DSL files based on what the user is asking. Use the "Query Intent Mapping" section there:
   - "event volume / traffic / activity" → `events__*`
   - "features / feature usage" → `feature_events__*`
   - "visitors / MAU / WAU / user count" → `total_count_of_visitors_past_7_days.dsl`
   - "funnel / conversion / drop-off" → `funnel_*`
   - "PES / engagement score" → `pes__*`
   - "session replays / frustration / error sessions" → `session_replays__*` or `recording_metadata__*`; also read `examples/SESSION_REPLAY_EXAMPLES.md`
   - "retention" → `*_retention_*`
   - "product areas / navigation" → `product_areas__*`

   Read the relevant example files and copy their patterns exactly, modifying only the parameters (appId, dates, filters).

3. **If segment filtering is needed**: Run `lookup_segments.py` to find the segment ID by name before writing the DSL.

4. **Write DSL** following the spec sheet and the patterns from the matched examples.
   - PES requests use `PIPELINE` mode with a `| pes { ... }` stage (PES replaces the normal `FROM` source).
   - **All output files must be saved to `./results/<topic name>/`**. Create the directory if it doesn't exist.

5. Compile and validate:
   ```
   python -m tools.pendo.dsl_compile query.dsl > results/<topic>/body.json
   python -m tools.pendo.validate results/<topic>/body.json
   ```

6. Run the aggregation:
   ```
   python -m tools.pendo.run_agg query.dsl > results/<topic>/result.json
   ```

7. If the request fails, iterate up to 5 times:
   - Adjust DSL based on the exact error message from the previous attempt, recompile, re-run.

8. **Enrich results** whenever they contain any of `featureId`, `pageId`, `trackTypeId`, or `guideId`. Always run the lookup and merge the names onto the same rows — do not skip this step and do not present raw IDs to the user:
   ```
   python -m tools.pendo.lookup_names results/<topic>/result.json > results/<topic>/result_enriched.json
   ```
   Use the enriched file (with names merged inline) for the summary and every downstream step.

9. Summarize and chart:
   ```
   python -m tools.pendo.chart results/<topic>/result.json --summary
   python -m tools.pendo.chart results/<topic>/result.json --vega --x field --y metric > results/<topic>/chart.vega.json
   ```
