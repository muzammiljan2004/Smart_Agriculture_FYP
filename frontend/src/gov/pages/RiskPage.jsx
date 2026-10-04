import { useState } from 'react'
import GovMap from '../GovMap'
import { ALERT_COLOR, ALERT_LABEL, f1, fmtAgo, title } from '../lib/fmt'
import {
  Card, Chip, Empty, Kpi, MapLegendItems, PageHead, Panel, Provenance, Tabs, TableWrap,
} from '../lib/ui'
import { districtCells } from '../lib/geo'
import { fetchRiskAlerts } from '../lib/queries'
import { useQuery } from '../lib/useQuery'

/**
 * Screen 10 — authority-side risk and alerts.
 *
 * NEVER SENT TO FARMERS, and that is structural rather than a policy note:
 * gov_risk_alerts is a different table from public.alerts, which is the one the
 * farmer side reads and emails. Nothing joins them. A provincial drought warning
 * cannot reach a grower's inbox because there is no path from this table to the
 * mailer.
 *
 * Two of the four alert types have a detector and two do not, and the screen says
 * which. The design showed fifteen alerts across all four types because it
 * generated them; here, flood needs Sentinel-1 backscatter at district grain and
 * anomaly needs a within-season curve, and neither is collected — so those tabs
 * report "no detector" rather than "no events", which are very different facts for
 * someone deciding whether to worry about floods.
 */
const DETECTORS = {
  drought: { wired: true,
    rule: 'Seasonal NDVI more than 1.0 SD below the district-crop\'s own mean across every '
        + 'earlier season, with at least four prior seasons to compare against.' },
  water_stress: { wired: true,
    rule: 'The same NDVI deviation at a milder threshold (between 1.0 and 1.5 SD below), '
        + 'labelled separately because a mild deficit more often reflects an irrigation gap '
        + 'than a failed stand.' },
  flood: { wired: false,
    rule: 'Needs a Sentinel-1 SAR backscatter drop over cropland. Radar is collected per FARM '
        + 'on the farmer side (satellite_features.vv/vh), never at district grain, so there is '
        + 'no series to threshold.' },
  anomaly: { wired: false,
    rule: 'Needs a within-season NDVI curve to find an abrupt change against. Only one '
        + 'season-long median composite is stored per district-crop, so there is no curve. The '
        + 'experimental temporal pipeline fetched one and was not promoted to production.' },
}

export default function RiskPage({ dims, season, seasonRow }) {
  const q = useQuery(() => fetchRiskAlerts(), [])
  const [type, setType] = useState('all')
  const [severity, setSeverity] = useState('all')

  return (
    <>
      <PageHead title="Risk & alerts"
                sub="Aggregated for authorities. These are not sent to farmers.">
        <Chip tone="n">Dashboard view only</Chip>
      </PageHead>

      <Panel q={q} skeleton={320}
             empty={<Empty what="No alerts have been generated.">
               The drought rule compares each district against its own history and writes rows when
               the threshold is crossed. Run ml-service/scripts/seed_gov_portal.py to evaluate it.
             </Empty>}>
        {(all) => {
          const forSeason = all.filter((a) => !season || a.season_id === season)
          const visible = forSeason.filter((a) =>
            (type === 'all' || a.alert_type === type) &&
            (severity === 'all' || a.severity === severity))

          const flagged = new Map()
          visible.forEach((a) => {
            if (!flagged.has(a.district_id)) flagged.set(a.district_id, [])
            flagged.get(a.district_id).push(a)
          })
          const cells = districtCells(
            dims.districts.map((d) => ({ ...d, hits: flagged.get(d.id) ?? [] }))
          )
          const worst = (hits) => hits.some((h) => h.severity === 'high') ? 'high'
            : hits.some((h) => h.severity === 'medium') ? 'medium'
              : hits.length ? 'low' : null
          const SEV = { high: '#b4342b', medium: '#d9822b', low: '#d4b02a' }

          return (
            <>
              <div className="grid g4">
                {Object.keys(DETECTORS).map((k) => {
                  const n = forSeason.filter((a) => a.alert_type === k).length
                  const high = forSeason.filter((a) => a.alert_type === k && a.severity === 'high').length
                  return (
                    <Kpi key={k} label={ALERT_LABEL[k]}
                         value={DETECTORS[k].wired ? n : '—'}
                         sub={DETECTORS[k].wired
                           ? `${high} high severity`
                           : 'No detector at this grain'} />
                  )
                })}
              </div>

              <Tabs
                items={[['all', 'All'], ...Object.keys(DETECTORS).map((k) => [k, ALERT_LABEL[k]])]}
                value={type} onChange={setType}
              />

              {type !== 'all' && !DETECTORS[type].wired && (
                <Empty what={`${ALERT_LABEL[type]} detection is not wired.`}>
                  {DETECTORS[type].rule}
                  <br /><br />
                  Zero {ALERT_LABEL[type].toLowerCase()} alerts here means no detector has run — it
                  does not mean no {ALERT_LABEL[type].toLowerCase()} occurred.
                </Empty>
              )}

              <div className="grid g32">
                <Card title="Risk map" sub="Districts with an open alert">
                  <GovMap
                    id="risk-map" height={420} data={cells} fillOpacity={0.5}
                    fill={(d) => {
                      const w = worst(d.hits)
                      return w ? SEV[w] : '#8d9a92'
                    }}
                    tip={(d) => d.hits.length
                      ? `<b>${d.name}</b><br>` + d.hits.map((h) =>
                        `${ALERT_LABEL[h.alert_type]} · ${h.severity}`).join('<br>')
                      : `<b>${d.name}</b><br>No open alert`}
                    legend={<MapLegendItems title="Highest severity"
                                            items={[['High', SEV.high], ['Medium', SEV.medium],
                                                    ['Low', SEV.low], ['None', '#8d9a92']]} />}
                  />
                </Card>

                <Card title="Alerts" sub={`${visible.length} shown`}
                      right={
                        <select className="inp" style={{ width: 'auto' }} value={severity}
                                aria-label="Severity" onChange={(e) => setSeverity(e.target.value)}>
                          <option value="all">All severities</option>
                          <option value="high">High</option>
                          <option value="medium">Medium</option>
                          <option value="low">Low</option>
                        </select>
                      }>
                  {visible.length === 0 ? (
                    <Empty what="No alerts match these filters." why="" />
                  ) : (
                    <div style={{ maxHeight: 400, overflow: 'auto' }}>
                      {visible.map((a) => (
                        <div className="list-row" key={a.id}>
                          <span style={{
                            width: 9, height: 9, borderRadius: '50%',
                            background: ALERT_COLOR[a.alert_type], marginTop: 5, flex: 'none',
                          }} />
                          <div className="grow">
                            <div className="row" style={{ gap: 6 }}>
                              <b>{ALERT_LABEL[a.alert_type]} · {a.gov_districts?.name}</b>
                              <Chip tone={a.severity === 'high' ? 'r' : a.severity === 'medium' ? 'a' : 'n'}>
                                {title(a.severity)}
                              </Chip>
                              {a.gov_crops?.name && <Chip tone="n">{title(a.gov_crops.name)}</Chip>}
                            </div>
                            <p>{a.message}</p>
                            <div className="row" style={{ marginTop: 6, gap: 8 }}>
                              <span className="sub">{fmtAgo(a.triggered_at)}</span>
                              {a.details?.z_score != null && (
                                <span className="sub mono">
                                  {f1(a.details.z_score, 2)} SD · {a.details.seasons_compared} seasons compared
                                </span>
                              )}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  <Provenance>
                    Alerts are not acknowledgeable here. The design had an Acknowledge button; the
                    table has a `resolved` flag but the portal's RLS gives authenticated users no
                    write access to it, because these rows are pipeline-owned. Acknowledgement
                    would need its own table with its own policy rather than a client-side flag
                    that resets on reload.
                  </Provenance>
                </Card>
              </div>

              <div className="grid g2">
                <Card title="Detection rules" sub="What fires each alert type">
                  {Object.entries(DETECTORS).map(([k, d]) => (
                    <div className="list-row" key={k}>
                      <span style={{
                        width: 9, height: 9, borderRadius: '50%', background: ALERT_COLOR[k],
                        marginTop: 5, flex: 'none',
                      }} />
                      <div className="grow">
                        <b>{ALERT_LABEL[k]}</b>
                        <p>{d.rule}</p>
                      </div>
                      {d.wired ? <Chip>Wired</Chip> : <Chip tone="n">Not wired</Chip>}
                    </div>
                  ))}
                </Card>

                <Card title="Evidence behind each alert" sub="The stored rule parameters">
                  {visible.length === 0 ? <Empty what="Nothing selected." why="" /> : (
                    <TableWrap>
                      <table>
                        <thead>
                          <tr>
                            <th>District</th><th className="r-">Observed</th>
                            <th className="r-">Mean</th><th className="r-">SD</th>
                            <th className="r-">Deviation</th>
                          </tr>
                        </thead>
                        <tbody>
                          {visible.slice(0, 14).map((a) => (
                            <tr key={a.id}>
                              <td><b>{a.gov_districts?.name}</b></td>
                              <td className="mono r-">{a.details?.observed_ndvi ?? '—'}</td>
                              <td className="mono r-">{a.details?.historical_mean ?? '—'}</td>
                              <td className="mono r-">{a.details?.historical_sd ?? '—'}</td>
                              <td className="mono r-">
                                {a.details?.z_score == null ? '—' : f1(a.details.z_score, 2) + ' SD'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </TableWrap>
                  )}
                  <Provenance>
                    Every alert stores the threshold, the observed value and the comparison window,
                    so a reviewer can tell a real signal from a cloud artefact without opening the
                    pipeline.
                  </Provenance>
                </Card>
              </div>
            </>
          )
        }}
      </Panel>
    </>
  )
}
