/* One theme preference for the whole product.
 *
 * The machinery already existed: gov.css defines a full dark token set under
 * :root[data-theme="dark"], and under [data-theme="system"] inside a
 * prefers-color-scheme query. What was missing was a way to reach it -- the
 * only control lived in the government portal's Settings screen, so the
 * researcher portal was stuck on whatever the OS said and the farmer app had no
 * dark mode at all. This module is the shared control surface; no stylesheet
 * needed rewriting.
 *
 * ONE KEY ACROSS ALL FOUR ENTRY POINTS, deliberately. They are four Vite inputs
 * on one origin, and a reader who picks light on the landing page and lands in a
 * dark portal reads that as a bug, not as four independent preferences. The old
 * `gov.theme` value is migrated on first read so nobody's existing choice is
 * silently reset.
 *
 * Every localStorage access is wrapped: it throws in a private window and with
 * site data blocked, and a display preference is never worth taking a screen
 * down for. The fallback is 'system', which is also the honest default -- it
 * matches what the viewer's OS already asked for.
 */
export const THEME_KEY = 'sa.theme'
const LEGACY_KEY = 'gov.theme'
export const THEMES = ['light', 'dark', 'system']

/** The stored preference, or 'system' when nothing is stored or storage fails. */
export function readTheme() {
  try {
    const v = localStorage.getItem(THEME_KEY) || localStorage.getItem(LEGACY_KEY)
    return THEMES.includes(v) ? v : 'system'
  } catch {
    return 'system'
  }
}

/** Write the attribute the stylesheets key on. Safe to call before React mounts. */
export function applyTheme(theme = readTheme()) {
  const t = THEMES.includes(theme) ? theme : 'system'
  document.documentElement.setAttribute('data-theme', t)
  return t
}

/** Persist and apply. Returns what was actually applied. */
export function setTheme(theme) {
  const t = applyTheme(theme)
  try { localStorage.setItem(THEME_KEY, t) } catch { /* not persisted; still applied */ }
  return t
}

/** What the viewer actually sees right now, resolving 'system'. */
export function resolvedTheme(theme = readTheme()) {
  if (theme !== 'system') return theme
  try {
    return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}
