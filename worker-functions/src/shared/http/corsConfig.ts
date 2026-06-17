import cors, { CorsOptions } from 'cors';

/**
 * Origens permitidas de CORS = defaults + CORS_ALLOWED_ORIGINS (CSV por ambiente).
 *
 * As origens via env evitam depender de URLs run.app hardcoded, que envelhecem quando o
 * serviço Cloud Run é recriado — foi exatamente o que quebrou o frontend de staging
 * (o run.app atual não estava na lista, então todo request cross-origin caía em CORS).
 */
const defaultAllowedOrigins = [
  'https://app.enlite.health',
  'https://n8n.enlite.health',
  'https://enlite-n8n-121472682203.southamerica-west1.run.app',
  'https://enlite-frontend-121472682203.southamerica-west1.run.app',
  'https://enlite-frontend-vtf37eainq-tl.a.run.app', // staging frontend (Cloud Run)
  'https://enlite-frontend-byh3gvl5yq-tl.a.run.app', // prod frontend (Cloud Run)
  'http://localhost:3000', // Local development
  'http://localhost:5173', // Vite default port
];

export function getAllowedOrigins(): string[] {
  const fromEnv = (process.env.CORS_ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  return [...defaultAllowedOrigins, ...fromEnv];
}

export function buildCorsOptions(): CorsOptions {
  const allowedOrigins = getAllowedOrigins();
  return {
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error('Not allowed by CORS'));
      }
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Partner-Key'],
  };
}

export function corsMiddleware() {
  return cors(buildCorsOptions());
}
