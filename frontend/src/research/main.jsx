import ReactDOM from 'react-dom/client'
import './research.css'

/* Mirrors src/main.jsx and src/gov/main.jsx: the same env-var check, and the
 * same reason for the DYNAMIC import below. Vite inlines VITE_* at BUILD time,
 * so a host with no environment variables configured produces a bundle where
 * they are `undefined` and supabase-js throws "supabaseUrl is required" the
 * moment src/supabase.js is evaluated. A static `import ResearchApp from
 * './ResearchApp'` is hoisted above every statement here, so the throw would
 * happen during the import phase and this check would never run -- leaving a
 * blank page with the reason buried in the console.
 *
 * VITE_ML_API_URL is NOT checked here, deliberately. The portal is fully usable
 * without it: every analytical screen is a Postgres read. Only the dataset
 * upload and the job start signal need the ML service, and those two say so
 * where they are used rather than blocking the whole portal at boot.
 */
const missing = [
  ['VITE_SUPABASE_URL', import.meta.env.VITE_SUPABASE_URL],
  ['VITE_SUPABASE_ANON_KEY', import.meta.env.VITE_SUPABASE_ANON_KEY],
].filter(([, v]) => !v).map(([k]) => k)

const root = ReactDOM.createRoot(document.getElementById('root'))

if (missing.length) {
  root.render(
    <div style={{ font: '15px/1.6 system-ui, sans-serif', maxWidth: 560, margin: '15vh auto', padding: 24 }}>
      <h1 style={{ font: '600 20px system-ui' }}>Configuration missing</h1>
      <p>This build has no value for:</p>
      <ul>{missing.map((k) => <li key={k}><code>{k}</code></li>)}</ul>
      <p style={{ color: '#6a796f' }}>
        Set them in the host's environment variables and <strong>redeploy</strong> — they are
        baked into the bundle at build time, so changing them has no effect until it is rebuilt.
      </p>
    </div>
  )
} else {
  import('./ResearchApp.jsx').then(({ default: App }) => root.render(<App />))
}
