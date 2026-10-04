import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// Three entry points, three separate bundles:
//   index.html      -> the public landing page (no JS at all, just a stylesheet)
//   farmer.html     -> the farmer portal       (Tailwind theme, sign-up allowed)
//   government.html -> the government portal   (its own stylesheet, invite-only)
//
// Declaring all three is required, not optional: once rollupOptions.input is set
// Vite builds only the entries listed, so dropping one would silently stop
// shipping that portal. In dev they are served at /, /farmer.html and
// /government.html.
//
// THE FARMER APP MOVED from index.html to farmer.html so that / can be the
// portal chooser. Anything bookmarked at the bare domain now lands on the
// landing page and is one click from where it was.
//
// Relative paths, resolved against `root`. The documented form uses
// resolve(__dirname, …), but this package is ESM ("type": "module") and
// __dirname does not exist there.
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      input: {
        landing: 'index.html',
        farmer: 'farmer.html',
        government: 'government.html',
      },
    },
  },
})
