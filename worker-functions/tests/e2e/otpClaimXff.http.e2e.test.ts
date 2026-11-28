/**
 * E1 (B2): o 1º item do X-Forwarded-For é escrito pelo cliente e NÃO escolhe o balde do limitador de claim/start.
 * 4 chamadas com 1º item diferente e ÚLTIMO igual: as `OTP_START_LIMIT` primeiras passam, a seguinte leva 429.
 */
import { fechar, limpar, montarApp, tokenDe, type AppOtp } from './helpers/otpHttpHarness';
import { readFileSync } from 'fs';
import { join } from 'path';

// `OTP_START_LIMIT` não é exportada por claimRoutes.ts (const de módulo): lida do código-fonte, nunca repetida aqui.
const OTP_START_LIMIT = Number(/const OTP_START_LIMIT = (\d+);/.exec(
  readFileSync(join(__dirname, '../../src/modules/auth/interfaces/routes/claimRoutes.ts'), 'utf8'),
)![1]);

describe('E1: X-Forwarded-For pelo último salto (claim/start)', () => {
  let app: AppOtp;
  beforeAll(async () => { app = await montarApp(); });
  beforeEach(async () => { await limpar(); });
  afterAll(async () => { await limpar(); await fechar(); });

  it('1º item diferente, último igual: a chamada OTP_START_LIMIT+1 responde 429 com retry-after', async () => {
    const statuses: number[] = [];
    let ultima: { body: any; headers: Record<string, string> } | null = null;
    for (let i = 1; i <= OTP_START_LIMIT + 1; i++) {
      const res = await app.http.post('/api/auth/claim/start')
        .set('X-Forwarded-For', `10.0.0.${i}, 203.0.113.9`)
        .set('Authorization', tokenDe('uid-teste-e1'))
        .send({ phone: '+5491100000000' });
      statuses.push(res.status);
      ultima = { body: res.body, headers: res.headers as Record<string, string> };
    }
    console.info('E1 statuses', JSON.stringify(statuses));
    expect(statuses.slice(0, OTP_START_LIMIT).every((s) => s !== 429)).toBe(true);
    expect(statuses[OTP_START_LIMIT]).toBe(429);
    expect(ultima!.body.success).toBe(false);
    expect(typeof ultima!.body.error).toBe('string');
    expect(ultima!.headers['retry-after']).toBeDefined();
  });
});
