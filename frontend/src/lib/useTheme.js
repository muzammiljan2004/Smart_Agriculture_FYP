import { useCallback, useEffect, useState } from 'react'
import { applyTheme, readTheme, resolvedTheme, setTheme, THEME_KEY } from './theme'

/** Shared theme state for a portal's toggle button.
 *
 * `toggle` flips between light and dark, resolving 'system' first, so one click
 * always does the visible thing. The three-way choice (including 'system')
 * stays in the government portal's Settings screen -- a header button with
 * three states makes the viewer click twice to find out what the third one is.
 *
 * The storage listener is what keeps two open tabs agreeing: localStorage fires
 * `storage` in every OTHER tab on the origin, so the farmer app in one tab
 * follows a change made in the researcher portal in another.
 */
export function useTheme() {
  const [theme, set] = useState(readTheme)

  useEffect(() => { applyTheme(theme) }, [theme])

  useEffect(() => {
    const onStorage = (e) => {
      if (e.key === THEME_KEY) set(readTheme())
    }
    // A viewer on 'system' has to follow the OS flipping at sunset, which the
    // attribute alone cannot do -- the CSS media query handles the paint, but
    // the button's own icon would otherwise go stale.
    const mq = window.matchMedia('(prefers-color-scheme: dark)')
    const onScheme = () => set((t) => t)
    window.addEventListener('storage', onStorage)
    mq.addEventListener?.('change', onScheme)
    return () => {
      window.removeEventListener('storage', onStorage)
      mq.removeEventListener?.('change', onScheme)
    }
  }, [])

  const toggle = useCallback(() => {
    set(setTheme(resolvedTheme(readTheme()) === 'dark' ? 'light' : 'dark'))
  }, [])

  return { theme, resolved: resolvedTheme(theme), toggle, set: (t) => set(setTheme(t)) }
}
