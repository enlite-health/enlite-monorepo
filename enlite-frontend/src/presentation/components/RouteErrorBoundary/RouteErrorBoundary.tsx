import { Component, ErrorInfo, ReactNode } from 'react';
import i18n from '../../../infrastructure/i18n/config';
import { Heading } from '../atoms/Heading';
import { Text } from '../atoms/Text';
import { Button } from '../atoms/Button';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

const RELOAD_KEY = 'enlite_route_chunk_reload';

export class RouteErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, errorInfo: null };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('[RouteErrorBoundary] Erro capturado:', error);
    console.error('[RouteErrorBoundary] Stack trace:', errorInfo.componentStack);

    const isChunkError =
      error.message.includes('Failed to fetch dynamically imported module') ||
      error.message.includes('Loading chunk') ||
      error.message.includes('Importing a module script failed');

    if (isChunkError) {
      const reloadCount = Number(sessionStorage.getItem(RELOAD_KEY) || '0');
      if (reloadCount < 2) {
        sessionStorage.setItem(RELOAD_KEY, String(reloadCount + 1));
        window.location.reload();
        return;
      }
      sessionStorage.removeItem(RELOAD_KEY);
    }

    this.setState({ error, errorInfo });
  }

  override render(): ReactNode {
    const t = i18n.t.bind(i18n);

    if (this.state.hasError) {
      if (this.props.fallback) {
        return this.props.fallback;
      }

      return (
        <div
          data-testid="route-error-boundary"
          className="min-h-screen flex items-center justify-center bg-gray-50 p-4"
        >
          <div className="bg-white rounded-2xl shadow-lg p-8 max-w-md w-full flex flex-col gap-6 items-center text-center">
            <div className="w-16 h-16 rounded-full bg-red-100 flex items-center justify-center">
              <svg
                className="w-8 h-8 text-red-600"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
                />
              </svg>
            </div>

            <div className="flex flex-col gap-2">
              <Heading level={2} color="secondary">
                {t('worker.errorBoundary.title')}
              </Heading>
              <Text size="sm" color="muted">
                {t('worker.errorBoundary.description')}
              </Text>
            </div>

            <div className="flex flex-col sm:flex-row gap-3 w-full">
              <Button
                variant="primary"
                size="md"
                fullWidth
                onClick={() => window.location.reload()}
              >
                {t('worker.errorBoundary.reload')}
              </Button>
              <Button
                variant="outline"
                size="md"
                fullWidth
                onClick={() => window.location.assign('/')}
              >
                {t('worker.errorBoundary.home')}
              </Button>
            </div>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
