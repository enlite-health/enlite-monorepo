/**
 * CORS_ALLOWED_ORIGINS é lista por env — e o deploy-cloudrun quebra listas com
 * vírgula (achado 14-16/08). Este teste trava que `;` e `,` funcionam iguais e
 * que o resultado é o que o middleware de fato usa para aceitar/recusar origin.
 */
import { buildCorsOptions, corsMiddleware, getAllowedOrigins } from '../corsConfig';

const ORIGINAL = process.env.CORS_ALLOWED_ORIGINS;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.CORS_ALLOWED_ORIGINS;
  else process.env.CORS_ALLOWED_ORIGINS = ORIGINAL;
});

type OriginFn = (origin: string | undefined, cb: (err: Error | null, allow?: boolean) => void) => void;
const decide = (origin: string | undefined) =>
  new Promise<boolean>((resolve) =>
    (buildCorsOptions().origin as OriginFn)(origin, (err, allow) => resolve(!err && allow === true)),
  );

describe('corsConfig', () => {
  it('sem env: só os defaults (prod/stg/local), nada vindo de env', () => {
    delete process.env.CORS_ALLOWED_ORIGINS;
    const origins = getAllowedOrigins();
    expect(origins).toContain('https://app.enlite.health');
    expect(origins.slice(-2)).toEqual(['http://localhost:3000', 'http://localhost:5173']);
  });

  it.each([
    ['https://a.enlite.health;https://b.enlite.health'],
    ['https://a.enlite.health,https://b.enlite.health'],
    ['https://a.enlite.health https://b.enlite.health'],
  ])('lista por env com qualquer separador (%s) entra depois dos defaults', (raw) => {
    process.env.CORS_ALLOWED_ORIGINS = raw;
    expect(getAllowedOrigins().slice(-2)).toEqual(['https://a.enlite.health', 'https://b.enlite.health']);
  });

  it('origin permitida passa, desconhecida é recusada, ausente (server-to-server) passa', async () => {
    process.env.CORS_ALLOWED_ORIGINS = 'https://qas.enlite.health';
    await expect(decide('https://qas.enlite.health')).resolves.toBe(true);
    await expect(decide('https://evil.example')).resolves.toBe(false);
    await expect(decide(undefined)).resolves.toBe(true);
  });

  it('opções fixas: credentials + métodos + headers (contrato do frontend)', () => {
    const o = buildCorsOptions();
    expect(o.credentials).toBe(true);
    expect(o.methods).toEqual(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
    expect(o.allowedHeaders).toEqual(['Content-Type', 'Authorization', 'X-Partner-Key']);
  });

  it('corsMiddleware devolve um handler express', () => {
    expect(typeof corsMiddleware()).toBe('function');
  });
});
