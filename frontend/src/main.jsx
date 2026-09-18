import React from 'react'
import ReactDOM from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// Vite inlines VITE_* variables AT BUILD TIME. If they are absent when the
// bundle is built -- the usual cause being a host like Vercel that has no
// Environment Variables configured -- they become `undefined`, supabase-js
// throws "supabaseUrl is required" while this module is still loading, and
// React never mounts. The result is a blank white page with the reason buried
// in the console. Check first and say so on the page instead.
const missing = ['VITE_SUPABASE_URL', 'VITE_SUPABASE_ANON_KEY'].filter(
  (k) => !import.meta.env[k]
)

const root = ReactDOM.createRoot(document.getElementById('root'))

if (missing.length) {
  root.render(
    <div style={{ font: '15px/1.6 system-ui, sans-serif', maxWidth: 560, margin: '15vh auto', padding: 24 }}>
      <h1 style={{ font: '600 20px system-ui' }}>Configuration missing</h1>
      <p>This build has no value for:</p>
      <ul>{missing.map((k) => <li key={k}><code>{k}</code></li>)}</ul>
      <p style={{ color: '#6c7a71' }}>
        Set them in your host's environment variables (Vercel → Settings →
        Environment Variables) and <strong>redeploy</strong> — these are baked
        into the bundle at build time, so changing them does not take effect
        until the project is rebuilt.
      </p>
    </div>
  )
} else {
  root.render(<App />)
}
