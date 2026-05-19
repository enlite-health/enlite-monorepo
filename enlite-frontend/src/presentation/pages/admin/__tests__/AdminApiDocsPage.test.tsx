import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, fallback?: string) => fallback ?? _key,
  }),
}));

const mockGetIdToken = vi.fn();
vi.mock('@infrastructure/services/FirebaseAuthService', () => ({
  FirebaseAuthService: vi.fn().mockImplementation(() => ({
    getIdToken: mockGetIdToken,
  })),
}));

vi.mock('@infrastructure/config/env', () => ({
  ENV: {
    API_WORKER_FUNCTIONS_URL: 'http://localhost:8080',
  },
}));

// Capture props passed to SwaggerUI to assert on URL + interceptor wiring
const mockSwaggerProps = vi.fn();
vi.mock('swagger-ui-react', () => ({
  default: (props: Record<string, unknown>) => {
    mockSwaggerProps(props);
    return <div data-testid="swagger-ui-mock">SwaggerUI({JSON.stringify({ url: props.url })})</div>;
  },
}));
vi.mock('swagger-ui-react/swagger-ui.css', () => ({}));

beforeEach(() => {
  vi.clearAllMocks();
  mockSwaggerProps.mockReset();
  mockGetIdToken.mockReset();
});

describe('AdminApiDocsPage', () => {
  it('renderiza título e subtítulo i18n', async () => {
    const { AdminApiDocsPage } = await import('../AdminApiDocsPage');
    render(<AdminApiDocsPage />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      /Documentación de la API/i,
    );
    expect(
      screen.getByText(/Referencia completa del worker-functions/i),
    ).toBeInTheDocument();
  });

  it('passa URL do openapi.json baseada em ENV.API_WORKER_FUNCTIONS_URL', async () => {
    const { AdminApiDocsPage } = await import('../AdminApiDocsPage');
    render(<AdminApiDocsPage />);

    expect(mockSwaggerProps).toHaveBeenCalledTimes(1);
    const props = mockSwaggerProps.mock.calls[0][0];
    expect(props.url).toBe('http://localhost:8080/api/docs/openapi.json');
  });

  it('requestInterceptor injeta o Bearer token do Firebase quando há sessão', async () => {
    mockGetIdToken.mockResolvedValue('mock-firebase-id-token');
    const { AdminApiDocsPage } = await import('../AdminApiDocsPage');
    render(<AdminApiDocsPage />);

    const props = mockSwaggerProps.mock.calls[0][0];
    const req = { headers: {} as Record<string, string>, url: 'http://x' };
    const result = await props.requestInterceptor(req);

    expect(mockGetIdToken).toHaveBeenCalled();
    expect(result.headers.Authorization).toBe('Bearer mock-firebase-id-token');
  });

  it('requestInterceptor não adiciona header quando token é null (sessão expirada)', async () => {
    mockGetIdToken.mockResolvedValue(null);
    const { AdminApiDocsPage } = await import('../AdminApiDocsPage');
    render(<AdminApiDocsPage />);

    const props = mockSwaggerProps.mock.calls[0][0];
    const req = { headers: {} as Record<string, string>, url: 'http://x' };
    const result = await props.requestInterceptor(req);

    expect(result.headers.Authorization).toBeUndefined();
  });

  it('habilita filter, tryItOut e docExpansion list', async () => {
    const { AdminApiDocsPage } = await import('../AdminApiDocsPage');
    render(<AdminApiDocsPage />);

    const props = mockSwaggerProps.mock.calls[0][0];
    expect(props.filter).toBe(true);
    expect(props.tryItOutEnabled).toBe(true);
    expect(props.docExpansion).toBe('list');
  });

  it('renderiza o container do swagger UI', async () => {
    const { AdminApiDocsPage } = await import('../AdminApiDocsPage');
    render(<AdminApiDocsPage />);

    await waitFor(() => {
      expect(screen.getByTestId('swagger-ui-container')).toBeInTheDocument();
      expect(screen.getByTestId('swagger-ui-mock')).toBeInTheDocument();
    });
  });
});
