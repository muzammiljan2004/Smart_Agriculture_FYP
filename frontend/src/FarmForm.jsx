import { useEffect, useState } from 'react'
import { supabase } from './supabase'

// All 34 Punjab districts the pipeline has data for. Must match the CHECK in
// supabase/migrations/20260927020000_all_punjab_districts.sql, which is itself
// generated from data/district_soil.csv -- so this list cannot drift ahead of
// the districts the suitability engine can actually assess.
//
// Centres are GAUL polygon CENTROIDS, not district towns. The centroid is what
// the satellite pipeline reduces over, so the coordinate inputs open on the
// same place the imagery describes. A town centre would drop the default pin
// on rooftops, which is the one land cover the model has nothing to say about.
export const DISTRICTS = {
  Attock: { lat: '33.4914', lng: '72.3060' },
  Bahawalnagar: { lat: '29.6087', lng: '73.0159' },
  Bahawalpur: { lat: '28.8295', lng: '71.7234' },
  Bhakkar: { lat: '31.6517', lng: '71.4221' },
  Chakwal: { lat: '32.9001', lng: '72.5321' },
  'Dera Ghazi Khan': { lat: '30.4141', lng: '70.4417' },
  Faisalabad: { lat: '31.2387', lng: '73.1479' },
  Gujranwala: { lat: '32.1398', lng: '74.0896' },
  Gujrat: { lat: '32.7228', lng: '73.9927' },
  Hafizabad: { lat: '32.0267', lng: '73.5032' },
  Jhang: { lat: '31.3178', lng: '72.3634' },
  Jhelum: { lat: '32.8302', lng: '73.2927' },
  Kasur: { lat: '31.0540', lng: '74.1582' },
  Khanewal: { lat: '30.3696', lng: '72.0178' },
  Khushab: { lat: '32.1897', lng: '72.1043' },
  Lahore: { lat: '31.4663', lng: '74.3584' },
  Layyah: { lat: '30.9726', lng: '71.2488' },
  Lodhran: { lat: '29.6740', lng: '71.6892' },
  'Mandi Bahauddin': { lat: '32.4359', lng: '73.4520' },
  Mianwali: { lat: '32.6657', lng: '71.5334' },
  Multan: { lat: '29.9386', lng: '71.4030' },
  Muzaffargarh: { lat: '30.0513', lng: '71.0374' },
  Narowal: { lat: '32.2068', lng: '74.9945' },
  Okara: { lat: '30.7087', lng: '73.6849' },
  Pakpattan: { lat: '30.3018', lng: '73.2439' },
  'Rahim Yar Khan': { lat: '28.4149', lng: '70.5345' },
  Rajanpur: { lat: '29.1633', lng: '70.0406' },
  Rawalpindi: { lat: '33.4654', lng: '73.1970' },
  Sahiwal: { lat: '30.5485', lng: '72.8939' },
  Sargodha: { lat: '32.0959', lng: '72.7407' },
  Sheikhupura: { lat: '31.6232', lng: '73.9154' },
  Sialkot: { lat: '32.4114', lng: '74.5331' },
  'Toba Tek Singh': { lat: '30.8789', lng: '72.5486' },
  Vehari: { lat: '30.0106', lng: '72.4046' },
}

// Season is derived, not chosen: the DB has a CHECK that rejects any other
// pairing, so offering it as a separate input could only produce errors.
//
// REGENERATE when ml-service/data/crops.csv changes:
//   python -c "from app.crops import ALL_CROPS, CROP_SEASON; //     [print(f\"  {c}: '{CROP_SEASON[c]}',\") for c in ALL_CROPS]"
// Ordered by how much of Punjab actually grows them, not alphabetically.
export const SEASON = {
  wheat: 'rabi',
  rice: 'kharif',
  maize: 'kharif',
  sugarcane: 'annual',
  cotton: 'kharif',
  potato: 'rabi',
  onion: 'rabi',
  garlic: 'rabi',
  tomato: 'kharif',
  brinjal: 'zaid',
  chilli: 'zaid',
  barley: 'rabi',
  bajra: 'kharif',
  jowar: 'kharif',
}

const WATER_SOURCES = [
  ['canal_and_tubewell', 'Canal + tubewell'],
  ['canal', 'Canal only'],
  ['tubewell', 'Tubewell only'],
  ['rainfed', 'Rain-fed (barani)'],
]

const SALINITY = [
  ['none', 'No salinity problem'],
  ['mild', 'Mild — some patches'],
  ['severe', 'Severe — visible salt crust'],
  ['unknown', "Don't know"],
]

const title = (c) => c.charAt(0).toUpperCase() + c.slice(1)

const field =
  'mt-1.5 w-full rounded-xl border border-leaf-100 bg-white px-4 py-3 text-ink ' +
  'outline-none transition focus:border-leaf-400 focus:ring-4 focus:ring-leaf-400/15 ' +
  'disabled:bg-leaf-50/60 disabled:text-muted'

export default function FarmForm({ onCreated }) {
  const [form, setForm] = useState({
    farmer_name: '',
    district: 'Sheikhupura',
    crop_type: 'wheat',
    gps_lat: DISTRICTS.Sheikhupura.lat,
    gps_lng: DISTRICTS.Sheikhupura.lng,
    planting_date: '',
    water_source: 'canal_and_tubewell',
    salinity_flag: 'none',
    last_crop: '',
  })
  const [err, setErr] = useState(null)
  const [busy, setBusy] = useState(false)
  // Which crops the model can actually predict. Read from the service rather
  // than hardcoded, so the warning below stays true after every retrain
  // instead of quietly going stale.
  const [trained, setTrained] = useState(null)

  useEffect(() => {
    fetch(`${import.meta.env.VITE_ML_API_URL}/health`)
      .then((r) => r.json())
      .then((h) => setTrained(h.trained_crops ?? []))
      .catch(() => setTrained([]))
  }, [])

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value })

  function setDistrict(e) {
    const d = e.target.value
    setForm({ ...form, district: d, gps_lat: DISTRICTS[d].lat, gps_lng: DISTRICTS[d].lng })
  }

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
        district: form.district,
        crop_type: form.crop_type,
        season: SEASON[form.crop_type],
        // '' would violate the date column. null is meaningful: the growth
        // tracker falls back to the season's conventional sowing date and
        // labels the result as estimated rather than pretending it was given.
        planting_date: form.planting_date || null,
        // The three things the farmer knows and no satellite does.
        water_source: form.water_source,
        salinity_flag: form.salinity_flag,
        last_crop: form.last_crop || null,
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
          We use the location to read your soil and climate, and to pull Sentinel-2
          imagery for your plot.
        </p>
      </div>

      <form onSubmit={submit} className="rounded-2xl bg-white p-7 shadow-sm ring-1 ring-leaf-100">
        <label className="block text-sm font-medium">
          Farmer name
          <input
            required
            value={form.farmer_name}
            onChange={set('farmer_name')}
            placeholder="e.g. Muhammad Aslam"
            className={field}
          />
        </label>

        <div className="mt-5 grid grid-cols-2 gap-4">
          <label className="block text-sm font-medium">
            District
            <select value={form.district} onChange={setDistrict} className={field}>
              {Object.keys(DISTRICTS).map((d) => (
                <option key={d} value={d}>{d}</option>
              ))}
            </select>
          </label>
          <label className="block text-sm font-medium">
            Crop
            <select value={form.crop_type} onChange={set('crop_type')} className={field}>
              {Object.entries(SEASON).map(([c, s]) => (
                <option key={c} value={c}>{title(c)} ({s})</option>
              ))}
            </select>
          </label>
        </div>

        {trained && !trained.includes(form.crop_type) && (
          <p className="mt-3 rounded-xl bg-wheat-300/25 px-4 py-3 text-xs leading-relaxed text-wheat-500 ring-1 ring-wheat-300/50">
            <strong className="font-semibold">
              No yield model for {title(form.crop_type)} yet.
            </strong>{' '}
            The farm saves fine, and land suitability, growth stages and weather alerts all
            work. Yield prediction will refuse until {title(form.crop_type)} seasons are added
            to the training set — the model currently covers{' '}
            {trained.length ? trained.join(' and ') : 'nothing yet'}.
          </p>
        )}

        <div className="mt-5 grid grid-cols-2 gap-4">
          <label className="block text-sm font-medium">
            Latitude
            <input
              type="number" step="any" required min={-90} max={90}
              value={form.gps_lat} onChange={set('gps_lat')} className={`${field} tnum`}
            />
          </label>
          <label className="block text-sm font-medium">
            Longitude
            <input
              type="number" step="any" required min={-180} max={180}
              value={form.gps_lng} onChange={set('gps_lng')} className={`${field} tnum`}
            />
          </label>
        </div>
        <p className="mt-2 text-xs text-muted">
          Prefilled with {form.district} town centre — adjust to your plot.
        </p>

        {/* The three things a farmer knows and no raster does. Salinity in
            particular has no free global layer, and in southern Punjab it is
            often what decides whether a crop is growable at all. */}
        <div className="mt-6 rounded-xl bg-leaf-50/60 p-5 ring-1 ring-leaf-100">
          <p className="text-sm font-medium">About your land</p>
          <p className="mt-1 text-xs text-muted">
            Satellites can read your soil and climate. These three they cannot.
          </p>

          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            <label className="block text-sm font-medium">
              Water source
              <select value={form.water_source} onChange={set('water_source')} className={field}>
                {WATER_SOURCES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
            <label className="block text-sm font-medium">
              Salinity
              <select value={form.salinity_flag} onChange={set('salinity_flag')} className={field}>
                {SALINITY.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            </label>
          </div>

          <label className="mt-4 block text-sm font-medium">
            Last crop grown <span className="font-normal text-muted">(optional)</span>
            <select value={form.last_crop} onChange={set('last_crop')} className={field}>
              <option value="">Not sure / first season</option>
              {Object.keys(SEASON).map((c) => (
                <option key={c} value={c}>{title(c)}</option>
              ))}
            </select>
          </label>
          <p className="mt-2 text-xs text-muted">
            Used to check rotation — planting tomato after potato carries the same
            soil diseases, for example.
          </p>
        </div>

        <label className="mt-5 block text-sm font-medium">
          Sowing date <span className="font-normal text-muted">(optional)</span>
          {/* Native date input rather than a picker library: it is already
              localised, keyboard accessible, and validated by the browser. */}
          <input
            type="date"
            value={form.planting_date}
            onChange={set('planting_date')}
            className={field}
          />
        </label>
        <p className="mt-2 text-xs text-muted">
          Drives the growth-stage tracker. Left blank, we assume this crop's usual
          sowing date and mark it estimated.
        </p>

        {err && (
          <p role="alert" className="mt-5 rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700 ring-1 ring-red-100">
            {err}
          </p>
        )}

        <button
          type="submit" disabled={busy}
          className="mt-7 w-full rounded-xl bg-leaf-700 py-3 font-medium text-white shadow-sm
                     transition hover:bg-leaf-800 active:scale-[.99] disabled:opacity-60"
        >
          {busy ? 'Saving…' : 'Register farm'}
        </button>
      </form>
    </div>
  )
}
