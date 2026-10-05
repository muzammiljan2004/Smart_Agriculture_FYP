import { Badge, Button, Card, CardHead } from './ui'
import { SUIT_STYLE, fmtDate, isNoCrop, isOutOfSeason, isWrongSeason, needsImagery } from '../lib/format'

/* Every component in this file came out of the old 793-line Dashboard.jsx.
   The markup is re-laid-out to match the new designs; the LOGIC -- which
   branches exist, what each one says, and when it shows -- is unchanged,
   because each branch was there for a reason that still holds. */

/** Expected harvest, framed by where the season actually is.
 *
 * `complete` is the case worth having. Without it a rabi crop viewed in
 * September reads "166 days overdue", because the sowing date defaults to the
 * most recent conventional one, which between seasons is LAST season's. The
 * arithmetic is right and the meaning is nonsense -- that crop came off the
 * field months ago. Nothing here observes a harvest; the system has no
 * "I harvested" input, so this says the season is over, not that the farmer
 * definitely cut it.
 */
export function HarvestLine({ g }) {
  const d = g.days_to_harvest
  const state = g.season_state ?? (d < 0 ? 'overdue' : 'growing')
  // A picked crop has no single harvest date, so the first pick is labelled as
  // such -- calling it "harvest" would imply the season ends there.
  const label = g.harvest_style === 'multi' ? 'First pick' : 'Expected harvest'
  const warn = state === 'overdue'
  const done = state === 'complete'

  return (
    <div
      className={
        'mt-5 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 rounded-xl px-4 py-3 ring-1 ' +
        (warn ? 'bg-wheat-300/20 ring-wheat-300/60'
          : done ? 'bg-black/3 ring-black/5'
            : 'bg-leaf-50 ring-leaf-100')
      }
    >
      <span className="text-sm">
        <span className="text-muted">{done ? 'Season ended ' : label + ' '}</span>
        <span className={done ? 'font-semibold text-muted' : 'font-semibold text-leaf-800'}>
          {fmtDate(g.harvest_date)}
        </span>
      </span>
      <span className="tnum text-xs">
        {done ? (
          <span className="text-muted">harvested or cleared · no crop currently tracked</span>
        ) : warn ? (
          <span className="font-semibold text-wheat-500">{-d} days overdue</span>
        ) : (
          <span className="text-muted">in {d} days</span>
        )}
        {!done && g.harvest_style === 'multi' && g.pick_interval_days && (
          <span className="text-muted"> · then every {g.pick_interval_days} days</span>
        )}
      </span>
    </div>
  )
}

/** When to sow a recommended crop. "Grow maize" alone is not actionable. */
export function SowingLine({ s }) {
  return (
    <p className="mt-2 flex flex-wrap items-baseline gap-x-2 text-xs">
      {s.open_now ? (
        <span className="font-semibold text-leaf-700">Sow now</span>
      ) : (
        <span className="text-muted">
          Sow from <span className="font-medium text-ink">{fmtDate(s.window_opens)}</span>{' '}
          <span className="tnum">({s.days_until_window}d)</span>
        </span>
      )}
      <span className="text-muted">
        · window shuts {fmtDate(s.window_closes)} · harvest ~{fmtDate(s.harvest_if_sown_now)}
      </span>
    </p>
  )
}

/** Phenological stage track. Everything comes from the API's growth object. */
export function GrowthTracker({ g, compact = false }) {
  const stages = g.stages ?? []
  const idx = g.stage_index ?? -1

  return (
    <Card>
      <CardHead
        title="Growth stage"
        right={<span className="tnum">Day {g.days_since_sowing} · {g.progress_pct}% of season</span>}
      />

      <p className="mt-3">
        <span className="font-display text-3xl font-semibold text-leaf-700">{g.stage}</span>
        {g.next_stage && (
          <span className="ml-3 text-sm text-muted">
            → {g.next_stage} in ~{g.days_to_next_stage} days
          </span>
        )}
      </p>

      {/* Stage track. Passed stages fill; the current one is marked. */}
      <ol className="mt-6 flex gap-1.5">
        {stages.map((s, i) => (
          <li key={s} className="flex-1">
            <div className={'h-1.5 rounded-full transition ' +
              (i < idx ? 'bg-leaf-400' : i === idx ? 'bg-leaf-900' : 'bg-leaf-100')} />
            <p className={'mt-2 text-[11px] leading-tight ' +
              (i === idx ? 'font-semibold text-leaf-800' : 'text-muted')}>
              {s}
            </p>
          </li>
        ))}
      </ol>

      {g.harvest_date && <HarvestLine g={g} />}

      {!compact && (
        <p className="mt-4 text-xs text-muted">
          Sown {g.planting_date}
          {g.planting_date_estimated && (
            <span className="text-wheat-500">
              {' '}— estimated from the season, not entered by the farmer
            </span>
          )}
          . Calendar-based estimate; not confirmed against satellite imagery.
        </p>
      )}
    </Card>
  )
}

/** Crop suitability. `data` is the /suitability payload, unchanged. */
export function SuitabilityPanel({ data, loading, error, limit }) {
  if (loading) {
    return (
      <Card>
        <CardHead title="Crop suitability" right="FAO classes" />
        <p className="mt-2 text-sm text-muted">
          Reading soil and ten years of climate for this location… the first check takes
          about half a minute, then it is cached.
        </p>
        <div className="mt-4 space-y-2">
          {[0, 1, 2].map((i) => <div key={i} className="h-11 animate-pulse rounded-xl bg-leaf-50" />)}
        </div>
      </Card>
    )
  }
  if (error) {
    return (
      <Card>
        <CardHead title="Crop suitability" right="FAO classes" />
        <p className="mt-2 text-sm text-red-700">{error}</p>
      </Card>
    )
  }
  if (!data) return null

  const { land, results } = data
  const viable = results.filter((r) => r.suitability !== 'excluded')
  const ruled = results.filter((r) => r.suitability === 'excluded')
  const shown = limit ? viable.slice(0, limit) : viable

  return (
    <Card>
      <CardHead title="Crop suitability" right="FAO classes" />

      <p className="mt-2 text-sm text-muted">
        {land.texture} · pH {land.ph?.toFixed(2)} · sand {land.sand_pct?.toFixed(0)}% ·
        rain {land.annual_rain_mm?.toFixed(0)} mm/yr · {land.water_source?.replace(/_/g, ' ')}
        {land.salinity_flag && land.salinity_flag !== 'none' && ` · salinity ${land.salinity_flag}`}
      </p>

      <ul className="mt-4">
        {shown.map((r) => {
          const [cls, label] = SUIT_STYLE[r.suitability] ?? SUIT_STYLE.excluded
          return (
            <li key={r.crop} className="border-b border-leaf-100 py-3 last:border-0">
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded-lg px-2 py-0.5 text-xs font-semibold ring-1 ${cls}`}>
                  {r.suitability}
                </span>
                <span className="font-medium capitalize">{r.crop}</span>
                {r.sowing && !limit && (
                  <span className="text-xs text-muted">
                    {r.sowing.open_now ? 'Sow now' : `Sow ${fmtDate(r.sowing.window_opens)}`}
                  </span>
                )}
                {r.crop === data.current_crop && (
                  <Badge tone="grey">growing now</Badge>
                )}
                <span className="ml-auto text-sm text-muted">{label}</span>
              </div>
              {!limit && (
                <>
                  {r.rotation?.effect === 'good' && (
                    <p className="mt-1.5 text-xs text-leaf-700">+ {r.rotation.reason}</p>
                  )}
                  {r.limitations?.map((l, i) => (
                    <p key={i} className="mt-1.5 text-xs text-wheat-500">! {l}</p>
                  ))}
                  {r.sowing && <SowingLine s={r.sowing} />}
                </>
              )}
            </li>
          )
        })}
      </ul>

      {limit && viable.length > limit && (
        <p className="mt-3 text-xs text-muted">
          + {viable.length - limit} more crop{viable.length - limit > 1 ? 's' : ''}
          {ruled.length > 0 && ` · ${ruled.length} ruled out`}
        </p>
      )}

      {!limit && ruled.length > 0 && (
        <details className="mt-4">
          <summary className="cursor-pointer text-sm text-muted">
            {ruled.length} crop{ruled.length > 1 ? 's' : ''} ruled out — and why
          </summary>
          <ul className="mt-2 space-y-1.5">
            {ruled.map((r) => (
              <li key={r.crop} className="text-xs text-muted">
                <span className="font-medium capitalize text-ink">{r.crop}</span> — {r.excluded_reason}
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* Honesty badge. Most thresholds are seed values not yet checked against
          a Punjab source, and the panel says so rather than implying authority. */}
      {!limit && data.thresholds_unverified?.length > 0 && (
        <p className="mt-4 rounded-xl bg-wheat-300/20 px-3.5 py-2.5 text-[11px] leading-relaxed text-wheat-500 ring-1 ring-wheat-300/40">
          <strong className="font-semibold">Provisional thresholds.</strong> Tolerance ranges for{' '}
          {data.thresholds_unverified.join(', ')} are starting values awaiting agronomist review.
          Wheat and rice are the calibrated ones.
        </p>
      )}
    </Card>
  )
}

/** What to show in place of a prediction, and the button that fixes it.
 *
 * Four distinct refusals reach here and each needs a different sentence,
 * because each needs a different action from the farmer. Collapsing them into
 * one message is what used to send people to re-fetch imagery they already had.
 */
export function PredictionGate({ err, fetching, onFetch, crop }) {
  const wants = needsImagery(err)
  const show = wants || fetching
  const muted = 'text-muted'

  if (!show) {
    return (
      <div className="max-w-2xl">
        <p className="font-display text-2xl font-semibold text-ink">
          No prediction yet
        </p>
        <p className={'mt-2 text-sm ' + muted}>{err}</p>
        {isNoCrop(err) && (
          <p className={'mt-2 text-xs ' + muted}>
            A growing field reaches roughly 0.6–0.9 NDVI at peak. This one never does,
            so no yield is reported rather than one read from the crop name.
          </p>
        )}
        {isWrongSeason(err) && (
          <p className={'mt-2 text-xs ' + muted}>
            Correct the sowing date on this farm if it was entered by mistake.
          </p>
        )}
      </div>
    )
  }

  return (
    <div className="max-w-2xl">
      <p className="font-display text-2xl font-semibold text-ink">
        No prediction yet
      </p>
      <p className={'mt-2 text-sm ' + muted}>
        {fetching
          ? 'Reading Sentinel-2 and Sentinel-1 for this field. This usually takes 10–30 seconds.'
          : isOutOfSeason(err)
            ? `The satellite images stored for this field are all from outside the ${crop}
               growing season, so they show bare ground rather than the crop. Fetching the
               season's imagery will fix this.`
            : `No satellite imagery has been collected for this field yet. This takes a few
               seconds and only needs doing once per season.`}
      </p>
      <Button variant="wheat" onClick={onFetch} disabled={fetching} className="mt-4">
        {fetching ? 'Fetching satellite imagery…' : 'Fetch satellite imagery'}
      </Button>
    </div>
  )
}

/** Caveats generated by the API from the real data state, so they disappear on
 *  their own once real training data and PBS yields land. */
export function Caveats({ items }) {
  if (!items?.length) return null
  return (
    <div className="rounded-2xl bg-wheat-300/15 p-5 ring-1 ring-wheat-300/50">
      <p className="text-xs font-semibold uppercase tracking-wide text-wheat-500">
        Read this before quoting the number
      </p>
      <ul className="mt-2 space-y-1.5">
        {items.map((c) => (
          <li key={c} className="flex gap-2 text-sm text-ink/80">
            <span className="text-wheat-500">•</span>{c}
          </li>
        ))}
      </ul>
    </div>
  )
}
