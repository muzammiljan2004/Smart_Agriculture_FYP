import { useMemo, useState } from 'react'
import { Card, Empty, Kpi, PageHead, Panel, Provenance, TableWrap } from '../../gov/lib/ui'
import { Line } from '../../gov/lib/charts'
import { dash, f1, fmtDate } from '../../gov/lib/fmt'
import { downloadCsv } from '../../gov/lib/csv'
import { useQuery } from '../../gov/lib/useQuery'
import { Select } from '../lib/rui'
import { canRun, canTrain } from '../lib/access'
import { fetchDatasetVersions, fetchSatelliteIndices } from '../lib/queries'

/**
 * Screen 2 — dataset explorer.
 *
 * Two things in one screen, because the brief asks for both: the raw temporal
 * feature data, filterable by district / crop / season, and the list of
 * dataset_versions available for training or running regardless of who
 * uploaded them.
 *
 * EXPORT IS GATED, PREVIEW IS NOT. The brief says "preview and export
 * (CSV/JSON) gated by permission level" without naming the level, so the
 * assumption taken -- and flagged in the summary -- is that an account which
 * can trigger work (can_run_models or can_train_models) may export, and a
 * read-only account may preview on screen but not take the data away. Reading a
 * table and walking off with the dataset are different acts; if that is the
 * wrong split it is one predicate to change.
 */
export default function ExplorerPage({ dims, crop, setCrop, season, setSeason,
                                       district, setDistrict, profile, go, say }) {
  const [limit, setLimit] = useState(200)
  const mayExport = canRun(profile) || canTrain(profile)

  const q = useQuery(
    () => fetchSatelliteIndices({ districtId: district, cropId: crop, seasonId: season }),
    [district, crop, season],
  )
  const versions = useQuery(() => fetchDatasetVersions(), [])

  const rows = q.data || []

  // The NDVI trace for the current selection. Only meaningful once the filters
  // narrow to a single series -- averaging NDVI across districts would draw a
  // line that describes no field anywhere.
  const trace = useMemo(() => {
    if (!district || !crop) return null
    const pts = rows.filter((r) => r.ndvi != null)
    if (pts.length < 2) return null
    return {
      labels: pts.map((r) => (r.date || '').slice(5)),
      series: [
        { name: 'NDVI', v: pts.map((r) => r.ndvi), c: 'var(--g500)' },
        { name: 'NDWI', v: pts.map((r) => r.ndwi), c: '#2f6f9a' },
      ],
    }
  }, [rows, district, crop])

  function exportRows(kind) {
    const flat = rows.map((r) => ({
      district: r.gov_districts?.name ?? '',
      crop: r.gov_crops?.name ?? '',
      season: r.gov_seasons?.label ?? '',
      date: r.date,
      ndvi: r.ndvi, evi: r.evi, ndwi: r.ndwi, savi: r.savi, nbr: r.nbr,
      source: r.source ?? '',
    }))
    if (kind === 'csv') {
      downloadCsv(`temporal_features_${Date.now()}.csv`, flat)
    } else {
      // JSON export has no helper in the shared lib because nothing else needs
      // one; a blob here is smaller than a module.
      const blob = new Blob([JSON.stringify(flat, null, 2)], { type: 'application/json' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = `temporal_features_${Date.now()}.json`
      a.click()
      URL.revokeObjectURL(a.href)
    }
    say(`Exported ${flat.length} rows as ${kind.toUpperCase()}`)
  }

  return (
    <>
      <PageHead title="Dataset explorer"
                sub="Raw temporal feature data, and the dataset versions available to train or run on" />

      <div className="r-filters">
        <Select label="District" value={district} onChange={setDistrict}
                options={dims?.districts ?? []} all="All districts" />
        <Select label="Crop" value={crop} onChange={setCrop}
                options={dims?.crops ?? []} all="All crops" />
        <Select label="Season" value={season} onChange={setSeason}
                options={(dims?.seasons ?? []).map((s) => ({ id: s.id, name: s.label }))}
                all="All seasons" />
        <div className="spacer" />
        {mayExport ? (
          <>
            <button className="btn sm" disabled={!rows.length}
                    onClick={() => exportRows('csv')}>Export CSV</button>
            <button className="btn sm" disabled={!rows.length}
                    onClick={() => exportRows('json')}>Export JSON</button>
          </>
        ) : (
          <span className="sub" style={{ fontSize: 11, maxWidth: 260 }}>
            Export needs <code>can_run_models</code> or <code>can_train_models</code>.
            Preview below is unrestricted.
          </span>
        )}
      </div>

      <div className="grid g4">
        <Kpi label="Observations" value={q.loading ? '—' : rows.length.toLocaleString('en-US')}
             sub="Matching the current filter" />
        <Kpi label="Districts" value={q.loading ? '—' : new Set(rows.map((r) => r.district_id)).size}
             sub={`of ${dims?.districts.length ?? '—'}`} />
        <Kpi label="Date range"
             value={rows.length ? (rows[0].date || '').slice(0, 7) : '—'}
             sub={rows.length ? `to ${(rows[rows.length - 1].date || '').slice(0, 7)}` : ''} />
        <Kpi label="Dataset versions" value={versions.loading ? '—' : (versions.data || []).length}
             sub="Usable for training or running" />
      </div>

      {trace && (
        <Card title="Index trace" sub="The current district, crop and season">
          <Line series={trace.series} labels={trace.labels} h={200} dec={3}
                alt="Vegetation and water index over the selected season" />
          <Provenance>
            Drawn only when a single district and crop are selected. Averaging an
            index across districts would plot a curve that describes no field
            anywhere, so the chart is withheld rather than made up.
          </Provenance>
        </Card>
      )}

      <Card title="Temporal features" sub={`First ${limit} rows`}
            right={rows.length > limit
              ? <button className="btn sm" onClick={() => setLimit((l) => l + 500)}>
                  Show 500 more
                </button>
              : null}>
        <Panel q={q} skeleton={260}
               empty={<Empty what="No observations match this filter."
                             why="gov_satellite_indices covers 2017-18 onward, and only the district-crop-season combinations the pipeline actually fetched. Widen the filter." />}>
          {(all) => (
            <TableWrap>
              <table>
                <thead>
                  <tr>
                    <th>Date</th><th>District</th><th>Crop</th><th>Season</th>
                    <th className="r-">NDVI</th><th className="r-">EVI</th>
                    <th className="r-">NDWI</th><th className="r-">SAVI</th>
                    <th className="r-">NBR</th><th>Source</th>
                  </tr>
                </thead>
                <tbody>
                  {all.slice(0, limit).map((r) => (
                    <tr key={r.id}>
                      <td className="mono">{r.date}</td>
                      <td>{r.gov_districts?.name ?? '—'}</td>
                      <td>{r.gov_crops?.name ?? '—'}</td>
                      <td className="mono">{r.gov_seasons?.label ?? '—'}</td>
                      <td className="mono r-">{dash(r.ndvi, (v) => f1(v, 3))}</td>
                      <td className="mono r-">{dash(r.evi, (v) => f1(v, 3))}</td>
                      <td className="mono r-">{dash(r.ndwi, (v) => f1(v, 3))}</td>
                      <td className="mono r-">{dash(r.savi, (v) => f1(v, 3))}</td>
                      <td className="mono r-">{dash(r.nbr, (v) => f1(v, 3))}</td>
                      <td className="sub">{r.source ?? '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Panel>
        <Provenance>
          Read-only from <code>gov_satellite_indices</code>, the government portal's
          district-level composites. A blank cell is a missing observation, never a
          zero — the two mean different things and this table does not conflate them.
        </Provenance>
      </Card>

      <Card title="Dataset versions" sub="Available to everyone who can train, whoever uploaded them"
            right={<button className="btn sm" onClick={() => go('versions')}>
                     Manage versions
                   </button>}>
        <Panel q={versions} skeleton={140}
               empty={<Empty what="No dataset versions have been registered."
                             why={canTrain(profile)
                               ? 'Upload one on the Dataset Versioning screen.'
                               : 'An account with can_train_models has to upload one.'} />}>
          {(list) => (
            <TableWrap>
              <table>
                <thead>
                  <tr>
                    <th>Description</th><th className="r-">Records</th>
                    <th>Schema</th><th>Uploaded by</th><th>Created</th>
                  </tr>
                </thead>
                <tbody>
                  {list.map((d) => (
                    <tr key={d.id}>
                      <td><b>{d.description}</b></td>
                      <td className="mono r-">{d.record_count.toLocaleString('en-US')}</td>
                      <td>
                        {d.schema_validated
                          ? <span className="r-badge approved"><i />Validated</span>
                          : <span className="r-badge candidate"><i />Failed</span>}
                      </td>
                      <td className="sub">{d.research_profiles?.full_name ?? '—'}</td>
                      <td className="sub">{fmtDate(d.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableWrap>
          )}
        </Panel>
      </Card>
    </>
  )
}
