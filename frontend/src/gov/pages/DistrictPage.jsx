import { useMemo, useState } from 'react'
import GovMap from '../GovMap'
import { Line } from '../lib/charts'
import { RAMPS, dash, f1, norm, ramp, title, yieldDec } from '../lib/fmt'
import {
  Card, Chip, Empty, MapLegendGradient, PageHead, Panel, Provenance, TableWrap,
} from '../lib/ui'
import { fetchDistrictHistory } from '../lib/queries'
import { useFacts } from '../lib/useFacts'
import { useQuery } from '../lib/useQuery'

/**
 * Screen 2 — district drill-down.
 *
 * The metric selector drives both the choropleth and the table, as in the design.
 * The one change is which metrics exist: the design offered NDVI, harvest
 * progress, yield forecast and a composite risk score. Harvest progress has no
 * data and the design's risk score was a synthetic formula over invented values,
 * so the selector offers NDVI, reported yield, model yield and the model's own
 * uncertainty width — all four computed from loaded rows.
 */
const METRICS = {
  ndvi: { label: 'NDVI', ramp: RAMPS.ndvi, lo: 0.2, hi: 0.8,
          get: (d) => d.indices?.ndvi, fmt: (v) => f1(v, 2) },
  actual: { label: 'Reported yield', ramp: RAMPS.yield, auto: true,
            get: (d) => d.actual?.yield_t_ha, fmt: (v, dec) => f1(v, dec) },
  predicted: { label: 'Model yield', ramp: RAMPS.yield, auto: true,
               get: (d) => d.prediction?.predicted_yield, fmt: (v, dec) => f1(v, dec) },
  spread: { label: 'Model uncertainty', ramp: RAMPS.risk, auto: true,
            get: (d) => (d.prediction?.ci_high != null && d.prediction?.ci_low != null
              ? d.prediction.ci_high - d.prediction.ci_low : null),
            fmt: (v, dec) => f1(v, dec) },
}

export default function DistrictPage({ dims, crop, season, cropRow, seasonRow, district, setDistrict }) {
  const facts = useFacts({ dims, crop, season })
  const [metric, setMetric] = useState('ndvi')
  const [search, setSearch] = useState('')

  const districtRow = dims.districts.find((d) => d.name === district) ?? dims.districts[0]
  const history = useQuery(
    () => fetchDistrictHistory({ districtId: districtRow.id, cropId: crop }),
    [districtRow?.id, crop],
    { enabled: Boolean(districtRow && crop) }
  )

  const m = METRICS[metric]

  return (
    <>
      <PageHead title="District monitoring"
                sub={`${title(cropRow?.name ?? '')} · ${seasonRow?.label ?? ''}`}>
        <Chip tone="n">{dims.districts.length} in scope</Chip>
      </PageHead>

      <Panel q={facts} skeleton={360}
             empty={<Empty what="Nothing loaded for this crop and season." why="Try another season." />}>
        {(rows) => {
          const dec = yieldDec(
            rows.find((r) => r.actual)?.actual.yield_t_ha ??
            rows.find((r) => r.prediction)?.prediction.predicted_yield ?? 1
          )
          const vals = rows.map(m.get).filter((v) => v != null).map(Number)
          const lo = m.auto ? (vals.length ? Math.min(...vals) : 0) : m.lo
          const hi = m.auto ? (vals.length ? Math.max(...vals) : 1) : m.hi
          const sel = rows.find((r) => r.name === districtRow?.name)

          const filtered = rows
            .filter((r) => r.name.toLowerCase().includes(search.trim().toLowerCase()))
            .sort((a, b) => {
              const av = m.get(a), bv = m.get(b)
              if (av == null) return 1
              if (bv == null) return -1
              return bv - av
            })

          return (
            <>
              <div className="grid g32">
                <Card title="District map" sub={`${m.label} · ${title(cropRow?.name)}`}
                      right={
                        <select className="inp" style={{ width: 'auto' }} value={metric}
                                aria-label="Map metric"
                                onChange={(e) => setMetric(e.target.value)}>
                          {Object.entries(METRICS).map(([k, v]) => (
                            <option key={k} value={k}>{v.label}</option>
                          ))}
                        </select>
                      }>
                  <GovMap
                    id="district-map" height={430} data={rows} selected={districtRow?.name}
                    fill={(d) => {
                      const v = m.get(d)
                      return v == null ? null : ramp(m.ramp, norm(Number(v), lo, hi))
                    }}
                    tip={(d) => {
                      const v = m.get(d)
                      return `<b>${d.name}</b><br>${m.label}: ${v == null ? 'no data' : m.fmt(Number(v), dec)}`
                    }}
                    onClick={(d) => setDistrict(d.name)}
                    legend={<MapLegendGradient title={m.label} stops={m.ramp}
                                               lo={m.auto ? f1(lo, dec) : String(m.lo)}
                                               hi={m.auto ? f1(hi, dec) : String(m.hi)}
                                               note="Grey = no value loaded" />}
                    badge="Approximate district cells"
                  />
                </Card>

                <Card title={districtRow?.name ?? '—'} sub={`District profile · ${title(cropRow?.name)}`}>
                  <div className="grid g2" style={{ margin: '0 0 8px' }}>
                    {[
                      ['NDVI', dash(sel?.indices?.ndvi)],
                      ['Reported yield', dash(sel?.actual?.yield_t_ha, (v) => f1(v, dec))],
                      ['Model yield', dash(sel?.prediction?.predicted_yield, (v) => f1(v, dec))],
                      ['Model range', sel?.prediction?.ci_low == null ? '—'
                        : `${f1(sel.prediction.ci_low, dec)}–${f1(sel.prediction.ci_high, dec)}`],
                    ].map(([l, v]) => (
                      <div key={l}>
                        <div className="lbl">{l}</div>
                        <div style={{ font: '700 20px var(--display)' }}>{v}</div>
                      </div>
                    ))}
                  </div>

                  <div className="row" style={{ marginBottom: 8 }}>
                    {sel?.prediction?.evaluation === 'in_sample' && (
                      <Chip tone="a">In-sample fit</Chip>
                    )}
                    {sel?.actual?.confidence && (
                      <Chip tone="n">{shortConfidence(sel.actual.confidence)}</Chip>
                    )}
                  </div>

                  <div className="lbl" style={{ marginTop: 6 }}>
                    Reported yield by season {history.data ? '' : ''}
                  </div>
                  <Panel q={history} skeleton={150}
                         empty={<Empty what="No history for this district and crop." why="" />}>
                    {(h) => <SeasonTrend h={h} seasons={dims.seasons} dec={dec} />}
                  </Panel>
                </Card>
              </div>

              <Card title="All districts" sub="Select a row to focus the map">
                <div className="row" style={{ marginBottom: 10 }}>
                  <input className="inp" style={{ maxWidth: 220 }} placeholder="Search district"
                         aria-label="Search district" value={search}
                         onChange={(e) => setSearch(e.target.value)} />
                </div>
                <TableWrap>
                  <table>
                    <thead>
                      <tr>
                        <th>District</th>
                        <th className="r-">NDVI</th>
                        <th className="r-">Reported</th>
                        <th className="r-">Model</th>
                        <th className="r-">Model range</th>
                        <th>Basis</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filtered.length === 0 ? (
                        <tr><td colSpan="6" className="sub">
                          No district matches “{search}”.
                        </td></tr>
                      ) : filtered.map((r) => (
                        <tr key={r.district_id}
                            className={'clk ' + (r.name === districtRow?.name ? 'sel' : '')}
                            onClick={() => setDistrict(r.name)}>
                          <td><b>{r.name}</b></td>
                          <td className="mono r-">{dash(r.indices?.ndvi)}</td>
                          <td className="mono r-">{dash(r.actual?.yield_t_ha, (v) => f1(v, dec))}</td>
                          <td className="mono r-">{dash(r.prediction?.predicted_yield, (v) => f1(v, dec))}</td>
                          <td className="mono r-">
                            {r.prediction?.ci_low == null ? '—'
                              : `${f1(r.prediction.ci_low, dec)}–${f1(r.prediction.ci_high, dec)}`}
                          </td>
                          <td>
                            {!r.prediction ? <Chip tone="n">No model run</Chip>
                              : r.prediction.evaluation === 'in_sample' ? <Chip tone="a">In-sample</Chip>
                                : <Chip>Out-of-sample</Chip>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </TableWrap>
                <Provenance>
                  “Reported” is the Bureau of Statistics figure for the season. “Model” is the
                  production RandomForest run on that district's seasonal composite. Where the
                  basis says in-sample, the model was trained on this row and the agreement
                  between the two columns says nothing about accuracy.
                </Provenance>
              </Card>
            </>
          )
        }}
      </Panel>
    </>
  )
}

/** Reported and modelled yield across every season the district has. */
function SeasonTrend({ h, seasons, dec }) {
  const { labels, actual, predicted } = useMemo(() => {
    const byA = new Map(h.actuals.map((a) => [a.season_id, Number(a.yield_t_ha)]))
    const byP = new Map(h.preds.map((p) => [p.season_id, Number(p.predicted_yield)]))
    return {
      labels: seasons.map((s) => s.label.slice(2)),
      // null, not 0, for a season with no row: Line breaks the path on null and
      // would otherwise draw a crash to zero and back.
      actual: seasons.map((s) => byA.get(s.id) ?? null),
      predicted: seasons.map((s) => byP.get(s.id) ?? null),
    }
  }, [h, seasons])

  if (!actual.some((v) => v != null) && !predicted.some((v) => v != null)) {
    return <Empty what="No seasons loaded for this district and crop." why="" />
  }

  return (
    <>
      <Line
        labels={labels} h={160} dec={dec}
        series={[
          { c: 'var(--g700)', v: actual, area: 1, name: 'Reported' },
          { c: '#d9822b', v: predicted, dash: 1, w: 1.6, name: 'Model' },
        ]}
        alt="Reported and modelled yield by season"
      />
      <div className="leg">
        <span><i style={{ background: 'var(--g700)' }} />Reported</span>
        <span><i style={{ background: '#d9822b' }} />Model</span>
      </div>
    </>
  )
}

/** The provenance strings are long sentences from the source series; the chip
 *  needs the first clause, and the full text stays in the title attribute. */
const shortConfidence = (s) => (s.length > 34 ? s.split(':')[0] : s)
