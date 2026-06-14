// Cmd-K / Ctrl-K command palette. On-demand actions + AI assistant,
// deliberately non-persistent to stay faithful to "inbox on mute".
//
// Reuses the cheat-overlay visual pattern. Exposes window.commandPalette
// = { open, close } so the global keyboard handler in app.js can trigger it.

import { api } from '/static/api.js';

const t = (k, v) => (window.t ? window.t(k, v) : k);

export function initCommandPalette({ navigate }) {
  // ── DOM ──────────────────────────────────────────────────────────
  const overlay = document.createElement('div');
  overlay.id = 'cmdk-overlay';
  overlay.className = 'cmdk-overlay hidden';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.innerHTML = `
    <div class="cmdk-card">
      <div class="cmdk-search">
        <i data-lucide="search" class="w-4 h-4"></i>
        <input id="cmdk-input" type="text" autocomplete="off" spellcheck="false"
               placeholder="${t('cmdk.placeholder')}" aria-label="${t('cmdk.placeholder')}" />
      </div>
      <ul id="cmdk-list" class="cmdk-list" role="listbox"></ul>
      <div id="cmdk-result" class="cmdk-result hidden"></div>
    </div>`;
  document.body.appendChild(overlay);

  const input = overlay.querySelector('#cmdk-input');
  const list = overlay.querySelector('#cmdk-list');
  const result = overlay.querySelector('#cmdk-result');

  // ── Command registry ─────────────────────────────────────────────
  // `when` gates visibility (e.g. AI commands hidden when AI is off).
  function commands() {
    const cmds = [
      { id: 'go-inbox', icon: 'inbox', label: t('cmdk.go_inbox'), run: () => navigate('#/inbox') },
      { id: 'go-dashboard', icon: 'activity', label: t('cmdk.go_dashboard'), run: () => navigate('#/dashboard') },
      { id: 'go-cleanup', icon: 'sparkles', label: t('cmdk.go_cleanup'), run: () => navigate('#/cleanup') },
      { id: 'go-settings', icon: 'settings', label: t('cmdk.go_settings'), run: () => navigate('#/settings') },
      { id: 'sync', icon: 'refresh-cw', label: t('cmdk.sync'), run: async () => {
          try { await api.triggerSync(); window.toast?.(t('cmdk.sync_started')); }
          catch (e) { window.toast?.(e.message); }
        } },
      { id: 'needs-reply', icon: 'reply', label: t('cmdk.needs_reply'),
        run: () => navigate('#/inbox?reply=1') },
      { id: 'theme', icon: 'moon', label: t('cmdk.theme'), run: () => document.getElementById('theme-toggle')?.click() },
      { id: 'search', icon: 'search', label: t('cmdk.search'), run: () => {
          navigate('#/inbox');
          setTimeout(() => document.querySelector('[data-role="search"]')?.focus(), 60);
        } },
    ];
    if (window.aiEnabled) {
      cmds.push(
        { id: 'ai-today', icon: 'sparkles', ai: true, label: t('cmdk.ai_today'),
          run: () => runAssistant(t('cmdk.ai_today_prompt')) },
        { id: 'ai-pending', icon: 'sparkles', ai: true, label: t('cmdk.ai_pending'),
          run: () => runAssistant(t('cmdk.ai_pending_prompt')) },
      );
    }
    return cmds;
  }

  let filtered = [];
  let active = 0;

  function render() {
    const q = input.value.trim().toLowerCase();
    const all = commands();
    // Free-text starting with a non-command word becomes an "ask AI" entry.
    filtered = all.filter((c) => !q || c.label.toLowerCase().includes(q));
    if (q && window.aiEnabled && !filtered.some((c) => c.ai)) {
      filtered.push({ id: 'ai-ask', icon: 'sparkles', ai: true,
        label: t('cmdk.ask', { q: input.value.trim() }),
        run: () => runAssistant(input.value.trim()) });
    }
    if (active >= filtered.length) active = 0;
    list.innerHTML = filtered.map((c, i) => `
      <li class="cmdk-item ${i === active ? 'active' : ''}" data-i="${i}" role="option">
        <i data-lucide="${c.icon}" class="w-4 h-4"></i>
        <span>${c.label}</span>
        ${c.ai ? `<span class="cmdk-tag">IA</span>` : ''}
      </li>`).join('');
    window.lucide?.createIcons?.();
  }

  async function runAssistant(message) {
    result.classList.remove('hidden');
    result.textContent = t('cmdk.thinking');
    try {
      const r = await api.assistantAsk(message);
      result.textContent = r.text || '—';
    } catch (e) {
      result.textContent = e.status === 409 ? t('cmdk.ai_off') : (e.message || String(e));
    }
  }

  function exec(i) {
    const c = filtered[i];
    if (!c) return;
    if (c.ai) { c.run(); return; }       // keep palette open to show result
    close();
    c.run();
  }

  // ── Open / close ─────────────────────────────────────────────────
  function open() {
    overlay.classList.remove('hidden');
    input.value = '';
    active = 0;
    result.classList.add('hidden');
    result.textContent = '';
    render();
    setTimeout(() => input.focus(), 0);
  }
  function close() { overlay.classList.add('hidden'); }

  input.addEventListener('input', () => { active = 0; render(); });
  overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });
  list.addEventListener('click', (e) => {
    const li = e.target.closest('.cmdk-item');
    if (li) exec(parseInt(li.dataset.i, 10));
  });
  overlay.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); close(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); active = Math.min(active + 1, filtered.length - 1); render(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(active - 1, 0); render(); }
    else if (e.key === 'Enter') { e.preventDefault(); exec(active); }
  });

  window.commandPalette = { open, close };
}
