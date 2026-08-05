/**
 * ListWorkerApplicationsUseCase (D89 item 5)
 * 1. mapeia etapa interna → rótulo amigável es-AR
 * 2. etapa desconhecida → fallback "en proceso"
 * 3. sem postulações → lista vazia
 * 4. query filtra por worker_id e NÃO retorna dado de paciente
 */
import { ListWorkerApplicationsUseCase } from '../ListWorkerApplicationsUseCase';

describe('ListWorkerApplicationsUseCase', () => {
  const makePool = (rows: unknown[]) =>
    ({ query: jest.fn().mockResolvedValue({ rows }) }) as never;

  it('mapeia etapas pra rótulos amigáveis', async () => {
    const pool = makePool([
      { title: 'CASO 210-2079', stage: 'INITIATED', created_at: '2026-08-04T23:47:00Z' },
      { title: 'CASO 111-222', stage: 'QUALIFIED', created_at: '2026-08-01T10:00:00Z' },
      { title: 'CASO 333-444', stage: 'REJECTED', created_at: '2026-07-01T10:00:00Z' },
    ]);
    const out = await new ListWorkerApplicationsUseCase(pool).execute(
      'c6260232-b961-4440-bedc-0fdaee120da0',
    );
    expect(out.applications.map((a) => a.stage)).toEqual([
      'postulación recibida',
      'calificada — próximo paso: entrevista',
      'no avanzó esta vez',
    ]);
    expect(out.applications[0].caseTitle).toBe('CASO 210-2079');
  });

  it('etapa desconhecida cai no fallback', async () => {
    const pool = makePool([{ title: 'CASO X', stage: 'ALGO_NOVO', created_at: '2026-08-04' }]);
    const out = await new ListWorkerApplicationsUseCase(pool).execute('w1');
    expect(out.applications[0].stage).toBe('en proceso');
  });

  it('sem postulações → lista vazia', async () => {
    const out = await new ListWorkerApplicationsUseCase(makePool([])).execute('w1');
    expect(out.applications).toEqual([]);
  });

  it('query filtra por worker_id e só junta job_postings (sem patients)', async () => {
    const pool = makePool([]);
    await new ListWorkerApplicationsUseCase(pool).execute('w1');
    const [sql, params] = (pool as never as { query: jest.Mock }).query.mock.calls[0];
    expect(String(sql)).toContain('worker_job_applications');
    expect(String(sql)).not.toMatch(/patients/i);
    expect(params).toEqual(['w1']);
  });
});
