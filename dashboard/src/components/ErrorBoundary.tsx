import { Component, type ReactNode, type ErrorInfo } from 'react';

interface Props {
  children: ReactNode;
  label?: string;
}

interface State {
  error: Error | null;
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // eslint-disable-next-line no-console
    console.error('ErrorBoundary caught', this.props.label ?? '', error, info);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="text-red text-xs space-y-1">
          <div className="font-semibold">⚠ {this.props.label ?? 'Component'} crashed</div>
          <div className="font-mono text-[10px] break-all opacity-80">
            {this.state.error.message}
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}
