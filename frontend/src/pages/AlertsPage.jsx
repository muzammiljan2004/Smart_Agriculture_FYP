import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../supabase'
import { title } from '../lib/format'
import { Badge, Button, Card, CardHead, PageHead, Skeleton } from '../components/ui'

/** Every alert across the caller's farms.
 *
 * Read straight from Supabase rather than through the API. There is no
 * "all alerts" route -- /predict returns only the OPEN alerts for one farm --
 * and the table already has a select policy scoped to the caller's own farms,
 * so RLS does the filtering the same way it does for the farms list. No
 * .eq('owner_id') here for exactly that reason: the database enforces it.
 */
function useAlerts(farms) {
  const [rows, setRows] = useState(null)
  const [err, setErr] = useState(null)

  useEffect(() => {
    let alive = true
    supabase
      .from('alerts')
      .select('*')
      .order('triggered_at', { ascending: false })
      .then(({ data, error }) => {
        if (!alive) return
        if (error) setErr(error.message)
        else setRows(data ?? [])
      })
    return () => { alive = false }
  }, [farms.length])

  return { rows, err }
}

const TONE = { critical: 'red', warning: 'wheat', info: 'blue' }
const BAR = { critical: 'border-red-700', warning: 'border-wheat-400', info: 'border-sky-400' }

function AlertRow({ a, farmName }) {
  const tone = a.resolved ? 'grey' : (TONE[a.severity] ?? 'grey')
  const bar = a.resolved ? 'border-leaf-200' : (BAR[a.severity] ?? 'border-leaf-200')
  return (
    <Card pad="p-0" className={`overflow-hidden border-l-4 ${bar}`}>
      <div className="flex flex-wrap items-start gap-4 p-5">
        <div className="min-w-[16rem] flex-1">
          <p className="flex flex-wrap items-center gap-2">
            <Badge tone={tone}>{a.resolved ? 'Resolved' : title(a.severity)}</Badge>
            <span className="font-semibold capitalize">{String(a.type).replace(/_/g, ' ')}</span>
            <span className="text-sm text-muted">
              {new Date(a.triggered_at).toLocaleDateString('en-GB',
                { day: 'numeric', month: 'short', year: 'numeric' })}
              {farmName ? ` · ${farmName}` : ''}
            </span>
          </p>
          <p className="mt-2 text-sm">{a.message}</p>
          <div className="mt-3 flex flex-wrap gap-x-10 gap-y-2 text-xs">
            <div>
              <p className="text-muted">Raised</p>
              <p className="font-semibold">{new Date(a.triggered_at).toLocaleString()}</p>
            </div>
            <div>
              <p className="text-muted">Email</p>
              <p className="font-semibold">{a.emailed_at ? 'Sent' : 'Not sent'}</p>
            </div>
            {a.resolved_at && (
              <div>
                <p className="text-muted">Cleared</p>
                <p className="font-semibold">{new Date(a.resolved_at).toLocaleString()}</p>
              </div>
            )}
          </div>
        </div>
      </div>
    </Card>
  )
}

/** Alerts per month for the last twelve. Real counts, bucketed client-side. */
function Timeline({ rows }) {
  const months = useMemo(() => {
    const out = []
    const now = new Date()
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
      out.push({
        key: `${d.getFullYear()}-${d.getMonth()}`,
        label: d.toLocaleDateString('en-GB', { month: 'short' }),
        total: 0, critical: 0,
      })
    }
    const byKey = Object.fromEntries(out.map((m) => [m.key, m]))
    rows.forEach((a) => {
      const d = new Date(a.triggered_at)
      const m = byKey[`${d.getFullYear()}-${d.getMonth()}`]
      if (m) { m.total++; if (a.severity === 'critical') m.critical++ }
    })
    return out
  }, [rows])

  const top = Math.max(1, ...months.map((m) => m.total))

  return (
    <Card>
      <CardHead title="Alert timeline" right="last 12 months" />
      <div className="mt-6 flex items-end gap-2" style={{ height: 130 }}>
        {months.map((m) => (
          <div key={m.key} className="flex flex-1 flex-col items-center justify-end gap-1.5">
            {m.total > 0 && <span className="tnum text-[10px] text-muted">{m.total}</span>}
            <div
              className={'w-full rounded-t-md ' + (m.critical ? 'bg-red-700' : m.total ? 'bg-leaf-200' : 'bg-leaf-50')}
              style={{ height: Math.max(3, (m.total / top) * 96) }}
              title={`${m.label}: ${m.total} alert(s), ${m.critical} critical`}
            />
            <span className="text-[10px] text-muted">{m.label}</span>
          </div>
        ))}
      </div>
    </Card>
  )
}

export default function AlertsPage({ farms }) {
  const { rows, err } = useAlerts(farms)
  const [filter, setFilter] = useState('all')
  const names = Object.fromEntries(farms.map((f) => [f.id, f.farmer_name]))

  if (err) {
    return (
      <div className="space-y-5">
        <PageHead title="Alerts" sub="Complete history across all farms" />
        <Card><p className="text-sm text-red-700">{err}</p></Card>
      </div>
    )
  }
  if (!rows) {
    return (
      <div className="space-y-5">
        <PageHead title="Alerts" sub="Complete history across all farms" />
        <Card><Skeleton className="h-24 w-full" /></Card>
      </div>
    )
  }

  const open = rows.filter((a) => !a.resolved)
  const counts = {
    all: rows.length,
    critical: open.filter((a) => a.severity === 'critical').length,
    warning: open.filter((a) => a.severity === 'warning').length,
    info: open.filter((a) => a.severity === 'info').length,
    resolved: rows.filter((a) => a.resolved).length,
  }
  const shown = rows.filter((a) =>
    filter === 'all' ? true
      : filter === 'resolved' ? a.resolved
        : !a.resolved && a.severity === filter)

  return (
    <div className="space-y-5">
      <PageHead title="Alerts" sub="Complete history across all farms">
        <Button variant="ghost" disabled
                title="The alerts table has no read/unread column — only open and resolved.">
          Mark all as read
        </Button>
      </PageHead>

      <div className="flex flex-wrap gap-1 rounded-xl bg-card p-1 ring-1 ring-leaf-100">
        {[['all', 'All'], ['critical', 'Critical'], ['warning', 'Warning'],
          ['info', 'Information'], ['resolved', 'Resolved']].map(([id, label]) => (
          <button key={id} onClick={() => setFilter(id)}
                  className={'rounded-lg px-4 py-2 text-sm transition ' +
                    (filter === id ? 'bg-leaf-100 font-semibold text-leaf-800' : 'text-muted hover:text-ink')}>
            {label} {counts[id]}
          </button>
        ))}
      </div>

      {shown.length === 0 ? (
        <Card><p className="text-sm text-muted">
          {rows.length === 0
            ? 'No alerts have been raised for your farms. Alerts are evaluated each time a prediction runs.'
            : 'Nothing in this category.'}
        </p></Card>
      ) : (
        <div className="space-y-3">
          {shown.map((a) => <AlertRow key={a.id} a={a} farmName={names[a.farm_id]} />)}
        </div>
      )}

      <Timeline rows={rows} />

      <p className="text-xs text-muted">
        “Mark all as read” is disabled: the alerts table tracks open and resolved, not read and
        unread, and the service resolves an alert on its own once the condition clears.
      </p>
    </div>
  )
}
