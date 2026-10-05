import ReactDOM from 'react-dom/client'
import './gov.css'
import { applyTheme } from '../lib/theme'

/* Mirrors src/main.jsx: the same env-var check, and the same reason for the
 * DYNAMIC import below. Vite inlines VITE_* at BUILD time, so a host with no
 * environment variables configured produces a bundle where they are `undefined`
 * and supabase-js throws "supabaseUrl is required" the moment src/supabase.js is
 * evaluated. A static `import GovApp from './GovApp'` is hoisted above every
 * statement here, so the throw would happen during the import phase and this
 * check would never run -- leaving a blank page with the reason in the console.
 */
const missing = [
  ['VITE_SUPABASE_URL', import.meta.env.VITE_SUPABASE_URL],
  ['VITE_SUPABASE_ANON_KEY', import.meta.env.VITE_SUPABASE_ANON_KEY],
].filter(([, v]) => !v).map(([k]) => k)

// Apply the saved Appearance choice before first paint. Now shared with the
// farmer app, the researcher portal and the landing page through one key --
// four entry points on one origin reading as one product. src/lib/theme.js
// migrates the old `gov.theme` value, so an existing choice is not reset.
applyTheme()

const root = ReactDOM.createRoot(document.getElementById('root'))

if (missing.length) {
  root.render(
    <div style={{ font: '15px/1.6 system-ui, sans-serif', maxWidth: 560, margin: '15vh auto', padding: 24 }}>
      <h1 style={{ font: '600 20px system-ui' }}>Configuration missing</h1>
      <p>This build has no value for:</p>
      <ul>{missing.map((k) => <li key={k}><code>{k}</code></li>)}</ul>
      <p style={{ color: '#66756b' }}>
        Set them in the host's environment variables and <strong>redeploy</strong> — they are
        baked into the bundle at build time, so changing them has no effect until it is rebuilt.
      </p>
    </div>
  )
} else {
  import('./GovApp.jsx').then(({ default: GovApp }) => root.render(<GovApp />))
}
