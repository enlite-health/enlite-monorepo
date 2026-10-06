/**
 * CreateManualWjaWithEncuadreUseCase.test.ts
 *
 * Extraído de WorkerApplicationsController.trackChannel — os testes de
 * comportamento do endpoint (WorkerApplicationsController.test.ts) continuam
 * cobrindo o caminho completo via mock de DatabaseConnection; este arquivo
 * cobre o use case isoladamente (params → SQL exato produzido).
 */

import crypto from 'crypto';
import { CreateManualWjaWithEncuadreUseCase } from '../CreateManualWjaWithEncuadreUseCase';

describe('CreateManualWjaWithEncuadreUseCase', () => {
  function makeDb() {
    const query = jest.fn();
    return { query } as unknown as { query: jest.Mock };
  }

  it('faz upsert de WJA com source=manual, stage=INVITED, RETURNING id', async () => {
    const db = makeDb();
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'wja-1' }] }) // WJA upsert
      .mockResolvedValueOnce({ rows: [] }); // encuadre insert

    const useCase = new CreateManualWjaWithEncuadreUseCase();
    const result = await useCase.execute(db as never, {
      workerId: 'w-1',
      jobPostingId: 'jp-1',
      acquisitionChannel: 'facebook',
    });

    expect(result).toEqual({ wjaId: 'wja-1' });

    const wjaCall = db.query.mock.calls[0];
    expect(wjaCall[0]).toContain('worker_job_applications');
    expect(wjaCall[0]).toContain("'INVITED'");
    expect(wjaCall[0]).toContain('acquisition_channel IS NULL');
    expect(wjaCall[0]).toContain('RETURNING id');
    expect(wjaCall[1]).toEqual(['w-1', 'jp-1', 'facebook']);
  });

  it('M6/M6a (D474): o ON CONFLICT só vira source=manual para a linha pré-Iniciado; o resto mantém o source', async () => {
    const db = makeDb();
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'wja-1', promoted: false, previous_source: null }] })
      .mockResolvedValueOnce({ rows: [] });

    await new CreateManualWjaWithEncuadreUseCase().execute(db as never, {
      workerId: 'w-1', jobPostingId: 'jp-1', acquisitionChannel: 'facebook',
    });

    const sql: string = db.query.mock.calls[0][0];
    expect(sql).toContain(
      "source = CASE\n             WHEN (worker_job_applications.application_funnel_stage = 'INVITED' AND worker_job_applications.source IS DISTINCT FROM 'manual') THEN 'manual'\n             ELSE worker_job_applications.source",
    );
    // nunca toca a etapa de uma linha existente
    expect(sql).not.toMatch(/application_funnel_stage\s*=\s*EXCLUDED/);
    // sem promoção → nada no histórico (só WJA upsert + encuadre)
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  it('M6: quando a linha pré-Iniciado é promovida grava UMA linha no histórico (field_name=source, old→manual)', async () => {
    const db = makeDb();
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'wja-9', promoted: true, previous_source: 'system' }] })
      .mockResolvedValueOnce({ rows: [] }) // histórico
      .mockResolvedValueOnce({ rows: [] }); // encuadre

    const result = await new CreateManualWjaWithEncuadreUseCase().execute(db as never, {
      workerId: 'w-1', jobPostingId: 'jp-1', acquisitionChannel: 'facebook',
    });

    expect(result).toEqual({ wjaId: 'wja-9' });
    const [histSql, histParams] = db.query.mock.calls[1];
    expect(histSql).toContain('INSERT INTO worker_job_application_stage_history');
    expect(histSql).toContain("'source'");
    expect(histSql).toContain("current_setting('app.current_uid', true)");
    expect(histParams).toEqual(['wja-9', 'system']);
    expect(db.query.mock.calls[2][0]).toContain('INSERT INTO encuadres');
  });

  it('cria encuadre com dedup_hash determinístico e NOT EXISTS guard', async () => {
    const db = makeDb();
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'wja-1' }] })
      .mockResolvedValueOnce({ rows: [] });

    const useCase = new CreateManualWjaWithEncuadreUseCase();
    await useCase.execute(db as never, {
      workerId: 'w-1',
      jobPostingId: 'jp-1',
      acquisitionChannel: 'instagram',
      workerName: 'María García',
      workerPhone: '+5491100000',
    });

    const encuadreCall = db.query.mock.calls[1];
    expect(encuadreCall[0]).toContain('INSERT INTO encuadres');
    expect(encuadreCall[0]).toContain('NOT EXISTS');
    expect(encuadreCall[0]).toContain('ON CONFLICT (worker_id, job_posting_id) DO NOTHING');

    const expectedHash = crypto.createHash('md5').update('social-link|w-1|jp-1').digest('hex');
    // $1=workerId, $2=jobPostingId, $3=dedupHash, $4=name, $5=phone, $6=channel
    expect(encuadreCall[1]).toEqual(['w-1', 'jp-1', expectedHash, 'María García', '+5491100000', 'instagram']);
  });

  it('usa string vazia como fallback quando workerName/workerPhone omitidos', async () => {
    const db = makeDb();
    db.query
      .mockResolvedValueOnce({ rows: [{ id: 'wja-2' }] })
      .mockResolvedValueOnce({ rows: [] });

    const useCase = new CreateManualWjaWithEncuadreUseCase();
    await useCase.execute(db as never, {
      workerId: 'w-2',
      jobPostingId: 'jp-2',
      acquisitionChannel: null,
    });

    const encuadreCall = db.query.mock.calls[1];
    expect(encuadreCall[1][3]).toBe('');
    expect(encuadreCall[1][4]).toBe('');
    expect(encuadreCall[1][5]).toBeNull();
  });

  it('retorna wjaId=null quando a query não retorna linha (defensivo)', async () => {
    const db = makeDb();
    db.query
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    const useCase = new CreateManualWjaWithEncuadreUseCase();
    const result = await useCase.execute(db as never, {
      workerId: 'w-3',
      jobPostingId: 'jp-3',
      acquisitionChannel: 'site',
    });

    expect(result).toEqual({ wjaId: null });
  });
});
