# Performance Workload Profiles

This document describes the synthetic dataset generators and named workload
profiles used for xConfess benchmarks and load tests.

## Overview

Benchmarks are only comparable when every run uses the same data distribution.
The `DatasetGenerator` class produces deterministic, privacy-safe synthetic
fixtures from a numeric seed — no production data is ever used or emitted.

Named **workload profiles** document the concurrency mix, dataset scale, and
request distribution for each test scenario.  Profiles live in
`xconfess-backend/src/common/performance/workload-profiles.ts` and are consumed
by benchmark scripts and load-test drivers.

## Dataset Generator

**File:** `xconfess-backend/src/common/performance/dataset-generator.ts`

```ts
import { DatasetGenerator } from './common/performance/dataset-generator';

const gen = new DatasetGenerator(42); // seed makes it reproducible
const users        = gen.users(500);
const confessions  = gen.confessions(5000, users);
const reactions    = gen.reactions(25000, confessions, users);
const comments     = gen.comments(10000, confessions, users);
const jobs         = gen.notificationJobs(2000, users);
```

All generated IDs are namespaced (`user-<seed>-<index>`) so fixtures from
different seeds can coexist in the same test database without collisions.

### Privacy guarantees

- Usernames are random hex strings; no real names are generated.
- Confession content is a fragment + random hex suffix; no PII patterns.
- No email addresses, phone numbers, or real passwords are emitted.

## Workload Profiles

| Name          | VUs | Target RPS | Seed | Purpose                                      |
|---------------|-----|------------|------|----------------------------------------------|
| `smoke`       |   5 |         20 |    1 | CI sanity check — fast p50 baseline          |
| `read-heavy`  | 100 |        300 |   42 | Typical daytime traffic (80 % reads)         |
| `write-spike` | 200 |        500 |   99 | Viral event — elevated writes + queue load   |
| `ws-soak`     | 500 |         50 |    7 | Long-lived WS connections — memory leak test |

### Profile: `smoke`

Minimal concurrency.  Runs in under 30 seconds.  Validates p50 latency
baselines before deeper profiling begins.

### Profile: `read-heavy`

Models typical daytime traffic.  ~80 % of operations are reads (feed,
detail, trending, search).  Use this profile to establish cache hit rates
and DB read throughput.

### Profile: `write-spike`

Simulates a viral event where many users post and react simultaneously.
Tests DB write throughput, notification queue back-pressure, and WS fanout
under high write ratio.

### Profile: `ws-soak`

500 concurrent WebSocket connections held open for ≥ 10 minutes.  Designed
to expose unbounded heap growth in the notification gateway.  Monitor RSS
and heap-used over time; both should plateau rather than grow linearly.

## Using Profiles in a Load Test

```ts
import { buildProfileDataset, READ_HEAVY_PROFILE, normaliseDistribution }
  from './common/performance/workload-profiles';

const { profile, users, confessions } = buildProfileDataset(READ_HEAVY_PROFILE);
const dist = normaliseDistribution(profile.distribution);

// dist[i].normalisedWeight is the probability of picking that operation.
```

## Budget Review Cadence

Latency budgets (see `latency-budgets.ts`) should be reviewed with product
owners at the start of each milestone and after any infrastructure change
that affects database or cache topology.

## Running the benchmark tests

```bash
# Unit tests only (no live server required)
npm run backend:test

# Full CI check
npm run ci
```
