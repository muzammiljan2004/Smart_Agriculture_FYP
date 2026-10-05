import { useMemo, useState } from 'react'
import { Card, Empty, PageHead, Panel, Provenance, TableWrap } from '../../gov/lib/ui'
import { HRows } from '../../gov/lib/charts'
import { f1, fmtDate } from '../../gov/lib/fmt'
import { downloadCsv } from '../../gov/lib/csv'
import { useQuery } from '../../gov/lib/useQuery'
import { Select, StatusBadge } from '../lib/rui'
import { fetchVersions } from '../lib/queries'

/**
 * Screen 5 — feature importance.
 *
 * Ranked importance per model version, read from `run_config.feature_importance`
 * — written by the ML service at training time from the fitted estimator's own
 * `feature_importances_`.
 *
 * WHY IT IS NOT ITS OWN TABLE: it is one short vector per run, written once and
 * never queried across runs. A table would need its own policies and its own
 * foreign key for no gain over a jsonb key on the row it belongs to.
 *
 * ONLY TREE MODELS HAVE IT. A model with no `feature_importances_` attribute
 * gets no key, and this screen says so rather than rendering an empty chart —
 * permutation importance would be a different measurement and labelling it the
 * same thing would be wrong.
 */
export default function ImportancePage({ say }) {
  const q = useQuery(() => fetchVersions(), [])
  const [pick, setPick] = useState(null)

  const withImportance = useMemo(
    () => (q.data || []).filter((v) => v.run_config?.feature_importance
                                    && v.job_status === 'completed'),
    [q.data],
  )

  const current = withImportance.find((v) => v.id === pick) || withImportance[0] || null

  const ranked = useMemo(() => {
    const fi = current?.run_config?.feature_importance
    if (!fi) return []
    return Object.entries(fi)
      .map(([f, v]) => ({ feature: f, value: Number(v) }))
      .sort((a, b) => b.value - a.value)
  }, [current])

  const max = ranked[0]?.value || 1

  // Which family each feature belongs to, so the chart can be read as
  // "vegetation beat soil" rather than as fifteen unrelated bars.
  const family = (f) => (
    ['ndvi', 'evi', 'ndwi', 'savi', 'nbr'].includes(f) ? 'vegetation index'
      : ['ph', 'clay_pct', 'silt_pct', 'sand_pct', 'bulk_dens', 'water_33k'].includes(f) ? 'soil'
        : f.startsWith('tmax') || f.startsWith('tmin') || f.startsWith('rain') ? 'weather'
          : 'other'
  )
  const colour = (f) => ({
    'vegetation index': 'var(--g500)',
    soil: '#a9823f',
    weather: '#2f6f9a',
    other: '#9aa79f',
  }[family(f)])

  return (
    <>
      <PageHead title="Feature importance"
                sub="Which index or variable drives each model’s prediction" />

      <div className="r-filters">
        <Select label="Model version" value={current?.id ?? null} onChange={setPick}
                all={null}
                style={{ minWidth: 260 }}
                options={withImportance.map((v) => ({
                  value: v.id,
                  label: `${v.version_label ?? v.id.slice(0, 8)} · ${v.status}`,
                }))} />
        <div className="spacer" />
        {ranked.length > 0 && (
          <button className="btn sm" onClick={() => {
            downloadCsv(`feature_importance_${current.version_label ?? current.id.slice(0, 8)}.csv`,
              ranked.map((r, i) => ({
                rank: i + 1, feature: r.feature, family: family(r.feature),
                importance: r.value,
                model_version: current.version_label ?? current.id,
                model_type: current.model_type, status: current.status,
              })))
            say('Exported feature importance')
          }}>Export CSV</button>
        )}
      </div>

      <Panel q={q} skeleton={260}
             empty={<Empty what="No model versions have been trained yet."
                           why="Feature importance is recorded at training time, so it appears once a training completes." />}>
        {() => withImportance.length === 0 ? (
          <Empty what="No trained version carries a feature-importance vector.">
            It is written at training time from the fitted estimator's own
            <code> feature_importances_</code>, which only tree-based models expose.
            A completed RandomForest training will populate this screen; a CNN or LSTM
            would need permutation importance instead, which is a different
            measurement and is not computed here.
          </Empty>
        ) : (
          <>
            <Card title={current.version_label ?? current.id.slice(0, 8)}
                  sub={`${current.model_type} · trained ${fmtDate(current.completed_at || current.created_at)}`}
                  right={<StatusBadge status={current.status} long />}>
              <HRows rows={ranked.map((r) => ({
                l: r.feature,
                v: r.value,
                max,
                t: f1(r.value * 100, 1) + '%',
                c: colour(r.feature),
              }))} />
              <div className="leg" style={{ marginTop: 10 }}>
                {['vegetation index', 'soil', 'weather'].map((fam) => (
                  <span key={fam}>
                    <i style={{ background: colour(fam === 'vegetation index' ? 'ndvi'
                      : fam === 'soil' ? 'ph' : 'tmax_mean_c') }} />
                    {fam}
                  </span>
                ))}
              </div>
              <Provenance>
                Importance is the estimator's own impurity-based measure, normalised to
                sum to 1 across the features this version was fitted on. It says which
                variable the forest <i>used</i>, not which variable causes yield —
                two correlated indices can split the credit between them arbitrarily,
                so a low bar is not evidence that a variable does not matter.
              </Provenance>
            </Card>

            <Card title="Ranked" sub="Highest first">
              <TableWrap>
                <table>
                  <thead>
                    <tr>
                      <th className="r-">#</th><th>Feature</th><th>Family</th>
                      <th className="r-">Importance</th><th className="r-">Share</th>
                    </tr>
                  </thead>
                  <tbody>
                    {ranked.map((r, i) => (
                      <tr key={r.feature}>
                        <td className="mono r-">{i + 1}</td>
                        <td><b>{r.feature}</b></td>
                        <td className="sub">{family(r.feature)}</td>
                        <td className="mono r-">{f1(r.value, 4)}</td>
                        <td className="mono r-">{f1(r.value * 100, 1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </TableWrap>
            </Card>

            {withImportance.length > 1 && (
              <Card title="Other versions with importance recorded"
                    sub="Pick one above to see its ranking">
                {withImportance.filter((v) => v.id !== current.id).map((v) => (
                  <div className="list-row" key={v.id}>
                    <div className="grow">
                      <b>{v.version_label ?? v.id.slice(0, 8)}</b>
                      <p>
                        {v.model_type} · {Object.keys(v.run_config.feature_importance).length} features
                        · trained {fmtDate(v.completed_at || v.created_at)}
                      </p>
                    </div>
                    <StatusBadge status={v.status} />
                    <button className="btn sm" onClick={() => setPick(v.id)}>View</button>
                  </div>
                ))}
              </Card>
            )}
          </>
        )}
      </Panel>
    </>
  )
}
