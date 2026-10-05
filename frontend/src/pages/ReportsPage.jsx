import { useState } from 'react'
import { API, authHeader } from '../lib/api'
import { title } from '../lib/format'
import { Badge, Button, Card, CardHead, NotWired, PageHead, Row } from '../components/ui'

/** The one report the service actually produces.
 *
 * /farms/{id}/report builds a one-page PDF from the same assembly /predict
 * uses, so it can never drift from what the dashboard shows. It is the ONLY
 * report route that exists. The design sketches five more -- field health,
 * crop monitoring, alert summary, season review -- plus a scheduling table;
 * none of those have an endpoint, a generator, or a table behind them, so they
 * are named here as planned rather than rendered as cards with invented dates.
 */
function ReportCard({ farm, onDownload, busy }) {
  return (
    <Card>
      <div className="flex items-start gap-3">
        <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-leaf-100 text-leaf-700">
          <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor"
               strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 20V10M10 20V4M16 20v-7M22 20H2" />
          </svg>
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="font-display text-lg font-semibold">Yield report</h3>
          <Badge tone="leaf" className="mt-1">Yield</Badge>
        </div>
      </div>

      <p className="mt-4 text-sm text-muted">
        Predicted yield with its confidence range, the indices behind it, growth stage,
        district comparison and every caveat the model attaches.
      </p>

      <div className="mt-4">
        <Row label="Farm" value={farm.farmer_name} />
        <Row label="Crop" value={title(farm.crop_type)} />
        <Row label="Type" value="PDF · generated on demand" />
      </div>

      <div className="mt-5 flex gap-2">
        <Button onClick={onDownload} disabled={busy} className="flex-1">
          {busy ? 'Generating…' : 'Download PDF'}
        </Button>
      </div>
      <p className="mt-3 text-xs text-muted">
        Generated fresh each time from the current prediction — there is no stored copy, so
        there is no “last generated” date to show.
      </p>
    </Card>
  )
}

const PLANNED = [
  ['Field health report', 'Health', 'Spectral indices and vegetation condition'],
  ['Crop monitoring report', 'Growth', 'Growth stage timeline and observations'],
  ['Alert summary', 'Alerts', 'All alerts with evidence and actions'],
  ['Season report', 'Season', 'Full season review with recommendations'],
]

export default function ReportsPage({ farm, farms, selectedId, onSelect }) {
  const [busy, setBusy] = useState(false)

  async function download() {
    setBusy(true)
    try {
      // Cannot be a plain <a href>: the endpoint needs an Authorization header,
      // which a link cannot carry. Fetch it, then hand the browser a blob.
      const r = await fetch(API + '/farms/' + farm.id + '/report', { headers: await authHeader() })
      if (!r.ok) {
        const b = await r.json().catch(() => ({}))
        throw new Error(b.detail ?? 'HTTP ' + r.status)
      }
      const url = URL.createObjectURL(await r.blob())
      const a = document.createElement('a')
      a.href = url
      a.download = `${farm.farmer_name}-yield-report.pdf`
      a.click()
      URL.revokeObjectURL(url)
    } catch (e) {
      alert('Report failed: ' + e.message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-5">
      <PageHead title="Reports" sub="Download or view reports for any farm">
        <label className="rounded-xl border border-leaf-200 bg-card px-3 py-1.5">
          <span className="block text-[11px] leading-none text-muted">Farm</span>
          <select value={selectedId ?? ''} onChange={(e) => onSelect(e.target.value)}
                  className="mt-0.5 max-w-[14rem] truncate bg-transparent text-sm font-medium outline-none">
            {farms.map((f) => <option key={f.id} value={f.id}>{f.farmer_name}</option>)}
          </select>
        </label>
      </PageHead>

      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
        <ReportCard farm={farm} onDownload={download} busy={busy} />

        {PLANNED.map(([name, tag, desc]) => (
          <Card key={name} className="opacity-70">
            <div className="flex items-start gap-3">
              <span className="grid h-10 w-10 shrink-0 place-items-center rounded-xl bg-black/4 text-muted">
                <svg viewBox="0 0 24 24" className="h-5 w-5" fill="none" stroke="currentColor"
                     strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8l-5-5ZM14 3v5h5" />
                </svg>
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="font-display text-lg font-semibold">{name}</h3>
                <Badge tone="grey" className="mt-1">{tag}</Badge>
              </div>
            </div>
            <p className="mt-4 text-sm text-muted">{desc}</p>
            <div className="mt-5">
              <Button variant="ghost" disabled className="w-full">Not available yet</Button>
            </div>
          </Card>
        ))}
      </div>

      <Card>
        <CardHead title="Scheduled reports" />
        <div className="mt-4">
          <NotWired
            what="Scheduling is not built."
            why="It needs a table of schedules, a job runner and an email path. The service can
                 send alert emails, but nothing schedules or stores a report, so no schedule rows
                 are shown rather than placeholder ones."
          />
        </div>
      </Card>
    </div>
  )
}
