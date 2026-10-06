import { useMemo, useState } from 'react'
import { Card, Empty, PageHead, Panel, Provenance, TableWrap } from '../../gov/lib/ui'
import { Bars } from '../../gov/lib/charts'
import { dash, f1 } from '../../gov/lib/fmt'
import { downloadCsv } from '../../gov/lib/csv'
import { useQuery } from '../../gov/lib/useQuery'
import { Select } from '../lib/rui'
import { canEditBenchmarks } from '../lib/access'
import {
  addBenchmark, deleteBenchmark, fetchBenchmarks, fetchVersions, updateBenchmark,
} from '../lib/queries'

/**
 * Screen 9 — benchmark comparison.
 *
 * This project's model results against the literature, as an editable
 * reference table.
 *
 * THREE SEEDED CITATIONS HAVE NO VALUE, DELIBERATELY. The brief asked to seed
 * "known literature values already used in the project documentation (Pantazi
 * et al. 2016, Kuwata & Shibasaki 2015, Kang et al. 2020)". Those papers appear
 * nowhere in this repository -- the only literature figure the project records
 * is the 0.78-0.84 R2 band hardcoded in train_real.py, and that comment cites
 * no paper. So the three rows are seeded with a NULL metric_value and a note
 * saying what is needed.
 *
 * Writing a remembered number next to a real author's name would put a
 * fabricated result into an academic comparison table, and it is the one error
 * here that nobody downstream could catch, because it would look exactly like a
 * real citation. An empty cell is recoverable; a plausible invented one is not.
 * That is why this screen renders a missing value as an em dash and tells a
 * lead to fill it in from the paper.
 */
export default function BenchmarkPage({ profile, say }) {
  const q = useQuery(() => fetchBenchmarks(), [])
  const versions = useQuery(() => fetchVersions(), [])
  const mayEdit = canEditBenchmarks(profile)

  const [crop, setCrop] = useState(null)
  const [draft, setDraft] = useState(null)
  const [adding, setAdding] = useState(false)
  const [err, setErr] = useState(null)

  const rows = useMemo(() => (q.data || [])
    .filter((b) => !crop || b.crop_type === crop), [q.data, crop])

  const crops = useMemo(
    () => [...new Set((q.data || []).map((b) => b.crop_type).filter(Boolean))].sort(),
    [q.data])

  const missing = (q.data || []).filter((b) => b.metric_value == null)

  // Our own best result per crop, for the chart. Trainings only, completed, and
  // regression only -- an F1 does not belong on an axis with a literature R².
  const ours = useMemo(() => {
    const best = new Map()
    for (const v of versions.data || []) {
      if (v.job_status !== 'completed' || v.output_type !== 'regression') continue
      if (v.r2 == null) continue
      const key = v.gov_crops?.name || 'all crops'
      if (!best.has(key) || Number(v.r2) > Number(best.get(key).r2)) best.set(key, v)
    }
    return best
  }, [versions.data])

  const chartRows = useMemo(() => {
    const lit = rows.filter((b) => b.metric_value != null && /r2|r²/i.test(b.metric_type))
    const out = lit.map((b) => ({
      l: b.citation.split(/[,(]/)[0].trim().slice(0, 18),
      v: Number(b.metric_value),
      c: '#9aa79f',
    }))
    for (const [cropName, v] of ours) {
      if (crop && cropName !== crop) continue
      out.push({ l: `ours · ${cropName}`.slice(0, 20), v: Number(v.r2), c: 'var(--g500)' })
    }
    return out
  }, [rows, ours, crop])

  async function save(row) {
    setErr(null)
    try {
      const patch = {
        citation: row.citation.trim(),
        metric_type: row.metric_type.trim(),
        metric_value: row.metric_value === '' || row.metric_value == null
          ? null : Number(row.metric_value),
        crop_type: row.crop_type?.trim() || null,
        notes: row.notes?.trim() || null,
      }
      if (!patch.citation || !patch.metric_type) {
        return setErr('A citation and a metric type are required.')
      }
      if (row.id) await updateBenchmark(row.id, patch)
      else await addBenchmark(patch)
      setDraft(null)
      setAdding(false)
      say(row.id ? 'Benchmark updated' : 'Benchmark added')
      q.reload()
    } catch (e) {
      setErr(String(e.message || e))
    }
  }

  const Editor = ({ row }) => (
    <div className="card" style={{ background: 'var(--g50)', marginBottom: 10 }}>
      <div className="grid g2" style={{ marginBottom: 0 }}>
        <div className="field">
          <label>Citation</label>
          <input value={row.citation ?? ''} maxLength={300}
                 onChange={(e) => setDraft({ ...row, citation: e.target.value })} />
        </div>
        <div className="field">
          <label>Metric type</label>
          <input value={row.metric_type ?? ''} placeholder="R2, RMSE, Accuracy…"
                 onChange={(e) => setDraft({ ...row, metric_type: e.target.value })} />
        </div>
        <div className="field">
          <label>Metric value <span className="sub">(leave blank if not yet read from the paper)</span></label>
          <input type="number" step="0.0001" value={row.metric_value ?? ''}
                 onChange={(e) => setDraft({ ...row, metric_value: e.target.value })} />
        </div>
        <div className="field">
          <label>Crop</label>
          <input value={row.crop_type ?? ''}
                 onChange={(e) => setDraft({ ...row, crop_type: e.target.value })} />
        </div>
      </div>
      <div className="field">
        <label>Notes</label>
        <textarea rows={2} maxLength={1000} value={row.notes ?? ''}
                  onChange={(e) => setDraft({ ...row, notes: e.target.value })} />
      </div>
      {err && <div className="err">{err}</div>}
      <div className="row" style={{ gap: 8, marginTop: 8 }}>
        <button className="btn dark sm" onClick={() => save(row)}>Save</button>
        <button className="btn sm" onClick={() => { setDraft(null); setAdding(false); setErr(null) }}>
          Cancel
        </button>
      </div>
    </div>
  )

  return (
    <>
      <PageHead title="Benchmark comparison"
                sub="This project’s results against published work" />

      <div className="r-filters">
        <Select label="Crop" value={crop} onChange={setCrop}
                options={crops.map((c) => ({ value: c, label: c }))} all="All crops" />
        <div className="spacer" />
        {mayEdit && !adding && (
          <button className="btn sm dark" onClick={() => {
            setAdding(true)
            setDraft({ citation: '', metric_type: 'R2', metric_value: '', crop_type: '', notes: '' })
          }}>Add a reference</button>
        )}
        <button className="btn sm" disabled={!rows.length} onClick={() => {
          downloadCsv(`benchmarks_${Date.now()}.csv`, rows.map((b) => ({
            citation: b.citation, metric_type: b.metric_type,
            metric_value: b.metric_value ?? '', crop_type: b.crop_type ?? '',
            notes: b.notes ?? '',
          })))
          say('Exported benchmarks')
        }}>Export CSV</button>
      </div>

      {missing.length > 0 && (
        <div className="r-warn" style={{ marginBottom: 12 }}>
          <b>{missing.length} reference{missing.length === 1 ? '' : 's'} have no value yet.</b>
          They were seeded as citations only. The papers are not in this repository, so
          no figure was invented for them — open each one, read the reported metric for
          the stated crop and model, and enter it
          {mayEdit ? ' below.' : '. A research lead can do this.'} Until then they are
          excluded from the chart.
        </div>
      )}

      {adding && draft && <Editor row={draft} />}

      {chartRows.length > 0 && (
        <Card title="R² against the literature" sub="Published values beside this project’s best">
          <Bars data={chartRows} dec={3} max={1} alt="R squared, literature versus this project" />
          <Provenance>
            Only R²-type metrics with a recorded value are plotted, and only our
            regression runs — an accuracy or an F1 on the same axis as an R² would
            invite a comparison between quantities that do not measure the same thing.
            Our bars are the best completed regression version per crop, not an average.
          </Provenance>
        </Card>
      )}

      <Card title="Reference table" sub={mayEdit ? 'Editable' : 'Read-only for your tier'}>
        <Panel q={q} skeleton={220}
               empty={<Empty what="No benchmark references."
                             why="The seed migration adds five; if none appear, it has not been applied." />}>
          {() => (
            <TableWrap>
              <table>
                <thead>
                  <tr>
                    <th>Citation</th><th>Metric</th><th className="r-">Value</th>
                    <th>Crop</th><th>Notes</th>{mayEdit && <th />}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((b) => draft?.id === b.id ? (
                    <tr key={b.id}>
                      <td colSpan={mayEdit ? 6 : 5}><Editor row={draft} /></td>
                    </tr>
                  ) : (
                    <tr key={b.id}>
                      <td><b>{b.citation}</b></td>
                      <td className="sub">{b.metric_type}</td>
                      <td className="mono r-">
                        {b.metric_value == null
                          ? <span className="r-badge candidate"><i />not entered</span>
                          : f1(b.metric_value, 4)}
                      </td>
                      <td>{b.crop_type ?? '—'}</td>
                      <td className="sub" style={{ maxWidth: 380 }}>{b.notes ?? '—'}</td>
                      {mayEdit && (
                        <td>
                          <div className="row" style={{ gap: 6 }}>
                            <button className="btn sm" onClick={() => { setErr(null); setDraft(b) }}>
                              Edit
                            </button>
                            <button className="btn sm" onClick={async () => {
                              try { await deleteBenchmark(b.id); say('Reference removed'); q.reload() }
                              catch (e) { say(String(e.message || e)) }
                            }}>Remove</button>
                          </div>
                        </td>
                      )}
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Panel>
        <Provenance>
          A value of <i>not entered</i> is an honest blank, not a zero. The project's own
          recorded expectation — the 0.78–0.84 R² band in
          <code> ml-service/scripts/train_real.py</code> — is seeded as two rows with
          real values, because that one is sourced from this repository.
        </Provenance>
      </Card>
    </>
  )
}
