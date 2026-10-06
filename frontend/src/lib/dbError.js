/* Turn a database error into something a person can act on.
 *
 * FIRST, THE THING THIS IS NOT. It is not an SQL-injection filter, and this
 * project does not have one, on purpose. Nothing here ever builds SQL from a
 * string: every read and write goes through PostgREST (supabase-js in the
 * browser, supabase-py in the service), which sends values as parameters and
 * generates the SQL itself. There is no raw SQL, no .rpc() and no interpolated
 * filter anywhere in the application code. `' OR 1=1 --` typed into any field
 * on any portal is stored and compared as that exact 12-character string.
 *
 * Blocking quotes or keywords would be worse than useless: it would reject
 * "Dera Ghazi Khan", "O'Brien" and "cotton, intercropped with onion" while
 * protecting nothing, and it would teach a reader that the parameterisation is
 * not trusted. The defence is parameterised queries, enumerated columns, ranged
 * numerics, bounded text and row-level security -- all of which are in place and
 * enforced by Postgres.
 *
 * WHAT IS ACTUALLY WRONG is what the user sees when one of those bounds fires.
 * PostgREST hands back the raw Postgres message:
 *
 *   new row for relation "farms" violates check constraint "farms_farmer_name_len"
 *   duplicate key value violates unique constraint "model_runs_one_production_per_type"
 *   new row violates row-level security policy for table "model_runs"
 *
 * Every screen in this project was printing those verbatim. They name tables,
 * constraints and policies -- internal structure a user has no business reading
 * and an attacker is glad to receive -- and they tell a farmer nothing about
 * what to change. This module maps them to a sentence about the field, and
 * keeps the original in the console for whoever is debugging.
 */

/** Constraint name -> what the person should do about it.
 *
 * Keyed on the constraint, not the message text, because the name is stable and
 * the wording is Postgres's to change. Adding a constraint without a line here
 * is not a failure -- it falls through to the generic message for its class.
 */
const BY_CONSTRAINT = {
  farms_farmer_name_len: 'The farmer name must be between 1 and 120 characters.',
  farms_area_hectares_check: 'Area must be greater than 0 and no more than 10,000 hectares.',
  farms_gps_lat_check: 'Latitude must be between -90 and 90.',
  farms_gps_lng_check: 'Longitude must be between -180 and 180.',
  farms_crop_type_check: 'That crop is not one the platform models yet.',
  farms_district_check: 'That district is not one of the 34 Punjab districts.',
  farms_crop_season_match: 'That crop does not grow in the selected season.',
  farms_salinity_flag_check: 'Choose one of the listed salinity options.',
  farms_water_source_check: 'Choose one of the listed water sources.',
  farms_planting_date_sane: 'The sowing date is too far in the past to be real.',
  farms_harvest_date_sane: 'The harvest date is too far in the past to be real.',

  gov_profiles_full_name_len: 'The full name must be between 1 and 120 characters.',
  research_profiles_full_name_len: 'The full name must be between 1 and 120 characters.',
  research_profiles_lead_flags: 'A research lead always holds both model permissions; they cannot be removed.',

  gov_field_surveys_verified_yield_check: 'Yield must be between 0 and 120 t/ha.',
  gov_field_surveys_gps_lat_check: 'Latitude must be between -90 and 90.',
  gov_field_surveys_gps_lng_check: 'Longitude must be between -180 and 180.',
  gov_field_surveys_observed_value_len: 'The observation must be 200 characters or fewer.',
  gov_field_surveys_notes_len: 'Notes must be 1,000 characters or fewer.',
  gov_field_surveys_survey_type_check: 'Choose one of the listed survey types.',

  dataset_versions_description_len: 'The description must be between 1 and 300 characters.',
  benchmark_references_citation_len: 'The citation must be between 1 and 300 characters.',
  benchmark_references_notes_len: 'Notes must be 1,000 characters or fewer.',

  model_runs_one_production_per_type:
    'Another version of this model type is already in production. Archive it first.',
  model_runs_status_scope:
    'An evaluation cannot carry a model status, and a training must have one.',
  model_runs_parent_not_self: 'A run cannot be retrained from itself.',
  model_runs_model_type_check: 'That model type is not one the platform supports.',
}

/** Pull the constraint name out of a Postgres message, which quotes it. */
function constraintOf(err) {
  const text = `${err?.message ?? ''} ${err?.details ?? ''}`
  return text.match(/constraint "([^"]+)"/)?.[1] ?? null
}

/** Human message for a supabase-js / PostgREST error.
 *
 * Returns a sentence that names the FIELD and the RULE, never a table, a
 * constraint or a policy. The original is logged, not shown.
 */
export function dbError(err, fallback = 'That could not be saved.') {
  if (!err) return fallback
  // Keep the real thing reachable for whoever is debugging, without putting it
  // on screen.
  try { console.warn('[db]', err?.code, err?.message, err?.details) } catch { /* no console */ }

  const named = BY_CONSTRAINT[constraintOf(err)]
  if (named) return named

  switch (err.code) {
    case '23514':   // check_violation, constraint not in the map above
      return 'One of the values is outside the range this field allows.'
    case '23505':   // unique_violation
      return 'That already exists. Check for a duplicate entry.'
    case '23503':   // foreign_key_violation
      return 'That refers to a record which no longer exists. Reload and try again.'
    case '23502':   // not_null_violation
      return 'A required field was left empty.'
    case '22001':   // string_data_right_truncation
      return 'One of the values is too long for its field.'
    case '22P02':   // invalid_text_representation -- a bad uuid or number
      return 'One of the values is not in the format this field expects.'
    case '22003':   // numeric_value_out_of_range
      return 'A number is too large for its field.'
    // RLS refusal and privilege refusal are deliberately given the SAME
    // message. Saying "a policy blocked this" tells a prober that the row
    // exists and that they are close; "you do not have permission" is true in
    // both cases and reveals nothing about which.
    case '42501':
    case 'PGRST116':
      return 'You do not have permission to do that.'
    case 'PGRST301':
    case '401':
      return 'Your session has expired. Sign in again.'
    case '23P01':   // exclusion_violation
      return 'That conflicts with an existing record.'
    default:
      break
  }

  if (/row-level security/i.test(err.message || '')) {
    return 'You do not have permission to do that.'
  }
  if (/JWT|token is expired/i.test(err.message || '')) {
    return 'Your session has expired. Sign in again.'
  }
  // Network and service failures carry no schema detail, so their own text is
  // both safe and more useful than anything generic.
  if (/fetch|network|timeout/i.test(err.message || '')) {
    return 'Could not reach the server. Check your connection and try again.'
  }
  return fallback
}

/** Same, for a thrown Error or a rejected promise. */
export const errText = (e, fallback) =>
  dbError(e, fallback ?? (typeof e?.message === 'string' && !/constraint|relation "/i.test(e.message)
    ? e.message
    : 'Something went wrong.'))
