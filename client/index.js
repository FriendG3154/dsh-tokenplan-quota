// Token Plan quota — Client half (Web GUI panel).
// Registers a card in settings.plugins.tab. All data comes from this plugin's
// own same-origin host routes (/api/tokenplan/*); no secrets cross here — the
// key-status route only reports presence + last-4 hint resolved host-side from
// environment variables (env-only since v0.1.1; the credentials seam is not used).
if (typeof window !== 'undefined' && window.__ModuleLoader__) {
window.__ModuleLoader__.load({
  // The client artifact id must equal the bundle package name.
  id: 'dsh-tokenplan-quota',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useState, useEffect, useCallback, useRef } = React;

    // v0.1.6 — every colour goes through DSH theme tokens so the panel follows
    // light/dark and custom themes. Token names verified against the AUTHORITATIVE
    // source: @deepseek-ai/dsh-client-ui-theme/src/styles/design-platform.css
    // (--dsw-alias-* defined per body / body[data-ds-dark-theme]). Note that
    // --dsw-alias-text-primary / --dsw-alias-bg-container do NOT exist there —
    // using them made the title fall back to a fixed dark colour on dark themes.
    const T = {
      text: 'var(--dsw-alias-label-primary, #1f2329)',
      text2: 'var(--dsw-alias-label-secondary, #4e5969)',
      text3: 'var(--dsw-alias-label-tertiary, #8a919f)',
      text4: 'var(--dsw-alias-label-dimmed, #a9aeb8)',
      border: 'var(--dsw-alias-border-l2, #e5e6eb)',
      bgCard: 'var(--dsw-alias-card-fill, var(--dsw-alias-bg-layer-2, #fff))',
      fill: 'var(--dsw-alias-border-l2, #e5e6eb)',
      brand: 'var(--dsw-alias-brand-primary, #6c5ce7)',
      ok: 'var(--dsw-alias-state-success-primary, #2fb37d)',
      warn: 'var(--dsw-alias-state-warn-primary, #f5b942)',
      danger: 'var(--dsw-alias-state-error-primary, #f53f3f)',
    };
    // Translucent tint over transparent background — works on any theme surface.
    const tint = (color, pct) => `color-mix(in srgb, ${color} ${pct}%, transparent)`;

    const css = {
      wrap: { display: 'flex', flexDirection: 'column', gap: 12, padding: '8px 0', maxWidth: 760 },
      head: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
      title: { fontSize: 15, fontWeight: 600, color: T.text },
      sub: { fontSize: 12, color: T.text3, marginTop: 2 },
      btn: {
        fontSize: 12, padding: '5px 12px', borderRadius: 6, cursor: 'pointer', whiteSpace: 'nowrap',
        border: `1px solid ${T.border}`, background: 'transparent', color: T.text2,
      },
      card: {
        padding: '14px 16px', borderRadius: 10, gap: 10, display: 'flex', flexDirection: 'column',
        border: `1px solid ${T.border}`, background: T.bgCard,
      },
      bigRow: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' },
      big: { fontSize: 28, fontWeight: 700, color: T.text },
      unit: { fontSize: 13, color: T.text3 },
      badge: { fontSize: 12, padding: '2px 8px', borderRadius: 999, whiteSpace: 'nowrap' },
      barOuter: { height: 8, borderRadius: 999, overflow: 'hidden', background: T.fill },
      metaGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '8px 16px' },
      metaLabel: { fontSize: 11, color: T.text2 },
      metaValue: { fontSize: 13, color: T.text, marginTop: 2, wordBreak: 'break-all' },
      err: { fontSize: 12, color: T.danger },
      hint: { fontSize: 12, color: T.text2, lineHeight: 1.6 },
      code: {
        fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12, padding: '6px 10px', borderRadius: 6,
        background: tint(T.text3, 12), color: T.text,
        userSelect: 'all', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8,
      },
      tierRow: { display: 'flex', alignItems: 'center', gap: 10, fontSize: 13, color: T.text },
    };

    const SOURCE_META = {
      cli: { zh: '官方 qianwen CLI（真实数据）', en: 'Official qianwen CLI (real data)', fg: T.ok, bg: tint(T.ok, 12) },
      gateway: { zh: 'Token Plan 网关端点（真实数据）', en: 'Token Plan gateway endpoint (real data)', fg: T.ok, bg: tint(T.ok, 12) },
      estimate: { zh: '本地估算 · 非官方数值', en: 'Local estimate · not official', fg: T.warn, bg: tint(T.warn, 14) },
    };

    function fmtTime(iso) {
      if (!iso) return '—';
      const d = new Date(iso);
      if (Number.isNaN(d.getTime())) return String(iso);
      return d.toLocaleString();
    }

    function fmtNum(n) {
      return typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString() : '—';
    }

    // v0.2.3: compact token count (1.23M / 456.7K / 820)
    function fmtTok(n) {
      if (typeof n !== 'number' || !Number.isFinite(n)) return '—';
      if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(2) + 'M';
      if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + 'K';
      return String(n);
    }
    // v0.2.4: Credits → 人民币 (加油包口径 100元/20,000Cr, 1Cr=0.005元)
    function fmtYuan(credits) {
      if (typeof credits !== 'number' || !Number.isFinite(credits)) return '—';
      const y = credits * 0.005;
      return '¥' + (y >= 100 ? y.toFixed(0) : y >= 10 ? y.toFixed(1) : y.toFixed(2));
    }
    const TPQ_LEDGER_TIP = '仅统计本机 DSH 会话里的模型调用（IDE/脚本等其他客户端不计入）。'
      + 'Credits 折算按 qwen3.6-plus 锚定费率估算（未逐模型核实），夜间折扣已计入；'
      + '¥ 价按加油包口径 100 元 / 20,000 Credits（1 Cr ≈ 0.005 元）换算，仅供参考。';

    // ---- v0.2.0 night-discount window (docs: part of the models get a
    // discount 22:00–08:00 local time; official billing page is authoritative).
    // Pure client clock math — no data source needed. The bar shows progress of
    // the CURRENT phase: elapsed share of the discount window when inside it,
    // elapsed share of the 08:00→22:00 peak span when outside it.
    function nightDiscount(now) {
      const hf = now.getHours() + now.getMinutes() / 60 + now.getSeconds() / 3600;
      if (hf >= 22 || hf < 8) {
        const elapsed = hf >= 22 ? hf - 22 : hf + 2;
        return { inWindow: true, pct: Math.min(100, Math.max(0, (elapsed / 10) * 100)), remainMin: Math.max(0, Math.round((10 - elapsed) * 60)) };
      }
      return { inWindow: false, pct: Math.min(100, Math.max(0, ((hf - 8) / 14) * 100)), remainMin: Math.max(0, Math.round((22 - hf) * 60)) };
    }
    const fmtDur = (min) => {
      const hh = Math.floor(min / 60), mm = Math.round(min % 60);
      return hh > 0 ? `${hh}小时${mm}分` : `${mm}分`;
    };
    function NightBar({ compact }) {
      const [now, setNow] = useState(() => new Date());
      useEffect(() => {
        const t = setInterval(() => setNow(new Date()), 30000);
        return () => clearInterval(t);
      }, []);
      const d = nightDiscount(now);
      const color = d.inWindow ? T.ok : T.brand;
      return h('div', { title: '千问夜间折扣时段 22:00–08:00（qwen3.8-flash 等部分模型适用，以官方计费页为准）' },
        // v0.2.1: label and status stacked vertically (老大 m01479: 要垂直配列，而非水平排列)
        h('div', { style: { display: 'flex', flexDirection: 'column', gap: 1, fontSize: compact ? 10 : 11, color: T.text2 } },
          h('span', null, 'flash 夜间折扣 22–08'),
          h('span', { style: { color } }, d.inWindow ? `折扣中，剩 ${fmtDur(d.remainMin)}` : `距折扣 ${fmtDur(d.remainMin)}`)),
        h('div', { style: { height: compact ? 4 : 6, borderRadius: 999, overflow: 'hidden', background: T.fill, marginTop: 3 } },
          h('div', { style: { height: '100%', width: d.pct + '%', background: color, borderRadius: 999, transition: 'width .3s ease' } })));
    }

    // Compact styles for the sidebar-footer card (v0.2.0, cost-meter position).
    const sbCss = {
      card: {
        display: 'flex', flexDirection: 'column', gap: 5, padding: '8px 10px', borderRadius: 8, boxSizing: 'border-box',
        border: `1px solid ${T.border}`, background: T.bgCard, fontSize: 11, color: T.text2,
        width: '100%', maxWidth: '100%', minWidth: 0, lineHeight: 1.35,
      },
      head: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 },
      title: { fontSize: 11, fontWeight: 600, color: T.text },
      tier: { fontSize: 10, padding: '1px 6px', borderRadius: 999, background: tint(T.brand, 14), color: T.brand, whiteSpace: 'nowrap' },
      bigRow: { display: 'flex', alignItems: 'baseline', gap: 6 },
      big: { fontSize: 18, fontWeight: 700, color: T.text, lineHeight: 1.1 },
      total: { fontSize: 11, color: T.text2 },
      barOuter: { height: 5, borderRadius: 999, overflow: 'hidden', background: T.fill },
      row: { display: 'flex', justifyContent: 'space-between', gap: 8 },
      val: { color: T.text, fontVariantNumeric: 'tabular-nums' },
    };

    function Bar({ pct }) {
      const p = Math.max(0, Math.min(100, pct || 0));
      const color = p >= 90 ? T.danger : p >= 70 ? T.brand : T.ok;
      return h('div', { style: css.barOuter },
        h('div', { style: { height: '100%', width: p + '%', background: color, borderRadius: 999, transition: 'width .2s ease' } }));
    }

    function CopyBtn({ text }) {
      const [done, setDone] = useState(false);
      return h('button', {
        style: css.btn,
        onClick: async () => {
          try { await navigator.clipboard.writeText(text); setDone(true); setTimeout(() => setDone(false), 1500); } catch { /* clipboard unavailable */ }
        },
      }, done ? '✓' : '复制');
    }

    function makePanel() {
      return function TokenPlanQuotaPanel() {
        const [state, setState] = useState(null);
        const [error, setError] = useState(null);
        const [busy, setBusy] = useState(false);
        const mounted = useRef(true);

        const load = useCallback(async (force) => {
          try {
            const url = force ? '/api/tokenplan/refresh' : '/api/tokenplan/state';
            const res = await fetch(url, { method: force ? 'POST' : 'GET' });
            // v0.1.1 (loader-findings.md §7.1): never feed a non-JSON body to
            // res.json() — an unregistered route falls through to the host's
            // text/plain "not found" and used to surface as a raw SyntaxError.
            const ct = res.headers.get('content-type') || '';
            if (!ct.includes('application/json')) {
              const snippet = (await res.text().catch(() => '')).slice(0, 80);
              if (mounted.current) setError(`宿主服务未就绪（HTTP ${res.status}，响应非 JSON${snippet ? '：' + snippet : ''}）。可能需重启宿主以加载插件。`);
              return;
            }
            const j = await res.json();
            if (!mounted.current) return;
            if (!res.ok && !j.snapshot) {
              setError(`宿主返回 HTTP ${res.status}：${j.error || j.reason || j.lastResult || 'unknown'}`);
              setState(j);
              return;
            }
            setState(j);
            setError(null);
          } catch (e) {
            if (mounted.current) setError('无法连接宿主服务：' + (e && e.message ? e.message : String(e)));
          } finally {
            if (mounted.current) setBusy(false);
          }
        }, []);

        useEffect(() => {
          mounted.current = true;
          void load(false);
          const t = setInterval(() => void load(false), 30000);
          return () => { mounted.current = false; clearInterval(t); };
        }, [load]);

        const manualRefresh = useCallback(async () => {
          setBusy(true);
          await load(true);
        }, [load]);

        const snap = state && state.snapshot;
        const src = snap && SOURCE_META[snap.source];
        const isEstimate = snap && snap.source === 'estimate';

        // remaining / total for the headline
        let remaining = null, total = null, usedPct = null;
        if (snap) {
          if (isEstimate) {
            total = snap.totalCredits ?? 45000; // Essential default anchor when unknown
            remaining = snap.remainingCredits != null ? snap.remainingCredits
              : (snap.estimatedUsedCredits != null && total ? Math.max(total - snap.estimatedUsedCredits, 0) : null);
            usedPct = snap.usedPct != null ? snap.usedPct
              : (remaining != null && total ? Math.round((total - remaining) / total * 1000) / 10 : null);
          } else {
            total = snap.totalCredits ?? null;
            remaining = snap.remainingCredits ?? null;
            usedPct = snap.usedPct != null ? snap.usedPct
              : (remaining != null && total ? Math.round((total - remaining) / total * 1000) / 10 : null);
          }
        }

        return h('div', { style: css.wrap },
          h('div', { style: css.head },
            h('div', null,
              h('div', { style: css.title }, '千问 Token Plan 额度'),
              h('div', { style: css.sub }, '剩余 Credits · 档位 · 重置时间 · 数据来源')),
            h('button', { style: css.btn, disabled: busy, onClick: manualRefresh }, busy ? '刷新中…' : '手动刷新')),

          error ? h('div', { style: css.err }, error) : null,

          snap ? h('div', { style: css.card },
            h('div', { style: css.bigRow },
              h('span', { style: css.big }, isEstimate ? '≈' + fmtNum(remaining) : fmtNum(remaining)),
              h('span', { style: css.unit }, 'Credits 剩余' + (total ? ' / ' + fmtNum(total) : '')),
              src ? h('span', { style: { ...css.badge, background: src.bg, color: src.fg } }, src.zh) : null,
              isEstimate ? h('span', { style: { ...css.badge, background: tint(T.warn, 14), color: T.warn } }, '估算') : null),
            usedPct != null ? h('div', null,
              h(Bar, { pct: usedPct }),
              h('div', { style: { ...css.metaLabel, marginTop: 4 } }, `已用 ${usedPct}%`)) : null,
            h('div', { style: css.metaGrid },
              h('div', null, h('div', { style: css.metaLabel }, '档位 / 套餐'), h('div', { style: css.metaValue }, snap.tierLabel || snap.planName || '—')),
              h('div', null, h('div', { style: css.metaLabel }, '今日使用'), h('div', { style: css.metaValue }, snap.usedTodayCredits != null ? (isEstimate ? '≈' : '') + fmtNum(snap.usedTodayCredits) + ' Credits' : '—')),
              // v0.2.3: token ledger detail (老大 m01525)
              snap.todayTokens ? h('div', { title: TPQ_LEDGER_TIP }, h('div', { style: css.metaLabel }, '今日 token'),
                h('div', { style: css.metaValue }, fmtTok(snap.todayTokens.totalTokens)
                  + '（输入 ' + fmtTok(snap.todayTokens.inputTokens) + ' / 输出 ' + fmtTok(snap.todayTokens.outputTokens)
                  + '，其中缓存命中 ' + fmtTok(snap.todayTokens.cachedTokens) + '）')) : null,
              snap.todayTokens ? h('div', { title: TPQ_LEDGER_TIP }, h('div', { style: css.metaLabel }, '今日折算价格'),
                h('div', { style: css.metaValue }, fmtYuan(snap.todayTokens.credits) + '（≈' + snap.todayTokens.credits
                  + ' Credits，加油包口径 100元/2万Cr）')) : null,
              h('div', null, h('div', { style: css.metaLabel }, 'Credits 重置时间'), h('div', { style: css.metaValue }, fmtTime(snap.resetAt))),
              snap.subscriptionEndAt ? h('div', null, h('div', { style: css.metaLabel }, '订阅到期' + (snap.remainingDays != null ? '（剩 ' + snap.remainingDays + ' 天）' : '')), h('div', { style: css.metaValue }, fmtTime(snap.subscriptionEndAt))) : null,
              h('div', null, h('div', { style: css.metaLabel }, '上次取数'), h('div', { style: css.metaValue }, fmtTime(snap.fetchedAt))),
              h('div', null, h('div', { style: css.metaLabel }, '上次轮询尝试'), h('div', { style: css.metaValue }, fmtTime(state.lastAttemptAt))),
              h('div', null, h('div', { style: css.metaLabel }, '轮询间隔'), h('div', { style: css.metaValue }, (state.pollIntervalSec || snap.pollIntervalSec || '—') + 's'))),
            h(NightBar, {}),
            // v0.2.3: per-model today breakdown (tokens → Credits)
            snap.todayTokens && Array.isArray(snap.todayTokens.perModel) && snap.todayTokens.perModel.length
              ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 }, title: TPQ_LEDGER_TIP },
                h('div', { style: css.metaLabel }, '今日分模型消耗（' + snap.todayTokens.calls + ' 次调用）'),
                snap.todayTokens.perModel.map((pm, i) => h('div', { key: i, style: css.tierRow },
                  h('span', { style: { minWidth: 140 } }, pm.model),
                  h('span', { style: css.metaValue }, fmtTok(pm.tokens) + ' tok'),
                  h('span', { style: { ...css.metaValue, minWidth: 70, textAlign: 'right' } }, '≈' + fmtYuan(pm.credits)))))
              : null,
            Array.isArray(snap.tiers) && snap.tiers.length > 1 ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
              h('div', { style: css.metaLabel }, '各窗口用量'),
              snap.tiers.map((t, i) => h('div', { key: i, style: css.tierRow },
                h('span', { style: { minWidth: 110 } }, `${t.tier || '?'} · ${t.windowType || ''}`),
                h('div', { style: { flex: 1 } }, h(Bar, { pct: t.usedPct })),
                h('span', { style: { ...css.metaLabel, minWidth: 60, textAlign: 'right' } }, t.usedPct != null ? t.usedPct + '%' : '—')))) : null,
            Array.isArray(snap.harnessAllowances) && snap.harnessAllowances.length ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 6 } },
              h('div', { style: css.metaLabel }, 'Harness 附赠工具额度'),
              snap.harnessAllowances.map((a, i) => h('div', { key: i, style: css.tierRow },
                h('span', { style: { minWidth: 140 } }, a.toolName || '?'),
                h('span', { style: css.metaValue }, `${fmtNum(a.remainingQuota)} / ${fmtNum(a.totalQuota)} ${a.quotaUnit || ''}`)))) : null,
            isEstimate ? h('div', { style: css.hint },
              `基于本机已发生的真实模型调用 usage × 公开费率估算（${fmtNum(snap.measuredCalls)} 次调用，自 ${fmtTime(snap.windowSince)}）。`,
              snap.ratesUnverified ? ' 逐模型费率表未完全核实，仅供参考。' : '',
              ' 本插件不会为探测额度而发起任何模型调用。') : null,
          ) : h('div', { style: css.card },
            h('div', { style: css.hint }, state ? '暂无额度数据。' : '加载中…'),
            state && state.lastError ? h('div', { style: css.err },
              '最近一次取数失败：' + (state.lastError.reason || '') + (state.lastError.detail ? '（' + state.lastError.detail + '）' : '')) : null,
            (state && (state.cliStatus || '').startsWith('unavailable')) ? h('div', { style: { display: 'flex', flexDirection: 'column', gap: 8 } },
              h('div', { style: css.hint },
                state.cliStatus.includes('cli-not-installed')
                  ? '未检测到 qianwen CLI。安装并登录后可显示官方真实额度：'
                  : 'qianwen CLI 未登录（或登录态失效）。执行登录后面板将自动恢复真值：'),
              h('div', { style: css.code },
                h('span', null, state.cliStatus.includes('cli-not-installed') ? 'npm i -g @qianwenai/qianwen-cli' : 'qianwen auth login'),
                h(CopyBtn, { text: state.cliStatus.includes('cli-not-installed') ? 'npm i -g @qianwenai/qianwen-cli' : 'qianwen auth login' }))) : null,
            state && state.gatewayProbed ? h('div', { style: css.metaLabel },
              'sk-sp 网关额度端点探测：' + (state.gatewayProbed.available ? '命中' : '未发现可用端点（与 t1 侦察结论一致）')) : null),

          h('div', { style: css.metaLabel },
            'sk-sp 密钥仅经环境变量在本机解析（QWEN_TOKEN_PLAN_CN_API_KEY）；面板与日志不回显完整 key。'));
      };
    }

    // ---- v0.2.0 sidebar-footer compact card (same slot family dsh-cost-meter
    // uses: sidebar.footer.action). Polls only this plugin's own state route;
    // renders nothing until the host has data, so a broken host never shows a
    // half-empty card in the sidebar.
    function makeSidebarCard() {
      return function TokenPlanSidebarCard() {
        const [snap, setSnap] = useState(null);
        useEffect(() => {
          let alive = true;
          const load = async () => {
            try {
              const res = await fetch('/api/tokenplan/state');
              const ct = res.headers.get('content-type') || '';
              if (!ct.includes('application/json')) return;
              const j = await res.json();
              if (alive && j && j.snapshot) setSnap(j.snapshot);
            } catch { /* host restarting; keep last data */ }
          };
          void load();
          const t = setInterval(load, 60000);
          return () => { alive = false; clearInterval(t); };
        }, []);
        if (!snap) return null;
        const total = snap.totalCredits;
        const remaining = snap.remainingCredits;
        const est = snap.source === 'estimate';
        const usedPct = snap.usedPct != null ? snap.usedPct
          : (remaining != null && total ? Math.round((total - remaining) / total * 1000) / 10 : null);
        return h('div', { style: sbCss.card, 'data-tpq-card': '', title: '千问 Token Plan — 剩余 / 今日使用 / 夜间折扣（点设置→插件页看详情）' },
          h('div', { style: sbCss.head },
            h('span', { style: sbCss.title }, 'Token Plan'),
            snap.tierLabel ? h('span', { style: sbCss.tier }, snap.tierLabel) : null),
          remaining != null ? h('div', { style: sbCss.bigRow },
            h('span', { style: sbCss.big }, (est ? '≈' : '') + fmtNum(remaining)),
            h('span', { style: sbCss.total }, total ? '/ ' + fmtNum(total) : 'Credits')) : h('div', { style: sbCss.total }, '暂无数据'),
          usedPct != null ? h('div', { style: sbCss.barOuter },
            h('div', { style: { height: '100%', width: usedPct + '%', background: usedPct >= 90 ? T.danger : usedPct >= 70 ? T.warn : T.ok, borderRadius: 999, transition: 'width .3s ease' } })) : null,
          h('div', { style: sbCss.row },
            h('span', null, '今日使用'),
            h('span', { style: sbCss.val }, snap.usedTodayCredits != null ? (est ? '≈' : '') + fmtNum(snap.usedTodayCredits) : '—')),
          // v0.2.3: today's token count + model-rate converted price (老大 m01525)
          snap.todayTokens ? h('div', { style: sbCss.row, title: TPQ_LEDGER_TIP },
            h('span', null, '今日 token'),
            h('span', { style: sbCss.val }, fmtTok(snap.todayTokens.totalTokens)
              + ' ≈' + fmtYuan(snap.todayTokens.credits))) : null,
          h(NightBar, { compact: true }));
      };
    }

    return {
      inject: ['slots'],
      apply(pluginCtx) {
        // Keep the rest of the plugin alive if a future host drops/renames the slot.
        try {
          const Panel = makePanel();
          pluginCtx.slots.inject('settings.plugins.tab', () => pluginCtx.slots.register({
            name: 'settings.plugins.tab', id: 'tokenplan-quota', order: 70, label: 'Token Plan 额度',
          }, Panel));
        } catch { /* no settings plugins slot on this host */ }
        // v0.2.0: compact quota card next to dsh-cost-meter in the sidebar footer.
        // v0.2.2: card takes its OWN full-width row (老大 m01497: 与远程控制按钮垂直排布).
        try {
          if (typeof document !== 'undefined' && !document.getElementById('tokenplan-quota-sidebar-css')) {
            const st = document.createElement('style');
            st.id = 'tokenplan-quota-sidebar-css';
            st.textContent = [
              // our slot item fills the whole row: flex-basis 100% forces a wrap onto its own line
              '[data-slot="sidebar.footer.action"]:has(>[data-tpq-card]){flex:1 1 100%!important;max-width:100%;min-width:0;grid-column:1/-1}',
              // the footer flex container must be allowed to wrap (same :has trick dsh-cost-meter uses)
              'div:has(>[data-slot="sidebar.footer.action"]>[data-tpq-card]){flex-wrap:wrap}',
              'div:has(>div>[data-slot="sidebar.footer.action"]>[data-tpq-card]){flex-wrap:wrap}',
            ].join('\n');
            document.head.appendChild(st);
          }
          const Card = makeSidebarCard();
          pluginCtx.slots.inject('sidebar.footer.action', () => pluginCtx.slots.register({
            name: 'sidebar.footer.action', id: 'tokenplan-quota', order: 2,
          }, Card));
        } catch { /* no sidebar footer slot on this host */ }
      },
    };
  },
});
}
