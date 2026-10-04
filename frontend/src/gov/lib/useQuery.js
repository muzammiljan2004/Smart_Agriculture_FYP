import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * One small hook behind every data-fetching screen.
 *
 * Exists so the loading / empty / error contract is written once rather than
 * fifteen times. The brief asks for all three states on every screen, and the
 * reliable way to get that is for there to be only one place they can come
 * from -- see <Panel> in ui.jsx, which consumes exactly this shape.
 *
 * `fn` receives an AbortSignal-like guard through the staleness check below
 * rather than a real signal: supabase-js v2 does not take one, so instead the
 * result of a superseded call is DISCARDED. Without that, switching crop twice
 * quickly can land the first (slower) response last and show the wrong crop's
 * numbers under the right crop's heading.
 */
export function useQuery(fn, deps, { enabled = true } = {}) {
  const [state, setState] = useState({ data: null, error: null, loading: enabled })
  const [nonce, setNonce] = useState(0)
  const seq = useRef(0)

  useEffect(() => {
    if (!enabled) {
      setState({ data: null, error: null, loading: false })
      return
    }
    const mine = ++seq.current
    setState((s) => ({ ...s, loading: true, error: null }))
    Promise.resolve()
      .then(fn)
      .then((data) => {
        if (mine === seq.current) setState({ data, error: null, loading: false })
      })
      .catch((error) => {
        if (mine === seq.current) setState({ data: null, error, loading: false })
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce, enabled])

  const reload = useCallback(() => setNonce((n) => n + 1), [])

  // An empty array and an empty object both mean "loaded, nothing in it". A
  // number or a boolean never does -- 0 is a real answer -- so only
  // collections are tested.
  const d = state.data
  const isEmpty =
    !state.loading && !state.error &&
    (d == null || (Array.isArray(d) && d.length === 0) ||
      (d && typeof d === 'object' && !Array.isArray(d) && Object.keys(d).length === 0))

  return { ...state, isEmpty, reload }
}
