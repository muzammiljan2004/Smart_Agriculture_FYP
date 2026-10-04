/** Screen id -> component. The ids match SCREENS in lib/access.js.
 *
 * A plain static map rather than lazy imports: the whole portal is one bundle
 * served to a desktop user on a government network, and fifteen dynamic chunks
 * would add a loading state to every sidebar click for no measurable gain.
 */
import AreaPage from './AreaPage'
import CropPage from './CropPage'
import DashboardPage from './DashboardPage'
import DataPage from './DataPage'
import DistrictPage from './DistrictPage'
import ForecastPage from './ForecastPage'
import HarvestPage from './HarvestPage'
import ReportsPage from './ReportsPage'
import RiskPage from './RiskPage'
import RolesPage from './RolesPage'
import SatellitePage from './SatellitePage'
import SettingsPage from './SettingsPage'
import StatsPage from './StatsPage'
import SubsidyPage from './SubsidyPage'
import SurveyPage from './SurveyPage'

export default {
  dashboard: DashboardPage,
  district: DistrictPage,
  crop: CropPage,
  satellite: SatellitePage,
  harvest: HarvestPage,
  area: AreaPage,
  stats: StatsPage,
  forecast: ForecastPage,
  subsidy: SubsidyPage,
  risk: RiskPage,
  survey: SurveyPage,
  data: DataPage,
  reports: ReportsPage,
  roles: RolesPage,
  settings: SettingsPage,
}
