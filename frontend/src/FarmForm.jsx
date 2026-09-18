import { useState } from 'react'
import { supabase } from './supabase'

// Sheikhupura city centre — a sane starting point so the demo isn't typing
// coordinates from scratch.
const DEFAULT = { lat: '31.7131', lng: '73.9783' }

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
    <form onSubmit={submit} className="max-w-md mx-auto bg-white rounded-lg shadow p-6 space-y-4">
      <h2 className="text-lg font-semibold">Register your farm</h2>

      <label className="block text-sm">
        Farmer name
        <input
          required value={form.farmer_name} onChange={set('farmer_name')}
          className="mt-1 w-full border rounded px-3 py-2"
        />
      </label>

      <div className="grid grid-cols-2 gap-3">
        <label className="block text-sm">
          Latitude
          <input
            type="number" step="any" required min={-90} max={90}
            value={form.gps_lat} onChange={set('gps_lat')}
            className="mt-1 w-full border rounded px-3 py-2"
          />
        </label>
        <label className="block text-sm">
          Longitude
          <input
            type="number" step="any" required min={-180} max={180}
            value={form.gps_lng} onChange={set('gps_lng')}
            className="mt-1 w-full border rounded px-3 py-2"
          />
        </label>
      </div>

      <label className="block text-sm">
        Crop
        <select className="mt-1 w-full border rounded px-3 py-2" value="wheat" disabled>
          <option value="wheat">Wheat</option>
        </select>
      </label>

      <label className="block text-sm">
        District
        <input value="Sheikhupura" disabled className="mt-1 w-full border rounded px-3 py-2 bg-gray-100" />
      </label>

      {err && <p className="text-sm text-red-600">{err}</p>}

      <button
        type="submit" disabled={busy}
        className="w-full bg-green-700 text-white rounded py-2 disabled:opacity-50"
      >
        {busy ? 'Saving...' : 'Register farm'}
      </button>
    </form>
  )
}
