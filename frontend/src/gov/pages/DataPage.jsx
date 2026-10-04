import { useState } from 'react'
import { HRows } from '../lib/charts'
import { fmt, fmtAgo, title } from '../lib/fmt'
import {
  Button, Card, Chip, Empty, Kpi, PageHead, Panel, Provenance, TableWrap,
} from '../lib/ui'
import { canManageDatasets } from '../lib/access'
import { addDataset, fetchDatasets, setDatasetStatus } from '../lib/queries'
import { useQuery } from '../lib/useQuery'

/**
 * Screen 12 — data management.
 *
 * Registers the PROVENANCE of each dataset, not the files themselves. There is no
 * Supabase Storage bucket configured for this project, so an upload control here
 * would be a button that cannot work; instead a dataset is registered with a
 * `file_url` pointing at wherever it actually lives, and the gap is stated.
 *
 * The design's quality scores (97, 95, 92…) are not reproduced. They were
 * invented per dataset; nothing in this project computes a dataset quality score,
 * and a number out of 100 beside "Verified" would be read as a measurement. The
 * column shows a score only where one has genuinely been written.
 */
export default function DataPage({ profile, say }) {
  const q = useQuery(() => fetchDatasets(), [])
  const [adding, setAdding] = useState(false)
  const mayManage = canManageDatasets(profile)

  return (
    <>
      <PageHead title="Data management"
                sub="Registered sources, their coverage and their verification state">
        {mayManage && (
          <Button variant="dark" onClick={() => setAdding((a) => !a)}>
            {adding ? 'Cancel' : 'Register a dataset'}
          </Button>
        )}
      </PageHead>

      <Panel q={q} skeleton={280}
             empty={<Empty what="No datasets registered.">
               Run ml-service/scripts/seed_gov_portal.py to register the sources this project
               actually uses — the Sentinel-2 composites, the reported yield series, the soil
               profile and the yield model.
             </Empty>}>
        {(rows) => {
          const verified = rows.filter((r) => r.status === 'verified')
          const pending = rows.filter((r) => r.status === 'pending')
          const flagged = rows.filter((r) => r.status === 'flagged')
          const records = rows.reduce((a, r) => a + Number(r.record_count || 0), 0)

          return (
            <>
              <div className="grid g4">
                <Kpi label="Datasets" value={rows.length} sub="Registered sources" />
                <Kpi label="Verified" value={`${verified.length} of ${rows.length}`}
                     sub="Cleared to feed dashboards" />
                <Kpi label="Awaiting review" value={pending.length}
                     sub={flagged.length ? `${flagged.length} flagged` : 'None flagged'} />
                <Kpi label="Rows loaded" value={fmt(records)} sub="Across all registered sources" />
              </div>

              {adding && mayManage && (
                <DatasetForm profile={profile} say={say}
                             onDone={() => { setAdding(false); q.reload() }} />
              )}

              <Card title="Registered datasets"
                    sub="Verify a source before it is relied on; flag it if it looks wrong">
                <TableWrap>
                  <table>
                    <thead>
                      <tr>
                        <th>Dataset</th><th>Source</th><th>Coverage</th>
                        <th className="r-">Rows</th><th>Scope</th><th>Updated</th>
                        <th>Quality</th><th>Status</th>
                        {mayManage && <th />}
                      </tr>
                    </thead>
                    <tbody>
                      {rows.map((d) => (
                        <tr key={d.id}>
                          <td>
                            <b>{d.name}</b>
                            {d.version !== '1' && <span className="sub"> v{d.version}</span>}
                            {d.description && (
                              <p className="sub" style={{ whiteSpace: 'normal', maxWidth: 320 }}>
                                {d.description}
                              </p>
                            )}
                          </td>
                          <td className="sub">{d.source ?? '—'}</td>
                          <td className="sub">{d.coverage ?? '—'}</td>
                          <td className="mono r-">{d.record_count == null ? '—' : fmt(d.record_count)}</td>
                          <td>
                            {d.district_id
                              ? <Chip tone="n">{d.gov_districts?.name}</Chip>
                              : <Chip tone="n">Province-wide</Chip>}
                          </td>
                          <td className="sub">{fmtAgo(d.uploaded_at)}</td>
                          <td className="sub">
                            {/* Only where a score was genuinely written. The
                                design showed one for every row; nothing in this
                                project computes one. */}
                            {d.quality_score == null
                              ? <span title="No quality score has been computed for this source">
                                  not scored
                                </span>
                              : <b className="mono">{d.quality_score}</b>}
                          </td>
                          <td>
                            <Chip tone={d.status === 'verified' ? '' : d.status === 'pending' ? 'n' : 'r'}>
                              {title(d.status)}
                            </Chip>
                          </td>
                          {mayManage && (
                            <td>
                              <div className="row" style={{ gap: 5, flexWrap: 'nowrap' }}>
                                <Button size="sm" onClick={async () => {
                                  try {
                                    await setDatasetStatus(d.id, 'verified')
                                    say('Marked verified'); q.reload()
                                  } catch (e) { say(e.message) }
                                }}>Verify</Button>
                                <Button size="sm" onClick={async () => {
                                  try {
                                    await setDatasetStatus(d.id, 'flagged')
                                    say('Flagged for review'); q.reload()
                                  } catch (e) { say(e.message) }
                                }}>Flag</Button>
                              </div>
                            </td>
                          )}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
                {!mayManage && (
                  <Provenance>
                    Read-only for your role. Only a district manager or the provincial
                    administrator may register or verify a dataset, and the database enforces
                    that rather than this screen.
                  </Provenance>
                )}
              </Card>

              <div className="grid g2">
                <Card title="What feeds each screen" sub="Where the portal's numbers come from">
                  <HRows rows={[
                    { l: 'Satellite indices', v: rows.find((r) => /Sentinel/i.test(r.name))?.record_count ?? 0,
                      max: Math.max(1, records), t: fmt(rows.find((r) => /Sentinel/i.test(r.name))?.record_count ?? 0) },
                    { l: 'Reported yields', v: rows.find((r) => /PBS/i.test(r.name))?.record_count ?? 0,
                      max: Math.max(1, records), t: fmt(rows.find((r) => /PBS/i.test(r.name))?.record_count ?? 0) },
                    { l: 'Model predictions', v: rows.find((r) => /model/i.test(r.name))?.record_count ?? 0,
                      max: Math.max(1, records), t: fmt(rows.find((r) => /model/i.test(r.name))?.record_count ?? 0) },
                  ]} />
                  <Provenance>
                    Counts are read back from the registry, which the seeding script writes from
                    what it actually loaded — not asserted in the frontend.
                  </Provenance>
                </Card>

                <Card title="File storage" sub="Not configured">
                  <Empty what="There is no upload bucket.">
                    This project has no Supabase Storage bucket, so a dataset is registered by
                    reference: `file_url` points at wherever the file genuinely lives. An upload
                    control here would be a button that cannot complete.
                    <br /><br />
                    To wire it: create a private bucket, add a storage policy matching the
                    gov_datasets insert policy (district managers scoped to their own district,
                    the provincial administrator unscoped), then upload and store the returned
                    path in `file_url`.
                  </Empty>
                </Card>
              </div>
            </>
          )
        }}
      </Panel>
    </>
  )
}

function DatasetForm({ profile, say, onDone }) {
  const [form, setForm] = useState({
    name: '', version: '1', source: '', coverage: '', description: '', file_url: '',
  })
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }))

  return (
    <Card title="Register a dataset"
          sub={profile.tier === 'super_admin'
            ? 'Registered province-wide'
            : `Registered for ${profile.gov_districts?.name}`}>
      <form onSubmit={async (e) => {
        e.preventDefault()
        setBusy(true); setErr(null)
        try {
          await addDataset(profile, form)
          say('Dataset registered as pending')
          onDone()
        } catch (e2) { setErr(e2) } finally { setBusy(false) }
      }}>
        <div className="grid g2" style={{ margin: 0 }}>
          <div className="field">
            <label htmlFor="ds-name">Name</label>
            <input id="ds-name" value={form.name} onChange={set('name')} required />
          </div>
          <div className="field">
            <label htmlFor="ds-ver">Version</label>
            <input id="ds-ver" value={form.version} onChange={set('version')} required />
          </div>
        </div>
        <div className="grid g2" style={{ margin: 0 }}>
          <div className="field">
            <label htmlFor="ds-src">Source / publisher</label>
            <input id="ds-src" value={form.source} onChange={set('source')} />
          </div>
          <div className="field">
            <label htmlFor="ds-cov">Coverage</label>
            <input id="ds-cov" value={form.coverage} onChange={set('coverage')}
                   placeholder="e.g. 34 districts · 10 m · seasonal" />
          </div>
        </div>
        <div className="field">
          <label htmlFor="ds-url">File location (URL or path)</label>
          <input id="ds-url" value={form.file_url} onChange={set('file_url')}
                 placeholder="No storage bucket is configured — reference where the file lives" />
        </div>
        <div className="field">
          <label htmlFor="ds-desc">Description</label>
          <textarea id="ds-desc" rows="2" value={form.description} onChange={set('description')} />
        </div>
        {err && <div className="err" style={{ marginBottom: 10 }}>
          <b>Could not register.</b>{err.message}</div>}
        <Button variant="dark" type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Register'}
        </Button>
      </form>
    </Card>
  )
}
