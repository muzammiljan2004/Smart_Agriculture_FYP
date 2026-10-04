import { useMemo } from 'react'
import { districtCells } from './geo'
import { fetchSeasonFacts } from './queries'
import { useQuery } from './useQuery'

/**
 * One row per district for the selected crop and season, with map geometry
 * attached — the shape six of the fifteen screens are built from.
 *
 * Returns a useQuery result whose `data` is already joined to the Voronoi cells,
 * so a screen can hand it straight to <GovMap> and to a table without doing the
 * join twice and risking the two disagreeing about which districts exist.
 */
export function useFacts({ dims, crop, season }) {
  const districts = dims?.districts ?? []
  const q = useQuery(
    () => fetchSeasonFacts({ cropId: crop, seasonId: season, districts }),
    [crop, season, districts.length],
    { enabled: Boolean(crop && season && districts.length) }
  )

  const data = useMemo(() => (q.data ? districtCells(q.data) : null), [q.data])

  // A season with no rows at all is empty; a season where only SOME tables have
  // rows is not. fetchSeasonFacts always returns one object per district, so the
  // array is never empty while districts exist -- emptiness has to be judged on
  // whether any district carries a measurement.
  const isEmpty = Boolean(
    data && !data.some((d) => d.prediction || d.actual || d.indices || d.area || d.harvest)
  )

  return { ...q, data, isEmpty }
}
