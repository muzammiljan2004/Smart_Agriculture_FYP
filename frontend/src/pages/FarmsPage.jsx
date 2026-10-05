import { useEffect, useState } from 'react'
import { getJSON } from '../lib/api'
import { fmtShort, title } from '../lib/format'
import FarmMap from '../components/FarmMap'
import { Badge, Button, Card, CardHead, PageHead, Skeleton } from '../components/ui'

/** One /predict per farm, resolved independently.
 *
 * WHY ONE CALL PER FARM. There is no bulk endpoint, and inventing one would be
 * backend work this page does not need: each call is a model run against rows
 * already in the database, not a satellite fetch. They are fired together and
 * land as they finish, so a slow farm never blocks the others.
 *
 * A failure is kept as a reason string rather than dropped. A card that shows
 * "needs imagery" is useful; a card that silently omits its yield is not.
 */
function useFarmSummaries(farms) {
  const [byId, setById] = useState({})

  useEffect(() => {
    let alive = true
    setById({})
    farms.forEach((f) => {
      getJSON('/farms/' + f.id + '/predict')
        .then((pred) => alive && setById((m) => ({ ...m, [f.id]: { pred } })))
        .catch((e) => alive && setById((m) => ({ ...m, [f.id]: { error: e.message } })))
    })
    return () => { alive = false }
  }, [farms.map((f) => f.id).join(',')])   // eslint-disable-line react-hooks/exhaustive-deps

  return byId
}

function statusOf(s) {
  if (!s) return { tone: 'grey', label: 'Loading…' }
  if (s.error) return { tone: 'grey', label: 'No prediction' }
  const a = s.pred.alerts ?? []
  const crit = a.filter((x) => x.severity === 'critical').length
  if (crit) return { tone: 'red', label: `${crit} critical alert${crit > 1 ? 's' : ''}` }
  if (a.length) return { tone: 'wheat', label: `${a.length} warning${a.length > 1 ? 's' : ''}` }
  return { tone: 'leaf', label: 'Healthy' }
}

export default function FarmsPage({ farms, selectedId, onSelect, onNavigate, onAddFarm }) {
  const [q, setQ] = useState('')
  const summaries = useFarmSummaries(farms)

  const shown = farms.filter((f) =>
    !q || [f.farmer_name, f.district, f.crop_type].join(' ').toLowerCase().includes(q.toLowerCase())
  )
  const totalHa = farms.reduce((s, f) => s + (Number(f.area_hectares) || 0), 0)

  // "Recent activity" is the alerts the per-farm predictions already returned,
  // newest first. No separate feed table exists, and building one would mean a
  // migration; this is the same information from data already on screen.
  const activity = farms.flatMap((f) =>
    (summaries[f.id]?.pred?.alerts ?? []).map((a) => ({ ...a, farm: f.farmer_name }))
  ).sort((x, y) => new Date(y.triggered_at) - new Date(x.triggered_at)).slice(0, 6)

  return (
    <div className="space-y-5">
      <PageHead title="Your farms"
                sub={`${farms.length} farm${farms.length === 1 ? '' : 's'} · ${totalHa.toFixed(1)} ha under monitoring`}>
        <Button variant="dark" onClick={onAddFarm}>+ Add Farm</Button>
      </PageHead>

      <div className="flex flex-wrap items-center gap-3">
        <label className="flex flex-1 items-center gap-2 rounded-xl border border-leaf-200 bg-card px-3.5 py-2.5">
          <svg viewBox="0 0 20 20" className="h-4 w-4 text-muted" fill="none" stroke="currentColor" strokeWidth="1.8">
            <circle cx="9" cy="9" r="6" /><path d="M14 14l4 4" strokeLinecap="round" />
          </svg>
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search farms"
                 className="w-full bg-transparent text-sm outline-none" />
        </label>
      </div>

      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
        {shown.map((f) => {
          const s = summaries[f.id]
          const st = statusOf(s)
          return (
            <Card key={f.id} pad="p-0" className="overflow-hidden">
              <FarmMap farms={f} height="h-36" zoom={15} />
              <div className="p-5">
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="font-display text-lg font-semibold">{f.farmer_name}</h3>
                    <p className="mt-0.5 text-xs text-muted">
                      {f.district} · {f.area_hectares ?? 1} ha · {title(f.crop_type)}
                    </p>
                  </div>
                  {f.id === selectedId && <Badge>Current</Badge>}
                </div>

                <dl className="mt-4">
                  <div className="flex items-baseline justify-between border-b border-leaf-100 py-2.5">
                    <dt className="text-sm text-muted">Predicted yield</dt>
                    <dd className="tnum text-sm font-semibold">
                      {s ? (s.error ? <span className="text-muted">—</span>
                        : `${s.pred.predicted_yield.toFixed(2)} ${s.pred.unit}`) : <Skeleton className="h-3 w-16" />}
                    </dd>
                  </div>
                  <div className="flex items-baseline justify-between border-b border-leaf-100 py-2.5">
                    <dt className="text-sm text-muted">Growth stage</dt>
                    <dd className="text-sm font-semibold">
                      {s ? (s.pred?.growth?.stage ?? '—') : <Skeleton className="h-3 w-20" />}
                    </dd>
                  </div>
                  <div className="flex items-baseline justify-between py-2.5">
                    <dt className="text-sm text-muted">Status</dt>
                    <dd><Badge tone={st.tone}>{st.label}</Badge></dd>
                  </div>
                </dl>

                <div className="mt-4 flex gap-2">
                  <Button onClick={() => { onSelect(f.id); onNavigate('dashboard') }} className="flex-1">
                    View farm
                  </Button>
                  <Button variant="ghost" onClick={() => onSelect(f.id)} className="flex-1"
                          disabled={f.id === selectedId}>
                    {f.id === selectedId ? 'Selected' : 'Switch to this farm'}
                  </Button>
                </div>
              </div>
            </Card>
          )
        })}
        {shown.length === 0 && (
          <Card className="md:col-span-2 xl:col-span-3">
            <p className="text-sm text-muted">No farm matches “{q}”.</p>
          </Card>
        )}
      </div>

      <div className="grid gap-5 lg:grid-cols-5">
        <Card pad="p-0" className="overflow-hidden lg:col-span-3">
          <div className="flex items-baseline justify-between px-6 pb-3 pt-6">
            <h3 className="font-display text-lg font-semibold">Farm locations</h3>
            <span className="text-xs text-muted">{farms.length} farms</span>
          </div>
          <FarmMap farms={farms} height="h-72" />
        </Card>

        <Card className="lg:col-span-2">
          <CardHead title="Recent activity" />
          {activity.length === 0 ? (
            <p className="mt-4 text-sm text-muted">
              Nothing recorded yet. Activity here is drawn from open alerts across your farms.
            </p>
          ) : (
            <ul className="mt-2">
              {activity.map((a) => (
                <li key={a.id} className="flex items-center gap-3 border-b border-leaf-100 py-3 last:border-0">
                  <span className="w-14 shrink-0 text-xs text-muted">{fmtShort(a.triggered_at)}</span>
                  <span className="flex-1 text-sm">
                    <span className="capitalize">{String(a.type).replace(/_/g, ' ')}</span>
                    <span className="text-muted"> · {a.farm}</span>
                  </span>
                  <Badge tone={a.severity === 'critical' ? 'red' : 'wheat'}>{title(a.severity)}</Badge>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card pad="p-0" className="overflow-hidden">
        <h3 className="px-6 pb-4 pt-6 font-display text-lg font-semibold">Farm portfolio</h3>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-y border-leaf-100 text-left text-xs text-muted">
                {['Farm', 'Location', 'Area', 'Crop', 'Season', 'Stage', 'Predicted yield', 'Alerts']
                  .map((h) => <th key={h} className="whitespace-nowrap px-6 py-3 font-medium">{h}</th>)}
              </tr>
            </thead>
            <tbody>
              {shown.map((f) => {
                const s = summaries[f.id]
                const st = statusOf(s)
                return (
                  <tr key={f.id} className="border-b border-leaf-50 last:border-0">
                    <td className="whitespace-nowrap px-6 py-3.5 font-semibold">{f.farmer_name}</td>
                    <td className="whitespace-nowrap px-6 py-3.5 text-muted">{f.district}</td>
                    <td className="tnum whitespace-nowrap px-6 py-3.5">{f.area_hectares ?? 1} ha</td>
                    <td className="whitespace-nowrap px-6 py-3.5 capitalize">{f.crop_type}</td>
                    <td className="whitespace-nowrap px-6 py-3.5 capitalize text-muted">{f.season}</td>
                    <td className="whitespace-nowrap px-6 py-3.5">{s?.pred?.growth?.stage ?? '—'}</td>
                    <td className="tnum whitespace-nowrap px-6 py-3.5">
                      {s?.pred ? `${s.pred.predicted_yield.toFixed(2)} ${s.pred.unit}` : '—'}
                    </td>
                    <td className="whitespace-nowrap px-6 py-3.5">
                      <Badge tone={st.tone}>{st.label}</Badge>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  )
}
