---
name: add-feed
description: Add a new data source feed — copy the blueprint, implement fetch+map+refresh, register cron, add env vars
---
# Add Feed — Step-by-step guide for new data sources

Read `AGENTS.md` first for project architecture. Read `docs/feeds-blueprint.txt` for the exact file template.

## The 6-Step Pattern

### 1. Decide the seam
- **Is this ingestion or configuration?**
  - Ingestion (API polling, WebSocket subscription) → feed file needed
  - Configuration (partner rules, limits, tiers) → TOML profile is enough
- **Which shared infrastructure does it feed into?**
  - Odds → `sportsbook-service.ts` (updateBookOdds)
  - Wagers/signals → `cascade-engine-integration.ts` (processSignalRoute)
  - Something new → add the function to the appropriate service file

### 2. Copy the blueprint
`docs/feeds-blueprint.txt` → `src/feeds/<source-name>.ts`

### 3. Implement the 3 functions

```typescript
// fetch*() — talk to the external API
async function fetchFromSource(): Promise<RawEntry[]> {
  const key = env.SOURCE_API_KEY;
  if (!key) throw new Error("SOURCE_API_KEY not configured");
  const resp = await fetch("https://api.source.com/v1/data", {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!resp.ok) throw new Error(`API returned ${resp.status}`);
  return (await resp.json()) as RawEntry[];
}

// map*() — transform API JSON → internal type (pure function)
function mapToInternal(raw: RawEntry[]): InternalEntry[] {
  return raw.map(r => ({ id: `src_${r.id}`, ... }));
}

// refresh() — orchestrator
export async function refresh(): Promise<FeedResult> {
  const result = { fetched: 0, mapped: 0, errors: [], timestamp: Date.now() };
  if (!env.SOURCE_API_KEY || !env.BUCKEYE_LIVE_MODE) return result;
  try {
    const raw = await fetchFromSource();
    result.fetched = raw.length;
    const mapped = mapToInternal(raw);
    for (const entry of mapped) {
      updateBookOdds(entry); // feed into shared infrastructure
    }
  } catch (e) {
    result.errors.push(e instanceof Error ? e.message : "Unknown");
  }
  return result;
}
```

### 4. Register in cron.ts

```typescript
// In src/services/cron.ts — inside createJobs()
{
  name: "<source>_refresh",
  schedule: "*/2 * * * *",          // adjust frequency
  description: "Fetch odds from <Source>",
  enabled: true,
  handler: async () => {
    if (env.BUCKEYE_LIVE_MODE && env.SOURCE_API_KEY) {
      const { refresh } = await import("../feeds/<source>");
      await refresh();
    }
  },
},
```

### 5. Add env vars to src/utils/env.ts

```typescript
SOURCE_API_KEY: z.string().optional(),
SOURCE_API_SECRET: z.string().optional(),
```

### 6. Run typecheck

```bash
bun run typecheck  # must pass clean: 0 errors
```

## Rules (non-negotiable)

- **One API per file.** Never put two data sources in one feed file.
- **No analytics in feeds.** CLV, steam, arbitrage, scoring → shared service files.
- **No broadcast in feeds.** SSE/WS broadcast → cron handler or shared service.
- **Gate behind env.** Default OFF. Missing key = graceful skip, never crash.
- **Result type always has `{ fetched, mapped, errors[], timestamp }`.**

## Gotchas

- `src/feeds/` is in tsconfig include — all feed files are typechecked. Keep Unicode characters out (no box-drawing, no em dashes in code).
- Use dynamic `await import()` in cron handlers to avoid circular dependencies.
- `buckeye-feed.ts` uses `processSignalRoute()` which fans out to all partners with matching books.
- `odds-feed.ts` uses `updateBookOdds()` which auto-detects line movements and triggers CLV/steam.
