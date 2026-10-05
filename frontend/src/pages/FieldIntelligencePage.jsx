import { INDEX_META, fmtDate, title } from '../lib/format'
import FarmMap from '../components/FarmMap'
import { Badge, Card, CardHead, IndexBar, NotWired, PageHead, Skeleton } from '../components/ui'
import { PredictionGate } from '../components/panels'

const TABS = [
  ['indices', 'Spectral Indices'],
  ['map', 'Satellite Map'],
  ['imagery', 'Imagery'],
]

function Indices({ pred, err, fetching, onFetch, crop }) {
  return (
    <Card>
      <CardHead title="Spectral indices"
                right={pred?.feature_date ? `observed ${fmtDate(pred.feature_date)}` : null}
                sub="Sentinel-2, cloud-masked median composite" />
      <div className="mt-6 space-y-5">
        {pred?.features
          ? Object.keys(INDEX_META).map((k) => (
            <IndexBar key={k} name={k} value={pred.features[k]} />
          ))
          : err || fetching
            ? <PredictionGate err={err} fetching={fetching} onFetch={onFetch} crop={crop} />
            : Object.keys(INDEX_META).map((k) => (
              <div key={k} className="space-y-1.5">
                <Skeleton className="h-3 w-16" /><Skeleton className="h-1.5 w-full" />
              </div>
            ))}
      </div>
    </Card>
  )
}

/** Every stored observation for this field, newest first. */
function ImageryTable({ series, error }) {
  if (error) return <Card><CardHead title="Imagery" /><p className="mt-3 text-sm text-red-700">{error}</p></Card>
  if (!series) return <Card><CardHead title="Imagery" /><div className="mt-4"><Skeleton className="h-32 w-full" /></div></Card>

  const rows = [...(series.series ?? [])].reverse()
  if (!rows.length) {
    return (
      <Card>
        <CardHead title="Imagery" />
        <div className="mt-4">
          <NotWired what="No observations stored for this field yet."
                    why="Fetch the season from the Dashboard to populate this list." />
        </div>
      </Card>
    )
  }

  return (
    <Card pad="p-0" className="overflow-hidden">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-6 pb-4 pt-6">
        <h3 className="font-display text-lg font-semibold">Imagery</h3>
        <span className="text-xs text-muted">
          {rows.length} observation{rows.length === 1 ? '' : 's'}
          {series.area_assumed && ' · area assumed 1 ha'}
        </span>
      </div>
      <div className="max-h-[32rem] overflow-auto">
        <table className="w-full text-sm">
          <thead className="sticky top-0 bg-card">
            <tr className="border-y border-leaf-100 text-left text-xs text-muted">
              {['Date', 'Source', 'NDVI', 'EVI', 'NDWI', 'SAVI', 'NBR', 'VV', 'VH', 'Cloud %', 'Valid px']
                .map((h) => <th key={h} className="whitespace-nowrap px-4 py-3 font-medium">{h}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.date} className="border-b border-leaf-50 last:border-0">
                <td className="whitespace-nowrap px-4 py-2.5 font-medium">{fmtDate(r.date)}</td>
                <td className="whitespace-nowrap px-4 py-2.5">
                  <Badge tone={r.source?.includes('S1') ? 'blue' : 'grey'}>{r.source ?? '—'}</Badge>
                </td>
                {['ndvi', 'evi', 'ndwi', 'savi', 'nbr', 'vv', 'vh'].map((k) => (
                  <td key={k} className="tnum whitespace-nowrap px-4 py-2.5">
                    {r[k] == null ? <span className="text-muted">—</span> : r[k].toFixed(3)}
                  </td>
                ))}
                <td className="tnum whitespace-nowrap px-4 py-2.5">
                  {r.cloud_pct == null ? '—' : r.cloud_pct.toFixed(1)}
                </td>
                <td className="tnum whitespace-nowrap px-4 py-2.5">{r.valid_px ?? '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  )
}

export default function FieldIntelligencePage({ farm, data, tab = 'indices', onTab }) {
  const { pred, err, series, seriesErr, fetching, refreshImagery } = data
  const obs = series?.series?.length ?? 0

  return (
    <div className="space-y-5">
      <PageHead
        title="Field intelligence"
        sub={`Sentinel-2 · cloud-masked median composite${
          pred?.feature_date ? ` · imagery ${fmtDate(pred.feature_date)}` : ''}`}
      >
        {obs > 0 && <Badge tone="grey">{obs} stored observations</Badge>}
      </PageHead>

      <div className="flex gap-1 border-b border-leaf-100">
        {TABS.map(([id, label]) => (
          <button key={id} onClick={() => onTab(id)}
                  className={'border-b-2 px-4 py-2.5 text-sm transition ' +
                    (tab === id ? 'border-leaf-700 font-semibold text-leaf-800'
                      : 'border-transparent text-muted hover:text-ink')}>
            {label}
          </button>
        ))}
      </div>

      {tab === 'indices' && (
        <div className="grid gap-5 lg:grid-cols-5">
          <div className="lg:col-span-3">
            <Card pad="p-0" className="overflow-hidden">
              <h3 className="px-6 pb-4 pt-6 font-display text-lg font-semibold">Field boundary</h3>
              <FarmMap farms={farm} height="h-[28rem]" />
            </Card>
          </div>
          <div className="lg:col-span-2">
            <Indices pred={pred} err={err} fetching={fetching}
                     onFetch={refreshImagery} crop={farm.crop_type} />
          </div>
        </div>
      )}

      {tab === 'map' && (
        <div className="grid gap-5 lg:grid-cols-5">
          <Card pad="p-0" className="overflow-hidden lg:col-span-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2 px-6 pb-4 pt-6">
              <h3 className="font-display text-lg font-semibold">Satellite map</h3>
              <span className="text-xs text-muted">
                {title(farm.crop_type)} · {farm.area_hectares ?? 1} ha
              </span>
            </div>
            <FarmMap farms={farm} height="h-[34rem]" />
          </Card>

          <div className="space-y-5 lg:col-span-2">
            <Card>
              <CardHead title="Layers & controls" />
              <div className="mt-4 space-y-3 text-sm">
                {[['Satellite basemap', true], ['Street basemap', true], ['Field boundary', true]].map(([l]) => (
                  <div key={l} className="flex items-center justify-between border-b border-leaf-100 py-2 last:border-0">
                    <span>{l}</span>
                    <Badge tone="leaf">Available</Badge>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-xs text-muted">
                Switch basemaps and toggle the boundary with the layer control on the map itself.
              </p>
              <div className="mt-4">
                <NotWired
                  what="NDVI / NDWI / EVI raster layers are not available."
                  why="They would need a tile service rendering Earth Engine imagery, and the API
                       returns index values rather than tiles. The numbers for this field are on the
                       Spectral Indices tab; the map shows the true-colour basemap and the sampled
                       boundary only."
                />
              </div>
            </Card>

            <Card>
              <CardHead title="Sampled footprint" />
              <div className="mt-3">
                <p className="text-sm text-muted">
                  The gold circle is the exact geometry the indices are reduced over: a circle of
                  the farm's own area centred on its pin, the same shape
                  <code className="mx-1 rounded bg-leaf-50 px-1 py-0.5 text-xs">app/field.py</code>
                  builds. It is not a drawn field boundary — the database stores a point and an
                  area, not a polygon.
                </p>
              </div>
            </Card>
          </div>
        </div>
      )}

      {tab === 'imagery' && <ImageryTable series={series} error={seriesErr} />}
    </div>
  )
}
