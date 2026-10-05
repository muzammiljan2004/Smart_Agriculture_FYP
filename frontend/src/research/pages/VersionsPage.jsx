import { useRef, useState } from 'react'
import { Card, Empty, Kpi, PageHead, Panel, Provenance, TableWrap } from '../../gov/lib/ui'
import { fmtDate } from '../../gov/lib/fmt'
import { useQuery } from '../../gov/lib/useQuery'
import { canTrain } from '../lib/access'
import { fetchDatasetVersions, uploadDataset } from '../lib/queries'

/**
 * Screen 3 — dataset versioning.
 *
 * A dataset_version is an immutable snapshot, and that immutability is the
 * point: a model_runs row names the exact version it used, so a result can be
 * reproduced later without the dataset having quietly grown underneath it.
 * Nothing on this screen edits or deletes one, because there is no policy that
 * would let it.
 *
 * UPLOAD LIVES HERE BUT BELONGS TO ACTION B. The brief folds dataset upload
 * into train/retrain rather than gating it separately, so the control is shown
 * only for can_train_models -- an account with can_run_models alone can select
 * an existing version on screen 7 and cannot add one. The form is absent, not
 * disabled, for anyone else.
 */
export default function VersionsPage({ profile, say, go }) {
  const q = useQuery(() => fetchDatasetVersions(), [])
  const mayUpload = canTrain(profile)

  const fileRef = useRef(null)
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const [ok, setOk] = useState(null)

  async function submit(e) {
    e.preventDefault()
    const file = fileRef.current?.files?.[0]
    setErr(null)
    setOk(null)
    if (!file) return setErr('Choose a CSV file first.')
    if (!description.trim()) return setErr('A description is required — it is how this snapshot is cited on every other screen.')

    setBusy(true)
    try {
      const res = await uploadDataset(file, description.trim())
      setOk(`Registered ${res.record_count.toLocaleString('en-US')} rows. ${res.notes.join('; ')}`)
      setDescription('')
      if (fileRef.current) fileRef.current.value = ''
      say('Dataset version registered')
      q.reload()
    } catch (e2) {
      // The ML service's validator message, verbatim: it names the column that
      // is missing. Nothing was written when this fires -- no row, no file.
      setErr(String(e2.message || e2))
    } finally {
      setBusy(false)
    }
  }

  const list = q.data || []
  const validated = list.filter((d) => d.schema_validated)
  const failed = list.filter((d) => !d.schema_validated)
  const totalRows = validated.reduce((a, d) => a + (d.record_count || 0), 0)

  return (
    <>
      <PageHead title="Dataset versioning"
                sub="Immutable snapshots, so a result stays reproducible" />

      <div className="grid g4">
        <Kpi label="Versions" value={q.loading ? '—' : list.length} sub="All uploaders" />
        <Kpi label="Validated" value={q.loading ? '—' : validated.length}
             sub="Usable for training" />
        <Kpi label="Failed validation" value={q.loading ? '—' : failed.length}
             sub={failed.length ? 'Kept so the failure is visible' : 'None'} />
        <Kpi label="Usable rows" value={q.loading ? '—' : totalRows.toLocaleString('en-US')}
             sub="Across validated versions" />
      </div>

      {mayUpload && (
        <Card title="Upload a temporal dataset" sub="Becomes reusable by everyone who can train">
          <form onSubmit={submit}>
            <div className="grid g2" style={{ marginBottom: 0 }}>
              <div className="field">
                <label htmlFor="ds-desc">Description</label>
                <input id="ds-desc" value={description} required
                       placeholder="e.g. Wheat 2017-18 to 2024-25, 500 m temporal composites"
                       onChange={(e) => setDescription(e.target.value)} />
              </div>
              <div className="field">
                <label htmlFor="ds-file">CSV file</label>
                <input id="ds-file" type="file" accept=".csv,text/csv" ref={fileRef} required />
              </div>
            </div>

            {err && (
              <div className="err" style={{ marginTop: 10 }}>
                <b>The file was rejected and nothing was saved.</b>
                {err}
              </div>
            )}
            {ok && (
              <div className="r-warn" style={{ marginTop: 10, background: 'var(--g100)', color: 'var(--g700)' }}>
                <b>Registered.</b>{ok}
              </div>
            )}

            <div className="row" style={{ marginTop: 12, gap: 8 }}>
              <button className="btn dark" type="submit" disabled={busy}>
                {busy ? 'Validating…' : 'Validate and register'}
              </button>
              <button className="btn" type="button" onClick={() => go('operations')}>
                Go to Train &amp; Run
              </button>
            </div>
          </form>

          <Provenance>
            The file is validated by the ML service before anything is written. It must
            carry all five index columns (<code>ndvi, evi, ndwi, savi, nbr</code>), a
            target column (<code>actual_yield</code>) and a temporal column
            (<code>date</code> or <code>season</code>). Weather and soil columns are
            optional and used where present. A malformed or empty file is rejected with
            the reason and <b style={{ display: 'inline' }}>no row and no file are
            created</b> — there is no half-registered state to clean up later.
          </Provenance>
        </Card>
      )}

      {!mayUpload && (
        <Card title="Upload" sub="Not available to this account">
          <Empty what="Uploading a dataset needs can_train_models.">
            Your account does not have it, so the form is not shown. You can still
            select any existing version below for an evaluation run. A research lead
            can grant the flag.
          </Empty>
        </Card>
      )}

      <Card title="Registered versions" sub="Newest first">
        <Panel q={q} skeleton={200}
               empty={<Empty what="No dataset versions yet."
                             why={mayUpload
                               ? 'Upload one above to make it available to everyone who can train.'
                               : 'An account with can_train_models has to upload the first one.'} />}>
          {(rows) => (
            <TableWrap>
              <table>
                <thead>
                  <tr>
                    <th>Description</th>
                    <th className="r-">Records</th>
                    <th>Schema</th>
                    <th>Validation notes</th>
                    <th>Uploaded by</th>
                    <th>Created</th>
                    <th>Path</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((d) => (
                    <tr key={d.id}>
                      <td><b>{d.description}</b></td>
                      <td className="mono r-">{d.record_count.toLocaleString('en-US')}</td>
                      <td>
                        {d.schema_validated
                          ? <span className="r-badge approved"><i />Validated</span>
                          : <span className="r-badge candidate"><i />Failed</span>}
                      </td>
                      <td className="sub" style={{ maxWidth: 300 }}>
                        {d.validation_notes || '—'}
                      </td>
                      <td className="sub">{d.research_profiles?.full_name ?? '—'}</td>
                      <td className="sub">{fmtDate(d.created_at)}</td>
                      <td className="mono sub" style={{ fontSize: 10.5 }}>{d.storage_path}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Panel>
        <Provenance>
          A version is never edited or deleted from this portal — no policy permits it.
          Changing a snapshot would silently change the meaning of every run that cites
          it. Supersede it by uploading a new one instead.
        </Provenance>
      </Card>
    </>
  )
}
