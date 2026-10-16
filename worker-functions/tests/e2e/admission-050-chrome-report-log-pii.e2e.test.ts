/**
 * spec 050 (gate do #680, Item B) — o log de ERRO da rota do relatório do Chrome não pode ecoar PII.
 *
 * `ChromeReportInternalController` chama `reportError(err)`. Um erro de constraint do Postgres carrega `detail` com a LINHA
 * ("Failing row contains (...)"), e a tabela `admission_chrome_reports` tem `host_email`. Regra dura: PII nunca vai a log.
 *
 * Medição com Postgres REAL: a escrita do relatório é forçada a violar a CHECK de `state` com um e-mail SINTÉTICO reconhecível;
 * a saída do logger GLOBAL (o que `reportError` usa) é capturada serializada pelo pino (mesmas opções do `Logger.ts`: serializer
 * de `err` padrão), e o e-mail NÃO pode aparecer em lugar nenhum dela.
 *
 * Controles (sem eles um verde não mede nada):
 *  - o erro do driver CARREGA o e-mail em `detail` (a fixture realmente tem PII para vazar);
 *  - o `code` (SQLSTATE) e o nome da constraint ESTÃO na saída (a captura enxerga o log do controller).
 */
import { Pool } from 'pg';
import pino from 'pino';
import { Writable } from 'stream';
import type { Request, Response } from 'express';
import { logger } from '../../src/shared/logging';
import { ChromeReportInternalController } from '../../src/modules/matching/interfaces/controllers/ChromeReportInternalController';
import type { ChromeReportJob } from '../../src/modules/matching/application/ChromeReportJob';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const EMAIL_SINTETICO = `pii.sentinela.${Date.now().toString(36)}@example.test`;

describe('F15 gate — log de erro do relatório do Chrome sem PII (Postgres real)', () => {
  let pool: Pool;
  const saida: string[] = [];
  let espiao: jest.SpyInstance;

  beforeAll(() => {
    pool = new Pool({ connectionString: DATABASE_URL });
    // Mesmas opções que importam do `Logger.ts` (messageKey + serializer padrão de `err`), escrevendo num array em vez do stdout.
    const capturador = pino({ messageKey: 'message' }, new Writable({ write(chunk, _enc, cb) { saida.push(String(chunk)); cb(); } }));
    espiao = jest.spyOn(logger, 'error').mockImplementation(((...args: unknown[]) => (capturador.error as (...a: unknown[]) => void)(...args)) as never);
  });

  afterAll(async () => {
    espiao.mockRestore();
    await pool.end();
  });

  /** Job cuja escrita viola a CHECK de `state` de verdade (erro REAL do driver `pg`, com `detail`). */
  const jobQueViolaConstraint = {
    run: async () => {
      await pool.query(`INSERT INTO admission_chrome_reports (host_email, state) VALUES ($1, 'estado_invalido')`, [EMAIL_SINTETICO]);
      return {} as never;
    },
  } as unknown as ChromeReportJob;

  it('controle: o erro do Postgres carrega o e-mail em `detail` (a fixture tem PII para vazar)', async () => {
    const err = await pool
      .query(`INSERT INTO admission_chrome_reports (host_email, state) VALUES ($1, 'estado_invalido')`, [EMAIL_SINTETICO])
      .then(() => null, (e: unknown) => e as { code?: string; detail?: string; constraint?: string });
    expect(err?.code).toBe('23514');
    expect(err?.detail).toContain(EMAIL_SINTETICO);
    expect(err?.constraint).toBeTruthy();
  });

  it('erro de constraint na escrita: responde 500 e o log NÃO contém o e-mail; contém o code e a constraint', async () => {
    saida.length = 0;
    let status = 0;
    const res = { status(s: number) { status = s; return this; }, json() { return this; } } as unknown as Response;

    await new ChromeReportInternalController(jobQueViolaConstraint).handle({} as Request, res);

    const log = saida.join('');
    expect(status).toBe(500);
    // Controle positivo: a captura enxerga o log deste controller (senão "não contém" seria ausência de medição).
    expect(log).toContain('ChromeReportInternalController');
    expect(log).toContain('23514');
    expect(log).toContain('admission_chrome_reports_state_check');
    // O que importa: nenhuma forma do e-mail (nem o local-part, que o `detail` e o `Failing row` também ecoariam).
    expect(log).not.toContain(EMAIL_SINTETICO);
    expect(log).not.toContain('pii.sentinela');
    expect(log).not.toContain('Failing row');
  });
});
