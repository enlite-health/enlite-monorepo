import { Component, ErrorInfo, ReactNode } from 'react';
import i18n from '../../../../infrastructure/i18n/config';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error: Error | null;
  errorInfo: ErrorInfo | null;
}

export class AdminErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error, errorInfo: null };
  }

  override componentDidCatch(error: Error, errorInfo: ErrorInfo): void {
    console.error('[AdminErrorBoundary] Erro capturado:', error);
    console.error('[AdminErrorBoundary] Stack trace:', errorInfo.componentStack);

    const isChunkError =
      error.message.includes('Failed to fetch dynamically imported module') ||
      error.message.includes('Loading chunk') ||
      error.message.includes('Importing a module script failed');

    if (isChunkError) {
      const RELOAD_KEY = 'enlite_chunk_reload';
      const reloadCount = Number(sessionStorage.getItem(RELOAD_KEY) || '0');
      if (reloadCount < 2) {
        sessionStorage.setItem(RELOAD_KEY, String(reloadCount + 1));
        window.location.reload();
        return;
      }
      // Exhausted retries — clear flag so future navigations can try again
      sessionStorage.removeItem(RELOAD_KEY);
    }

    this.setState({ error, errorInfo });
  }

  override render(): ReactNode {
    const t = i18n.t.bind(i18n);
    
    if (this.state.hasError) {
      return (
        this.props.fallback || (
          <div className="min-h-screen flex items-center justify-center bg-gray-50 p-4">
            <div className="bg-white rounded-lg shadow-lg p-6 max-w-lg w-full">
              <h2 className="text-xl font-semibold text-red-600 mb-4">
                {t('admin.errorBoundary.title')}
              </h2>
              <p className="text-gray-600 mb-4">
                {t('admin.errorBoundary.description')}
              </p>
              {/* O stack trace deixa de ser a primeira coisa que a operadora vê.
                  Medido em 30/08: a tela cuspia "Cannot read properties of
                  undefined (reading 'map')" com sete linhas de `at RenderedRoute`
                  — para quem opera, indistinguível de "o sistema morreu". O
                  detalhe continua acessível (o suporte pede para expandir) e
                  continua indo para o console, que é onde o dev olha. */}
              {(this.state.error?.message || this.state.errorInfo?.componentStack) && (
                <details className="mt-2" data-testid="admin-error-details">
                  <summary className="cursor-pointer text-sm text-gray-500 hover:text-gray-700 select-none">
                    {t('admin.errorBoundary.details')}
                  </summary>
                  <pre className="mt-2 bg-gray-100 p-3 rounded text-xs overflow-auto max-h-48 text-red-700">
                    {this.state.error?.message}
                    {'\n'}
                    {this.state.errorInfo?.componentStack}
                  </pre>
                </details>
              )}
              <button
                onClick={() => window.location.reload()}
                className="mt-4 px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
              >
                {t('admin.errorBoundary.reload')}
              </button>
            </div>
          </div>
        )
      );
    }

    return this.props.children;
  }
}
