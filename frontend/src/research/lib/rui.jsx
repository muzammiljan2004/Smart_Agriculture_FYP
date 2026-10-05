/** UI primitives this portal has and the government one does not.
 *
 * Everything the two share -- Card, Panel, Kpi, Empty, ErrorNote, TableWrap,
 * the chart marks, useQuery, the formatters, the CSV writer -- is imported from
 * `../../gov/lib/*` by the screens that need it rather than copied. Only the
 * genuinely new pieces live here: a model status badge, a job state chip, a
 * metric block that knows regression from classification, a confusion matrix, a
 * multi-select model picker, a log console, a permission toggle and a
 * confirmation dialog.
 *
 * The classes they use are the `r-` prefixed ones in research.css.
 */
import { useEffect, useRef } from 'react'
import { STATUS_LABEL } from './access'
import { dash, f1 } from '../../gov/lib/fmt'

/* ------------------------------------------------------------------ badges */

/** Model version status. Required on every model entry in every picker.
 *
 * `production` is the only filled badge, because it is the only status that
 * means "this is what the operational pipeline is serving". The others are
 * outlined so no amount of squinting makes a candidate look live.
 */
export const StatusBadge = ({ status, long }) =>
  !status ? <span className="r-badge archived">—</span> : (
    <span className={`r-badge ${status}`} title={`Model status: ${STATUS_LABEL[status] ?? status}`}>
      <i />{long && status === 'candidate' ? 'Candidate · experimental' : STATUS_LABEL[status] ?? status}
    </span>
  )

/** Job state. A squared chip, deliberately a different shape from
 *  StatusBadge, so "running" is never read as a version status. */
export const JobChip = ({ status }) => (
  <span className={`r-job ${status}`}>
    {status === 'running' && <i />}
    {status === 'queued' ? 'Queued'
      : status === 'running' ? 'Running'
        : status === 'completed' ? 'Completed' : 'Failed'}
  </span>
)

/* ----------------------------------------------------------------- metrics */

/** The metric block for one run.
 *
 * THE BRIEF'S HARDEST RULE IS ENFORCED HERE: "Never show classification
 * metrics for a pure regression output or vice versa -- label clearly which
 * metric set applies to which run." So this reads `output_type` off the row and
 * renders one set or the other, never both and never a guess. A run whose
 * output_type is null has not completed; it gets a stated absence rather than a
 * grid of dashes that looks like four failed measurements.
 *
 * R² is tinted red when negative. A negative R² means the model did worse than
 * predicting the mean, and it is the one metric here whose sign changes its
 * meaning entirely -- five of this project's eleven crops sit below zero, so
 * the case is common enough to be worth distinguishing at a glance.
 */
export function MetricSet({ run, compact }) {
  if (!run || run.job_status !== 'completed') {
    return (
      <p className="sub" style={{ fontSize: 12 }}>
        {run?.job_status === 'failed'
          ? 'This run failed, so it has no metrics.'
          : 'No metrics yet — this run has not completed.'}
      </p>
    )
  }
  const reg = run.output_type === 'regression'
  const items = reg
    ? [['R²', run.r2, 4], ['RMSE', run.rmse, 3], ['MAE', run.mae, 3]]
    : [['Accuracy', run.accuracy, 4], ['Precision', run.precision_score, 4],
       ['Recall', run.recall, 4], ['F1', run.f1_score, 4]]

  return (
    <>
      <p className="sub" style={{ fontSize: 10.5, letterSpacing: '.06em', marginBottom: 7 }}>
        {reg ? 'REGRESSION METRICS' : 'CLASSIFICATION METRICS'}
      </p>
      <div className="r-metrics">
        {items.map(([k, v, d]) => (
          <div key={k} className={'r-metric' + (k === 'R²' && Number(v) < 0 ? ' neg' : '')}>
            <div className="k">{k}</div>
            <div className="v">{dash(v, (x) => f1(x, d))}</div>
          </div>
        ))}
      </div>
      {!compact && reg && Number(run.r2) < 0 && (
        <p className="prov">
          A negative R² means this run predicted the held-out values less well than
          simply predicting their mean. Reported as computed.
        </p>
      )}
    </>
  )
}

/** Confusion matrix for a classification run.
 *
 * Rendered as a real table with readable counts rather than a heat image: the
 * numbers have to be legible and exportable. The diagonal is bolded and tinted
 * by share-of-row, so the shape is visible without the colour carrying the
 * value on its own.
 */
export function ConfusionMatrix({ cm }) {
  if (!cm?.labels?.length || !cm?.matrix?.length) return null
  const { labels, matrix } = cm
  const rowTotals = matrix.map((r) => r.reduce((a, b) => a + b, 0))
  return (
    <div className="tw">
      <table className="r-cm">
        <caption>Rows are the true class, columns the predicted class.</caption>
        <thead>
          <tr>
            <th />
            {labels.map((l) => <th key={l}>pred {l}</th>)}
            <th>total</th>
          </tr>
        </thead>
        <tbody>
          {matrix.map((row, i) => (
            <tr key={labels[i]}>
              <th>true {labels[i]}</th>
              {row.map((v, j) => {
                const share = rowTotals[i] ? v / rowTotals[i] : 0
                return (
                  <td key={j} className={i === j ? 'diag' : ''}
                      style={i === j && share > 0
                        ? { background: `rgba(26,127,75,${0.1 + share * 0.32})` }
                        : undefined}>
                    {v}
                  </td>
                )
              })}
              <td className="sub">{rowTotals[i]}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** The full report for one completed run.
 *
 * MetricSet is the headline; this is everything else a researcher needs to
 * write the run up: the derived metric (MSE), the split it was measured on, the
 * residual summary, the feature list, and the per-model breakdown when several
 * were scored in one comparison.
 *
 * Most of it comes from `run_config.report`, written by the ML service. A run
 * from before that block existed renders the headline metrics and says the rest
 * is unavailable, rather than showing a grid of dashes that reads like a set of
 * failed measurements.
 */
export function RunReport({ run }) {
  if (!run || run.job_status !== 'completed') return <MetricSet run={run} />
  const rep = run.run_config?.report || null
  const reg = run.output_type === 'regression'
  const perModel = run.run_config?.per_model || null

  return (
    <>
      <MetricSet run={run} />

      {reg && rep && (
        <>
          <p className="sub" style={{ fontSize: 10.5, letterSpacing: '.06em', margin: '14px 0 7px' }}>
            DERIVED &amp; RESIDUALS
          </p>
          <div className="r-metrics">
            <div className="r-metric">
              <div className="k">MSE</div><div className="v">{dash(rep.mse, (x) => f1(x, 4))}</div>
            </div>
            <div className="r-metric">
              <div className="k">Mean bias</div>
              <div className="v">{rep.bias == null ? '—'
                : (rep.bias > 0 ? '+' : '') + f1(rep.bias, 3)}</div>
            </div>
            <div className="r-metric">
              <div className="k">Residual σ</div>
              <div className="v">{dash(rep.residual_std, (x) => f1(x, 3))}</div>
            </div>
            <div className="r-metric">
              <div className="k">Within ±1</div>
              <div className="v">{rep.within_1 == null ? '—' : f1(rep.within_1 * 100, 1) + '%'}</div>
            </div>
            <div className="r-metric">
              <div className="k">Within ±2</div>
              <div className="v">{rep.within_2 == null ? '—' : f1(rep.within_2 * 100, 1) + '%'}</div>
            </div>
          </div>
        </>
      )}

      {rep && (
        <>
          <p className="sub" style={{ fontSize: 10.5, letterSpacing: '.06em', margin: '14px 0 7px' }}>
            WHAT IT WAS MEASURED ON
          </p>
          <div className="tw">
            <table>
              <tbody>
                <Fact k="Rows" v={rep.n_rows?.toLocaleString('en-US')} />
                <Fact k="Train / test"
                      v={`${(rep.n_train ?? 0).toLocaleString('en-US')} / `
                         + `${(rep.n_test ?? 0).toLocaleString('en-US')}`
                         + (run.run_config?.train_split
                           ? ` (ratio ${run.run_config.train_split})` : '')} />
                {/* The scope the rows were filtered to, so a per-crop run reads
                    as one. Stated either way: "every row" is also a result. */}
                <Fact k="Scope"
                      v={rep.scope && Object.keys(rep.scope).length
                        ? Object.entries(rep.scope).map(([k, v]) => `${k} = ${v}`).join(' · ')
                        : 'every row in the dataset (no crop/district/season filter)'} />
                <Fact k="Features" v={rep.n_features} />
                {reg && <Fact k="Mean actual" v={dash(rep.mean_actual, (x) => f1(x, 3))} />}
                {/* The yardstick R2 is measured against. A reader seeing RMSE
                    larger than this spread knows the negative R2 before the
                    formula is quoted at them. */}
                {reg && <Fact k="Actual spread (σ)" v={dash(rep.std_actual, (x) => f1(x, 3))} />}
                {reg && <Fact k="Mean predicted" v={dash(rep.mean_predicted, (x) => f1(x, 3))} />}
                {reg && <Fact k="Residual range"
                              v={rep.residual_min == null ? '—'
                                : `${f1(rep.residual_min, 2)} … ${f1(rep.residual_max, 2)}`} />}
                <Fact k="Duration" v={rep.duration_s == null ? '—' : `${rep.duration_s}s`} />
                {rep.models_scored != null && <Fact k="Models scored" v={rep.models_scored} />}
              </tbody>
            </table>
          </div>
          {rep.feature_names?.length > 0 && (
            <p className="prov">
              <b style={{ display: 'inline' }}>Features: </b>
              <span className="mono">{rep.feature_names.join(', ')}</span>
            </p>
          )}

          {/* A negative R2 is the one number on this screen that reads as a
              broken run when it is usually a mismatched one, so it gets said
              in words, with this run's own figures. */}
          {reg && run.r2 != null && run.r2 < 0 && (
            <div className="r-warn" style={{ marginTop: 10 }}>
              <b>A negative R² is not an error.</b>
              It means this model did worse on these rows than always answering
              with their average
              {rep.mean_actual != null ? ` (${f1(rep.mean_actual, 2)} t/ha)` : ''}.
              R² = 1 − (RMSE / σ)², so an RMSE of {dash(run.rmse, (x) => f1(x, 2))}
              {rep.std_actual != null ? ` against a spread of only σ ${f1(rep.std_actual, 2)}` : ''}
              {' '}gives this figure.
              {rep.scope?.crop_type && !rep.feature_names.some((n) => n.startsWith('crop_'))
                ? ` This model carries no crop feature, so it cannot tell ${rep.scope.crop_type}`
                  + ' from any other crop and predicts near the all-crop mean. Train a model'
                  + ' on this scope, or pick one that has the crop one-hot.'
                : ' Narrowing to a single crop removes the between-crop variance that'
                  + ' makes a pooled R² look high, so judge a scoped run by RMSE and MAE'
                  + ' against σ above, not by R² against a pooled run.'}
            </div>
          )}
        </>
      )}

      {!rep && (
        <p className="prov">
          This run predates the detailed report block, so only the headline
          metrics above were recorded. Re-run it to capture the rest.
        </p>
      )}

      {perModel && Object.keys(perModel).length > 0 && (
        <>
          <p className="sub" style={{ fontSize: 10.5, letterSpacing: '.06em', margin: '14px 0 7px' }}>
            PER MODEL · {Object.keys(perModel).length} scored on the same rows
          </p>
          <div className="tw">
            <table>
              <thead>
                <tr>
                  <th>Version</th><th>Status</th>
                  {reg ? <><th className="r-">R²</th><th className="r-">RMSE</th><th className="r-">MAE</th></>
                       : <><th className="r-">Accuracy</th><th className="r-">F1</th></>}
                </tr>
              </thead>
              <tbody>
                {Object.entries(perModel)
                  .sort((a, b) => (reg ? (b[1].r2 ?? -9) - (a[1].r2 ?? -9)
                                       : (b[1].accuracy ?? -9) - (a[1].accuracy ?? -9)))
                  .map(([label, m]) => (
                    <tr key={label}>
                      <td><b>{label}</b></td>
                      <td><StatusBadge status={m.status} /></td>
                      {reg ? (
                        <>
                          <td className="mono r-"
                              style={Number(m.r2) < 0 ? { color: 'var(--red)' } : undefined}>
                            {dash(m.r2, (x) => f1(x, 4))}
                          </td>
                          <td className="mono r-">{dash(m.rmse, (x) => f1(x, 3))}</td>
                          <td className="mono r-">{dash(m.mae, (x) => f1(x, 3))}</td>
                        </>
                      ) : (
                        <>
                          <td className="mono r-">{dash(m.accuracy, (x) => f1(x, 4))}</td>
                          <td className="mono r-">{dash(m.f1_score, (x) => f1(x, 4))}</td>
                        </>
                      )}
                    </tr>
                  ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      {run.output_type === 'classification' && run.confusion_matrix && (
        <div style={{ marginTop: 14 }}>
          <p className="sub" style={{ fontSize: 10.5, letterSpacing: '.06em', marginBottom: 7 }}>
            CONFUSION MATRIX
          </p>
          <ConfusionMatrix cm={run.confusion_matrix} />
        </div>
      )}
    </>
  )
}

const Fact = ({ k, v }) => (
  <tr>
    <td className="sub" style={{ width: 150 }}>{k}</td>
    <td className="mono">{v ?? '—'}</td>
  </tr>
)

/* ------------------------------------------------------------ model picker */

/** Multi-select list of model versions.
 *
 * NEVER FILTERED TO PRODUCTION. The brief is explicit twice over: the picker
 * "lists EVERY model version that exists in the system, across all statuses and
 * all model types -- never filtered down to only production by default", and
 * each entry shows a status badge, a version identifier, a training date and
 * its last known metrics at a glance. All of that is here, and there is no
 * default filter to undo.
 *
 * `single` renders radio behaviour for Action B's retrain base, where picking
 * two starting points is meaningless.
 */
export function ModelPicker({ versions, selected, onChange, single, emptyNote }) {
  if (!versions?.length) {
    return (
      <p className="sub" style={{ fontSize: 12 }}>
        {emptyNote || 'No model versions exist yet. Train one first — a trained '
          + 'candidate appears here immediately.'}
      </p>
    )
  }
  const toggle = (id) => {
    if (single) return onChange(selected.includes(id) ? [] : [id])
    onChange(selected.includes(id)
      ? selected.filter((x) => x !== id)
      : [...selected, id])
  }
  return (
    <div className="r-pick">
      {versions.map((v) => {
        const on = selected.includes(v.id)
        const score = v.output_type === 'classification'
          ? (v.accuracy == null ? null : `acc ${f1(v.accuracy, 3)}`)
          : (v.r2 == null ? null : `R² ${f1(v.r2, 3)}`)
        return (
          <label key={v.id} className={'r-pick-row' + (on ? ' on' : '')}>
            <input type={single ? 'radio' : 'checkbox'} checked={on}
                   onChange={() => toggle(v.id)} />
            <span className="grow">
              <b>{v.version_label || `${v.model_type} ${v.id.slice(0, 8)}`}</b>
              <span className="meta">
                {v.model_type}
                {' · trained '}
                {(v.completed_at || v.created_at || '').slice(0, 10) || 'unknown'}
                {v.gov_crops?.name ? ` · ${v.gov_crops.name}` : ''}
                {v.parent_model_run_id ? ' · retrained' : ''}
              </span>
            </span>
            <StatusBadge status={v.status} />
            <span className="num">{score ?? 'no metrics'}</span>
          </label>
        )
      })}
    </div>
  )
}

/* ---------------------------------------------------------------- console */

/** Live-ish job log. Fed by polling model_run_logs; column-reverse in CSS so
 *  the newest line sits in view with no scroll scripting. */
export function Console({ lines }) {
  if (!lines?.length) {
    return <div className="r-console"><p className="t">waiting for the first log line…</p></div>
  }
  return (
    <div className="r-console">
      {[...lines].reverse().map((l) => (
        <p key={l.id} className={/^failed/i.test(l.log_line) ? 'err' : undefined}>
          <span className="t">{(l.logged_at || '').slice(11, 19)}</span>{l.log_line}
        </p>
      ))}
    </div>
  )
}

/* ------------------------------------------------------------------ flags */

/** One permission switch. `locked` renders the same row without a control, for
 *  the read-only view a researcher gets of their own account and for a lead
 *  whose flags are implied by tier and cannot be edited. */
export function FlagToggle({ name, label, hint, checked, onChange, locked }) {
  const Row = locked ? 'div' : 'label'
  return (
    <Row className={'r-flag' + (checked ? ' on' : '') + (locked ? ' locked' : '')}>
      {locked
        ? <input type="checkbox" checked={checked} readOnly disabled aria-label={label} />
        : <input type="checkbox" name={name} checked={checked}
                 onChange={(e) => onChange(e.target.checked)} />}
      <span>
        <b>{label}</b>
        <span>{hint}</span>
      </span>
    </Row>
  )
}

/* ----------------------------------------------------------------- dialog */

/** Confirmation dialog built on the native <dialog>.
 *
 * Action C requires "an explicit confirmation step in the UI given its
 * production impact -- never a one-click action". The platform element is the
 * right one: Escape, the backdrop and focus containment come for free, and a
 * native modal cannot be dismissed by a stray click behind it the way a
 * hand-rolled overlay can.
 *
 * showModal() has to be called imperatively -- the `open` attribute renders a
 * non-modal dialog, which is dismissible and does not trap focus.
 */
export function Confirm({ open, title, sub, children, confirmLabel, danger,
                          onConfirm, onCancel, busy }) {
  const ref = useRef(null)

  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) d.showModal()
    if (!open && d.open) d.close()
  }, [open])

  // A dialog closed by Escape or the backdrop fires `cancel`/`close` without
  // telling React, which would leave `open` true and the dialog unopenable.
  useEffect(() => {
    const d = ref.current
    if (!d) return
    const onClose = () => { if (open) onCancel?.() }
    d.addEventListener('close', onClose)
    return () => d.removeEventListener('close', onClose)
  }, [open, onCancel])

  return (
    <dialog ref={ref} className="r-dialog" aria-labelledby="r-dlg-h">
      <div className="hd">
        <h3 id="r-dlg-h">{title}</h3>
        {sub && <p>{sub}</p>}
      </div>
      <div className="bd">{children}</div>
      <div className="ft">
        <button className="btn" onClick={onCancel} disabled={busy}>Cancel</button>
        <button className={'btn ' + (danger ? 'dark' : 'dark')}
                onClick={onConfirm} disabled={busy}>
          {busy ? 'Working…' : confirmLabel}
        </button>
      </div>
    </dialog>
  )
}

/* ---------------------------------------------------------------- filters */

/** A labelled select for the filter bars. `all` adds an "All" option, which is
 *  what every screen's default scope is.
 *
 *  `all={null}` drops that option, for a control where no choice is not a valid
 *  scope -- "which dataset to train on" has no sensible all. That case needs the
 *  placeholder below. With no option matching value="", a browser displays the
 *  FIRST option while the state is still null, so the control reads as filled in
 *  while the submit button it gates stays disabled: the user sees a dataset
 *  chosen, clicks Run, and nothing happens. An unselected control has to look
 *  unselected, so an unmatched value gets an explicit placeholder.
 */
export const Select = ({ label, value, onChange, options, all = 'All', style, placeholder = 'Select…' }) => (
  <div className="sel" style={style}>
    <span>{label}</span>
    <select value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
      {all != null
        ? <option value="">{all}</option>
        : (value == null || !options.some((o) => String(o.value ?? o.id) === String(value)))
            && <option value="">{placeholder}</option>}
      {options.map((o) => (
        <option key={o.value ?? o.id} value={o.value ?? o.id}>{o.label ?? o.name}</option>
      ))}
    </select>
  </div>
)

/** Lineage marker for screen 8. */
export const Lineage = ({ parent }) =>
  !parent ? <span className="sub">trained from scratch</span> : (
    <span className="r-lineage">
      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4">
        <path d="M5 4v9a4 4 0 0 0 4 4h10" /><path d="m15 13 4 4-4 4" />
      </svg>
      from {parent}
    </span>
  )
