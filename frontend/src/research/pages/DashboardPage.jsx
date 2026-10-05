import { Card, Empty, Kpi, PageHead, Panel, Provenance } from '../../gov/lib/ui'
import { fmtAgo, fmtDate } from '../../gov/lib/fmt'
import { useQuery } from '../../gov/lib/useQuery'
import { JobChip, StatusBadge } from '../lib/rui'
import { canOpenOperations, canRun, canTrain } from '../lib/access'
import { fetchDatasetVersions, fetchRuns } from '../lib/queries'

/**
 * Screen 1 — research dashboard.
 *
 * A summary and a set of doors, nothing more: what data exists, how much work
 * has been logged, when the last training happened. Every number here is a
 * count of rows this account can actually see, so a researcher and a lead may
 * legitimately read different totals and neither is wrong.
 */
export default function DashboardPage({ profile, go }) {
  const datasets = useQuery(() => fetchDatasetVersions(), [])
  const runs = useQuery(() => fetchRuns(), [])

  const r = runs.data || []
  const trainings = r.filter((x) => x.run_kind === 'training')
  const evaluations = r.filter((x) => x.run_kind === 'evaluation')
  const lastTraining = trainings.find((x) => x.job_status === 'completed')
  const inFlight = r.filter((x) => ['queued', 'running'].includes(x.job_status))
  const production = trainings.filter((x) => x.status === 'production')
  const ds = datasets.data || []
  const validated = ds.filter((d) => d.schema_validated)

  return (
    <>
      <PageHead title="Research dashboard"
                sub={`Signed in as ${profile.full_name}`} />

      <div className="grid g4">
        <Kpi label="Dataset versions" value={datasets.loading ? '—' : ds.length}
             sub={datasets.loading ? 'loading' : `${validated.length} schema-validated`} />
        <Kpi label="Trainings logged" value={runs.loading ? '—' : trainings.length}
             sub={`${production.length} in production`} />
        <Kpi label="Evaluation runs" value={runs.loading ? '—' : evaluations.length}
             sub="Read-only scorings" />
        <Kpi label="Last training"
             value={lastTraining ? fmtAgo(lastTraining.completed_at || lastTraining.created_at) : '—'}
             sub={lastTraining
               ? `${lastTraining.version_label ?? lastTraining.model_type}`
               : 'No completed training yet'} />
      </div>

      {inFlight.length > 0 && (
        <Card title="In flight" sub="Jobs queued or running right now">
          {inFlight.map((x) => (
            <div className="list-row" key={x.id}>
              <div className="grow">
                <b>{x.version_label || `${x.model_type} ${x.run_kind}`}</b>
                <p>
                  {x.run_kind === 'training' ? 'Training' : 'Evaluation'} ·
                  {' '}started {x.started_at ? fmtAgo(x.started_at) : 'not yet'}
                  {' '}· by {x.research_profiles?.full_name ?? 'unknown'}
                </p>
              </div>
              <JobChip status={x.job_status} />
              <button className="btn sm" onClick={() => go('operations')}>Open</button>
            </div>
          ))}
          <Provenance>
            Progress is polled, not pushed — this project has no realtime channel.
            Open Train &amp; Run Models for the live log of a job.
          </Provenance>
        </Card>
      )}

      <div className="grid g2">
        <Card title="Recent activity" sub="Newest first">
          <Panel q={runs} skeleton={180}
                 empty={<Empty what="Nothing has been run yet."
                               why={canOpenOperations(profile)
                                 ? 'Train a model or run an existing one to populate this.'
                                 : 'Results appear here once a colleague runs or trains something.'} />}>
            {(rows) => (
              <>
                {rows.slice(0, 7).map((x) => (
                  <div className="list-row" key={x.id}>
                    <div className="grow">
                      <b>{x.version_label || `${x.model_type} · ${x.run_kind}`}</b>
                      <p>
                        {fmtDate(x.created_at)} · {x.research_profiles?.full_name ?? 'unknown'}
                        {x.gov_crops?.name ? ` · ${x.gov_crops.name}` : ''}
                      </p>
                    </div>
                    {x.run_kind === 'training'
                      ? <StatusBadge status={x.status} />
                      : <span className="sub" style={{ fontSize: 10.5 }}>evaluation</span>}
                    <JobChip status={x.job_status} />
                  </div>
                ))}
                {rows.length > 7 && (
                  <div className="row" style={{ marginTop: 8 }}>
                    <button className="btn sm" onClick={() => go('comparison')}>
                      See all {rows.length} in Performance Comparison
                    </button>
                  </div>
                )}
              </>
            )}
          </Panel>
        </Card>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <Card title="Go to" sub="The screens you have access to">
            <div className="list-row">
              <div className="grow">
                <b>Dataset Explorer</b>
                <p>Browse the temporal feature data by district, crop and season.</p>
              </div>
              <button className="btn sm" onClick={() => go('explorer')}>Open</button>
            </div>
            <div className="list-row">
              <div className="grow">
                <b>Model Performance Comparison</b>
                <p>Compare runs side by side across type and status.</p>
              </div>
              <button className="btn sm" onClick={() => go('comparison')}>Open</button>
            </div>
            {canOpenOperations(profile) && (
              <div className="list-row">
                <div className="grow">
                  <b>Train &amp; Run Models</b>
                  <p>
                    {canRun(profile) && canTrain(profile)
                      ? 'Run an existing version or train a new one.'
                      : canTrain(profile) ? 'Train or retrain a model.'
                        : canRun(profile) ? 'Run an existing version to evaluate it.'
                          : 'Promote a candidate.'}
                  </p>
                </div>
                <button className="btn sm dark" onClick={() => go('operations')}>Open</button>
              </div>
            )}
            <div className="list-row">
              <div className="grow">
                <b>Model Version History</b>
                <p>Every version, its lineage and its status trail.</p>
              </div>
              <button className="btn sm" onClick={() => go('history')}>Open</button>
            </div>
          </Card>

          {/* A read-only account is told WHY it has no action screens, rather
              than left to conclude the portal is broken. */}
          {!canOpenOperations(profile) && (
            <Card title="Your access" sub="Read-only">
              <Empty what="You can view results but not trigger work.">
                Neither <code>can_run_models</code> nor <code>can_train_models</code> is
                set on your account, so the Train &amp; Run Models screen is not shown.
                Every analytical screen is still fully available, including results from
                runs other researchers have completed. A research lead can grant either
                flag independently.
              </Empty>
            </Card>
          )}
        </div>
      </div>
    </>
  )
}
