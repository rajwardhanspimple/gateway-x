import React from "react";

/* ==========================================================================
   ErrorBoundary
   --------------------------------------------------------------------------
   A class component on purpose: componentDidCatch has no hook equivalent.
   Without a boundary, one render-time throw (the password-strength crash, for
   example) unmounted the entire tree and left a blank white page with the
   stack only in the console. Now the failure is contained to the current
   route, the message is on screen, and the shell stays interactive.
   ========================================================================== */
export default class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    /* keep the original stack in the console for debugging */
    console.error("[ragestar] render error", error, info && info.componentStack);
  }

  componentDidUpdate(prevProps) {
    /* navigating away from a broken view gives it a clean slate */
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) {
      this.setState({ error: null });
    }
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;

    return (
      <div className="err-boundary" role="alert">
        <div className="err-card">
          <span className="err-badge mono xs">render error</span>
          <h2>This view hit an unexpected error.</h2>
          <p>
            Nothing else was lost — the rest of the app is still running. Reload
            the page, or jump back to a screen that works.
          </p>
          <pre className="err-trace mono xs">{String((error && error.message) || error)}</pre>
          <div className="err-actions">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={() => window.location.reload()}
            >
              Reload this page
            </button>
            <a className="btn btn-sm" href="#/">
              Go home
            </a>
          </div>
        </div>
      </div>
    );
  }
}
