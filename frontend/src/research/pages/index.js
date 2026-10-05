/** Screen id -> component.
 *
 * Keys must match the ids in lib/access.js SCREENS. The shell looks a screen up
 * here by the id the hash route resolved to, and a missing key renders
 * "Unknown screen" rather than a blank page -- scripts/research-selfcheck.mjs
 * asserts the two lists agree, because a typo here is otherwise only found by
 * clicking every item in the sidebar.
 */
import DashboardPage from './DashboardPage'
import ExplorerPage from './ExplorerPage'
import VersionsPage from './VersionsPage'
import ComparisonPage from './ComparisonPage'
import ImportancePage from './ImportancePage'
import ActualPage from './ActualPage'
import OperationsPage from './OperationsPage'
import HistoryPage from './HistoryPage'
import BenchmarkPage from './BenchmarkPage'
import ReportsPage from './ReportsPage'
import AccessPage from './AccessPage'

export default {
  dashboard: DashboardPage,
  explorer: ExplorerPage,
  versions: VersionsPage,
  comparison: ComparisonPage,
  importance: ImportancePage,
  actual: ActualPage,
  operations: OperationsPage,
  history: HistoryPage,
  benchmark: BenchmarkPage,
  reports: ReportsPage,
  access: AccessPage,
}
