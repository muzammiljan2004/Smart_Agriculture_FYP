import { Fragment, useMemo, useState } from 'react'
import { Card, Empty, Kpi, PageHead, Panel, Provenance, TableWrap } from '../../gov/lib/ui'
import { dash, f1, fmtDate } from '../../gov/lib/fmt'
import { downloadCsv } from '../../gov/lib/csv'
import { useQuery } from '../../gov/lib/useQuery'
import { JobChip, Lineage, Select, StatusBadge } from '../lib/rui'
import { MODEL_TYPES } from '../lib/access'
import { fetchDatasetVersions, fetchStatusHistory, fetchVersions } from '../lib/queries'

/**
 * Screen 8 — model version history.
 *
 * Every trained version per algorithm, with its metrics, its parent lineage,
 * the dataset version it used, and the audit trail of who changed its status
 * and when.
 *
 * THE AUDIT TRAIL IS NOT ASSEMBLED HERE. It comes from
 * `model_status_history`, written by a database trigger on every status change
 * rather than by the screen that performs one -- so a promotion issued straight
 * to the API appears in this list too. A trail the application maintains is a
 * trail that can be bypassed by not using the application.
 */
export default function HistoryPage({ say }) {
  const versions = useQuery(() => fetchVersions(), [])
  const history = useQuery(() => fetchStatusHistory(), [])
  const datasets = useQuery(() => fetchDatasetVersions(), [])
  const [modelType, setModelType] = useState(null)
  const [expanded, setExpanded] = useState(null)

  const list = versions.data || []
  const dsById = useMemo(
    () => new Map((datasets.data || []).map((d) => [d.id, d])), [datasets.data])
  const labelById = useMemo(
    () => new Map(list.map((v) => [v.id, v.version_label ?? v.id.slice(0, 8)])), [list])

  const trail = useMemo(() => {
    const m = new Map()
    for (const h of history.data || []) {
      if (!m.has(h.model_run_id)) m.set(h.model_run_id, [])
      m.get(h.model_run_id).push(h)
    }
    return m
  }, [history.data])

  const shown = modelType ? list.filter((v) => v.model_type === modelType) : list

  const byType = useMemo(() => {
    const m = new Map()
    for (const v of shown) {
      if (!m.has(v.model_type)) m.set(v.model_type, [])
      m.get(v.model_type).push(v)
    }
    return [...m.entries()]
  }, [shown])

  return (
    <>
      <PageHead title="Model version history"
                sub="Every trained version, its lineage, its dataset and its status trail" />

      <div className="r-filters">
        <Select label="Model type" value={modelType} onChange={setModelType}
                options={MODEL_TYPES.map((m) => ({ value: m, label: m }))} all="All types" />
        <div className="spacer" />
        <button className="btn sm" disabled={!shown.length} onClick={() => {
          downloadCsv(`model_versions_${Date.now()}.csv`, shown.map((v) => ({
            version: v.version_label ?? '', run_id: v.id, model_type: v.model_type,
            status: v.status, job_status: v.job_status, output_type: v.output_type ?? '',
            r2: v.r2 ?? '', rmse: v.rmse ?? '', mae: v.mae ?? '',
            accuracy: v.accuracy ?? '', f1: v.f1_score ?? '',
            crop: v.gov_crops?.name ?? '',
            dataset: dsById.get(v.dataset_version_id)?.description ?? '',
            retrained_from: v.parent_model_run_id ? labelById.get(v.parent_model_run_id) ?? v.parent_model_run_id : '',
            trained_by: v.research_profiles?.full_name ?? '',
            completed_at: v.completed_at ?? '',
            status_changes: (trail.get(v.id) || []).length,
          })))
          say(`Exported ${shown.length} versions`)
        }}>Export CSV</button>
      </div>

      <div className="grid g4">
        <Kpi label="Versions" value={versions.loading ? '—' : list.length}
             sub={`${byType.length} algorithm${byType.length === 1 ? '' : 's'}`} />
        <Kpi label="In production"
             value={versions.loading ? '—' : list.filter((v) => v.status === 'production').length}
             sub="At most one per algorithm" />
        <Kpi label="Candidates"
             value={versions.loading ? '—' : list.filter((v) => v.status === 'candidate').length}
             sub="Awaiting review" />
        <Kpi label="Status changes" value={history.loading ? '—' : (history.data || []).length}
             sub="Recorded by trigger" />
      </div>

      <Panel q={versions} skeleton={280}
             empty={<Empty what="No model versions yet."
                           why="A completed training creates the first one." />}>
        {() => byType.map(([type, vs]) => (
          <Card key={type} title={type} sub={`${vs.length} version${vs.length === 1 ? '' : 's'}`}>
            <TableWrap>
              <table>
                <thead>
                  <tr>
                    <th>Version</th><th>Status</th><th>Job</th>
                    <th>Lineage</th><th>Dataset</th>
                    <th className="r-">Metric</th>
                    <th>Trained</th><th>By</th><th />
                  </tr>
                </thead>
                <tbody>
                  {vs.map((v) => {
                    const ds = dsById.get(v.dataset_version_id)
                    const changes = trail.get(v.id) || []
                    const metric = v.output_type === 'classification'
                      ? ['F1', v.f1_score] : ['R²', v.r2]
                    return (
                      <Fragment key={v.id}>
                        <tr>
                          <td><b>{v.version_label ?? v.id.slice(0, 8)}</b></td>
                          <td><StatusBadge status={v.status} /></td>
                          <td><JobChip status={v.job_status} /></td>
                          <td><Lineage parent={v.parent_model_run_id
                            ? labelById.get(v.parent_model_run_id) ?? v.parent_model_run_id.slice(0, 8)
                            : null} /></td>
                          <td className="sub" style={{ maxWidth: 220 }}>
                            {ds ? ds.description : '—'}
                            {ds && (
                              <span className="sub" style={{ fontSize: 10 }}>
                                {' '}· {ds.record_count.toLocaleString('en-US')} rows
                              </span>
                            )}
                          </td>
                          <td className="mono r-"
                              style={metric[0] === 'R²' && Number(metric[1]) < 0
                                ? { color: 'var(--red)' } : undefined}>
                            {metric[0]} {dash(metric[1], (x) => f1(x, 4))}
                          </td>
                          <td className="sub">{fmtDate(v.completed_at || v.created_at)}</td>
                          <td className="sub">{v.research_profiles?.full_name ?? '—'}</td>
                          <td>
                            {changes.length > 0 && (
                              <button className="btn sm"
                                      onClick={() => setExpanded(expanded === v.id ? null : v.id)}>
                                {expanded === v.id ? 'Hide' : `Trail (${changes.length})`}
                              </button>
                            )}
                          </td>
                        </tr>
                        {expanded === v.id && (
                          <tr>
                            <td colSpan={9} style={{ background: 'var(--g50)' }}>
                              <p className="sub" style={{ fontSize: 10.5, letterSpacing: '.06em', marginBottom: 7 }}>
                                STATUS TRAIL
                              </p>
                              {changes.map((h) => (
                                <div className="list-row" key={h.id}>
                                  <div className="grow">
                                    <b style={{ fontSize: 12 }}>
                                      {h.old_status ?? 'created'} → {h.new_status}
                                    </b>
                                    <p>
                                      {new Date(h.changed_at).toLocaleString('en-GB')}
                                      {' · '}
                                      {h.research_profiles?.full_name
                                        ?? (h.changed_by ? h.changed_by.slice(0, 8) : 'unattributed')}
                                    </p>
                                  </div>
                                  <StatusBadge status={h.new_status} />
                                </div>
                              ))}
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    )
                  })}
                </tbody>
              </table>
            </TableWrap>
          </Card>
        ))}
      </Panel>

      <Provenance>
        An <i>unattributed</i> change means the trigger recorded no actor — which happens
        when a status is changed by the service key rather than by a signed-in user. A
        version that has never been promoted has no trail, which is why the button is
        absent rather than showing an empty list.
      </Provenance>
    </>
  )
}
