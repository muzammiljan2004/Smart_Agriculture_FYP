import { useCallback, useEffect, useMemo, useState } from 'react'
import { Card, Empty, PageHead, Panel, Provenance, Tabs } from '../../gov/lib/ui'
import { fmtDate } from '../../gov/lib/fmt'
import { useQuery } from '../../gov/lib/useQuery'
import {
  Confirm, Console, JobChip, MetricSet, ModelPicker, RunReport, Select, StatusBadge,
} from '../lib/rui'
import {
  MODEL_TYPES, STATUS_LABEL, TRAINABLE, UNTRAINABLE_REASON,
  canPromote, canRun, canTrain,
} from '../lib/access'
import {
  fetchDatasetVersions, fetchRun, fetchRunLogs, fetchVersions,
  queueEvaluation, queueTraining, setModelStatus, startRun,
} from '../lib/queries'
import { dbError } from '../../lib/dbError'

/**
 * Screen 7 — train & run models. The core interactive screen.
 *
 * THREE ACTIONS, THREE SEPARATE CODE PATHS, NO SHARED WRITE LOGIC. The brief
 * asks for that explicitly and it is worth saying where the separation actually
 * lives, because tabs in one component are not separation:
 *
 *   Action A  queueEvaluation()  -> insert run_kind='evaluation', status NULL
 *   Action B  queueTraining()    -> insert run_kind='training',   status 'candidate'
 *   Action C  setModelStatus()   -> update status, and only status
 *
 * Those are three distinct functions in lib/queries.js writing three distinct
 * shapes, each matched by its own RLS policy. No helper is shared between them,
 * so there is no code path by which running a model could touch a status.
 *
 * WHAT IS RENDERED IS DECIDED BY CAPABILITY, AND ABSENT RATHER THAN DISABLED.
 * A researcher without can_train_models gets no Train tab at all -- not a
 * greyed-out one. A greyed control still announces a capability being withheld,
 * which is a worse experience than a screen that simply does not offer it.
 */
const ACTIVE_KEY = 'research.activeRun'

/** What the job is actually doing, per kind -- "running" alone does not say
 *  whether a model is being scored or fitted, and those take different times. */
const WORKING_ON = {
  evaluation: 'scoring the selected version(s) against the chosen dataset',
  training: 'fitting a new candidate model on the chosen dataset',
}

export default function OperationsPage({ profile, dims, say }) {
  const mayRun = canRun(profile)
  const mayTrain = canTrain(profile)
  const mayPromote = canPromote(profile)

  // Tabs takes [value, label] PAIRS, not objects -- see gov/lib/ui.jsx, where a
  // non-array item is used as both the value and the label.
  const tabs = [
    ...(mayRun ? [['run', 'Run existing model']] : []),
    ...(mayTrain ? [['train', 'Train / retrain']] : []),
    ...(mayPromote ? [['promote', 'Promote']] : []),
  ]
  const [tab, setTab] = useState(tabs[0]?.[0] ?? 'run')

  const versions = useQuery(() => fetchVersions(), [])
  const datasets = useQuery(() => fetchDatasetVersions(), [])

  /* ------------------------------------------------------- the running job
   *
   * Polled, because this project has no queue and no realtime channel -- the
   * ML service writes progress to Postgres from a daemon thread and this reads
   * it back. 2s while the job is live, then stopped: an interval left running
   * after completion is a request every two seconds for nothing.
   */
  /* The pointer is kept in sessionStorage, not just state. A run takes long
   * enough that people switch tabs or reload while it works, and losing the
   * pointer meant the finished report was only findable on the comparison
   * screen. Per-tab and best-effort: a blocked or private store just returns
   * to the old behaviour, so every access is wrapped. */
  const [activeId, setActiveId] = useState(() => {
    try { return sessionStorage.getItem(ACTIVE_KEY) || null } catch { return null }
  })
  const [run, setRun] = useState(null)
  const [logs, setLogs] = useState([])

  const chooseRun = useCallback((id) => {
    setRun(null)
    setLogs([])
    setActiveId(id)
    try {
      if (id) sessionStorage.setItem(ACTIVE_KEY, id)
      else sessionStorage.removeItem(ACTIVE_KEY)
    } catch { /* non-fatal: the pointer just will not survive a reload */ }
  }, [])

  const poll = useCallback(async (id) => {
    const [r, l] = await Promise.all([fetchRun(id), fetchRunLogs(id)])
    setRun(r)
    setLogs(l || [])
    return r
  }, [])

  useEffect(() => {
    if (!activeId) return
    let live = true
    let timer
    let first = true
    const tick = async () => {
      if (!live) return
      try {
        const r = await poll(activeId)
        const restored = first
        first = false
        if (live && r && ['queued', 'running'].includes(r.job_status)) {
          timer = setTimeout(tick, 2000)
        } else if (live && r && !restored) {
          // Terminal state: refresh the pickers so a new candidate is
          // immediately selectable, which the brief requires.
          versions.reload()
          say(r.job_status === 'completed' ? 'Run completed' : 'Run failed — see the log')
        }
      } catch {
        if (live) timer = setTimeout(tick, 4000)
      }
    }
    tick()
    return () => { live = false; clearTimeout(timer) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId, poll])

  const validDatasets = (datasets.data || []).filter((d) => d.schema_validated)

  return (
    <>
      <PageHead title="Train & run models"
                sub="Running evaluates. Training creates a candidate. Only promoting changes what the pipeline serves." />

      {tabs.length === 0 ? (
        <Empty what="This account cannot trigger any operation.">
          Neither <code>can_run_models</code> nor <code>can_train_models</code> is set,
          and you are not a research lead. Every analytical screen is still available.
        </Empty>
      ) : (
        <>
          <Tabs items={tabs} value={tab} onChange={setTab} />

          {tab === 'run' && mayRun && (
            <ActionA profile={profile} dims={dims} versions={versions}
                     datasets={validDatasets} datasetsQ={datasets}
                     onQueued={chooseRun} say={say} />
          )}
          {tab === 'train' && mayTrain && (
            <ActionB profile={profile} dims={dims} versions={versions}
                     datasets={validDatasets} datasetsQ={datasets}
                     onQueued={chooseRun} say={say} />
          )}
          {tab === 'promote' && mayPromote && (
            <ActionC versions={versions} say={say} />
          )}

          {activeId && (
            <Card title="Job" sub={run?.version_label || run?.run_kind || 'starting…'}
                  right={
                    <div className="row" style={{ gap: 8 }}>
                      {run ? <JobChip status={run.job_status} /> : null}
                      {run && !['queued', 'running'].includes(run.job_status) && (
                        <button className="btn sm" onClick={() => chooseRun(null)}>
                          Dismiss
                        </button>
                      )}
                    </div>
                  }>
              {(!run || ['queued', 'running'].includes(run.job_status)) && (
                <div className="r-live" style={{ marginBottom: 12 }}>
                  <i />
                  <span>
                    {!run ? (
                      <>
                        <b>Starting…</b>
                        Reading the job back from the database.
                      </>
                    ) : run.job_status === 'running' ? (
                      <>
                        <b>
                          Model is running — {WORKING_ON[run.run_kind] || 'working'}
                        </b>
                        The full report appears below the moment it finishes. This keeps
                        polling every 2 seconds, and the job survives you leaving the page.
                      </>
                    ) : (
                      <>
                        <b>Queued — waiting for the ML service to pick this up</b>
                        If this does not turn into <code>running</code> within a few seconds,
                        the ML service on port 8000 is not reachable.
                      </>
                    )}
                  </span>
                </div>
              )}
              <Console lines={logs} />
              {run?.job_status === 'completed' && (
                <div style={{ marginTop: 14 }}>
                  <p className="sub" style={{ fontSize: 10.5, letterSpacing: '.06em', margin: '0 0 8px' }}>
                    RESULT — {run.run_kind === 'training'
                      ? 'new candidate, nothing in production changed'
                      : 'evaluation only, no model status changed'}
                  </p>
                  <RunReport run={run} />
                </div>
              )}
              {run?.job_status === 'failed' && (
                <div className="err" style={{ marginTop: 12 }}>
                  <b>This run failed.</b>
                  {run.error_message || 'See the log above.'}
                </div>
              )}
              {run?.job_status === 'queued' && (
                <div className="row" style={{ marginTop: 10 }}>
                  <button className="btn sm" onClick={async () => {
                    try { await startRun(activeId); say('Start signal sent') }
                    catch (e) { say(dbError(e)) }
                  }}>
                    Send start signal again
                  </button>
                  <span className="sub" style={{ fontSize: 11 }}>
                    Queued but not picked up — the ML service may be unreachable.
                  </span>
                </div>
              )}
              <Provenance>
                Progress is polled every two seconds, not pushed: there is no queue or
                realtime channel in this project. A job whose service restarts mid-run
                is marked failed on the next startup rather than left spinning.
              </Provenance>
            </Card>
          )}
        </>
      )}
    </>
  )
}

/* ========================================================== ACTION A ===== */

function ActionA({ profile, dims, versions, datasets, datasetsQ, onQueued, say }) {
  const [picked, setPicked] = useState([])
  const [datasetId, setDatasetId] = useState(null)
  const [outputType, setOutputType] = useState('regression')
  const [cropId, setCropId] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  const list = versions.data || []
  const chosen = list.filter((v) => picked.includes(v.id))

  async function go() {
    setErr(null)
    if (!picked.length) return setErr('Select at least one model version to evaluate.')
    if (!datasetId) return setErr('Select a dataset version to evaluate against.')
    setBusy(true)
    try {
      const id = await queueEvaluation({
        me: profile,
        modelIds: { ids: picked, modelType: chosen[0]?.model_type ?? 'RandomForest' },
        datasetVersionId: datasetId,
        cropId,
        outputType,
      })
      onQueued(id)
      say(`Evaluation queued for ${picked.length} model(s)`)
    } catch (e) {
      // The run row may exist even though the hand-off failed; point at it
      // so the log and the "send start signal again" button are reachable.
      if (e.runId) onQueued(e.runId)
      setErr(dbError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title="Action A — run an existing model"
          sub="Scores a saved version against a dataset. Changes nothing about the model.">
      <div className="r-warn" style={{ background: 'var(--blue-bg)', color: 'var(--blue)', marginBottom: 14 }}>
        <b>This action is read-and-evaluate only.</b>
        Running any model — including the current production one — never changes its
        status and never affects what the farmer-facing pipeline is serving. The result
        is saved as its own evaluation row.
      </div>

      <div className="grid g2">
        <div>
          <p className="sub" style={{ fontSize: 10.5, letterSpacing: '.06em', marginBottom: 7 }}>
            MODEL VERSIONS · {list.length} available, every status shown
          </p>
          <Panel q={versions} skeleton={200}
                 empty={<Empty what="No model versions exist yet."
                               why="Train one on the next tab — a new candidate appears here immediately." />}>
            {() => (
              <ModelPicker versions={list} selected={picked} onChange={setPicked} />
            )}
          </Panel>
          {picked.length > 1 && (
            <p className="prov">
              {picked.length} models selected — they will be scored on the same rows in
              one comparison run.
            </p>
          )}
        </div>

        <div>
          <div className="r-filters" style={{ marginBottom: 10 }}>
            <Select label="Dataset version" value={datasetId} onChange={setDatasetId}
                    all={null} style={{ minWidth: 240 }}
                    options={datasets.map((d) => ({
                      value: d.id,
                      label: `${d.description} (${d.record_count.toLocaleString('en-US')} rows)`,
                    }))} />
          </div>
          {datasetsQ.loading && <div className="skel" style={{ height: 40 }} />}
          {!datasetsQ.loading && datasets.length === 0 && (
            <Empty what="No validated dataset version to evaluate against."
                   why="An account with can_train_models has to upload one first." />
          )}

          <div className="r-filters">
            <Select label="Output type" value={outputType} onChange={(v) => setOutputType(v || 'regression')}
                    all={null}
                    options={[{ value: 'regression', label: 'Regression (yield value)' },
                              { value: 'classification', label: 'Classification (yield bucket)' }]} />
            <Select label="Crop scope" value={cropId} onChange={setCropId}
                    options={dims?.crops ?? []} all="All crops" />
          </div>
          <p className="prov">
            Output type decides which metric set is computed and recorded —
            R²/RMSE/MAE, or Accuracy/Precision/Recall/F1 with a confusion matrix.
            It is stored on the run so no screen has to guess which applies.
          </p>

          {chosen.length > 0 && (
            <div style={{ marginTop: 10 }}>
              <p className="sub" style={{ fontSize: 10.5, letterSpacing: '.06em', marginBottom: 6 }}>
                SELECTED
              </p>
              {chosen.map((v) => (
                <div className="list-row" key={v.id}>
                  <div className="grow">
                    <b>{v.version_label ?? v.id.slice(0, 8)}</b>
                    <p>{v.model_type} · trained {fmtDate(v.completed_at || v.created_at)}</p>
                  </div>
                  <StatusBadge status={v.status} />
                </div>
              ))}
            </div>
          )}

          {err && <div className="err" style={{ marginTop: 10 }}><b>Could not queue the run.</b>{err}</div>}

          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn dark" onClick={go}
                    disabled={busy || !picked.length || !datasetId}>
              {busy ? 'Queueing…' : `Run ${picked.length || ''} model${picked.length === 1 ? '' : 's'}`}
            </button>
            {/* A disabled button that does not say why reads as a broken one. */}
            {!busy && (!picked.length || !datasetId) && (
              <span className="sub" style={{ fontSize: 11 }}>
                {!picked.length && !datasetId
                  ? 'Pick a model version on the left and a dataset version above.'
                  : !picked.length
                    ? 'Pick at least one model version on the left.'
                    : 'Pick a dataset version to evaluate against.'}
              </span>
            )}
          </div>
        </div>
      </div>
    </Card>
  )
}

/* ========================================================== ACTION B ===== */

function ActionB({ profile, dims, versions, datasets, datasetsQ, onQueued, say }) {
  const [mode, setMode] = useState('new')          // 'new' | 'retrain'
  const [modelType, setModelType] = useState('RandomForest')
  const [parent, setParent] = useState([])
  const [datasetId, setDatasetId] = useState(null)
  const [split, setSplit] = useState('0.8')
  const [trees, setTrees] = useState('500')
  const [depth, setDepth] = useState('25')
  const [outputType, setOutputType] = useState('regression')
  const [cropId, setCropId] = useState(null)
  const [districtId, setDistrictId] = useState(null)
  const [seasonId, setSeasonId] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  const list = versions.data || []
  const base = list.find((v) => v.id === parent[0]) || null
  const trainable = TRAINABLE.includes(modelType)

  // Picking a retrain base fixes the algorithm: retraining a RandomForest as an
  // LSTM is not a retrain, it is a different model.
  useEffect(() => {
    if (mode === 'retrain' && base && base.model_type !== modelType) {
      setModelType(base.model_type)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, base])

  async function go() {
    setErr(null)
    if (!datasetId) return setErr('Select a dataset version to train on.')
    if (mode === 'retrain' && !parent.length) {
      return setErr('Select the model version to retrain from.')
    }
    const ratio = Number(split)
    if (!(ratio >= 0.1 && ratio <= 0.95)) {
      return setErr('Train split must be between 0.1 and 0.95.')
    }
    setBusy(true)
    try {
      const id = await queueTraining({
        me: profile,
        modelType,
        datasetVersionId: datasetId,
        parentId: mode === 'retrain' ? parent[0] : null,
        cropId, districtId, seasonId,
        config: {
          train_split: ratio,
          output_type: outputType,
          n_estimators: Number(trees) || 500,
          max_depth: Number(depth) || 25,
          ...(mode === 'retrain' ? { retrained_from: base?.version_label ?? parent[0] } : {}),
        },
      })
      onQueued(id)
      say(mode === 'retrain' ? 'Retraining queued' : 'Training queued')
    } catch (e) {
      // The run row may exist even though the hand-off failed; point at it
      // so the log and the "send start signal again" button are reachable.
      if (e.runId) onQueued(e.runId)
      setErr(dbError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card title="Action B — train or retrain"
          sub="Always produces a new candidate, whatever it was trained from">
      <div className="r-warn" style={{ marginBottom: 14 }}>
        <b>Every training produces a candidate.</b>
        Never approved, never production — regardless of the status of the model it was
        retrained from. The database enforces this: the insert policy pins
        <code> status = 'candidate'</code>, so a request asking for anything else is
        refused rather than corrected.
      </div>

      <Tabs items={[['new', 'Train new model'], ['retrain', 'Retrain existing model']]}
            value={mode} onChange={setMode} />

      <div className="grid g2">
        <div>
          {mode === 'retrain' && (
            <>
              <p className="sub" style={{ fontSize: 10.5, letterSpacing: '.06em', marginBottom: 7 }}>
                BASE VERSION · any status may be used as a starting point
              </p>
              <Panel q={versions} skeleton={180}
                     empty={<Empty what="No version to retrain from."
                                   why="Train one from scratch first." />}>
                {() => <ModelPicker versions={list} selected={parent}
                                    onChange={setParent} single />}
              </Panel>
              {base && (
                <p className="prov">
                  The new version will be linked to {base.version_label ?? base.id.slice(0, 8)}
                  {' '}via <code>parent_model_run_id</code> for lineage. The base model itself
                  is not modified and its status is unchanged — retraining from the
                  production model is safe.
                </p>
              )}
            </>
          )}

          <div className="r-filters" style={{ marginTop: mode === 'retrain' ? 12 : 0 }}>
            <Select label="Model type" value={modelType}
                    onChange={(v) => setModelType(v || 'RandomForest')} all={null}
                    options={MODEL_TYPES.map((m) => ({ value: m, label: m }))} />
            <Select label="Dataset version" value={datasetId} onChange={setDatasetId}
                    all={null} style={{ minWidth: 230 }}
                    options={datasets.map((d) => ({
                      value: d.id,
                      label: `${d.description} (${d.record_count.toLocaleString('en-US')} rows)`,
                    }))} />
          </div>

          {/* The brief wants all four types offered. Three of them cannot be
              trained in this environment, and saying so HERE is better than
              letting the researcher wait for a job that fails. */}
          {!trainable && (
            <div className="err" style={{ marginTop: 10 }}>
              <b>{modelType} cannot be trained in this deployment.</b>
              {UNTRAINABLE_REASON[modelType]}. The type is offered because the
              portal supports it; queueing it would produce a failed run with this
              same message.
            </div>
          )}

          {!datasetsQ.loading && datasets.length === 0 && (
            <Empty what="No validated dataset version."
                   why="Upload one on the Dataset Versioning screen — upload is part of this action and your account already has the flag for it." />
          )}
        </div>

        <div>
          <p className="sub" style={{ fontSize: 10.5, letterSpacing: '.06em', marginBottom: 7 }}>
            CONFIGURATION
          </p>
          <div className="grid g2" style={{ marginBottom: 0 }}>
            <div className="field">
              <label htmlFor="b-split">Train split</label>
              <input id="b-split" type="number" step="0.05" min="0.1" max="0.95"
                     value={split} onChange={(e) => setSplit(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="b-trees">Estimators</label>
              <input id="b-trees" type="number" min="10" max="2000" step="10"
                     value={trees} onChange={(e) => setTrees(e.target.value)} />
            </div>
            <div className="field">
              <label htmlFor="b-depth">Max depth</label>
              <input id="b-depth" type="number" min="2" max="60"
                     value={depth} onChange={(e) => setDepth(e.target.value)} />
            </div>
          </div>

          <div className="r-filters" style={{ marginTop: 4 }}>
            <Select label="Output type" value={outputType}
                    onChange={(v) => setOutputType(v || 'regression')} all={null}
                    options={[{ value: 'regression', label: 'Regression' },
                              { value: 'classification', label: 'Classification' }]} />
            <Select label="Target crop" value={cropId} onChange={setCropId}
                    options={dims?.crops ?? []} all="All crops" />
            <Select label="Target district" value={districtId} onChange={setDistrictId}
                    options={dims?.districts ?? []} all="All districts" />
            <Select label="Season" value={seasonId} onChange={setSeasonId}
                    options={(dims?.seasons ?? []).map((s) => ({ id: s.id, name: s.label }))}
                    all="All seasons" />
          </div>
          <p className="prov">
            Crop, district and season are recorded as the run's scope for filtering on
            the comparison screen. The split is seeded, so the same configuration on the
            same dataset version reproduces the same numbers — which is what pinning a
            version is for.
          </p>

          {err && <div className="err" style={{ marginTop: 10 }}><b>Could not queue.</b>{err}</div>}

          <div className="row" style={{ marginTop: 12 }}>
            <button className="btn dark" onClick={go} disabled={busy || !datasetId}>
              {busy ? 'Queueing…'
                : mode === 'retrain' ? 'Retrain as new candidate' : 'Train new candidate'}
            </button>
          </div>
        </div>
      </div>
    </Card>
  )
}

/* ========================================================== ACTION C ===== */

/** Allowed transitions. candidate -> approved -> production, and anything
 *  except an already-archived row may be archived. Encoded as a map rather
 *  than an if-chain so the UI cannot offer a step the brief does not describe. */
const NEXT = {
  candidate: ['approved', 'archived'],
  approved: ['production', 'archived'],
  production: ['archived'],
  archived: ['candidate'],
}

function ActionC({ versions, say }) {
  const [target, setTarget] = useState(null)   // { run, next }
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)

  const list = versions.data || []
  const byType = useMemo(() => {
    const m = new Map()
    for (const v of list) {
      if (!m.has(v.model_type)) m.set(v.model_type, [])
      m.get(v.model_type).push(v)
    }
    return [...m.entries()]
  }, [list])

  const outgoing = target?.next === 'production'
    ? list.find((v) => v.model_type === target.run.model_type
                    && v.status === 'production' && v.id !== target.run.id)
    : null

  async function confirm() {
    setBusy(true)
    setErr(null)
    try {
      await setModelStatus(target.run, target.next)
      say(`${target.run.version_label ?? 'Model'} → ${STATUS_LABEL[target.next]}`)
      setTarget(null)
      versions.reload()
    } catch (e) {
      setErr(dbError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <Card title="Action C — promote a model version"
            sub="The only action in this portal that changes what the operational pipeline serves">
        <div className="r-warn" style={{ marginBottom: 14 }}>
          <b>This is the one action with production impact.</b>
          Promoting to production archives the outgoing production model of the same
          type. Nothing is deleted — the archived version stays fully viewable and
          re-runnable, and can be promoted back.
        </div>

        <Panel q={versions} skeleton={200}
               empty={<Empty what="No model versions to promote."
                             why="A training has to complete first." />}>
          {() => byType.map(([type, vs]) => (
            <div key={type} style={{ marginBottom: 14 }}>
              <p className="sub" style={{ fontSize: 10.5, letterSpacing: '.06em', marginBottom: 6 }}>
                {type.toUpperCase()}
              </p>
              {vs.map((v) => (
                <div className="list-row" key={v.id}>
                  <div className="grow">
                    <b>{v.version_label ?? v.id.slice(0, 8)}</b>
                    <p>
                      trained {fmtDate(v.completed_at || v.created_at)}
                      {v.gov_crops?.name ? ` · ${v.gov_crops.name}` : ''}
                      {v.parent_model_run_id ? ' · retrained' : ''}
                      {v.job_status !== 'completed' ? ` · job ${v.job_status}` : ''}
                    </p>
                  </div>
                  <StatusBadge status={v.status} long />
                  {v.job_status !== 'completed' ? (
                    <span className="sub" style={{ fontSize: 10.5 }}>
                      not promotable — job {v.job_status}
                    </span>
                  ) : (
                    (NEXT[v.status] || []).map((next) => (
                      <button key={next} className={'btn sm' + (next === 'production' ? ' dark' : '')}
                              onClick={() => { setErr(null); setTarget({ run: v, next }) }}>
                        → {STATUS_LABEL[next]}
                      </button>
                    ))
                  )}
                </div>
              ))}
            </div>
          ))}
        </Panel>

        <Provenance>
          Every status change is written to <code>model_status_history</code> by a
          database trigger, not by this screen — so a promotion issued directly to the
          API is recorded too. A research lead can only change the status column: the
          migration revokes UPDATE on the run table and re-grants it on that one
          column, so a metric cannot be rewritten even deliberately.
        </Provenance>
      </Card>

      {/* The explicit confirmation step the brief requires. Never one click. */}
      <Confirm open={Boolean(target)}
               title={target ? `Promote to ${STATUS_LABEL[target.next]}?` : ''}
               sub={target
                 ? `${target.run.version_label ?? target.run.id.slice(0, 8)} · ${target.run.model_type}`
                 : ''}
               confirmLabel={target ? `Yes, set ${STATUS_LABEL[target.next]}` : ''}
               danger={target?.next === 'production'}
               busy={busy}
               onCancel={() => { if (!busy) { setTarget(null); setErr(null) } }}
               onConfirm={confirm}>
        {target && (
          <>
            <div className="row" style={{ gap: 10, marginBottom: 12, alignItems: 'center' }}>
              <StatusBadge status={target.run.status} long />
              <span className="sub">→</span>
              <StatusBadge status={target.next} long />
            </div>

            {target.next === 'production' && (
              <div className="r-warn">
                <b>This changes what the operational pipeline serves.</b>
                {outgoing
                  ? `${outgoing.version_label ?? outgoing.id.slice(0, 8)} is currently in `
                    + 'production and will be archived. It stays viewable and re-runnable.'
                  : `No ${target.run.model_type} is currently in production, so nothing `
                    + 'will be archived.'}
              </div>
            )}

            {target.next === 'archived' && target.run.status === 'production' && (
              <div className="r-warn">
                <b>This retires the live model without replacing it.</b>
                After archiving there will be no production {target.run.model_type}.
                Promote a replacement first if the pipeline needs one.
              </div>
            )}

            <div style={{ marginTop: 12 }}>
              <MetricSet run={target.run} compact />
            </div>

            {err && <div className="err" style={{ marginTop: 10 }}><b>Failed.</b>{err}</div>}
          </>
        )}
      </Confirm>
    </>
  )
}
