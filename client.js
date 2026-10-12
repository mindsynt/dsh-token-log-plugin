/**
 * Token usage ledger + cost dashboard — Client half.
 *
 * One conversation view tab: an overview with summary tiles, an hourly and a
 * daily line chart, and a per-workspace bar chart, all switchable between token
 * counts and money; plus a pricing editor that sets per-model rates per million
 * tokens, time-of-day tiers, and separate holiday prices.
 *
 * The view fetches only while its tab is active, which the conversation shell
 * already enforces by rendering the body on demand.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-token-log',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const useState = React.useState;
    const useEffect = React.useEffect;
    const useLayoutEffect = React.useLayoutEffect;
    const useRef = React.useRef;

    const NS = 'tokenLog';
    const STATS_PATH = '/api/token-log/stats';
    const SETTINGS_PATH = '/api/token-log/settings';
    const LEDGER_PATH = '/api/token-log/ledger';
    const POLL_MS = 15000;
    const ICON = 'data:image/svg+xml;utf8,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">'
      + '<rect x="2" y="2" width="60" height="60" rx="15" fill="#0d6b66"/>'
      + '<polyline points="12,45 25,33 35,39 52,17" fill="none" stroke="#eafff8" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>'
      + '<circle cx="12" cy="45" r="4.5" fill="#ffd166"/><circle cx="25" cy="33" r="4.5" fill="#ffd166"/>'
      + '<circle cx="35" cy="39" r="4.5" fill="#ffd166"/><circle cx="52" cy="17" r="4.5" fill="#ffd166"/></svg>'
    );

    const EN = {
      tab: 'Token usage',
      title: 'Token usage',
      subtitle: 'Hourly, daily, and per-workspace accounting with configurable model pricing.',
      overview: 'Overview',
      prices: 'Pricing',
      metricTokens: 'Tokens',
      metricCost: 'Cost',
      today: 'Today',
      last24: 'Last 24 h',
      last30: 'Last 30 days',
      all: 'All time',
      calls: 'calls',
      unpriced: 'unpriced',
      holiday: 'holiday',
      hourlyTitle: 'Today, hour by hour',
      hourlyHint: 'Live consumption per hour for today.',
      dailyTitle: 'Daily, last 30 days',
      workspaceTitle: 'By workspace project',
      workspaceHint: 'Total consumption of every workspace project.',
      modelsTitle: 'By model',
      input: 'input',
      cacheRead: 'cache read',
      cacheWrite: 'cache write',
      output: 'output',
      total: 'total',
      noData: 'No usage recorded yet.',
      notDurable: 'Not saved to disk: {reason}',
      loading: 'Loading…',
      error: 'Could not load usage data.',
      retry: 'Retry',
      updated: 'Updated {time}',
      save: 'Save prices',
      saved: 'Saved.',
      saving: 'Saving…',
      addModel: 'Add model',
      removeModel: 'Remove',
      perMillion: 'per 1M tokens',
      cacheInput: 'cached input',
      label: 'Label',
      model: 'Model',
      tiers: 'Time-of-day tiers',
      tiersHint: 'Each hour in a range is billed at base rate × multiplier, where the base is the holiday price on a listed holiday. The first matching tier wins; a range may cross midnight.',
      addTier: 'Add tier',
      from: 'From',
      to: 'To',
      multiplier: 'Multiplier',
      holidayPrices: 'Separate holiday prices',
      holidays: 'Holidays',
      holidaysHint: 'ISO dates, comma separated. A model with separate holiday prices uses them as its base on these dates, so its time-of-day tiers still compose on top; other models keep their normal rates.',
      timezone: 'Time zone',
      currency: 'Currency',
      symbol: 'Symbol',
      retention: 'Retention days',
      retentionHint: 'Hourly buckets older than this are dropped.',
      clearLedger: 'Clear all usage records',
      confirmClear: 'Really clear? Cannot be undone',
      clearing: 'Clearing…',
      cleared: 'Ledger cleared.',
      reset: 'Use example defaults',
      unpricedNote: 'Unpriced models: {models}',
      noWorkspaces: 'No workspace attribution yet.',
      noModels: 'No models recorded yet.',
      pricesHint: 'Rates are per million tokens. Editing them re-prices the whole history.',
      modelId: 'Model id',
      addModelNote: 'Type a model id and press Enter.',
      failed: 'Failed',
      clearFailed: 'Clearing failed.'
    };

    const ZH = {
      tab: 'Token 用量',
      title: 'Token 用量看板',
      subtitle: '按小时、按天、按工作区项目统计 token 与金额，支持自定义模型计价。',
      overview: '概览',
      prices: '计价',
      metricTokens: 'Token',
      metricCost: '金额',
      today: '今天',
      last24: '近 24 小时',
      last30: '近 30 天',
      all: '全部',
      calls: '次调用',
      unpriced: '未定价',
      holiday: '节假日',
      hourlyTitle: '今日逐小时',
      hourlyHint: '今天每个小时的实时消耗。',
      dailyTitle: '每日消耗（近 30 天）',
      workspaceTitle: '各工作区项目',
      workspaceHint: '每个工作区项目的消耗总量。',
      modelsTitle: '各模型',
      input: '输入',
      cacheRead: '缓存读',
      cacheWrite: '缓存写',
      output: '输出',
      total: '合计',
      noData: '还没有记录到用量。',
      notDurable: '未写入磁盘：{reason}',
      loading: '加载中…',
      error: '用量数据加载失败。',
      retry: '重试',
      updated: '更新于 {time}',
      save: '保存价格',
      saved: '已保存。',
      saving: '保存中…',
      addModel: '添加模型',
      removeModel: '删除',
      perMillion: '每百万 token',
      cacheInput: '缓存输入',
      label: '名称',
      model: '模型',
      tiers: '时间段加价',
      tiersHint: '落在区间内的小时按“基准价 × 倍数”计费，节假日的基准价为节假日价格；命中多个区间时取第一个，区间可跨零点。',
      addTier: '添加时间段',
      from: '起',
      to: '止',
      multiplier: '倍数',
      holidayPrices: '节假日单独计价',
      holidays: '节假日日期',
      holidaysHint: 'ISO 日期，逗号分隔。设置了节假日价格的模型在这些日期以节假日价格作为基准，时间段倍数仍会叠加；其余模型按正常价格计费。',
      timezone: '时区',
      currency: '币种',
      symbol: '符号',
      retention: '保留天数',
      retentionHint: '早于该天数的分桶会被清理。',
      clearLedger: '清空全部用量记录',
      confirmClear: '确定清空？不可恢复',
      clearing: '清空中…',
      cleared: '已清空。',
      reset: '使用示例默认值',
      unpricedNote: '未定价模型：{models}',
      noWorkspaces: '还没有项目归属数据。',
      noModels: '还没有模型数据。',
      pricesHint: '价格单位为每百万 token。修改后历史记录会按新价格重新计算。',
      modelId: '模型 id',
      addModelNote: '输入模型 id 后回车。',
      failed: '失败',
      clearFailed: '清空失败。'
    };

    /* ---------------------------------------------------------- */
    /* Formatting                                                  */
    /* ---------------------------------------------------------- */

    function formatTokens(value) {
      const n = Number(value) || 0;
      if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
      if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
      if (n >= 1e4) return (n / 1e3).toFixed(1) + 'k';
      return Math.round(n).toLocaleString();
    }

    function formatCost(value, symbol) {
      const n = Number(value) || 0;
      const digits = n >= 100 ? 1 : n >= 1 ? 2 : 4;
      return (symbol || '') + n.toFixed(digits);
    }

    function formatClock(timestamp) {
      const date = new Date(Number(timestamp) || Date.now());
      return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }

    function truncate(text, max) {
      const s = String(text ?? '');
      return s.length > max ? s.slice(0, Math.max(1, max - 1)) + '…' : s;
    }

    /** Round a maximum up to a readable axis top. */
    function niceCeiling(value) {
      const n = Number(value) || 0;
      if (n <= 0) return 1;
      const pow = Math.pow(10, Math.floor(Math.log10(n)));
      const unit = n / pow;
      const factor = unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 2.5 ? 2.5 : unit <= 5 ? 5 : 10;
      return factor * pow;
    }

    /** Measure one element's content width so charts fill their card. */
    function useMeasure() {
      const ref = useRef(null);
      const [width, setWidth] = useState(0);
      useLayoutEffect(() => {
        const node = ref.current;
        if (!node) return undefined;
        const update = () => setWidth(node.clientWidth);
        update();
        const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(update) : null;
        if (observer) observer.observe(node);
        return () => {
          if (observer) observer.disconnect();
        };
      }, []);
      return [ref, width];
    }

    /* ---------------------------------------------------------- */
    /* Style                                                       */
    /* ---------------------------------------------------------- */

    const CSS = [
      '.dslt{--dslt-accent:var(--dsw-alias-state-business-primary, #2f7d6d);--dslt-warn:var(--dsw-alias-state-warn-primary, #b98200);box-sizing:border-box;width:100%;max-width:calc(var(--dsh-chat-content-width, 920px) + 2 * var(--dsh-composer-side-clearance, 16px));margin:0 auto;padding:8px 24px 32px;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family, inherit);font-size:14px;line-height:1.5;}',
      '.dslt *{box-sizing:border-box}',
      '.dslt-head{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap;margin:0 0 14px}',
      '.dslt-icon{flex:none;width:26px;height:26px;border-radius:var(--dsw-radius-sm, 6px)}',
      '.dslt-title{margin:0;font-size:16px;font-weight:600;line-height:20px}',
      '.dslt-sub{margin:2px 0 0;font-size:12px;color:var(--dsw-alias-label-tertiary)}',
      '.dslt-actions{display:flex;align-items:center;gap:6px;margin-left:auto;flex-wrap:wrap}',
      '.dslt-updated{font-size:11px;color:var(--dsw-alias-label-tertiary);font-variant-numeric:tabular-nums}',
      '.dslt-note{margin:8px 0 0;font-size:11px;color:var(--dsw-alias-state-warn-primary, var(--dsw-alias-label-tertiary))}',
      '.dslt-error{margin:8px 0 0;font-size:12px;color:var(--dsw-alias-state-error-primary)}',
      '.dslt-empty{padding:22px 0;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:13px}',
      '.dslt-seg{display:inline-flex;gap:2px;padding:2px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md, 8px);background:var(--dsw-alias-bg-base)}',
      '.dslt-seg button{padding:4px 10px;border:none;border-radius:calc(var(--dsw-radius-md, 8px) - 3px);background:transparent;color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}',
      '.dslt-seg button[aria-pressed="true"]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-weight:600}',
      '.dslt-seg button:hover{color:var(--dsw-alias-label-primary)}',
      '.dslt-btn{padding:5px 11px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md, 8px);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-secondary);font:inherit;font-size:12px;cursor:pointer}',
      '.dslt-btn:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dslt-btn[disabled]{opacity:.55;cursor:default}',
      '.dslt-btn--danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-state-error-primary)}',
      '.dslt-btn--primary{background:var(--dsw-alias-button-primary-fill, var(--dsw-alias-state-business-primary));border-color:transparent;color:var(--dsw-alias-label-primary-foreground, #fff);font-weight:600}',
      '.dslt-tiles{display:grid;grid-template-columns:repeat(auto-fit, minmax(150px, 1fr));gap:10px;margin:0 0 14px}',
      '.dslt-tile{padding:12px 14px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg, 10px);background:var(--dsw-alias-bg-layer-1)}',
      '.dslt-tile-h{margin:0 0 4px;font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--dsw-alias-label-tertiary)}',
      '.dslt-tile-v{margin:0;font-size:20px;font-weight:600;font-variant-numeric:tabular-nums;letter-spacing:-.01em}',
      '.dslt-tile-s{margin:2px 0 0;font-size:12px;color:var(--dsw-alias-label-secondary);font-variant-numeric:tabular-nums}',
      '.dslt-card{margin:0 0 14px;padding:14px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-lg, 10px);background:var(--dsw-alias-bg-layer-1)}',
      '.dslt-card-h{display:flex;align-items:baseline;gap:10px;flex-wrap:wrap;margin:0 0 2px}',
      '.dslt-card-t{margin:0;font-size:13px;font-weight:600}',
      '.dslt-card-s{margin:0;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.dslt-chart{position:relative;width:100%;margin-top:8px}',
      '.dslt-chart svg{display:block;width:100%;overflow:visible}',
      '.dslt-grid{stroke:var(--dsw-alias-border-l1);stroke-width:1}',
      '.dslt-axis{fill:var(--dsw-alias-label-tertiary);font-size:10px;font-variant-numeric:tabular-nums}',
      '.dslt-readout{fill:var(--dsw-alias-label-secondary);font-size:11px;font-variant-numeric:tabular-nums}',
      '.dslt-line{fill:none;stroke:var(--dslt-accent);stroke-width:2;stroke-linejoin:round;stroke-linecap:round}',
      '.dslt-area{fill:var(--dsw-alias-state-business-primary, #2f7d6d);opacity:.13}',
      '.dslt-dot{fill:var(--dslt-accent)}',
      '.dslt-holiday{fill:var(--dslt-warn);opacity:.14}',
      '.dslt-guide{stroke:var(--dsw-alias-label-tertiary);stroke-width:1;stroke-dasharray:3 3}',
      '.dslt-bar{fill:var(--dslt-accent);opacity:.85}',
      '.dslt-bar--hover{opacity:1}',
      '.dslt-legend{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:10px 0 0;font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.dslt-legend i{display:inline-block;width:8px;height:8px;border-radius:2px;margin-right:5px;vertical-align:middle}',
      '.dslt-legend i.a{background:var(--dslt-accent)}',
      '.dslt-legend i.b{background:var(--dslt-warn)}',
      '.dslt-table{width:100%;border-collapse:collapse;font-size:12px}',
      '.dslt-table th{text-align:right;padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l2);font-weight:600;color:var(--dsw-alias-label-tertiary);font-size:11px;white-space:nowrap}',
      '.dslt-table th:first-child,.dslt-table td:first-child{text-align:left}',
      '.dslt-table td{padding:6px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.dslt-table tr:last-child td{border-bottom:none}',
      '.dslt-mono{font-family:var(--dsw-font-mono, ui-monospace, monospace)}',
      '.dslt-dim{color:var(--dsw-alias-label-tertiary)}',
      '.dslt-form{display:grid;gap:12px}',
      '.dslt-grid2{display:grid;grid-template-columns:repeat(auto-fit, minmax(180px, 1fr));gap:10px}',
      '.dslt-field{display:grid;gap:3px}',
      '.dslt-field label{font-size:11px;color:var(--dsw-alias-label-tertiary)}',
      '.dslt-input,.dslt-area-input{width:100%;padding:5px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm, 6px);background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary);font:inherit;font-size:12px}',
      '.dslt-input:focus,.dslt-area-input:focus{outline:2px solid var(--dsw-alias-state-business-primary, #2f7d6d);outline-offset:0}',
      '.dslt-rows{display:grid;gap:10px}',
      '.dslt-model{padding:10px 12px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md, 8px);background:var(--dsw-alias-bg-base);}',
      '.dslt-model-h{display:flex;align-items:center;gap:8px;margin:0 0 8px;flex-wrap:wrap}',
      '.dslt-model-id{font-size:12px;font-weight:600;font-family:var(--dsw-font-mono, ui-monospace, monospace)}',
      '.dslt-tier{display:grid;grid-template-columns:1fr 92px 92px 76px auto;gap:6px;align-items:center;margin:0 0 6px}',
      '.dslt-check{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--dsw-alias-label-secondary);cursor:pointer}',
      '.dslt-mini{padding:3px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-sm, 6px);background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:11px;cursor:pointer}',
      '.dslt-mini:hover{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.dslt-status{font-size:12px}',
      '.dslt-status.ok{color:var(--dsw-alias-state-success-primary)}',
      '.dslt-status.bad{color:var(--dsw-alias-state-error-primary)}'
    ].join('\n');

    function Style() {
      return h('style', { 'data-dsh-token-log': 'styles' }, CSS);
    }

    /* ---------------------------------------------------------- */
    /* Charts                                                      */
    /* ---------------------------------------------------------- */

    /** One line chart with a readable axis, hover readout, and holiday bands. */
    function LineChart({ points, height, format, accent }) {
      const [ref, width] = useMeasure();
      const [hover, setHover] = useState(-1);
      const w = Math.max(width, 260);
      const pad = { top: 22, right: 12, bottom: 26, left: 58 };
      const innerW = Math.max(20, w - pad.left - pad.right);
      const innerH = Math.max(20, height - pad.top - pad.bottom);
      const n = points.length;
      const max = niceCeiling(points.reduce((best, point) => Math.max(best, Number(point.value) || 0), 0));
      const x = (index) => pad.left + (n > 1 ? (index * innerW) / (n - 1) : innerW / 2);
      const y = (value) => pad.top + innerH - (Number(value) || 0) / max * innerH;

      const line = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${x(index).toFixed(2)} ${y(point.value).toFixed(2)}`).join(' ');
      const area = n > 1
        ? `${line} L ${x(n - 1).toFixed(2)} ${(pad.top + innerH).toFixed(2)} L ${x(0).toFixed(2)} ${(pad.top + innerH).toFixed(2)} Z`
        : '';
      const ticks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => ({
        value: max * fraction,
        y: pad.top + innerH - fraction * innerH
      }));
      const step = n > 1 ? innerW / (n - 1) : innerW;
      const every = Math.max(1, Math.ceil(n / 9));
      const hovered = hover >= 0 && hover < n ? points[hover] : null;

      return h('div', {
        ref: ref,
        className: 'dslt-chart',
        onMouseLeave: () => setHover(-1),
        onMouseMove: (event) => {
          if (n === 0) return;
          const rect = event.currentTarget.getBoundingClientRect();
          const local = event.clientX - rect.left - pad.left;
          const index = Math.round(local / step);
          setHover(Math.min(Math.max(index, 0), n - 1));
        }
      }, h('svg', { viewBox: `0 0 ${w} ${height}`, width: '100%', height: height, role: 'img' },
        ticks.map((tick) => h('g', { key: `g${tick.value}` },
          h('line', { className: 'dslt-grid', x1: pad.left, x2: w - pad.right, y1: tick.y, y2: tick.y }),
          h('text', { className: 'dslt-axis', x: pad.left - 7, y: tick.y + 3.5, textAnchor: 'end' }, format(tick.value))
        )),
        points.filter((point) => point.holiday).map((point, index) => {
          const realIndex = points.indexOf(point);
          return h('rect', {
            key: `h${realIndex}`,
            className: 'dslt-holiday',
            x: (x(realIndex) - step / 2).toFixed(2),
            y: pad.top,
            width: Math.max(1, step).toFixed(2),
            height: innerH
          });
        }),
        points.length === 0 ? null : h('path', { className: 'dslt-area', d: area }),
        points.length === 0 ? null : h('path', { className: 'dslt-line', d: line, style: accent ? { stroke: accent } : undefined }),
        hovered === null ? null : h('line', {
          className: 'dslt-guide',
          x1: x(hover), x2: x(hover), y1: pad.top, y2: pad.top + innerH
        }),
        hovered === null ? null : h('circle', { className: 'dslt-dot', cx: x(hover), cy: y(hovered.value), r: 3.5 }),
        points.map((point, index) => (index % every === 0 || n - index === 0) ? h('text', {
          key: `x${index}`,
          className: 'dslt-axis',
          x: x(index),
          y: pad.top + innerH + 15,
          textAnchor: 'middle'
        }, point.label) : null),
        h('text', { className: 'dslt-readout', x: pad.left, y: 12 },
          hovered === null
            ? `${format(max)}`
            : `${hovered.label} · ${format(hovered.value)}`
        )
      ));
    }

    /** Vertical bars over workspace totals, labels truncated with full titles. */
    function BarChart({ items, height, format, unit }) {
      const [ref, width] = useMeasure();
      const [hover, setHover] = useState(-1);
      const w = Math.max(width, 260);
      const pad = { top: 22, right: 12, bottom: 40, left: 58 };
      const innerW = Math.max(20, w - pad.left - pad.right);
      const innerH = Math.max(20, height - pad.top - pad.bottom);
      const n = items.length;
      const max = niceCeiling(items.reduce((best, item) => Math.max(best, Number(item.value) || 0), 0));
      const slot = n > 0 ? innerW / n : innerW;
      const barWidth = Math.max(6, Math.min(56, slot * 0.62));
      const x = (index) => pad.left + slot * index + (slot - barWidth) / 2;
      const y = (value) => pad.top + innerH - (Number(value) || 0) / max * innerH;
      const ticks = [0, 0.25, 0.5, 0.75, 1].map((fraction) => ({
        value: max * fraction,
        y: pad.top + innerH - fraction * innerH
      }));
      const hovered = hover >= 0 && hover < n ? items[hover] : null;

      return h('div', {
        ref: ref,
        className: 'dslt-chart',
        onMouseLeave: () => setHover(-1)
      }, h('svg', { viewBox: `0 0 ${w} ${height}`, width: '100%', height: height, role: 'img' },
        ticks.map((tick) => h('g', { key: `g${tick.value}` },
          h('line', { className: 'dslt-grid', x1: pad.left, x2: w - pad.right, y1: tick.y, y2: tick.y }),
          h('text', { className: 'dslt-axis', x: pad.left - 7, y: tick.y + 3.5, textAnchor: 'end' }, format(tick.value))
        )),
        n === 0 ? h('text', { className: 'dslt-axis', x: pad.left, y: pad.top + innerH / 2 }) : items.map((item, index) => {
          const top = y(item.value);
          return h('g', {
            key: item.key,
            onMouseEnter: () => setHover(index)
          },
            h('rect', {
              className: index === hover ? 'dslt-bar dslt-bar--hover' : 'dslt-bar',
              x: x(index).toFixed(2),
              y: top.toFixed(2),
              width: barWidth.toFixed(2),
              height: Math.max(0, pad.top + innerH - top).toFixed(2),
              rx: 3
            }),
            h('title', null, `${item.title}\n${format(item.value)}${unit ? ' ' + unit : ''}`),
            h('text', {
              className: 'dslt-axis',
              x: (x(index) + barWidth / 2).toFixed(2),
              y: pad.top + innerH + 14,
              textAnchor: 'middle'
            }, truncate(item.title, 12))
          );
        }),
        h('text', { className: 'dslt-readout', x: pad.left, y: 12 },
          hovered === null ? `${format(max)}` : `${truncate(hovered.title, 22)} · ${format(hovered.value)}${unit ? ' ' + unit : ''}`
        )
      ));
    }

    /* ---------------------------------------------------------- */
    /* Overview                                                    */
    /* ---------------------------------------------------------- */

    function Tile({ label, value, sub }) {
      return h('div', { className: 'dslt-tile' },
        h('div', { className: 'dslt-tile-h' }, label),
        h('div', { className: 'dslt-tile-v' }, value),
        sub ? h('div', { className: 'dslt-tile-s' }, sub) : null
      );
    }

    function Card({ title, subtitle, action, children }) {
      return h('section', { className: 'dslt-card' },
        h('div', { className: 'dslt-card-h' },
          h('h3', { className: 'dslt-card-t' }, title),
          subtitle ? h('span', { className: 'dslt-card-s' }, subtitle) : null,
          action ? h('span', { className: 'dslt-actions' }, action) : null
        ),
        children
      );
    }

    function Overview({ data, metric, t, onMetric }) {
      const symbol = data.currencySymbol;
      const valueOf = (point) => (metric === 'cost' ? point.cost : point.tokens.total);
      const format = metric === 'cost' ? (value) => formatCost(value, symbol) : formatTokens;
      const dailyTokens = data.daily.reduce((sum, point) => sum + point.tokens.total, 0);
      const dailyCost = data.daily.reduce((sum, point) => sum + point.cost, 0);

      const hourlyPoints = data.today.hours.map((point) => ({
        label: point.label,
        value: valueOf(point),
        active: point.active
      }));

      const segments = (
        value,
        onChange,
        options,
        label
      ) => h('div', { className: 'dslt-seg', role: 'group', 'aria-label': label },
        options.map((option) => h('button', {
          key: option.value,
          type: 'button',
          'aria-pressed': value === option.value,
          onClick: () => onChange(option.value)
        }, option.label)))

      return h('div', null,
        h('div', { className: 'dslt-tiles' },
          h(Tile, { label: t('today'), value: primary(data.today), sub: secondary(data.today) }),
          h(Tile, { label: t('last24'), value: primary(sumOf(data.last24)), sub: secondary(sumOf(data.last24)) }),
          h(Tile, { label: t('last30'), value: primary(sumOf(data.daily)), sub: secondary(sumOf(data.daily)) }),
          h(Tile, { label: t('all'), value: primary(data.totals), sub: secondary(data.totals) })
        ),

        h(Card, {
          title: t('hourlyTitle'),
          subtitle: t('hourlyHint'),
          action: segments(metric, onMetric, [
            { value: 'tokens', label: t('metricTokens') },
            { value: 'cost', label: t('metricCost') }
          ], 'metric')
        },
          h(LineChart, { points: hourlyPoints, height: 220, format: format }),
          h('div', { className: 'dslt-legend' },
            h('span', null, h('i', { className: 'a' }), metric === 'cost' ? formatCost(data.today.cost, symbol) : formatTokens(data.today.tokens.total)),
            h('span', null, data.today.tokens.calls.toLocaleString(), ' ', t('calls'))
          )
        ),

        h(Card, {
          title: t('dailyTitle'),
          subtitle: t('holiday')
        },
          h(LineChart, {
            points: data.daily.map((point) => ({ label: point.label, value: valueOf(point), holiday: point.holiday })),
            height: 240,
            format: format
          }),
          h('div', { className: 'dslt-legend' },
            h('span', null, h('i', { className: 'a' }), metric === 'cost' ? formatCost(dailyCost, symbol) : formatTokens(dailyTokens)),
            h('span', null, h('i', { className: 'b' }), t('holiday'))
          )
        ),

        h(Card, { title: t('workspaceTitle'), subtitle: t('workspaceHint') },
          data.workspaces.length === 0
            ? h('div', { className: 'dslt-empty' }, t('noWorkspaces'))
            : h(BarChart, {
                items: data.workspaces.map((workspace) => ({
                  key: workspace.path,
                  title: workspace.title,
                  value: metric === 'cost' ? workspace.cost : workspace.total
                })),
                height: 240,
                format: format,
                unit: metric === 'cost' ? symbol : 'tokens'
              })
        ),

        h(Card, { title: t('modelsTitle') },
          data.models.length === 0
            ? h('div', { className: 'dslt-empty' }, t('noModels'))
            : h('table', { className: 'dslt-table' },
                h('thead', null, h('tr', null,
                  h('th', null, t('model')),
                  h('th', null, t('input')),
                  h('th', null, t('cacheRead')),
                  h('th', null, t('cacheWrite')),
                  h('th', null, t('output')),
                  h('th', null, t('total')),
                  h('th', null, t('calls')),
                  h('th', null, t('metricCost'))
                )),
                h('tbody', null, data.models.map((model) => h('tr', { key: model.model },
                  h('td', null,
                    h('span', { className: 'dslt-mono' }, model.model),
                    model.label ? h('span', { className: 'dslt-dim' }, ` (${model.label})`) : null,
                    model.priced ? null : h('span', { className: 'dslt-dim' }, ` · ${t('unpriced')}`)
                  ),
                  h('td', null, formatTokens(model.tokens.input)),
                  h('td', null, formatTokens(model.tokens.cacheRead)),
                  h('td', null, formatTokens(model.tokens.cacheWrite)),
                  h('td', null, formatTokens(model.tokens.output)),
                  h('td', null, formatTokens(model.tokens.total)),
                  h('td', null, model.calls.toLocaleString()),
                  h('td', null, formatCost(model.cost, symbol))
                )))
              )
        )
      );

      function primary(item) {
        return metric === 'cost' ? formatCost(item.cost, symbol) : formatTokens(item.tokens ? item.tokens.total : item.total);
      }
      function secondary(item) {
        if (metric === 'cost') return formatTokens(item.tokens ? item.tokens.total : item.total);
        return formatCost(item.cost, symbol);
      }
      function sumOf(points) {
        return {
          tokens: { total: points.reduce((sum, point) => sum + point.tokens.total, 0) },
          cost: points.reduce((sum, point) => sum + point.cost, 0)
        };
      }
    }

    /* ---------------------------------------------------------- */
    /* Pricing editor                                              */
    /* ---------------------------------------------------------- */

    function NumberField({ value, onChange, step, min, ariaLabel }) {
      return h('input', {
        className: 'dslt-input',
        type: 'number',
        value: Number.isFinite(value) ? value : '',
        step: step === undefined ? 0.01 : step,
        min: min === undefined ? 0 : min,
        'aria-label': ariaLabel,
        onChange: (event) => onChange(event.target.value === '' ? '' : Number(event.target.value))
      });
    }

    function TextField({ value, onChange, placeholder, ariaLabel }) {
      return h('input', {
        className: 'dslt-input',
        type: 'text',
        value: value === undefined || value === null ? '' : String(value),
        placeholder: placeholder,
        'aria-label': ariaLabel,
        onChange: (event) => onChange(event.target.value)
      });
    }

    function PricingEditor({ settings, defaults, onSave, onClear, t }) {
      const [draft, setDraft] = useState(settings);
      const [status, setStatus] = useState({ kind: 'idle', text: '' });
      const [confirmClear, setConfirmClear] = useState(false);

      useEffect(() => {
        setDraft(settings);
        setStatus({ kind: 'idle', text: '' });
      }, [settings]);

      const edit = (mutate) => {
        setDraft((previous) => {
          const next = structuredClone(previous);
          mutate(next);
          return next;
        });
        setStatus({ kind: 'idle', text: '' });
      };
      const busy = status.kind === 'saving' || status.kind === 'clearing';

      return h('div', { className: 'dslt-form' },
        h('p', { className: 'dslt-sub' }, t('pricesHint')),

        h('section', { className: 'dslt-card' },
          h('h3', { className: 'dslt-card-t', style: { marginTop: '0' } }, t('timezone')),
          h('div', { className: 'dslt-grid2' },
            h('div', { className: 'dslt-field' },
              h('label', null, t('timezone')),
              h(TextField, { value: draft.timezone, onChange: (value) => edit((next) => { next.timezone = value; }), ariaLabel: t('timezone') })
            ),
            h('div', { className: 'dslt-field' },
              h('label', null, t('currency')),
              h(TextField, { value: draft.currency, onChange: (value) => edit((next) => { next.currency = value; }), ariaLabel: t('currency') })
            ),
            h('div', { className: 'dslt-field' },
              h('label', null, t('symbol')),
              h(TextField, { value: draft.currencySymbol, onChange: (value) => edit((next) => { next.currencySymbol = value; }), ariaLabel: t('symbol') })
            ),
            h('div', { className: 'dslt-field' },
              h('label', null, t('retention')),
              h(NumberField, { value: draft.retentionDays, onChange: (value) => edit((next) => { next.retentionDays = value === '' ? '' : Number(value); }), step: 1, min: 30, ariaLabel: t('retention') }),
              h('span', { className: 'dslt-sub', style: { marginTop: '4px' } }, t('retentionHint'))
            )
          ),
          h('div', { className: 'dslt-field', style: { marginTop: '10px' } },
            h('label', null, t('holidays')),
            h('textarea', {
              className: 'dslt-area-input',
              rows: 3,
              value: (draft.holidays || []).join(', '),
              'aria-label': t('holidays'),
              onChange: (event) => edit((next) => {
                next.holidays = event.target.value.split(/[\n,]+/).map((entry) => entry.trim()).filter((entry) => entry !== '');
              })
            }),
            h('span', { className: 'dslt-sub' }, t('holidaysHint'))
          )
        ),

        h('section', { className: 'dslt-card' },
          h('div', { className: 'dslt-card-h' },
            h('h3', { className: 'dslt-card-t', style: { margin: '0' } }, t('model')),
            h('span', { className: 'dslt-card-s' }, t('perMillion'))
          ),
          h('div', { className: 'dslt-rows' },
            Object.entries(draft.models || {}).map(([modelId, entry]) => h('div', { className: 'dslt-model', key: modelId },
              h('div', { className: 'dslt-model-h' },
                h('span', { className: 'dslt-model-id' }, modelId),
                h(TextField, {
                  value: entry.label,
                  placeholder: t('label'),
                  'aria-label': t('label'),
                  onChange: (value) => edit((next) => { next.models[modelId].label = value; })
                }),
                h('button', {
                  type: 'button',
                  className: 'dslt-mini',
                  disabled: busy,
                  onClick: () => edit((next) => { delete next.models[modelId]; })
                }, t('removeModel'))
              ),
              h('div', { className: 'dslt-grid2' },
                h('div', { className: 'dslt-field' },
                  h('label', null, t('input')),
                  h(NumberField, { value: entry.input, onChange: (value) => edit((next) => { next.models[modelId].input = value; }), ariaLabel: t('input') })
                ),
                h('div', { className: 'dslt-field' },
                  h('label', null, t('cacheInput')),
                  h(NumberField, { value: entry.cacheInput, onChange: (value) => edit((next) => { next.models[modelId].cacheInput = value; }), ariaLabel: t('cacheInput') })
                ),
                h('div', { className: 'dslt-field' },
                  h('label', null, t('output')),
                  h(NumberField, { value: entry.output, onChange: (value) => edit((next) => { next.models[modelId].output = value; }), ariaLabel: t('output') })
                )
              ),
              h('div', { className: 'dslt-field', style: { marginTop: '10px' } },
                h('label', null, t('tiers')),
                h('span', { className: 'dslt-sub' }, t('tiersHint')),
                h('div', { className: 'dslt-rows', style: { marginTop: '6px' } },
                  (entry.tiers || []).map((tier, index) => h('div', { className: 'dslt-tier', key: index },
                    h(TextField, {
                      value: tier.label === undefined ? '' : tier.label,
                      placeholder: t('label'),
                      'aria-label': t('label'),
                      onChange: (value) => edit((next) => {
                        const target = next.models[modelId].tiers[index];
                        if (value === '') delete target.label; else target.label = value;
                      })
                    }),
                    h(TextField, {
                      value: tier.from,
                      placeholder: 'HH:MM',
                      'aria-label': t('from'),
                      onChange: (value) => edit((next) => { next.models[modelId].tiers[index].from = value; })
                    }),
                    h(TextField, {
                      value: tier.to,
                      placeholder: 'HH:MM',
                      'aria-label': t('to'),
                      onChange: (value) => edit((next) => { next.models[modelId].tiers[index].to = value; })
                    }),
                    h(TextField, {
                      value: tier.multiplier,
                      placeholder: '1.0',
                      'aria-label': t('multiplier'),
                      onChange: (value) => edit((next) => {
                        const parsed = Number(value);
                        next.models[modelId].tiers[index].multiplier = Number.isFinite(parsed) ? parsed : 1;
                      })
                    }),
                    h('button', {
                      type: 'button',
                      className: 'dslt-mini',
                      disabled: busy,
                      onClick: () => edit((next) => { next.models[modelId].tiers.splice(index, 1); })
                    }, t('removeModel'))
                  )),
                  h('button', {
                    type: 'button',
                    className: 'dslt-mini',
                    disabled: busy,
                    onClick: () => edit((next) => {
                      next.models[modelId].tiers = next.models[modelId].tiers || [];
                      next.models[modelId].tiers.push({ from: '08:00', to: '18:00', multiplier: 1 });
                    })
                  }, t('addTier'))
                )
              ),
              h('div', { style: { marginTop: '10px' } },
                h('label', { className: 'dslt-check' },
                  h('input', {
                    type: 'checkbox',
                    checked: entry.holidayRates !== null && entry.holidayRates !== undefined,
                    onChange: (event) => edit((next) => {
                      const target = next.models[modelId];
                      if (event.target.checked) {
                        target.holidayRates = { input: target.input, cacheInput: target.cacheInput, output: target.output };
                      } else {
                        target.holidayRates = null;
                      }
                    })
                  }),
                  t('holidayPrices')
                )
              ),
              entry.holidayRates !== null && entry.holidayRates !== undefined
                ? h('div', { className: 'dslt-grid2', style: { marginTop: '8px' } },
                    h('div', { className: 'dslt-field' },
                      h('label', null, t('input')),
                      h(NumberField, { value: entry.holidayRates.input, onChange: (value) => edit((next) => { next.models[modelId].holidayRates.input = value; }), ariaLabel: t('input') })
                    ),
                    h('div', { className: 'dslt-field' },
                      h('label', null, t('cacheInput')),
                      h(NumberField, { value: entry.holidayRates.cacheInput, onChange: (value) => edit((next) => { next.models[modelId].holidayRates.cacheInput = value; }), ariaLabel: t('cacheInput') })
                    ),
                    h('div', { className: 'dslt-field' },
                      h('label', null, t('output')),
                      h(NumberField, { value: entry.holidayRates.output, onChange: (value) => edit((next) => { next.models[modelId].holidayRates.output = value; }), ariaLabel: t('output') })
                    )
                  )
                : null
            ))
          ),
          h(AddModel, { t: t, onAdd: (modelId) => edit((next) => {
            next.models[modelId] = { label: '', input: 0, cacheInput: 0, output: 0, tiers: [], holidayRates: null };
          }) })
        ),

        h('div', { className: 'dslt-actions', style: { margin: '0', flexWrap: 'wrap' } },
          h('button', {
            type: 'button',
            className: 'dslt-btn dslt-btn--primary',
            disabled: busy,
            onClick: () => {
              setStatus({ kind: 'saving', text: t('saving') });
              onSave(draft).then(
                (result) => {
                  if (result && result.ok === false) setStatus({ kind: 'bad', text: result.error || t('failed') });
                  else setStatus({ kind: 'ok', text: t('saved') });
                },
                (error) => setStatus({ kind: 'bad', text: String((error && error.message) || error) })
              );
            }
          }, status.kind === 'saving' ? t('saving') : t('save')),
          h('button', {
            type: 'button',
            className: 'dslt-btn',
            disabled: busy,
            onClick: () => {
              setDraft(structuredClone(defaults));
              setStatus({ kind: 'idle', text: '' });
            }
          }, t('reset')),
          h('button', {
            type: 'button',
            className: 'dslt-btn dslt-btn--danger',
            disabled: busy || confirmClear === false,
            onClick: () => {
              if (confirmClear === false) {
                setConfirmClear(true);
                return;
              }
              setConfirmClear(false);
              setStatus({ kind: 'clearing', text: t('clearing') });
              onClear().then(
                () => setStatus({ kind: 'ok', text: t('cleared') }),
                (error) => setStatus({ kind: 'bad', text: `${t('clearFailed')} ${String((error && error.message) || error)}` })
              );
            }
          }, confirmClear ? t('confirmClear') : t('clearLedger'))
        ),
        status.text !== '' ? h('div', { className: `dslt-status ${status.kind === 'bad' ? 'bad' : status.kind === 'ok' ? 'ok' : ''}` }, status.text) : null
      );
    }

    /** Add a model id without a native prompt. */
    function AddModel({ onAdd, t }) {
      const [value, setValue] = useState('');
      const submit = () => {
        const id = value.trim();
        if (id === '') return;
        onAdd(id);
        setValue('');
      };
      return h('div', { className: 'dslt-field', style: { marginTop: '10px' } },
        h('div', { style: { display: 'flex', gap: '6px', alignItems: 'center' } },
          h('input', {
            className: 'dslt-input',
            type: 'text',
            value: value,
            placeholder: t('modelId'),
            'aria-label': t('modelId'),
            onChange: (event) => setValue(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                submit();
              }
            }
          }),
          h('button', { type: 'button', className: 'dslt-btn', onClick: submit }, t('addModel'))
        ),
        h('span', { className: 'dslt-sub' }, t('addModelNote'))
      );
    }

    /* ---------------------------------------------------------- */
    /* View                                                        */
    /* ---------------------------------------------------------- */

    function Dashboard({ translate }) {
      const t = translate;
      const [data, setData] = useState(null);
      const [error, setError] = useState(null);
      const [metric, setMetric] = useState('tokens');
      const [panel, setPanel] = useState('overview');
      const [settings, setSettings] = useState(null);
      const [defaults, setDefaults] = useState(null);
      const [generation, setGeneration] = useState(0);

      useEffect(() => {
        let live = true;
        let controller = null;

        const load = async () => {
          controller = new AbortController();
          try {
            const response = await fetch(SETTINGS_PATH, {
              headers: { accept: 'application/json' },
              cache: 'no-store',
              signal: controller.signal
            });
            const body = await response.json();
            if (!live) return;
            if (body && body.ok) {
              setSettings(body.settings);
              setDefaults(body.defaults);
            }
          } catch {
            /* settings stay empty; the editor shows its own failure */
          }
        };
        void load();
        return () => {
          live = false;
          if (controller) controller.abort();
        };
      }, []);

      useEffect(() => {
        let live = true;
        let inflight = false;
        let controller = null;

        const refresh = async () => {
          // Skip a tick if the previous request is still in flight, so a slow
          // response never queues up behind a faster one and an older body can
          // never overwrite a newer one.
          if (!live || inflight) return;
          inflight = true;
          controller = new AbortController();
          try {
            const response = await fetch(STATS_PATH, {
              headers: { accept: 'application/json' },
              cache: 'no-store',
              signal: controller.signal
            });
            const body = await response.json();
            if (!live) return;
            if (body && body.ok === true) {
              setData(body);
              setError(null);
            } else {
              setError(String((body && body.error) || 'HTTP ' + response.status));
            }
          } catch (reason) {
            if (live && !(reason && reason.name === 'AbortError')) {
              setError(String((reason && reason.message) || reason));
            }
          } finally {
            inflight = false;
          }
        };

        void refresh();
        const timer = setInterval(() => {
          if (document.visibilityState === 'visible') void refresh();
        }, POLL_MS);

        return () => {
          live = false;
          if (controller) controller.abort();
          clearInterval(timer);
        };
      }, [generation]);

      const save = (draft) => fetch(SETTINGS_PATH, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(draft)
      }).then(async (response) => {
        const body = await response.json();
        if (body && body.ok) {
          setSettings(body.settings);
          return { ok: true };
        }
        return { ok: false, error: String((body && body.error) || 'HTTP ' + response.status) };
      });

      const clear = () => fetch(LEDGER_PATH, { method: 'POST', headers: { accept: 'application/json' } }).then(async (response) => {
        const body = await response.json();
        if (!body || body.ok !== true) throw new Error(String((body && body.error) || 'HTTP ' + response.status));
        setGeneration((value) => value + 1);
      });

      const segmented = h('div', { className: 'dslt-seg', role: 'group', 'aria-label': 'metric' },
        h('button', {
          type: 'button',
          'aria-pressed': metric === 'tokens',
          onClick: () => setMetric('tokens')
        }, t('metricTokens')),
        h('button', {
          type: 'button',
          'aria-pressed': metric === 'cost',
          onClick: () => setMetric('cost')
        }, t('metricCost'))
      );

      return h('div', { className: 'dslt' },
        h(Style),
        h('header', { className: 'dslt-head' },
          h('img', { className: 'dslt-icon', src: ICON, alt: '' }),
          h('div', null,
            h('h2', { className: 'dslt-title' }, t('title')),
            h('p', { className: 'dslt-sub' }, t('subtitle')),
            data && data.totals.unpricedModels && data.totals.unpricedModels.length > 0
              ? h('p', { className: 'dslt-note' }, t('unpricedNote', {
                  models: data.totals.unpricedModels.join(', ')
                }))
              : null,
            data && data.storage && data.storage.durable === false && data.storage.error
              ? h('p', { className: 'dslt-note' }, t('notDurable', { reason: data.storage.error }))
              : null
          ),
          h('div', { className: 'dslt-actions' },
            data ? h('span', { className: 'dslt-updated' }, t('updated', { time: formatClock(data.generatedAt) })) : null,
            segmented,
            h('div', { className: 'dslt-seg', role: 'group', 'aria-label': 'panel' },
              h('button', { type: 'button', 'aria-pressed': panel === 'overview', onClick: () => setPanel('overview') }, t('overview')),
              h('button', { type: 'button', 'aria-pressed': panel === 'prices', onClick: () => setPanel('prices') }, t('prices'))
            )
          )
        ),

        error !== null
          ? h('div', { className: 'dslt-error' },
              t('error'), ' ', error,
              h('button', {
                className: 'dslt-btn',
                type: 'button',
                style: { marginLeft: '8px' },
                onClick: () => setGeneration((value) => value + 1)
              }, t('retry')))
          : null,

        data === null && error === null
          ? h('div', { className: 'dslt-empty' }, t('loading'))
          : null,

        data !== null && (data.totals.total || 0) === 0
          ? h('div', { className: 'dslt-empty' }, t('noData'))
          : null,

        panel === 'overview' && data !== null
          ? h(Overview, { data: data, metric: metric, t: t, onMetric: setMetric })
          : null,

        panel === 'prices'
          ? (settings === null
            ? h('div', { className: 'dslt-empty' }, t('loading'))
            : h(PricingEditor, {
                settings: settings,
                defaults: defaults === null ? settings : defaults,
                onSave: save,
                onClear: clear,
                t: t
              }))
          : null
      );
    }

    /* ---------------------------------------------------------- */
    /* Registration                                                */
    /* ---------------------------------------------------------- */

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        ctx.effect(() => {
          if (!ctx.locale || typeof ctx.locale.register !== 'function') return () => {};
          try {
            return ctx.locale.register(NS, { en: EN, zh: ZH });
          } catch (error) {
            console.warn('[dsh-token-log] locale registration failed:', error && error.message);
            return () => {};
          }
        }, 'dsh-token-log: dictionaries');

        const translate = ctx.locale && typeof ctx.locale.bind === 'function'
          ? ctx.locale.bind(NS)
          : (key, params) => String(key).replace(/\{(\w+)\}/g, (match, name) =>
              params && name in params ? String(params[name]) : match);

        // Re-render on locale switch so the bound translator picks up the new
        // dictionary instead of freezing on the one resolved at first mount.
        const Root = () => {
          const [, setTick] = useState(0);
          useEffect(() => {
            const service = ctx.locale;
            if (!service || typeof service.subscribe !== 'function') return undefined;
            return service.subscribe(() => setTick((value) => value + 1));
          }, []);
          return h(Dashboard, { translate: translate });
        };

        ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view',
          id: 'token-log',
          order: 50,
          label: () => translate('tab')
        }, Root));
      }
    };
  }
});
