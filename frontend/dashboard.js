import {
  api,
  avatarColor, initials, senderName, avatarImgHtml,
  shortDate, escapeHtml,
  CATEGORY_LABEL, CATEGORY_COLOR, scoreClass,
} from '/static/api.js';

export async function mountDashboard(host, opts) {
  const t = window.t || ((k) => k);
  host.innerHTML = `
    <div class="dash">
      <div class="dash-head">
        <div style="display:flex;align-items:baseline;gap:12px;flex-wrap:wrap">
          <h1>${t('dash.title')}</h1>
        </div>
        <div style="display:flex;gap:10px;align-items:center">
        </div>
      </div>

      <div class="dash-grid">
        <!-- 1. Accounts strip -->
        <section class="card col-12">
          <h3>
            <span style="display:flex;align-items:center;gap:8px">
              <i data-lucide="server" class="w-4 h-4"></i>${t('dash.accounts.synced')}
            </span>
            <span class="sub" id="acc-summary">—</span>
          </h3>
          <div class="acc-strip" id="acc-strip"></div>
        </section>

        <!-- 3. Categories donut -->
        <section class="card col-4">
          <h3>
            <span style="display:flex;align-items:center;gap:8px">
              <i data-lucide="pie-chart" class="w-4 h-4"></i>${t('dash.donut.title')}
            </span>
          </h3>
          <div class="donut-wrap">
            <svg class="donut" id="donut" viewBox="0 0 100 100" aria-label="${t('dash.donut.aria')}"></svg>
            <div class="donut-legend" id="donut-legend"></div>
          </div>
        </section>

        <!-- 7. 24h reception heatmap (vertical) -->
        <section class="card col-2 hm-card">
          <h3>
            <span style="display:flex;align-items:center;gap:6px">
              <i data-lucide="clock" class="w-4 h-4"></i>${t('dash.heatmap.title')}
            </span>
            <span class="sub" id="hm-summary">—</span>
          </h3>
          <div class="hm-vert" id="hm-row"></div>
        </section>

        <!-- 5. Actionable -->
        <section class="card col-6">
          <h3>
            <span style="display:flex;align-items:center;gap:8px">
              <i data-lucide="zap" class="w-4 h-4"></i>${t('dash.todo.title')}
            </span>
            <span class="sub" id="todo-count">—</span>
          </h3>
          <div class="todo-list" id="todo-list"></div>
        </section>

        <!-- 2. AI queue + throughput -->
        <section class="card col-6">
          <h3>
            <span style="display:flex;align-items:center;gap:8px">
              <i data-lucide="cpu" class="w-4 h-4"></i>${t('dash.queue.title')}
            </span>
            <button class="dash-link" id="btn-run-queue" title="${t('dash.queue.run_title')}">
              <i data-lucide="cpu" class="w-3.5 h-3.5" id="btn-run-queue-icon"></i>
              <span id="btn-run-queue-label">${t('dash.queue.run_label')}</span>
            </button>
          </h3>
          <div style="display:flex;gap:16px;margin-bottom:10px;flex-wrap:wrap">
            <div class="kpi" style="flex:1;min-width:120px">
              <span class="num" id="kpi-pending">0</span>
              <span class="lbl">${t('dash.queue.pending')}</span>
            </div>
            <div class="kpi" style="flex:1;min-width:120px">
              <span class="num" id="kpi-cost">—</span>
              <span class="lbl" id="kpi-cost-lbl">${t('dash.queue.cost_estimated')}</span>
            </div>
          </div>
          <div class="spark-wrap">
            <svg class="spark" id="spark" viewBox="0 0 600 100" preserveAspectRatio="none" aria-label="${t('dash.queue.spark_aria')}"></svg>
            <div class="spark-tip" id="spark-tip"></div>
          </div>
          <div class="sub" style="margin-top:6px;display:flex;justify-content:space-between">
            <span id="kpi-throughput">—</span>
            <span id="kpi-peak">—</span>
          </div>
        </section>

        <!-- 4. Account activity bar chart -->
        <section class="card col-6">
          <h3>
            <span style="display:flex;align-items:center;gap:8px">
              <i data-lucide="inbox" class="w-4 h-4"></i>${t('dash.acc_bars.title')}
            </span>
            <span class="sub" id="acc-bar-sub"></span>
          </h3>
          <div class="acc-bars" id="acc-bars"></div>
        </section>

        <!-- 6. Top senders (cleanup hook) -->
        <section class="card col-7">
          <h3>
            <span style="display:flex;align-items:center;gap:8px">
              <i data-lucide="user-round" class="w-4 h-4"></i>${t('dash.top.title')}
            </span>
            <a href="#/cleanup?tab=senders" class="dash-link" id="dash-top-link" title="${t('dash.top.see_all_title')}">
              <span>${t('dash.top.see_all')}</span>
              <i data-lucide="arrow-right" class="w-3.5 h-3.5"></i>
            </a>
          </h3>
          <div class="top-senders" id="top-senders">
            <div class="sub" style="font-style:italic">${t('dash.loading')}</div>
          </div>
        </section>

        <!-- 8. Unsubscribe quick action (cleanup hook) -->
        <section class="card col-5">
          <h3>
            <span style="display:flex;align-items:center;gap:8px">
              <i data-lucide="mail-x" class="w-4 h-4"></i>${t('dash.unsub.title')}
            </span>
            <span class="sub" id="unsub-sub">—</span>
          </h3>
          <div class="unsub-card" id="unsub-card">
            <div class="sub" style="font-style:italic">${t('dash.loading')}</div>
          </div>
        </section>

      </div>
    </div>
  `;

  const $ = (s) => host.querySelector(s);

  const state = {
    prevRunning: false,
  };

  // ── Accounts strip ────────────────────────────────────────
  function ageBucket(iso) {
    if (!iso) return 'cold';
    const d = new Date(iso.replace(' ', 'T') + (iso.endsWith('Z') ? '' : 'Z'));
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 15 * 60) return 'fresh';
    if (diff < 60 * 60) return 'stale';
    return 'cold';
  }
  function relativeShort(iso) {
    if (!iso) return t('dash.accounts.never');
    const d = new Date(iso.replace(' ', 'T') + (iso.endsWith('Z') ? '' : 'Z'));
    const diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60)    return t('time.short.s', { n: Math.floor(diff) });
    if (diff < 3600)  return t('time.short.m', { n: Math.floor(diff / 60) });
    if (diff < 86400) return t('time.short.h', { n: Math.floor(diff / 3600) });
    return t('time.short.d', { n: Math.floor(diff / 86400) });
  }

  function renderAccounts(s) {
    $('#acc-summary').textContent = t('dash.accounts.summary', {
      count: s.accounts.length,
      pending: s.queue_pending,
    });
    $('#acc-strip').innerHTML = s.accounts.map((a) => {
      const ini = initials(a.email);
      const col = avatarColor(a.email);
      const bucket = ageBucket(a.last_sync);
      const rel = a.last_sync
        ? t('dash.accounts.ago', { rel: relativeShort(a.last_sync) })
        : t('dash.accounts.never');
      const badge = a.unread > 0 ? `<span class="b">${a.unread}</span>` : '';
      return `
        <span class="acc-chip ${bucket}" title="${escapeHtml(a.name)} · ${escapeHtml(a.email)} · sync ${rel}">
          <span class="av" style="background:${col}">${escapeHtml(ini)}</span>
          <span class="acc-name">${escapeHtml(a.name)}</span>
          <span class="acc-dot"></span>
          ${badge}
        </span>
      `;
    }).join('');
  }

  // ── AI cost formatting ────────────────────────────────────
  function formatCostUsd(usd) {
    if (usd <= 0)    return '0 ¢';
    if (usd < 0.001) return '< 0.1 ¢';
    if (usd < 0.01)  return `${(usd * 100).toFixed(2)} ¢`;
    if (usd < 1)     return `${(usd * 100).toFixed(1)} ¢`;
    return `$${usd.toFixed(2)}`;
  }

  // ── Queue + throughput ────────────────────────────────────
  function renderQueue(s) {
    $('#kpi-pending').textContent = s.queue_pending;

    // Running indicator on the queue button
    const btn   = $('#btn-run-queue');
    const icon  = $('#btn-run-queue-icon');
    const label = $('#btn-run-queue-label');
    if (s.running) {
      btn.disabled = true;
      icon.setAttribute('data-lucide', 'loader-2');
      icon.classList.add('icon-spin');
      label.textContent = t('dash.queue.running');
    } else {
      btn.disabled = false;
      icon.setAttribute('data-lucide', 'cpu');
      icon.classList.remove('icon-spin');
      label.textContent = t('dash.queue.run_label');
    }
    window.lucide?.createIcons({ nodes: [btn] });

    // Daily 30-day buckets (primary view)
    const daily    = s.throughput_30d || [];
    const total30d = daily.reduce((a, b) => a + b, 0);
    const peakDay  = Math.max(0, ...daily);

    $('#kpi-throughput').textContent = t('dash.queue.throughput_30d', { total: total30d });
    $('#kpi-peak').textContent       = t('dash.queue.peak_per_day',   { n: peakDay });

    // Cost: hidden in no-AI mode (nothing to bill), real if token data
    // exists, else placeholder dash.
    const costKpi = $('#kpi-cost')?.closest('.kpi');
    if (!window.aiEnabled) {
      if (costKpi) costKpi.style.display = 'none';
    } else {
      if (costKpi) costKpi.style.display = '';
      const tokens  = s.tokens_30d || { tokens_in: 0, tokens_out: 0 };
      const hasReal = tokens.tokens_in > 0 || tokens.tokens_out > 0;
      $('#kpi-cost').textContent     = hasReal ? formatCostUsd(s.cost_30d_usd || 0) : '—';
      $('#kpi-cost-lbl').textContent = t('dash.queue.cost_real');
    }

    drawSpark(daily, 'day');
  }

  function drawSpark(values, unit = 'min') {
    const svg = $('#spark');
    const tip = $('#spark-tip');
    const W = 600, H = 100, P = 4;
    if (!values.length) { svg.innerHTML = ''; return; }
    const max = Math.max(1, ...values);
    const dx = (W - 2 * P) / (values.length - 1 || 1);
    const points = values.map((v, i) => {
      const x = P + i * dx;
      const y = H - P - ((v / max) * (H - 2 * P));
      return [x, y];
    });
    const linePath = points.map((p, i) => `${i ? 'L' : 'M'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
    const areaPath = `${linePath} L${points[points.length - 1][0].toFixed(1)},${H - P} L${points[0][0].toFixed(1)},${H - P} Z`;
    const grid = `<line class="grid" x1="${P}" y1="${H - P}" x2="${W - P}" y2="${H - P}" />`;
    svg.innerHTML = `${grid}<path class="area" d="${areaPath}"/><path class="line" d="${linePath}"/><line class="spark-cursor" id="spark-cursor" x1="0" y1="0" x2="0" y2="${H}" style="display:none"/>`;

    // Build day labels for tooltip
    const now = new Date();
    const wrap = svg.closest('.spark-wrap');
    wrap.addEventListener('mousemove', (e) => {
      const rect = svg.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const ratio = Math.max(0, Math.min(1, px / rect.width));
      const idx = Math.round(ratio * (values.length - 1));
      const svgX = P + idx * dx;
      const cursor = svg.querySelector('.spark-cursor');
      cursor.setAttribute('x1', svgX); cursor.setAttribute('x2', svgX);
      cursor.style.display = '';

      let label;
      const localeBcp47 = (window.LULLMAIL_LOCALE || 'fr') === 'en' ? 'en-US' : 'fr-FR';
      if (unit === 'day') {
        const daysAgo = values.length - 1 - idx;
        const d = new Date(now);
        d.setDate(d.getDate() - daysAgo);
        const dayStr = d.toLocaleDateString(localeBcp47, { day: '2-digit', month: 'short' });
        label = t('dash.queue.tip_day', { date: dayStr, n: values[idx] });
      } else {
        label = t('dash.queue.tip_min', { n: idx + 1, v: values[idx] });
      }

      tip.textContent = label;
      const tipW = tip.offsetWidth;
      const left = Math.min(rect.width - tipW - 4, Math.max(4, px - tipW / 2));
      tip.style.left = `${left}px`;
      tip.style.opacity = '1';
    });
    wrap.addEventListener('mouseleave', () => {
      const cursor = svg.querySelector('.spark-cursor');
      if (cursor) cursor.style.display = 'none';
      tip.style.opacity = '0';
    });
  }

  // ── Donut ─────────────────────────────────────────────────
  function renderDonut(byCat) {
    const order = ['important', 'newsletter', 'transactional', 'pending', 'spam', 'other'];
    const data = order
      .map((c) => ({ id: c, value: byCat[c] || 0 }))
      .filter((d) => d.value > 0);
    const total = data.reduce((a, b) => a + b.value, 0);
    const svg = $('#donut');
    const cx = 50, cy = 50, r = 38, sw = 14;
    if (!total) {
      svg.innerHTML = `<circle cx="50" cy="50" r="${r}" fill="none" stroke="var(--border)" stroke-width="${sw}"/>
        <text x="50" y="48" text-anchor="middle" font-size="11" fill="var(--muted)">${t('dash.donut.empty')}</text>`;
      $('#donut-legend').innerHTML = '';
      return;
    }
    const C = 2 * Math.PI * r;
    let offset = -C / 4; // start at top
    const segs = data.map((d) => {
      const len = (d.value / total) * C;
      const seg = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none"
        stroke="${CATEGORY_COLOR[d.id]}" stroke-width="${sw}"
        stroke-dasharray="${len.toFixed(2)} ${(C - len).toFixed(2)}"
        stroke-dashoffset="${offset.toFixed(2)}"
        transform="rotate(0 ${cx} ${cy})"
        style="transition: stroke-dasharray 280ms ease"/>`;
      offset -= len;
      return seg;
    }).join('');

    svg.innerHTML = `
      ${segs}
      <text x="${cx}" y="${cy - 2}" text-anchor="middle" font-size="14" font-weight="800" fill="var(--text)">${total}</text>
      <text x="${cx}" y="${cy + 12}" text-anchor="middle" font-size="8" fill="var(--muted)">${t('dash.donut.unit')}</text>
    `;

    $('#donut-legend').innerHTML = data.map((d) => `
      <div class="row">
        <b class="pip-num" style="color:${CATEGORY_COLOR[d.id]}">${d.value}</b>
        <span>${escapeHtml(CATEGORY_LABEL[d.id] || d.id)}</span>
      </div>
    `).join('');
  }

  // ── Histogram ─────────────────────────────────────────────
  function renderAccBars(accounts) {
    const el = $('#acc-bars');
    if (!el) return;
    const sorted = [...accounts].sort((a, b) => (b.unread || 0) - (a.unread || 0));
    const maxUnread = Math.max(1, ...sorted.map((a) => a.unread || 0));
    const totalUnread = sorted.reduce((s, a) => s + (a.unread || 0), 0);
    $('#acc-bar-sub').textContent = t('dash.acc_bars.unread_total', { n: totalUnread });

    el.innerHTML = sorted.map((a) => {
      const col   = avatarColor(a.email);
      const ini   = initials(a.name || a.email);
      const pct   = Math.max(2, Math.round(((a.unread || 0) / maxUnread) * 100));
      const label = a.name || a.email;
      return `
        <div class="acc-bar-row" title="${escapeHtml(a.email)}">
          <span class="acc-bar-av" style="background:${col}">${escapeHtml(ini)}</span>
          <span class="acc-bar-name">${escapeHtml(label)}</span>
          <div class="acc-bar-track">
            <div class="acc-bar-fill" style="width:${pct}%;background:${col}"></div>
          </div>
          <span class="acc-bar-val">${a.unread || 0}</span>
        </div>`;
    }).join('');
  }

  // ── Actionable list ───────────────────────────────────────
  const TODO_MAX = 3;

  function renderTodo(items) {
    $('#todo-count').textContent = t('dash.todo.count', { n: items.length });
    if (!items.length) {
      $('#todo-list').innerHTML = `
        <div class="todo-empty">
          <div class="todo-empty-icon">
            <i data-lucide="check-check" class="w-5 h-5"></i>
          </div>
          <div class="todo-empty-title">${t('dash.todo.empty_title')}</div>
          <div class="todo-empty-sub">${t('dash.todo.empty_sub')}</div>
        </div>`;
      window.lucide?.createIcons();
      return;
    }
    const visible  = items.slice(0, TODO_MAX);
    const overflow = items.length - visible.length;
    const overflowCard = overflow > 0 ? `
      <div class="todo-item todo-overflow" role="button" tabindex="0" data-overflow="1">
        <i data-lucide="inbox" class="w-4 h-4" style="color:var(--muted)"></i>
        <div class="ti-body">
          <div class="ti-sender" style="color:var(--muted)">${t('dash.todo.overflow', { n: overflow })}</div>
        </div>
        <i data-lucide="arrow-right" class="w-4 h-4" style="color:var(--muted-2)"></i>
      </div>` : '';

    $('#todo-list').innerHTML = visible.map((em) => {
      const sName = senderName(em.sender);
      return `
        <div class="todo-item" data-id="${em.int_id}" role="button" tabindex="0">
          <span class="score-pill ${scoreClass(em.importance_score || 0)}">${em.importance_score || 0}</span>
          <div class="ti-body">
            <div class="ti-sender">${escapeHtml(sName)} ${em.needs_reply ? '<i data-lucide="reply" class="w-3 h-3" style="color:var(--success);vertical-align:-1px"></i>' : ''}</div>
            <div class="ti-subj">${escapeHtml(em.subject || t('dash.todo.no_subject'))}</div>
          </div>
          <i data-lucide="arrow-right" class="w-4 h-4" style="color:var(--muted-2)"></i>
        </div>
      `;
    }).join('') + overflowCard;

    $('#todo-list').querySelectorAll('.todo-item:not(.todo-overflow)').forEach((el) => {
      el.addEventListener('click', () => opts.onRouteChange(`#/inbox?focus=${el.dataset.id}`));
    });
    const overflowEl = $('#todo-list').querySelector('[data-overflow]');
    if (overflowEl) {
      overflowEl.addEventListener('click', () => opts.onRouteChange('#/inbox?sort=score'));
    }
    window.lucide?.createIcons();
  }


  // ── 24h heatmap ───────────────────────────────────────────
  function renderHeatmap(hours) {
    const cont = $('#hm-row');
    const summary = $('#hm-summary');
    if (!cont || !hours || hours.length !== 24) return;

    const max = Math.max(1, ...hours);
    const total = hours.reduce((a, b) => a + b, 0);

    // Rotate to local time: localHours[h] = emails at local hour h.
    const shift = ((-new Date().getTimezoneOffset() / 60) % 24 + 24) % 24;
    const localHours = Array.from({ length: 24 }, (_, h) => hours[(h - shift + 24) % 24]);
    const peakLocal = localHours.indexOf(Math.max(...localHours));

    summary.textContent = t('dash.heatmap.peak', { hour: peakLocal });
    const localeIsEn = (window.LULLMAIL_LOCALE || 'fr') === 'en';

    cont.innerHTML = localHours.map((v, h) => {
      const ratio = v / max;
      const barW = Math.max(2, Math.round(ratio * 100));
      const opacity = (0.15 + ratio * 0.85).toFixed(3);
      const showLabel = h % 3 === 0;
      const isPeak = v === max && v > 0;
      const tip = t('dash.heatmap.tooltip', { hour: h, n: v });
      const lblText = showLabel ? (localeIsEn ? h + ':00' : h + 'h') : '';
      return `<div class="hm-vrow${isPeak ? ' hm-vpeak' : ''}" title="${tip}">
        <span class="hm-vlbl">${lblText}</span>
        <div class="hm-vtrack"><div class="hm-vbar" style="width:${barW}%;opacity:${opacity}"></div></div>
      </div>`;
    }).join('');
  }

  // ── Top senders + Unsubscribe (cleanup hooks) ─────────────
  // These two cards use the cleanup endpoints rather than the dashboard
  // payload. They change slowly, so we poll them on a 30 s timer instead
  // of piggy-backing the 2 s status loop.
  function renderTopSenders(senders) {
    const el = $('#top-senders');
    if (!el) return;
    if (!senders || !senders.length) {
      el.innerHTML = `<div class="ts-empty">
        <i data-lucide="inbox" class="w-5 h-5"></i>
        <span>${t('dash.top.empty')}</span>
      </div>`;
      window.lucide?.createIcons({ nodes: [el] });
      return;
    }
    const top = senders.slice(0, 5);
    el.innerHTML = top.map((s) => {
      const av = avatarColor(s.email);
      const ini = initials(s.name || s.email);
      const display = s.name || s.email;
      const pct = Math.max(2, Math.round((s.total / top[0].total) * 100));
      const subBits = [];
      if (s.unread)     subBits.push(t('dash.top.unread',      { n: s.unread }));
      if (s.newsletter) subBits.push(t('dash.top.newsletters', { n: s.newsletter }));
      const sub = subBits.join(' · ') || t('dash.top.totals', { n: s.total });
      return `
        <a class="ts-row" href="#/inbox?q=${encodeURIComponent(s.email)}" title="${t('dash.top.row_title', { name: escapeHtml(display) })}">
          <span class="ts-av" style="background:${av}">
            <span class="av-text">${escapeHtml(ini)}</span>
            ${avatarImgHtml(s.email)}
          </span>
          <div class="ts-body">
            <div class="ts-name" title="${escapeHtml(s.email)}">${escapeHtml(display)}</div>
            <div class="ts-sub">${escapeHtml(sub)}</div>
          </div>
          <div class="ts-bar"><div class="ts-bar-fill" style="width:${pct}%;background:${av}"></div></div>
          <span class="ts-count">${s.total}</span>
        </a>`;
    }).join('');
  }

  function renderUnsubExpress(senders) {
    const card = $('#unsub-card');
    const sub  = $('#unsub-sub');
    if (!card) return;
    const list = senders || [];
    const oneClick = list.filter((x) => x.has_one_click && !x.unsubscribed_at);
    const allActive = list.filter((x) => !x.unsubscribed_at);
    const noisyMails = allActive.reduce((acc, x) => acc + (x.total || 0), 0);

    if (sub) sub.textContent = list.length
      ? t('dash.unsub.detected', { n: list.length })
      : '';

    if (!oneClick.length && !allActive.length) {
      card.innerHTML = `<div class="ux-empty">
        <i data-lucide="check-circle" class="w-5 h-5"></i>
        <div>
          <div class="ux-empty-title">${t('dash.unsub.empty_title')}</div>
          <div class="ux-empty-sub">${t('dash.unsub.empty_sub')}</div>
        </div>
      </div>`;
      window.lucide?.createIcons({ nodes: [card] });
      return;
    }

    // Show top 5 unsubscribe candidates by volume — one-click first, then
    // the rest. Each row is a real list item with avatar + count, like the
    // inbox. The chip-list looked nice but didn't tell users what they were
    // actually about to clean up.
    const ranked = [
      ...oneClick,
      ...allActive.filter((x) => !oneClick.includes(x)),
    ].sort((a, b) => (b.total || 0) - (a.total || 0)).slice(0, 3);

    const rowsHtml = ranked.map((s) => {
      const av = avatarColor(s.email);
      const ini = initials(s.name || s.email);
      const display = s.name || s.email;
      const tag = s.has_one_click
        ? `<span class="ux-tag ok">${t('dash.unsub.tag.oneclick')}</span>`
        : `<span class="ux-tag muted">${t('dash.unsub.tag.manual')}</span>`;
      const subBits = [t('dash.unsub.row.mails', { n: s.total })];
      if (s.unread) subBits.push(t('dash.unsub.row.unread', { n: s.unread }));
      return `
        <a class="ux-row" href="#/cleanup?tab=unsubscribe&sender=${encodeURIComponent(s.email)}" title="${t('dash.unsub.row_title', { name: escapeHtml(display) })}">
          <span class="ts-av" style="background:${av}">
            <span class="av-text">${escapeHtml(ini)}</span>
            ${avatarImgHtml(s.email)}
          </span>
          <div class="ux-row-body">
            <div class="ux-row-name" title="${escapeHtml(s.email)}">${escapeHtml(display)}</div>
            <div class="ux-row-sub">${subBits.join(' · ')}</div>
          </div>
          ${tag}
        </a>`;
    }).join('');

    card.innerHTML = `
      <div class="ux-stats">
        <div class="ux-num-block">
          <span class="ux-num">${oneClick.length}</span>
          <span class="ux-lbl">${t('dash.unsub.kpi.oneclick')}</span>
        </div>
        <div class="ux-num-block subtle">
          <span class="ux-num">${noisyMails}</span>
          <span class="ux-lbl">${t('dash.unsub.kpi.affected')}</span>
        </div>
      </div>
      <div class="ux-list">${rowsHtml}</div>
      <a class="mb-cta ux-cta" href="#/cleanup?tab=unsubscribe">
        <span>${t('dash.unsub.cta_all')}</span>
        <i data-lucide="arrow-right" class="w-4 h-4"></i>
      </a>`;
    window.lucide?.createIcons({ nodes: [card] });
  }

  // ── Polling ───────────────────────────────────────────────
  let timers = [];
  function setupPolling() {
    const tickStatus = async () => {
      if (document.hidden) return;
      try {
        const s = await api.getDashboard();
        renderAccounts(s);
        renderQueue(s);
        renderDonut(s.by_category || {});
        renderAccBars(s.accounts || []);
        renderTodo(s.actionable || []);
        renderHeatmap(s.hours_distribution || []);

        if (state.prevRunning && !s.running) {
          forceRefresh();
        }
        state.prevRunning = s.running;
      } catch (err) {
        console.error('Dashboard poll error:', err);
      }
    };

    const tickCleanup = async () => {
      if (document.hidden) return;
      try {
        const [top, unsub] = await Promise.all([
          api.getTopSenders({ limit: 5 }).catch(() => []),
          api.getUnsubscribeSenders().catch(() => []),
        ]);
        renderTopSenders(top || []);
        renderUnsubExpress(unsub || []);
      } catch (err) {
        console.error('Cleanup card poll error:', err);
      }
    };

    // 5s (was 2s) — /api/dashboard/status chains ~8 SQL queries; going
    // from 30 to 12 polls/min cuts DB load by 60% with no visible UX
    // hit (3s-stale "pending" counters are fine).
    timers.push(setInterval(tickStatus, 5000));
    timers.push(setInterval(tickCleanup, 30000));
    tickStatus();
    tickCleanup();

    const onVis = () => {
      if (!document.hidden) { tickStatus(); tickCleanup(); }
    };
    document.addEventListener('visibilitychange', onVis);
    timers.push({ stop: () => document.removeEventListener('visibilitychange', onVis) });
  }

  async function forceRefresh() {
    try {
      const s = await api.getDashboard();
      renderQueue(s);
      renderDonut(s.by_category || {});
      renderAccBars(s.accounts || []);
      renderTodo(s.actionable || []);
      renderHeatmap(s.hours_distribution || []);
    } catch (_) {}
  }

  // ── Toolbar ───────────────────────────────────────────────
  $('#btn-run-queue').addEventListener('click', async () => {
    try {
      const r = await api.triggerSync();
      window.toast(r.message || t('dash.toast.analysis_started'));
    } catch (err) {
      window.toast(t('dash.toast.error', { msg: err.message }));
    }
  });

  setupPolling();
  window.lucide?.createIcons();

  return () => {
    timers.forEach((t) => {
      if (typeof t === 'number') clearInterval(t);
      else if (t && t.stop) t.stop();
    });
  };
}
