import { useCallback, useEffect, useRef, useState } from 'react'
import { API, authHeader, getJSON } from '../lib/api'

/** Prediction, suitability and the field time series for one farm.
 *
 * WHY THIS IS ONE HOOK. The old Dashboard held all of this as local state in a
 * single 793-line component. Splitting the UI into eight pages without also
 * lifting the fetches would have meant each page refetching the same
 * prediction, so the state moved up here and the pages became presentational.
 * The fetch logic itself -- the effects, the error handling, the `alive` guard,
 * the refresh-then-retry flow -- is the original, moved rather than rewritten.
 *
 * Suitability is fetched separately from the prediction, not folded into it:
 * the first call for a farm builds its land profile -- one Earth Engine call
 * and ten Open-Meteo calls -- so blocking the yield number behind it would make
 * the whole app feel broken on a farm's first visit.
 */
export function useFarmData(farm) {
  const [pred, setPred] = useState(null)
  const [err, setErr] = useState(null)
  const [suit, setSuit] = useState(null)
  const [suitErr, setSuitErr] = useState(null)
  const [series, setSeries] = useState(null)
  const [seriesErr, setSeriesErr] = useState(null)
  const [fetching, setFetching] = useState(false)
  const [attempt, setAttempt] = useState(0)

  const id = farm?.id

  useEffect(() => {
    if (!id) return
    let alive = true
    setSuit(null)
    setSuitErr(null)
    getJSON('/farms/' + id + '/suitability')
      .then((d) => alive && setSuit(d))
      .catch((e) => alive && setSuitErr(e.message))
    return () => { alive = false }
  }, [id])

  useEffect(() => {
    if (!id) return
    let alive = true
    setPred(null)
    setErr(null)
    getJSON('/farms/' + id + '/predict')
      .then((d) => alive && setPred(d))
      .catch((e) => alive && setErr(e.message))
    return () => { alive = false }   // a stale response must not overwrite newer state
  }, [id, attempt])

  useEffect(() => {
    if (!id) return
    let alive = true
    setSeries(null)
    setSeriesErr(null)
    getJSON('/farms/' + id + '/timeseries')
      .then((d) => alive && setSeries(d))
      .catch((e) => alive && setSeriesErr(e.message))
    return () => { alive = false }
  }, [id, attempt])

  /** Fetch this field's imagery from Earth Engine, then re-run everything.
   *
   * `err` is deliberately NOT cleared here: it is what keeps the calling
   * panel mounted. On success the effects above clear it; on failure the catch
   * replaces it. Either way the user is never left looking at a bare skeleton.
   */
  const refreshImagery = useCallback(async () => {
    if (!id) return
    setFetching(true)
    try {
      const r = await fetch(API + '/farms/' + id + '/timeseries?refresh=true',
        { headers: await authHeader() })
      const body = await r.json()
      if (!r.ok) throw new Error(body.detail ?? 'HTTP ' + r.status)
      setAttempt((n) => n + 1)
    } catch (e) {
      setErr(e.message === 'Failed to fetch'
        ? `Cannot reach the service at ${API}.` : e.message)
    } finally {
      setFetching(false)
    }
  }, [id])

  return { pred, err, suit, suitErr, series, seriesErr, fetching, refreshImagery }
}

/** Counts from 0 to `to` once, on mount and whenever `to` changes. */
export function useCountUp(to, ms = 900) {
  const [n, setN] = useState(0)
  const raf = useRef()
  useEffect(() => {
    if (to == null) return
    const t0 = performance.now()
    const tick = (t) => {
      const p = Math.min(1, (t - t0) / ms)
      setN(to * (1 - Math.pow(1 - p, 3)))   // ease-out cubic
      if (p < 1) raf.current = requestAnimationFrame(tick)
    }
    raf.current = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(raf.current)
  }, [to, ms])
  return n
}
