/** Tailwind config for the self-hosted (vendored) build.
 *
 * Mirrors the theme that used to live inline in index.html under the
 * cdn.tailwindcss.com runtime. Regenerate the stylesheet with the standalone
 * CLI (no Node needed):
 *
 *   tailwindcss -c tailwind.config.js -i tailwind-input.css -o tailwind.css --minify
 *
 * The custom colours are aliases of the CSS variables defined in style.css so
 * `bg-bg`, `text-ink`, … keep resolving to the active theme.
 */
module.exports = {
  darkMode: ['selector', '[data-theme="dark"]'],
  content: ['./*.html', './*.js'],
  theme: {
    extend: {
      fontFamily: {
        sans: ['Plus Jakarta Sans', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['JetBrains Mono', 'ui-monospace', 'monospace'],
      },
      colors: {
        bg:         'var(--bg)',
        surface:    'var(--surface)',
        surface2:   'var(--surface-2)',
        ink:        'var(--text)',
        muted:      'var(--muted)',
        line:       'var(--border)',
        accent:     'var(--accent)',
        accentSoft: 'var(--accent-soft)',
        danger:     'var(--danger)',
        warning:    'var(--warning)',
        success:    'var(--success)',
      },
      boxShadow: {
        card: '0 1px 2px rgba(15, 23, 42, 0.04), 0 1px 1px rgba(15, 23, 42, 0.03)',
        pop:  '0 12px 32px -8px rgba(15, 23, 42, 0.18), 0 4px 12px -4px rgba(15, 23, 42, 0.08)',
      },
    },
  },
};
