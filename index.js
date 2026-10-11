/**
 * Token usage ledger + cost dashboard — Host half.
 *
 * Every model call lands its token accounting in the durable session log as an
 * `assistant/message` event whose `data.usage` reports disjoint counts:
 * uncached input, cache reads, cache writes, output. This plugin folds those
 * events into wall-clock hourly buckets, keeps them in durable KV storage, and
 * prices every bucket against the configured per-model price table.
 *
 * Counting happens on two feeds that funnel through one de-duplicated writer:
 *
 *   - `session/event`, the post-commit append feed, for usage that happens
 *     while the plugin is loaded; and
 *   - a throttled sweep over the session corpus, which catches usage from
 *     before the plugin was first enabled (so the dashboard is not empty on
 *     day one) and from any interval it was disabled.
 *
 * Each session records the highest event seq it has counted, so the two feeds
 * can never double-count the same call and a restart never restarts the count.
 *
 * Token counts are the only stored figures. Cost is recomputed from the counts
 * on every read, so editing a price re-prices the whole history immediately.
 * Cached input bills `cacheRead + cacheWrite` against a model's `cacheInput`
 * rate. An hour is priced at its own rate, so a tier boundary inside an hour is
 * not split.
 *
 * Routes (authenticated, on the shared `/api` channel):
 *
 *   GET  /api/token-log/stats      today's hourly buckets, trailing 24 hours,
 *                                  the last 30 days, and per-workspace totals
 *   GET  /api/token-log/settings   the pricing configuration plus the example
 *                                  defaults used on first run
 *   PUT  /api/token-log/settings   replace the pricing configuration
 *   POST /api/token-log/ledger     clear every recorded bucket
 */

const UNIT_NAME = 'token_log'
const BUCKETS_TABLE = 'buckets'
const SETTINGS_TABLE = 'settings'
const SETTINGS_KEY = 'current'
const UNIT_VERSION = 1
const STATS_PATH = '/api/token-log/stats'
const SETTINGS_PATH = '/api/token-log/settings'
const LEDGER_PATH = '/api/token-log/ledger'
const DEFAULT_RETENTION_DAYS = 400
const DEFAULT_DAILY_DAYS = 30
const MAX_LOADED_BUCKETS = 40000
const FLUSH_AFTER_MS = 1500
const SWEEP_AFTER_MS = 5 * 60 * 1000
const MAX_SWEEP_SESSIONS = 400
const CLEAR_CONCURRENCY = 16
const PRICE_UNIT = 1_000_000

/** The models configured in this deployment; example rates the user adjusts. */
const EXAMPLE_MODELS = {
  'sensenova-6.8-flash-lite': { label: '', input: 0.5, cacheInput: 0.05, output: 2 },
  'glm-5.2': { label: '', input: 0.8, cacheInput: 0.1, output: 2.5 },
  'glm-5.3-flash': { label: '', input: 0.6, cacheInput: 0.08, output: 2 },
  'deepseek-v4.1-flash': { label: '', input: 0.5, cacheInput: 0.05, output: 2 }
}

/**
 * Suggested Chinese statutory holidays for 2026. Official break dates are fixed
 * by the State Council notice for each year and move with the lunar calendar, so
 * the user must check this list against the notice and edit it — the ledger
 * applies whatever is listed as-is.
 */
const EXAMPLE_HOLIDAYS = [
  '2026-01-01',
  '2026-02-16', '2026-02-17', '2026-02-18', '2026-02-19', '2026-02-20', '2026-02-21', '2026-02-22',
  '2026-04-04', '2026-04-05', '2026-04-06',
  '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05',
  '2026-06-19',
  '2026-09-25',
  '2026-10-01', '2026-10-02', '2026-10-03', '2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07'
]

/* --------------------------------------------------------------- */
/* Time                                                            */
/* --------------------------------------------------------------- */

function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function number(value, fallback = 0) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function pad2(value) {
  return String(value).padStart(2, '0')
}

/** Read the runtime's own IANA time zone so the ledger matches the console. */
function runtimeTimeZone() {
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions().timeZone
    return typeof resolved === 'string' && resolved.length > 0 ? resolved : 'UTC'
  } catch {
    return 'UTC'
  }
}

function isValidTimeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone })
    return true
  } catch {
    return false
  }
}

/**
 * Wall-clock parts in one time zone. Offsets are derived from the parts
 * themselves rather than a DST table, so a shift stays exact for fixed-offset
 * zones and can drift by at most one hour across a DST edge — the same
 * approximation every wall-clock hourly aggregate makes.
 */
function makePartsOf(timeZone) {
  const formatter = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  })
  return (timestamp) => {
    const parts = { year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0 }
    for (const part of formatter.formatToParts(new Date(timestamp))) {
      if (part.type === 'year') parts.year = Number(part.value)
      else if (part.type === 'month') parts.month = Number(part.value)
      else if (part.type === 'day') parts.day = Number(part.value)
      else if (part.type === 'hour') parts.hour = Number(part.value)
      else if (part.type === 'minute') parts.minute = Number(part.value)
      else if (part.type === 'second') parts.second = Number(part.value)
    }
    return parts
  }
}

const partsOfCache = new Map()

/** One cached formatter per time zone: usage events all share the zone. */
function partsOfTimeZone(timeZone) {
  let entry = partsOfCache.get(timeZone)
  if (entry === undefined) {
    entry = makePartsOf(timeZone)
    partsOfCache.set(timeZone, entry)
  }
  return entry
}

function offsetMs(parts, timestamp) {
  return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second) - timestamp
}

/** Walk the wall clock backwards by `minutes`, keeping the clock continuous. */
function shiftBack(timestamp, minutes, partsOf) {
  const start = partsOf(timestamp)
  const wall = timestamp + offsetMs(start, timestamp) - minutes * 60000
  const first = wall - offsetMs(partsOf(wall), wall)
  return wall - offsetMs(partsOf(first), first)
}

function dateKeyOf(parts) {
  return `${parts.year}-${pad2(parts.month)}-${pad2(parts.day)}`
}

function hourKeyOf(parts) {
  return `${dateKeyOf(parts)}T${pad2(parts.hour)}`
}

function basename(path) {
  return String(path).replace(/\/+$/, '').split('/').filter(Boolean).pop() || String(path)
}

/* --------------------------------------------------------------- */
/* Pricing configuration                                           */
/* --------------------------------------------------------------- */

const DEFAULT_SETTINGS = (() => {
  const models = {}
  for (const [model, entry] of Object.entries(EXAMPLE_MODELS)) {
    models[model] = {
      label: entry.label,
      input: entry.input,
      cacheInput: entry.cacheInput,
      output: entry.output,
      tiers: [],
      holidayRates: null
    }
  }
  return {
    timezone: runtimeTimeZone(),
    currency: 'CNY',
    currencySymbol: '¥',
    retentionDays: DEFAULT_RETENTION_DAYS,
    models,
    holidays: [...EXAMPLE_HOLIDAYS]
  }
})()

/**
 * Validate and normalize one submitted pricing configuration. Returns
 * `{ errors }` for a bad document, or `{ value }` in the stored shape. Coercion
 * is lossless where possible, so a hand-edited blob still lands intact.
 */
function normalizeSettings(raw) {
  const errors = []
  const source = isRecord(raw) ? raw : {}

  const timezone = typeof source.timezone === 'string' && source.timezone.trim() !== ''
    ? source.timezone.trim()
    : DEFAULT_SETTINGS.timezone
  if (!isValidTimeZone(timezone)) errors.push(`timezone "${timezone}" is not a valid IANA time zone`)

  const currency = typeof source.currency === 'string' && source.currency.trim() !== ''
    ? source.currency.trim().slice(0, 16)
    : DEFAULT_SETTINGS.currency
  const currencySymbol = typeof source.currencySymbol === 'string' && source.currencySymbol.trim() !== ''
    ? source.currencySymbol.trim().slice(0, 8)
    : DEFAULT_SETTINGS.currencySymbol
  const retentionDays = Math.min(
    3650,
    Math.max(30, Math.round(number(source.retentionDays, DEFAULT_SETTINGS.retentionDays)))
  )

  const holidays = Array.isArray(source.holidays)
    ? source.holidays.filter((entry) => typeof entry === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry))
    : [...EXAMPLE_HOLIDAYS]

  const models = {}
  // An absent table means "no preference yet" and inherits the example rates;
  // a present-but-empty one is the user's own empty table and stays empty.
  const modelsSource = isRecord(source.models) ? source.models : DEFAULT_SETTINGS.models
  for (const [modelId, entry] of Object.entries(modelsSource)) {
    if (typeof modelId !== 'string' || modelId.trim() === '') continue
    const body = isRecord(entry) ? entry : {}

    const tiers = []
    for (const tier of Array.isArray(body.tiers) ? body.tiers : []) {
      if (!isRecord(tier)) continue
      const from = /^\d{2}:\d{2}$/.test(String(tier.from)) ? String(tier.from) : null
      const to = /^\d{2}:\d{2}$/.test(String(tier.to)) ? String(tier.to) : null
      if (from === null || to === null) continue
      const multiplier = number(tier.multiplier, 0)
      if (!(multiplier >= 0)) continue
      const label = typeof tier.label === 'string' ? tier.label.trim().slice(0, 48) : ''
      tiers.push({ from, to, multiplier, ...(label === '' ? {} : { label }) })
    }

    let holidayRates = null
    if (isRecord(body.holidayRates)) {
      holidayRates = {
        input: number(body.holidayRates.input, 0),
        cacheInput: number(body.holidayRates.cacheInput, 0),
        output: number(body.holidayRates.output, 0)
      }
    }

    models[modelId] = {
      label: typeof body.label === 'string' ? body.label.trim().slice(0, 64) : '',
      input: number(body.input, 0),
      cacheInput: number(body.cacheInput, 0),
      output: number(body.output, 0),
      tiers,
      holidayRates
    }
  }

  if (errors.length > 0) return { errors }
  return { value: { timezone, currency, currencySymbol, retentionDays, models, holidays } }
}

const holidayCaches = new WeakMap()

function holidaySetOf(settings) {
  let set = holidayCaches.get(settings)
  if (set === undefined) {
    set = new Set(settings.holidays)
    holidayCaches.set(settings, set)
  }
  return set
}

/**
 * The active rate set for one model at one instant: the holiday rates when the
 * date is a listed holiday and the model declares them, otherwise the base
 * rates, then the first matching time-of-day tier's multiplier applied to all
 * three. Returns null when the model has no entry, which prices it as unpriced
 * rather than as free.
 */
function rateFor(settings, modelId, parts) {
  const entry = settings.models[modelId]
  if (entry === undefined) return null
  const holiday = holidaySetOf(settings).has(dateKeyOf(parts))
  const base = holiday && entry.holidayRates ? entry.holidayRates : entry
  const minute = parts.hour * 60 + parts.minute
  let multiplier = 1
  for (const tier of entry.tiers) {
    const from = Number(tier.from.slice(0, 2)) * 60 + Number(tier.from.slice(3, 5))
    const to = Number(tier.to.slice(0, 2)) * 60 + Number(tier.to.slice(3, 5))
    if (to === from) continue
    const hit = to > from ? (minute >= from && minute < to) : (minute >= from || minute < to)
    if (hit) {
      multiplier = tier.multiplier
      break
    }
  }
  return {
    input: number(base.input) * multiplier,
    cacheInput: number(base.cacheInput) * multiplier,
    output: number(base.output) * multiplier,
    holiday,
    multiplier
  }
}

function countCost(counts, rate) {
  return (counts.input * rate.input
    + (counts.cacheRead + counts.cacheWrite) * rate.cacheInput
    + counts.output * rate.output) / PRICE_UNIT
}

/* --------------------------------------------------------------- */
/* Aggregation                                                     */
/* --------------------------------------------------------------- */

function zeroTokens() {
  return { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, total: 0, calls: 0 }
}

function addTokens(target, source) {
  if (!source) return target
  target.input += source.input || 0
  target.cacheRead += source.cacheRead || 0
  target.cacheWrite += source.cacheWrite || 0
  target.output += source.output || 0
  target.calls += source.calls || 0
  target.total = target.input + target.cacheRead + target.cacheWrite + target.output
  return target
}

/** Fold one bucket table into the dashboard payload. */
function buildSnapshot(buckets, settings, storage) {
  const partsOf = partsOfTimeZone(settings.timezone)
  const holidays = holidaySetOf(settings)
  const now = Date.now()
  const nowParts = partsOf(now)
  const todayDate = dateKeyOf(nowParts)

  const totals = zeroTokens()
  let totalCost = 0
  let unpricedTokens = 0
  const unpricedModels = new Set()
  const modelAgg = new Map()
  const workspaceAgg = new Map()
  const hourly = new Map()

  for (const bucket of buckets.values()) {
    const parts = partsOf(bucket.time)
    const dateKey = dateKeyOf(parts)
    const holiday = holidays.has(dateKey)
    const tokens = zeroTokens()
    let bucketCost = 0

    for (const [modelId, counts] of Object.entries(bucket.models ?? {})) {
      addTokens(tokens, counts)
      const model = modelAgg.get(modelId) ?? { model: modelId, ...zeroTokens(), cost: 0 }
      addTokens(model, counts)
      const rate = rateFor(settings, modelId, parts)
      if (rate === null) {
        unpricedTokens += counts.input + counts.cacheRead + counts.cacheWrite + counts.output
        unpricedModels.add(modelId)
      } else {
        const cost = countCost(counts, rate)
        bucketCost += cost
        totalCost += cost
        model.cost += cost
      }
      modelAgg.set(modelId, model)
    }

    for (const workspace of Object.values(bucket.workspaces ?? {})) {
      const identity = workspaceAgg.get(workspace.path) ?? {
        path: workspace.path,
        title: workspace.title,
        ...zeroTokens(),
        cost: 0,
        unpriced: 0
      }
      if (workspace.title) identity.title = workspace.title
      for (const [modelId, counts] of Object.entries(workspace.models ?? {})) {
        addTokens(identity, counts)
        const rate = rateFor(settings, modelId, parts)
        if (rate === null) {
          identity.unpriced += counts.input + counts.cacheRead + counts.cacheWrite + counts.output
          continue
        }
        identity.cost += countCost(counts, rate)
      }
      workspaceAgg.set(workspace.path, identity)
    }

    hourly.set(bucket.key, {
      label: pad2(parts.hour),
      tokens,
      cost: bucketCost,
      holiday
    })
    addTokens(totals, tokens)
  }

  const todayTokens = zeroTokens()
  let todayCost = 0
  const todayHours = []
  for (let hour = 0; hour < 24; hour += 1) {
    const key = `${todayDate}T${pad2(hour)}`
    const hit = hourly.get(key)
    if (hit !== undefined) {
      addTokens(todayTokens, hit.tokens)
      todayCost += hit.cost
    }
    todayHours.push({
      hour,
      key,
      label: pad2(hour),
      tokens: hit === undefined ? zeroTokens() : hit.tokens,
      cost: hit === undefined ? 0 : hit.cost,
      active: hit !== undefined
    })
  }

  const last24 = []
  for (let index = 23; index >= 0; index -= 1) {
    const parts = partsOf(shiftBack(now, index * 60, partsOf))
    const key = hourKeyOf(parts)
    const hit = hourly.get(key)
    last24.push({
      key,
      label: pad2(parts.hour),
      tokens: hit === undefined ? zeroTokens() : hit.tokens,
      cost: hit === undefined ? 0 : hit.cost,
      active: hit !== undefined,
      holiday: hit === undefined ? holidays.has(dateKeyOf(parts)) : hit.holiday
    })
  }

  const daily = []
  for (let index = DEFAULT_DAILY_DAYS - 1; index >= 0; index -= 1) {
    const key = dateKeyOf(partsOf(shiftBack(now, index * 24 * 60, partsOf)))
    const tokens = zeroTokens()
    let cost = 0
    let active = false
    let holiday = false
    for (const [bucketKey, hit] of hourly) {
      if (!bucketKey.startsWith(`${key}T`)) continue
      active = true
      addTokens(tokens, hit.tokens)
      cost += hit.cost
      holiday = holiday || hit.holiday
    }
    daily.push({
      key,
      label: `${Number(key.slice(5, 7))}/${Number(key.slice(8, 10))}`,
      tokens,
      cost,
      active,
      holiday
    })
  }

  return {
    ok: true,
    generatedAt: now,
    timezone: settings.timezone,
    currency: settings.currency,
    currencySymbol: settings.currencySymbol,
    retentionDays: settings.retentionDays,
    storage,
    totals: {
      ...totals,
      cost: totalCost,
      unpricedTokens,
      unpricedModels: [...unpricedModels].sort()
    },
    today: { date: todayDate, tokens: todayTokens, cost: todayCost, hours: todayHours },
    last24,
    daily,
    workspaces: [...workspaceAgg.values()]
      .sort((a, b) => b.total - a.total || a.path.localeCompare(b.path)),
    models: [...modelAgg.values()]
      .map((model) => ({
        model: model.model,
        label: settings.models[model.model]?.label ?? '',
        tokens: {
          input: model.input,
          cacheRead: model.cacheRead,
          cacheWrite: model.cacheWrite,
          output: model.output,
          total: model.total,
          calls: model.calls
        },
        cost: model.cost,
        calls: model.calls,
        priced: !unpricedModels.has(model.model)
      }))
      .sort((a, b) => b.tokens.total - a.tokens.total || a.model.localeCompare(b.model))
  }
}

/* --------------------------------------------------------------- */
/* Ledger                                                          */
/* --------------------------------------------------------------- */

/**
 * One durable ledger: hourly buckets keyed by wall-clock hour, plus the pricing
 * configuration and the per-session high-water marks that keep the live feed
 * and the corpus sweep from counting the same call twice.
 */
function createLedger(ctx) {
  const buckets = new Map()
  const seen = new Map()
  let settings = structuredClone(DEFAULT_SETTINGS)
  let dirtyKeys = new Set()
  let dirtyMeta = false
  let chain = Promise.resolve()
  let unit = null
  let storageError = null
  let lastSweep = 0
  let sweepRunning = false
  let flushTimer = null

  function serialize(work) {
    const run = chain.then(work, work)
    chain = run.then(() => {}, () => {})
    return run
  }

  async function load() {
    const backend = ctx.get('storage')?.backend?.get
    if (typeof backend !== 'function') {
      storageError = 'no storage service is registered; the ledger is memory-only'
      ctx.logger?.warn?.('token-log: ' + storageError)
      return
    }
    try {
      const handle = backend.call(ctx.get('storage').backend, 'json')
      if (typeof handle?.kv?.open !== 'function') throw new Error('no JSON storage backend is registered')
      unit = await handle.kv.open({
        name: UNIT_NAME,
        version: UNIT_VERSION,
        tables: [BUCKETS_TABLE, SETTINGS_TABLE],
        hasGlobal: false,
        layout: 'per-record'
      })
    } catch (error) {
      unit = null
      storageError = String(error?.message ?? error)
      ctx.logger?.warn?.('token-log: durable storage is unavailable, the ledger is memory-only: ' + storageError)
      return
    }

    try {
      const snapshot = await unit.loadAll()
      const doc = snapshot?.tables?.[SETTINGS_TABLE]?.[SETTINGS_KEY]
      const parsed = normalizeSettings(isRecord(doc?.settings) ? doc.settings : doc ?? {})
      if (parsed.value !== undefined) {
        settings = parsed.value
      } else if (doc !== undefined && doc !== null) {
        storageError = `stored settings were unreadable (${parsed.errors.join('; ')}); defaults are in force`
        ctx.logger?.warn?.('token-log: ' + storageError)
      }
      const marks = isRecord(doc?.backfill?.sessions) ? doc.backfill.sessions : {}
      for (const [sessionId, seq] of Object.entries(marks)) {
        const value = number(seq, 0)
        if (value > 0) seen.set(sessionId, value)
      }

      const stored = snapshot?.tables?.[BUCKETS_TABLE] ?? {}
      let loaded = 0
      for (const [key, record] of Object.entries(stored)) {
        if (loaded >= MAX_LOADED_BUCKETS) break
        if (!isRecord(record)) continue
        buckets.set(key, normalizeBucket(key, record))
        loaded += 1
      }
      prune(settings)
    } catch (error) {
      storageError = String(error?.message ?? error)
      ctx.logger?.warn?.('token-log: the stored ledger could not be read: ' + storageError)
      try { await unit?.close() } catch { /* already closed */ }
      unit = null
    }
  }

  function normalizeBucket(key, record) {
    const models = {}
    for (const [modelId, counts] of Object.entries(isRecord(record.models) ? record.models : {})) {
      if (!isRecord(counts)) continue
      models[modelId] = {
        input: Math.max(0, Math.round(number(counts.input))),
        cacheRead: Math.max(0, Math.round(number(counts.cacheRead))),
        cacheWrite: Math.max(0, Math.round(number(counts.cacheWrite))),
        output: Math.max(0, Math.round(number(counts.output))),
        calls: Math.max(0, Math.round(number(counts.calls)))
      }
    }
    const workspaces = {}
    for (const [path, workspace] of Object.entries(isRecord(record.workspaces) ? record.workspaces : {})) {
      if (!isRecord(workspace)) continue
      workspaces[path] = {
        path: typeof workspace.path === 'string' ? workspace.path : path,
        title: typeof workspace.title === 'string' ? workspace.title : basename(path),
        models: isRecord(workspace.models)
          ? Object.fromEntries(Object.entries(workspace.models).map(([modelId, counts]) => [
              modelId,
              normalizeCounts(counts)
            ]))
          : {}
      }
    }
    return { key, time: number(record.time, 0), models, workspaces }
  }

  function normalizeCounts(counts) {
    if (!isRecord(counts)) return null
    return {
      input: Math.max(0, Math.round(number(counts.input))),
      cacheRead: Math.max(0, Math.round(number(counts.cacheRead))),
      cacheWrite: Math.max(0, Math.round(number(counts.cacheWrite))),
      output: Math.max(0, Math.round(number(counts.output))),
      calls: Math.max(0, Math.round(number(counts.calls)))
    }
  }

  /** Drop buckets outside the retention window. */
  function prune(activeSettings) {
    if (buckets.size === 0) return
    const partsOf = partsOfTimeZone(activeSettings.timezone)
    const limit = shiftBack(Date.now(), activeSettings.retentionDays * 24 * 60, partsOf)
    for (const bucket of [...buckets.values()]) {
      if (bucket.time < limit) buckets.delete(bucket.key)
    }
  }

  /** Resolve one working directory to a workspace identity. */
  function workspaceOf(cwd) {
    if (typeof cwd !== 'string' || cwd.length === 0) return null
    const path = cwd.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/'
    let title = null
    let best = null
    try {
      for (const workspace of ctx.get('workspaceRegistry')?.list?.() ?? []) {
        const workspacePath = String(workspace?.path ?? '').replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/'
        if (workspacePath === '') continue
        if (workspacePath === path) {
          title = String(workspace.title ?? workspacePath)
          best = workspacePath
          break
        }
        if (path.startsWith(`${workspacePath}/`) && (best === null || workspacePath.length > best.length)) {
          best = workspacePath
          title = String(workspace.title ?? workspacePath)
        }
      }
    } catch { /* registry unavailable */ }
    return { path, title: title ?? basename(path) }
  }

  /**
   * The one counting funnel. `sessionId` and `seq` de-duplicate the live feed
   * against the corpus sweep; `cwd` attributes the call to a workspace.
   */
  function recordUsage(sessionId, cwd, event) {
    if (typeof sessionId !== 'string' || sessionId === '' || !isRecord(event)) return
    if (event.type !== 'assistant/message') return
    const usage = isRecord(event.data?.usage) ? event.data.usage : null
    if (usage === null) return
    const seq = number(event.seq, 0)
    const last = seen.get(sessionId)
    if (last !== undefined && seq <= last) return

    const counts = {
      input: Math.max(0, Math.round(number(usage.inputTokens))),
      cacheRead: Math.max(0, Math.round(number(usage.cacheReadTokens))),
      cacheWrite: Math.max(0, Math.round(number(usage.cacheWriteTokens))),
      output: Math.max(0, Math.round(number(usage.outputTokens))),
      calls: 1
    }
    if (counts.input + counts.cacheRead + counts.cacheWrite + counts.output + counts.calls === 0) return

    const timestamp = number(event.time, Date.now())
    const parts = partsOfTimeZone(settings.timezone)(timestamp)
    // Retention is measured from now, so ancient history is dropped at the
    // door instead of being kept and pruned later.
    const cutoff = shiftBack(Date.now(), settings.retentionDays * 24 * 60, partsOfTimeZone(settings.timezone))
    if (timestamp < cutoff) return
    const key = hourKeyOf(parts)
    const modelId = String(event.data.message?.source?.model ?? 'unknown')
    const workspace = workspaceOf(cwd)

    let bucket = buckets.get(key)
    if (bucket === undefined) {
      bucket = { key, time: timestamp, models: {}, workspaces: {} }
      buckets.set(key, bucket)
    }
    const model = bucket.models[modelId] ?? { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0 }
    addTokens(model, counts)
    bucket.models[modelId] = model

    if (workspace !== null) {
      const entry = bucket.workspaces[workspace.path] ?? {
        path: workspace.path,
        title: workspace.title,
        models: {}
      }
      const nested = entry.models[modelId] ?? { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, calls: 0 }
      addTokens(nested, counts)
      entry.models[modelId] = nested
      entry.title = workspace.title
      bucket.workspaces[workspace.path] = entry
    }

    if (last === undefined || seq > last) seen.set(sessionId, seq)
    dirtyKeys.add(key)
    dirtyMeta = true
    scheduleFlush()
  }

  function scheduleFlush() {
    if (flushTimer !== null) return
    flushTimer = setTimeout(() => {
      flushTimer = null
      void flush().catch((error) => ctx.logger?.warn?.('token-log: flush failed: ' + String(error?.message ?? error)))
    }, FLUSH_AFTER_MS)
    if (typeof flushTimer.unref === 'function') flushTimer.unref()
  }

  function metaDocument() {
    return {
      settings,
      backfill: { sessions: Object.fromEntries(seen) }
    }
  }

  /**
   * Write pending buckets and the meta record. The caller must already hold
   * the chain: this is reentrant and may be called from inside a serialized
   * operation, which flush() itself must never do.
   */
  async function writeDirty() {
    if (unit === null) return
    const changed = [...dirtyKeys]
    dirtyKeys = new Set()
    for (const key of changed) {
      const bucket = buckets.get(key)
      if (bucket !== undefined) await unit.putRecord(BUCKETS_TABLE, key, bucket)
    }
    if (dirtyMeta) {
      dirtyMeta = false
      await unit.putRecord(SETTINGS_TABLE, SETTINGS_KEY, metaDocument())
    }
  }

  async function flush() {
    if (unit === null) return
    if (dirtyKeys.size === 0 && !dirtyMeta) return
    return serialize(writeDirty)
  }

  /**
   * Count what the live feed could not see: usage recorded before the plugin
   * was first enabled, or while it was disabled. Each session's high-water mark
   * makes the sweep idempotent against the live feed and against itself.
   */
  async function sweep() {
    if (sweepRunning) return
    const sessionQuery = ctx.get('sessionQuery')
    const listSessions = sessionQuery?.filterSessions
    if (typeof listSessions !== 'function' || typeof sessionQuery.readSession !== 'function') {
      lastSweep = Date.now()
      return
    }
    sweepRunning = true
    try {
      const records = await listSessions.call(sessionQuery, [])
      let reads = 0
      for (const record of records) {
        if (reads >= MAX_SWEEP_SESSIONS) break
        const sessionId = String(record?.header?.id ?? '')
        if (sessionId === '') continue
        try {
          const snapshot = await sessionQuery.readSession(sessionId)
          reads += 1
          const cwd = snapshot.session?.cwd ?? record?.header?.cwd
          for (const event of snapshot.events ?? []) {
            if (event?.type !== 'assistant/message') continue
            recordUsage(sessionId, cwd, event)
          }
        } catch (error) {
          ctx.logger?.warn?.(`token-log: session "${sessionId}" could not be swept: ${String(error?.message ?? error)}`)
        }
      }
      prune(settings)
      await flush()
    } catch (error) {
      ctx.logger?.warn?.('token-log: sweep failed: ' + String(error?.message ?? error))
    } finally {
      sweepRunning = false
      lastSweep = Date.now()
    }
  }

  return {
    load,
    flush,
    storageError: () => storageError,
    hasStorage: () => unit !== null,
    recordUsage,
    sweep,
    dueSweep: () => Date.now() - lastSweep > SWEEP_AFTER_MS && !sweepRunning,
    clear: () => serialize(async () => {
      const keys = [...buckets.keys()]
      buckets.clear()
      dirtyKeys = new Set()
      dirtyMeta = true
      if (unit === null) return
      for (let index = 0; index < keys.length; index += CLEAR_CONCURRENCY) {
        const batch = keys.slice(index, index + CLEAR_CONCURRENCY)
        await Promise.all(batch.map((key) => unit.deleteRecord(BUCKETS_TABLE, key).catch(() => {})))
      }
      await writeDirty()
    }),
    getSettings: () => structuredClone(settings),
    getDefaults: () => structuredClone(DEFAULT_SETTINGS),
    saveSettings: (candidate) => serialize(async () => {
      const parsed = normalizeSettings(candidate)
      if (parsed.value === undefined) {
        const error = new Error(parsed.errors.join('; '))
        error.code = 'invalid-settings'
        error.errors = parsed.errors
        throw error
      }
      settings = parsed.value
      prune(settings)
      // Only the meta record changes: bucket keys and counts stay put, and
      // cost is recomputed from the counts on every read.
      dirtyMeta = true
      await writeDirty()
      return structuredClone(settings)
    }),
    snapshot: () => {
      const ordered = [...buckets.keys()].sort()
      return buildSnapshot(
        buckets,
        structuredClone(settings),
        {
          durable: unit !== null,
          error: storageError,
          buckets: buckets.size,
          first: ordered[0] ?? null,
          last: ordered.at(-1) ?? null
        }
      )
    },
    close: () => {
      if (flushTimer !== null) {
        clearTimeout(flushTimer)
        flushTimer = null
      }
      const work = chain.then(() => flush(), () => flush())
      return work
        .catch((error) => { ctx.logger?.warn?.('token-log: final flush failed: ' + String(error?.message ?? error)) })
        .then(() => unit?.close())
        .catch((error) => { ctx.logger?.warn?.('token-log: unit close failed: ' + String(error?.message ?? error)) })
        .then(() => undefined)
    }
  }
}

/* --------------------------------------------------------------- */
/* Routes                                                          */
/* --------------------------------------------------------------- */

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
  })
}

export const inject = ['connection']

export function apply(ctx) {
  const ledger = createLedger(ctx)

  ctx.effect(async () => {
    await ledger.load()
  }, 'token-log: load ledger')

  // Usage arrives on the post-commit append feed; counting is synchronous and
  // the durable write is scheduled behind it, so no step latency is added.
  ctx.on('session/event', (session, event) => {
    if (event?.type !== 'assistant/message') return
    try {
      let cwd = null
      try {
        cwd = ctx.get('workingDirectory')?.get?.(session)
      } catch { /* session not bound to a directory */ }
      if (typeof cwd !== 'string' || cwd.length === 0) cwd = session?.header?.cwd
      ledger.recordUsage(String(session?.id ?? ''), cwd, event)
    } catch (error) {
      ctx.logger?.warn?.('token-log: usage recording failed: ' + String(error?.message ?? error))
    }
  })

  ctx.effect(async () => {
    const disposeStats = await ctx.connection.fetch.register({
      path: STATS_PATH,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async () => {
        try {
          await ledger.flush()
          // Await the sweep rather than firing it in the background: the first
          // read after a cold start is otherwise an empty dashboard that only
          // fills on the next poll, and the sweep is capped to one corpus pass.
          if (ledger.dueSweep()) await ledger.sweep()
          return json(ledger.snapshot())
        } catch (error) {
          ctx.logger?.warn?.('token-log: stats failed: ' + String(error?.message ?? error))
          return json({ ok: false, error: String(error?.message ?? error) }, 500)
        }
      }
    })
    const disposeSettings = await ctx.connection.fetch.register({
      path: SETTINGS_PATH,
      methods: ['GET', 'PUT'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          if (request.method === 'GET') {
            return json({ ok: true, settings: ledger.getSettings(), defaults: ledger.getDefaults() })
          }
          const body = await request.json().catch(() => ({}))
          const saved = await ledger.saveSettings(body)
          return json({ ok: true, settings: saved })
        } catch (error) {
          const status = error?.code === 'invalid-settings' ? 400 : 500
          return json({ ok: false, error: String(error?.message ?? error), errors: error?.errors }, status)
        }
      }
    })
    const disposeLedger = await ctx.connection.fetch.register({
      path: LEDGER_PATH,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async () => {
        try {
          await ledger.clear()
          await ledger.flush()
          return json({ ok: true })
        } catch (error) {
          ctx.logger?.warn?.('token-log: clear failed: ' + String(error?.message ?? error))
          return json({ ok: false, error: String(error?.message ?? error) }, 500)
        }
      }
    })
    return async () => {
      for (const dispose of [disposeStats, disposeSettings, disposeLedger]) {
        try { await dispose() } catch { /* already removed */ }
      }
      await ledger.close()
    }
  }, 'token-log: API routes')
}
