import { supabase } from '../supabase'

export const API = import.meta.env.VITE_ML_API_URL

/** Bearer header for the FastAPI service.
 *
 * The API runs on the service_role key, which bypasses RLS, so it cannot tell
 * who is calling unless we say -- and it returns 403 for a farm the token does
 * not own. Moved here from Dashboard.jsx unchanged; every page needs it now.
 */
export const authHeader = async () => {
  const { data } = await supabase.auth.getSession()
  return { Authorization: 'Bearer ' + data.session?.access_token }
}

/** GET a JSON route, turning a non-2xx into a thrown Error carrying `detail`.
 *
 * "Failed to fetch" is the browser's blanket TypeError for a network-level
 * failure (connection refused, CORS, mixed content). It carries no status code
 * and tells the user nothing, so it is renamed here once rather than in every
 * caller.
 */
export async function getJSON(path) {
  let r
  try {
    r = await fetch(API + path, { headers: await authHeader() })
  } catch (e) {
    if (e.message === 'Failed to fetch') {
      throw new Error(
        `Cannot reach the prediction service at ${API}. Is it running? ` +
        `(cd ml-service && uvicorn app.main:app --reload)`
      )
    }
    throw e
  }
  const body = await r.json()
  if (!r.ok) throw new Error(body.detail ?? 'HTTP ' + r.status)
  return body
}
