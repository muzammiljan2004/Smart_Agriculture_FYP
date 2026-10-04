import { Component } from 'react'

/**
 * Per-screen error boundary.
 *
 * The brief asks for no unhandled promise rejections and no blank screens.
 * Async failures are covered by useQuery, which routes them to <Panel>; this
 * catches the other half -- a throw during RENDER, which useQuery cannot see and
 * which React responds to by unmounting the whole tree. Without a boundary a
 * single bad row (a null where a chart expected a number) takes the entire
 * portal to a white page, sidebar included.
 *
 * Still a class component: React has no hook equivalent of
 * componentDidCatch/getDerivedStateFromError, so this is the supported API
 * rather than a legacy choice.
 */
export default class ErrorBoundary extends Component {
  state = { error: null }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    // Kept: the component stack is the only thing that locates the failing
    // chart, and it is otherwise lost once the boundary swallows the throw.
    console.error('[gov portal] render failed in', this.props.screen, error, info?.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="err" style={{ marginTop: 10 }}>
        <b>This screen failed to render.</b>
        {this.props.screen ? `“${this.props.screen}” ` : ''}
        stopped with: {String(this.state.error.message || this.state.error)}
        <div className="row" style={{ marginTop: 10 }}>
          <button className="btn sm" onClick={() => this.setState({ error: null })}>
            Try this screen again
          </button>
          <button className="btn sm" onClick={() => { window.location.hash = '#/dashboard' }}>
            Back to dashboard
          </button>
        </div>
      </div>
    )
  }
}
