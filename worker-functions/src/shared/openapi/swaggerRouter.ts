import { Router, type Request, type Response, type RequestHandler } from 'express';
import swaggerUi from 'swagger-ui-express';
import { buildOpenApiDocument } from './document';
import { enumerateExpressRoutes, expressPathToOpenApi } from './routeEnumerator';

export interface SwaggerRouterOptions {
  /**
   * Middlewares aplicados antes de servir a UI/spec.
   * Em produção use `[authMiddleware.requireStaff()]` para gatear acesso.
   * Em dev/test pode passar `[]` para acesso público.
   */
  guards?: RequestHandler[];
}

const SWAGGER_UI_OPTIONS: swaggerUi.SwaggerUiOptions = {
  customSiteTitle: 'Enlite worker-functions · API docs',
  customCss: [
    '.topbar { display: none; }',
    '.swagger-ui .info { margin: 16px 0 24px; }',
    '.swagger-ui .info hgroup.main h2.title { font-size: 28px; }',
    '.swagger-ui .opblock-tag { font-size: 18px; }',
    '.swagger-ui .opblock-tag small { color: #555; font-weight: normal; }',
    '.swagger-ui .opblock .opblock-summary-description { font-weight: 500; color: #333; }',
  ].join('\n'),
  swaggerOptions: {
    docExpansion: 'list',
    defaultModelsExpandDepth: 1,
    defaultModelExpandDepth: 2,
    displayRequestDuration: true,
    filter: true,
    persistAuthorization: true,
    tagsSorter: 'alpha',
    operationsSorter: 'alpha',
    tryItOutEnabled: true,
  },
};

export function createSwaggerRouter(options: SwaggerRouterOptions = {}): Router {
  const router = Router();
  const guards = options.guards ?? [];
  const document = buildOpenApiDocument();

  router.get('/openapi.json', ...guards, (_req: Request, res: Response) => {
    res.status(200).json(document);
  });

  // Debug endpoint used by the Playwright coverage test: enumera as rotas
  // Express realmente registradas no app. Mesma gate da UI — não vaza nada
  // em prod.
  router.get('/_routes', ...guards, (req: Request, res: Response) => {
    const routes = enumerateExpressRoutes(req.app).map((r) => ({
      method: r.method,
      expressPath: r.path,
      openApiPath: expressPathToOpenApi(r.path),
    }));
    res.status(200).json({ count: routes.length, routes });
  });

  router.use('/', ...guards, swaggerUi.serveFiles(document, SWAGGER_UI_OPTIONS));
  router.get('/', ...guards, swaggerUi.setup(document, SWAGGER_UI_OPTIONS));

  return router;
}

/**
 * Decide se a UI deve ser pública ou exigir staff baseado em env.
 * Em `production` SEM `OPENAPI_PUBLIC=true` → exige staff.
 * Em qualquer outro caso → público (dev, test, staging com flag).
 */
export function shouldGateDocs(): boolean {
  if (process.env.OPENAPI_PUBLIC === 'true') return false;
  return process.env.NODE_ENV === 'production';
}
