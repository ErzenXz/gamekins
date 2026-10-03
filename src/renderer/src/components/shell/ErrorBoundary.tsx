import { Component, type ErrorInfo, type ReactNode } from 'react'

/**
 * Catches render/effect errors so one broken view can't blank the whole window.
 * `scope="app"` offers a full reload; `scope="view"` lets the user try the view again
 * (the boundary is keyed by route, so navigating away also resets it).
 */
export class ErrorBoundary extends Component<
  { children: ReactNode; scope: 'app' | 'view'; onHome?: () => void },
  { error: Error | null }
> {
  state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error('[lodestar] UI error', error, info.componentStack)
  }

  render(): ReactNode {
    const { error } = this.state
    if (!error) return this.props.children
    const app = this.props.scope === 'app'
    return (
      <div className={`crash ${app ? 'crash-app' : 'crash-view'}`} role="alert">
        <div className="crash-card">
          <div className="crash-title">{app ? 'Lodestar ran into a problem' : 'This page ran into a problem'}</div>
          <p className="crash-text">
            {app
              ? 'Something went wrong while drawing the window. Your downloads and games are safe; reloading the interface usually fixes it.'
              : 'Something went wrong while showing this page. The rest of Lodestar still works.'}
          </p>
          <pre className="crash-detail mono">{error.message || String(error)}</pre>
          <div className="crash-actions">
            {!app && (
              <button className="btn btn-ghost" onClick={() => this.setState({ error: null })}>
                Try again
              </button>
            )}
            {!app && this.props.onHome && (
              <button
                className="btn btn-ghost"
                onClick={() => {
                  this.setState({ error: null })
                  this.props.onHome?.()
                }}
              >
                Go to library
              </button>
            )}
            <button className="btn btn-blue" onClick={() => location.reload()}>
              Reload
            </button>
          </div>
        </div>
      </div>
    )
  }
}
