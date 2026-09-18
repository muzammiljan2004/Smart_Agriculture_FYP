import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'

// Vite inlines VITE_* variables AT BUILD TIME. If they are absent when the
// bundle is built -- typically a host like Vercel with no Environment
// Variables configured -- they become `undefined` and supabase-js throws
// "supabaseUrl is required" as soon as src/supabase.js is evaluated.
//
// App.jsx is loaded with a DYNAMIC import below, not a static one, and that is
// load-bearing. A static `import App from './App.jsx'` is hoisted and
// evaluated before any statement in this file runs, so supabase.js would throw
// during the import phase and the check below would never execute -- leaving a
// blank page with the reason buried in the console. Deferring the import is
// what lets this file run first and report the problem on the page.
const missing = [
  ['VITE_SUPABASE_URL', import.meta.env.VITE_SUPABASE_URL],
  ['VITE_SUPABASE_ANON_KEY', import.meta.env.VITE_SUPABASE_ANON_KEY],
]
  .filter(([, v]) => !v)
  .map(([k]) => k)

const root = ReactDOM.createRoot(document.getElementById('root'))

if (missing.length) {
  root.render(
    <div style={{ font: '15px/1.6 system-ui, sans-serif', maxWidth: 560, margin: '15vh auto', padding: 24 }}>
      <h1 style={{ font: '600 20px system-ui' }}>Configuration missing</h1>
      <p>This build has no value for:</p>
      <ul>
        {missing.map((k) => (
          <li key={k}><code>{k}</code></li>
        ))}
      </ul>
      <p style={{ color: '#6c7a71' }}>
        Set them in your host's environment variables (Vercel → Settings →
        Environment Variables) and <strong>redeploy</strong> — these are baked
        into the bundle at build time, so changing them has no effect until the
        project is rebuilt.
      </p>
    </div>
  )
} else {
  import('./App.jsx').then(({ default: App }) => root.render(<App />))
}
