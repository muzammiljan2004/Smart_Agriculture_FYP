import { useState } from 'react'
import GovMap from '../GovMap'
import { HRows } from '../lib/charts'
import { RAMPS, f1, ramp, title } from '../lib/fmt'
import {
  Button, Card, Empty, Kpi, MapLegendGradient, PageHead, Panel, Provenance, Tabs, TableWrap,
} from '../lib/ui'
import { districtCells } from '../lib/geo'
import { fetchSubsidy, fetchSubsidyResourceTypes } from '../lib/queries'
import { useQuery } from '../lib/useQuery'
import { downloadCsv } from '../lib/csv'

/**
 * Screen 9 — subsidy and resource targeting.
 *
 * THE RULE IS THE SCREEN. The brief requires the ranking rationale to be visible
 * per row, not a bare ordered list, so `reason` is a full sentence stored with
 * each row and printed in its own column at full width — and the rule is also
 * stated once at the top in the same terms, so a reader can check that the rows
 * follow it.
 *
 * The design's budget-allocation planner is NOT reproduced. It distributed a
 * notional PKR figure across districts by priority-score-squared, which is an
 * allocation formula nobody specified and which this project has no authority to
 * propose; printing rupee amounts next to district names invites them to be read
 * as a decision. The ranking and its justification are what the brief asks for and
 * what the data supports.
 *
 * Resource tabs come from the DATA, not a fixed list: only the water rule has been
 * implemented upstream, so the screen shows one tab rather than four with three
 * empty.
 */
export default function SubsidyPage({ dims, crop, season, cropRow, seasonRow, say }) {
  const types = useQuery(() => fetchSubsidyResourceTypes(), [])
  const [resource, setResource] = useState(null)
  const chosen = resource ?? types.data?.[0] ?? null

  const q = useQuery(
    () => fetchSubsidy({ seasonId: season, resourceType: chosen }),
    [season, chosen],
    { enabled: Boolean(season && chosen) }
  )

  return (
    <>
      <PageHead title="Subsidy & resources"
                sub={`Targeting for ${seasonRow?.label ?? ''} · ranked within each crop`} />

      <Panel q={types} skeleton={60}
             empty={<Empty what="No targeting rule has been run.">
               gov_subsidy_recommendations is empty. The rule is implemented in
               ml-service/scripts/seed_gov_portal.py; run it to populate this screen.
             </Empty>}>
        {(list) => (
          <>
            {list.length > 1 && (
              <Tabs items={list.map((t) => [t, title(t)])} value={chosen} onChange={setResource} />
            )}

            <Card title="The ranking rule" sub="Both conditions are required; neither alone qualifies a district">
              <div className="grid g2" style={{ margin: 0 }}>
                <div>
                  <div className="lbl">Condition A — yield deficit</div>
                  <p style={{ fontSize: 12, marginTop: 4 }}>
                    This season's reported yield is at least <b>10% below</b> that district's own
                    mean for the same crop across every earlier season, needing at least four prior
                    seasons to compare against. Below 10% is inside the year-to-year noise of the
                    reported series itself.
                  </p>
                </div>
                <div>
                  <div className="lbl">Condition B — water access</div>
                  <p style={{ fontSize: 12, marginTop: 4 }}>
                    The district's soil water retention at field capacity (−33 kPa, from
                    OpenLandMap) ranks in the <b>drier half</b> of Punjab's 34 districts. This is
                    the measured proxy for how much of an irrigation turn the soil can hold.
                  </p>
                </div>
              </div>
              <Provenance>
                Compared against each district's OWN history rather than a provincial threshold:
                barani Chakwal runs structurally drier than canal-irrigated Sahiwal, so a single
                provincial cut-off would flag the north every season and tell a policymaker nothing
                they did not already know. A district measured against itself flags a change.
                <br />
                This is a prioritisation aid. It is not an allocation decision, and it deliberately
                attaches no budget figure to any district.
              </Provenance>
            </Card>

            <Panel q={q} skeleton={300}
                   empty={<Empty what={`No district met both conditions in ${seasonRow?.label}.`}>
                     That is a result, not a gap: the rule requires a yield deficit of 10% or more
                     AND below-median soil water retention, and in this season no district-crop
                     pair satisfied both. Districts that met only one are deliberately not listed.
                   </Empty>}>
              {(rows) => {
                const forCrop = rows.filter((r) => r.crop_id === crop)
                const cells = districtCells(
                  dims.districts.map((d) => {
                    const hit = forCrop.find((r) => r.district_id === d.id)
                    return { ...d, rec: hit || null }
                  })
                )
                const exportRows = () => rows.map((r) => ({
                  rank: r.rank,
                  district: r.gov_districts?.name ?? '',
                  crop: r.gov_crops?.name ?? '',
                  resource: r.resource_type,
                  priority_score: r.priority_score,
                  yield_deficit_pct: r.yield_deficit_pct,
                  water_access_score: r.resource_access_score,
                  reason: r.reason,
                }))

                return (
                  <>
                    <div className="grid g4">
                      <Kpi label="Districts flagged" value={forCrop.length}
                           sub={`${title(cropRow?.name)} · of ${dims.districts.length}`} />
                      <Kpi label="Across all crops" value={rows.length}
                           sub={`${new Set(rows.map((r) => r.crop_id)).size} crops affected`} />
                      <Kpi
                        label="Largest deficit"
                        value={rows.length
                          ? f1(Math.max(...rows.map((r) => Number(r.yield_deficit_pct || 0))), 1) + '%'
                          : '—'}
                        sub="Below the district's own mean"
                      />
                      <Kpi label="Resource" value={title(chosen ?? '—')}
                           sub={list.length === 1 ? 'Only rule implemented' : 'Selected'} />
                    </div>

                    <div className="grid g32">
                      <Card title="Priority by district"
                            sub={`${title(cropRow?.name)} · darker is higher priority`}>
                        <GovMap
                          id="subsidy-map" height={420} data={cells} fillOpacity={0.6}
                          fill={(d) => (d.rec == null ? null
                            : ramp(RAMPS.prio, Number(d.rec.priority_score)))}
                          tip={(d) => d.rec
                            ? `<b>${d.name}</b><br>Priority ${Math.round(d.rec.priority_score * 100)}/100`
                              + `<br>Deficit ${f1(d.rec.yield_deficit_pct, 1)}%`
                            : `<b>${d.name}</b><br>Did not meet both conditions`}
                          legend={<MapLegendGradient title="Priority" stops={RAMPS.prio}
                                                     lo="lower" hi="higher"
                                                     note="Grey = not flagged" />}
                        />
                      </Card>

                      <Card title="Flagged districts" sub={`${title(cropRow?.name)}, by priority`}>
                        {forCrop.length === 0 ? (
                          <Empty what={`No ${title(cropRow?.name)} districts flagged.`}
                                 why="Other crops may be — see the table below." />
                        ) : (
                          <HRows
                            rows={forCrop.map((r) => ({
                              l: r.gov_districts?.name ?? '—',
                              v: Number(r.priority_score), max: 1,
                              t: String(Math.round(r.priority_score * 100)),
                              c: ramp(RAMPS.prio, Number(r.priority_score)),
                            }))}
                          />
                        )}
                      </Card>
                    </div>

                    <Card title="Ranked districts, with the reason for each"
                          sub={`${title(chosen)} support · ${seasonRow?.label}`}
                          right={
                            <Button size="sm"
                                    onClick={() => {
                                      downloadCsv(`subsidy-targeting-${seasonRow?.label}.csv`, exportRows())
                                      say('Targeting list exported')
                                    }}>
                              Export CSV
                            </Button>
                          }>
                      <TableWrap>
                        <table>
                          <thead>
                            <tr>
                              <th className="r-">#</th><th>District</th><th>Crop</th>
                              <th className="r-">Priority</th><th className="r-">Deficit</th>
                              <th className="r-">Water access</th>
                              <th style={{ minWidth: 320 }}>Why this district is listed</th>
                            </tr>
                          </thead>
                          <tbody>
                            {rows.map((r) => (
                              <tr key={r.id}
                                  className={r.crop_id === crop ? 'sel' : undefined}>
                                <td className="mono r-">{r.rank}</td>
                                <td><b>{r.gov_districts?.name}</b></td>
                                <td>{title(r.gov_crops?.name ?? '')}</td>
                                <td className="mono r-">{Math.round(r.priority_score * 100)}</td>
                                <td className="mono r-">{f1(r.yield_deficit_pct, 1)}%</td>
                                <td className="mono r-">{f1(r.resource_access_score, 2)}</td>
                                {/* The brief's requirement: the rationale, in full, per row. */}
                                <td style={{ whiteSpace: 'normal', lineHeight: 1.45 }}>{r.reason}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </TableWrap>
                      <Provenance>
                        Rank is within each crop. Rows for {title(cropRow?.name)} are highlighted;
                        every crop's flagged districts are listed so a cross-crop pattern in one
                        district is visible rather than hidden behind the crop selector.
                      </Provenance>
                    </Card>
                  </>
                )
              }}
            </Panel>
          </>
        )}
      </Panel>
    </>
  )
}
