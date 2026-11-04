/**
 * VacancyTalentumPauseService (spec 084 F4/R13/P7). O cliente Talentum é SEMPRE dublê: nenhuma chamada sai para
 * api.v2.talentum.chat. O que se prova: 403 → lista manual (nunca silêncio, nunca lança), sucesso → PAUSED,
 * e que a classe NÃO tem caminho de DELETE.
 */
jest.mock('@shared/logging', () => ({ reportError: jest.fn(), loggingAls: { getStore: () => undefined } }));
import { reportError } from '@shared/logging';
import { VacancyTalentumPauseService } from '../VacancyTalentumPauseService';

function setup(projects: Record<string, string | null>, client: Record<string, jest.Mock>) {
  const writes: Array<{ id: string; state: unknown }> = [];
  const db = {
    query: jest.fn(async (sql: string, params: unknown[]) => {
      if (/^\s*SELECT id, talentum_project_id/.test(sql)) {
        const ids = params[0] as string[];
        return { rows: ids.map((id) => ({ id, talentum_project_id: projects[id] ?? null })) };
      }
      if (/UPDATE job_postings SET talentum_pause_state/.test(sql)) {
        writes.push({ id: params[0] as string, state: params[1] });
        return { rows: [] };
      }
      throw new Error(`SQL inesperado: ${sql}`);
    }),
  };
  const factory = jest.fn(async () => client as never);
  return { svc: new VacancyTalentumPauseService(db as never, factory), writes, db, factory };
}

describe('VacancyTalentumPauseService', () => {
  beforeEach(() => jest.clearAllMocks());

  it('pausa por API e grava PAUSED; vaga sem projeto não chama o Talentum', async () => {
    const client = { pauseProject: jest.fn(async () => undefined), resumeProject: jest.fn() };
    const { svc, writes } = setup({ v1: 'proj-1', v2: null }, client);
    const out = await svc.pause(['v1', 'v2']);
    expect(client.pauseProject).toHaveBeenCalledTimes(1);
    expect(client.pauseProject).toHaveBeenCalledWith('proj-1');
    expect(writes).toEqual([{ id: 'v1', state: 'PAUSED' }]);
    expect(out).toEqual(expect.arrayContaining([
      { vacancyId: 'v1', state: 'PAUSED', attempted: true },
      { vacancyId: 'v2', state: null, attempted: false },
    ]));
  });

  it('403 do Talentum: a vaga entra na lista manual (MANUAL_PAUSE), o erro é reportado e NADA lança', async () => {
    const client = { pauseProject: jest.fn(async () => { throw new Error('[TalentumApiClient] PUT /projects/p/pause — HTTP 403: forbidden'); }), resumeProject: jest.fn() };
    const { svc, writes } = setup({ v1: 'proj-1' }, client);
    await expect(svc.pause(['v1'])).resolves.toEqual([{ vacancyId: 'v1', state: 'MANUAL_PAUSE', attempted: true }]);
    expect(writes).toEqual([{ id: 'v1', state: 'MANUAL_PAUSE' }]);
    expect(reportError).toHaveBeenCalledTimes(1); // nunca em silêncio
  });

  it('cliente que nem inicializa (credencial/rede): MANUAL_PAUSE + reportError, sem lançar', async () => {
    const db = { query: jest.fn(async (sql: string) => (/SELECT id/.test(sql) ? { rows: [{ id: 'v1', talentum_project_id: 'p1' }] } : { rows: [] })) };
    const svc = new VacancyTalentumPauseService(db as never, async () => { throw new Error('sem credencial'); });
    await expect(svc.pause(['v1'])).resolves.toEqual([{ vacancyId: 'v1', state: 'MANUAL_PAUSE', attempted: true }]);
    expect(reportError).toHaveBeenCalled();
  });

  it('retomar: sucesso limpa o estado; 400 (não estava pausado) também; 403 vai para MANUAL_RESUME', async () => {
    const ok = { pauseProject: jest.fn(), resumeProject: jest.fn(async () => undefined) };
    const a = setup({ v1: 'p1' }, ok);
    expect(await a.svc.resume(['v1'])).toEqual([{ vacancyId: 'v1', state: null, attempted: true }]);
    expect(a.writes).toEqual([{ id: 'v1', state: null }]);

    const notPaused = { pauseProject: jest.fn(), resumeProject: jest.fn(async () => { throw new Error('PUT /projects/p/resume — HTTP 400: not paused'); }) };
    const b = setup({ v1: 'p1' }, notPaused);
    expect(await b.svc.resume(['v1'])).toEqual([{ vacancyId: 'v1', state: null, attempted: true }]);
    expect(reportError).not.toHaveBeenCalled();

    const forbidden = { pauseProject: jest.fn(), resumeProject: jest.fn(async () => { throw new Error('PUT /projects/p/resume — HTTP 403: nope'); }) };
    const c = setup({ v1: 'p1' }, forbidden);
    expect(await c.svc.resume(['v1'])).toEqual([{ vacancyId: 'v1', state: 'MANUAL_RESUME', attempted: true }]);
    expect(reportError).toHaveBeenCalledTimes(1);
  });

  it('P7/R2: o cliente que o serviço enxerga NÃO tem como apagar — só pause/resume são chamados', async () => {
    const client = { pauseProject: jest.fn(async () => undefined), resumeProject: jest.fn(async () => undefined), deletePrescreening: jest.fn() };
    const { svc } = setup({ v1: 'p1' }, client);
    await svc.pause(['v1']);
    await svc.resume(['v1']);
    expect(client.deletePrescreening).not.toHaveBeenCalled();
  });

  it('lista vazia: não toca banco nem Talentum', async () => {
    const client = { pauseProject: jest.fn(), resumeProject: jest.fn() };
    const { svc, db, factory } = setup({}, client);
    expect(await svc.pause([])).toEqual([]);
    expect(db.query).not.toHaveBeenCalled();
    expect(factory).not.toHaveBeenCalled();
  });
});
