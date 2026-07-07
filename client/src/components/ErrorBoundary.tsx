import { Component, type ReactNode } from 'react';
import { formatDiagnostics, logError } from '../errorLog.js';

// Catches render/runtime errors so a bug shows a recoverable screen with a
// copyable diagnostic bundle instead of a white page (beta plan §5).

interface Props {
  children: ReactNode;
}
interface State {
  hasError: boolean;
  message: string;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: '' };

  static getDerivedStateFromError(err: unknown): State {
    return { hasError: true, message: err instanceof Error ? err.message : String(err) };
  }

  componentDidCatch(err: unknown, info: { componentStack?: string | null }): void {
    const stack = `${err instanceof Error ? err.stack ?? '' : ''}\n${info.componentStack ?? ''}`;
    logError('react', err instanceof Error ? err.message : String(err), stack);
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <div className="gate">
        <div className="gate-inner">
          <div className="gate-logo" aria-hidden>
            ⚠️
          </div>
          <h1>Something went wrong</h1>
          <p className="gate-msg">The app hit an unexpected error. Your data is safe on this device.</p>
          <p className="gate-note gate-error">{this.state.message}</p>
          <div className="confirm-row" style={{ justifyContent: 'center' }}>
            <button
              onClick={() => {
                void navigator.clipboard?.writeText(formatDiagnostics());
              }}
            >
              Copy diagnostics
            </button>
            <button className="primary" onClick={() => window.location.reload()}>
              Reload app
            </button>
          </div>
        </div>
      </div>
    );
  }
}
