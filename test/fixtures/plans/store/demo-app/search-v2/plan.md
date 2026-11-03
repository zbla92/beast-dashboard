---
topic: search-v2
title: Search v2
repo: /srv/demo-app
status: active
created: 2026-11-03T07:58:00Z
---

Goal: replace the LIKE-based product search with a ranked full-text index, behind a feature flag.

## Next

T6 Query endpoint: finish cursor pagination (`after` param), then run the gate.
If the gate is red, fix it before starting T7.

## Waiting on you

- q1 Re-index the legacy synonym lists, or only copy them? · blocks T9 · asked 2026-11-03T10:41:00Z
  The repo has 4 synonym lists committed under data/. Re-indexing changes ranking for
  existing queries; copying keeps them as they are until someone reviews them.

## Phase 1 — Index

- [x] T1 Index schema · Opus · gate ✓ 12 tests
  Goal: freeze the search_documents table and its tsvector column.
  Owns: db/migrations/0042_search.sql, lib/search/schema.js
  Gate: npm test -- search/schema
- [x] T2 Tokenizer · Sonnet · gate ✓ 24 tests
- [x] T3 Backfill job · Sonnet · gate ✓ 31 tests

## Phase 2 — API

- [x] T4 Search endpoint · Sonnet · gate ✓ 38 tests
- [!] T5 Contract tests · Sonnet · gate ✗ lint · 2 errors
  Fix the two lint errors in test/search.contract.test.js, then re-run the gate.
- [~] T6 Query endpoint · Sonnet
  Goal: GET /api/search?q=&after= returns 20 ranked hits and a cursor.
  Owns: lib/search/query.js, routes/search.js
  Must not touch: db/migrations/

  Gate: npm test && npm run lint
- [ ] T7 Rate limits · Sonnet

## Phase 3 — Rollout

- [ ] T8 Feature flag · Haiku
- [?] T9 Import legacy synonyms · Opus
- [ ] T10 Runbook

## Decisions

- Postgres full-text search, no external engine.
- Ranking weights live in config, not code.

```text
## Not a heading (inside a fence)
```
