# Token Usage Ledger

A DSH plugin that counts the tokens this deployment actually spent, prices them
against a rate table you own, and draws three views over the result: today hour
by hour, the last 30 days, and the total per workspace project.

It lives in the conversation view as a **Token usage** tab.

---

## What you see

**Overview**

- Four tiles: today, last 24 hours, last 30 days, all time.
- **Today, hour by hour** — a 24-point line, live.
- **Daily, last 30 days** — one point per day; listed holidays are shaded.
- **By workspace project** — bars, one per workspace path, using the matching
  workspace title where the registry knows one.
- **By model** — a table with input / cache-read / cache-write / output / total,
  the call count, and the cost. A model you never priced is flagged instead of
  silently billed at zero.

Every chart and every table has a **Tokens / Cost** switch in the header. Both
views are always in range: cost is recomputed from the counts on each read, so
there is never a stale figure to reconcile.

**Pricing**

- Time zone, currency code, currency symbol, retention days.
- Holidays: ISO dates, one model at a time or for everyone.
- One row per model with **input**, **cached input**, and **output** per million
  tokens, plus:
  - **time-of-day tiers** — `from` / `to` / multiplier. The first matching tier
    wins, and a range may cross midnight (`18:00 → 06:00`).
  - **separate holiday prices** — three more rates used as the base on a listed
    holiday.

Editing a rate re-prices the entire history immediately, because only token
counts are stored. Nothing about money is ever persisted.

---

## How the numbers are computed

Token accounting comes from the durable session log. Every model call appends an
`assistant/message` event whose `usage` record reports four disjoint counts:
uncached input, cache reads, cache writes, and output. Those four numbers are
the only thing this plugin stores, folded into a bucket keyed by the local hour,
with a per-model and a per-workspace breakdown inside.

Cost is derived, never stored:

```
cost = (input × inputRate
       + (cacheRead + cacheWrite) × cacheInputRate
       + output × outputRate)
       / 1,000,000 × tierMultiplier
```

Two decisions worth knowing about:

- **Cache writes bill at the cache-input rate.** A write to the cache is the
  same work as a read of it, so both fall under one `cacheInput` rate rather
  than a fourth dimension.
- **An hour is priced at its own rate.** A tier boundary inside an hour is not
  split, because the boundary is not recorded anywhere in the log.
- **Holiday prices and tiers compose.** On a listed holiday, a model's holiday
  rates become the base and its tiers still multiply them. Set the tier to
  `1.0`, or leave tiers empty, to make the holiday price stand alone.

An hour is attributed to whichever zone you pick, and the bucket key is that
local hour — so moving the time zone re-buckets history rather than shifting a
display offset. The default is the runtime's own zone.

Two feeds count through one de-duplicated writer: the live `session/event` feed
for usage that happens while the plugin is loaded, and a one-time corpus sweep
on first read that catches everything that happened before the plugin was
enabled, plus any window it spent disabled. Each session records the highest
event it has counted, so the two feeds can never double-count and a restart
never restarts the count.

Retention defaults to 400 days of hourly buckets and is configurable between 30
and 3650.

---

## Install

```bash
# from this directory
dsh bundle install .
```

or in the UI: **Settings → Bundles → Install**, and pick this directory. The
plugin needs the web platform; it is inert on headless profiles.

Because `immediately: true` is set, the tab appears on the first session with no
extra wiring.

## Verify after install

```bash
dsh bundle list | grep token-log
```

The bundle exposes three routes on the authenticated `/api` channel, which you
can hit from the Host console:

```
GET  /api/token-log/stats       today's hours, trailing 24h, last 30 days, per-workspace
GET  /api/token-log/settings    the rate table plus the example defaults
PUT  /api/token-log/settings    replace the rate table (400 on an invalid zone)
POST /api/token-log/ledger      clear every recorded bucket
```

The response includes `storage.durable` and `storage.error`. If durable storage
is not available in the profile, the ledger still works for the lifetime of the
process and the dashboard says so in the header instead of failing silently.

## Data location

`$DSH_HOME/storages/token_log/` — hourly bucket records plus one settings
record holding the rate table and the per-session high-water marks. Deleting the
directory resets the ledger to empty; the settings table ships with example
rates for the four models in this deployment and a suggested 2026 holiday list,
both of which you overwrite from the Pricing tab.

## Known limits

- **Holiday dates are a starting point.** The 2026 list is a reasonable
  suggestion for Chinese statutory breaks, not the official calendar. Edit it
  before you trust a holiday figure.
- **Workspace attribution is path-based.** A session's working directory is
  matched against the workspace registry by longest prefix, so a worktree inside
  a workspace counts toward that workspace. Sessions with no working directory
  are counted in the totals but appear in no bar.
- **Subagent usage is folded into the parent session's workspace**, because the
  log records no separate workspace for a subagent turn.

## Files

| File | Purpose |
| --- | --- |
| `index.js` | Host half: the ledger, pricing, retention, and the three routes. |
| `client.js` | Client half: the tab, the charts, and the pricing editor. |
| `cordis.patch.yml` | Inserts the `token-log` bundle entry. |
| `locale/en.json`, `locale/zh.json` | Bundle metadata for the picker. |
| `icon.svg` | A 64×64 line-chart mark. |
