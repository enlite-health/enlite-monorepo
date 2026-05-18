import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import SwaggerUI from 'swagger-ui-react';
import 'swagger-ui-react/swagger-ui.css';

import { ENV } from '@infrastructure/config/env';
import { FirebaseAuthService } from '@infrastructure/services/FirebaseAuthService';
import { PageContainer } from '@presentation/components/atoms/PageContainer';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';

export function AdminApiDocsPage(): JSX.Element {
  const { t } = useTranslation();

  // Swagger UI lê o interceptor 1x no mount. O interceptor pega o token
  // fresco a cada request (Firebase rotaciona em 1h).
  const authService = useMemo(() => new FirebaseAuthService(), []);
  const specUrl = `${ENV.API_WORKER_FUNCTIONS_URL}/api/docs/openapi.json`;

  // Swagger UI tipa Request como `{ [k: string]: any }` — usamos esse shape solto.
  const requestInterceptor = useMemo(
    () => async (req: Record<string, unknown>) => {
      const token = await authService.getIdToken();
      if (token) {
        const headers = (req.headers as Record<string, string> | undefined) ?? {};
        headers.Authorization = `Bearer ${token}`;
        req.headers = headers;
      }
      return req;
    },
    [authService],
  );

  return (
    <PageContainer>
      <div className="mb-4">
        <Heading level={1}>{t('admin.apiDocs.title', 'Documentación de la API')}</Heading>
        <Text size="base" className="text-gray-600 mt-1">
          {t(
            'admin.apiDocs.subtitle',
            'Referencia completa del worker-functions. Todas las llamadas usan tu token de staff actual automáticamente.',
          )}
        </Text>
      </div>

      <div className="bg-white rounded shadow" data-testid="swagger-ui-container">
        <SwaggerUI
          url={specUrl}
          requestInterceptor={requestInterceptor}
          docExpansion="list"
          defaultModelsExpandDepth={1}
          tryItOutEnabled={true}
          filter={true}
          persistAuthorization={false}
        />
      </div>
    </PageContainer>
  );
}

export default AdminApiDocsPage;
