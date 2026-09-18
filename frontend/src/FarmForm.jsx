import { useState } from 'react'
import { supabase } from './supabase'

// Sheikhupura city centre — a sane starting point so the demo isn't typing
// coordinates from scratch.
const DEFAULT = { lat: '31.7131', lng: '73.9783' }

const field =
  'mt-1.5 w-full rounded-xl border border-leaf-100 bg-white px-4 py-3 text-ink ' +
  'outline-none transition focus:border-leaf-400 focus:ring-4 focus:ring-leaf-400/15 ' +
  'disabled:bg-leaf-50/60 disabled:text-muted'

export default function FarmForm({ onCreated }) {
  const [form, setForm] = useState({ farmer_name: '', gps_lat: DEFAULT.lat, gps_lng: DEFAULT.lng })
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value })

  async function submit(e) {
    e.preventDefault()
    setBusy(true)
    setErr(null)

    // owner_id is NOT sent: the column defaults to auth.uid(), which Postgres
    // evaluates from this request's JWT. The RLS insert policy then checks
    // owner_id = auth.uid(), so a farmer cannot create a farm owned by someone
    // else even by forging the field.
    const { data, error } = await supabase
      .from('farms')
      .insert({
        farmer_name: form.farmer_name,
        gps_lat: parseFloat(form.gps_lat),
        gps_lng: parseFloat(form.gps_lng),
        district: 'Sheikhupura',
        crop_type: 'wheat',
      })
      .select()
      .single()

    setBusy(false)
    if (error) return setErr(error.message)
    onCreated(data)
  }

  return (
    <div className="mx-auto max-w-lg">
      <div className="mb-6 text-center">
        <span className="inline-flex items-center gap-2 rounded-full bg-leaf-100 px-3 py-1 text-xs font-medium text-leaf-700">
          <span className="h-1.5 w-1.5 rounded-full bg-leaf-500" />
          Step 1 of 1
        </span>
        <h2 className="mt-4 font-display text-3xl font-semibold">Register your farm</h2>
        <p className="mt-2 text-sm text-muted">
          We use the location to pull Sentinel-2 imagery for your plot.
        </p>
      </div>

      <form onSubmit={submit} className="rounded-2xl bg-white p-7 shadow-sm ring-1 ring-leaf-100">
        <label className="block text-sm font-medium">
          Farmer name
          <input required value={form.farmer_name} onChange={set('farmer_name')}
                 placeholder="e.g. Muhammad Aslam" className={field} />
        </label>

        <div className="mt-5 grid grid-cols-2 gap-4">
          <label className="block text-sm font-medium">
            Latitude
            <input type="number" step="any" required min={-90} max={90}
                   value={form.gps_lat} onChange={set('gps_lat')} className={`${field} tnum`} />
          </label>
          <label className="block text-sm font-medium">
            Longitude
            <input type="number" step="any" required min={-180} max={180}
                   value={form.gps_lng} onChange={set('gps_lng')} className={`${field} tnum`} />
          </label>
        </div>
        <p className="mt-2 text-xs text-muted">Prefilled with Sheikhupura centre — adjust to your plot.</p>

        <div className="mt-5 grid grid-cols-2 gap-4">
          <label className="block text-sm font-medium">
            Crop
            <select value="wheat" disabled className={field}>
              <option value="wheat">Wheat</option>
            </select>
          </label>
          <label className="block text-sm font-medium">
            District
            <input value="Sheikhupura" disabled className={field} />
          </label>
        </div>
        <p className="mt-2 text-xs text-muted">
          Locked for this release — one district, one crop.
        </p>

        {err && (
          <p role="alert" className="mt-5 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 ring-1 ring-red-100">
            {err}
          </p>
        )}

        <button type="submit" disabled={busy}
                className="mt-7 w-full rounded-xl bg-leaf-700 py-3 font-medium text-white shadow-sm
                           transition hover:bg-leaf-800 active:scale-[.99] disabled:opacity-60">
          {busy ? 'Saving…' : 'Register farm'}
        </button>
      </form>
    </div>
  )
}
