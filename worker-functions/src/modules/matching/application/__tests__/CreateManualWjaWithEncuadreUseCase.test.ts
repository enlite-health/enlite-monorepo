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
