/**
 * MergeLegacyVacancyIntoServiceVacancyUseCase (spec 084 F3, grupo c / R19). Dublês dos repositórios e das peças reaproveitadas.
 * O que morre se desfizerem: a antiga é BAIXADA no mesmo passo (motivo CUTOFF) e NUNCA apagada; os filhos vão da antiga para a
 * vaga do serviço; conflito e pulo não escrevem nada. A prova com SQL real é o e2e `084-linha-de-corte`.
 */
const mockLock = jest.fn();
jest.mock('../recruitmentReadinessContext', () => ({
  ...jest.requireActual('../recruitmentReadinessContext'),
  lockRecruitmentContext: (...a: unknown[]) => mockLock(...a),
}));
jest.mock('../../../matching/application/ReconcileMergedWorkerApplications', () => ({
  ...jest.requireActual('../../../matching/application/ReconcileMergedWorkerApplications'),
  bypassRegisteredGuard: jest.fn(async () => undefined),
}));
const mockSnapshot = jest.fn();
jest.mock('../../../matching/interfaces/controllers/vacancyCrudAuditHelpers', () => ({
  lockLiveVacancySnapshot: (...a: unknown[]) => mockSnapshot(...a),
}));

import { MergeLegacyVacancyIntoServiceVacancyUseCase, type LegacyMergePair } from '../MergeLegacyVacancyIntoServiceVacancyUseCase';
import { FusionCountMismatchError } from '../FuseDraftIntoOfficialVacancyUseCase';
import { ServiceAlreadyRecruitingError } from '../recruitmentReadinessContext';
import { FUSION_COUNTED_TABLES, type ApplicationCollision, type FusionCounts } from '../../infrastructure/DraftFusionRepository';

const PAIR: LegacyMergePair = { patientId: 'p1', legacyId: 'old', targetId: 'svc-vaga' };
const client = { marker: 'client' };
const actor = { actorUserId: null, actorType: 'CLI' as const, actorLabel: 'linha-de-corte-vagas', traceId: null };

const counts = (over: Partial<Record<keyof FusionCounts, [number, number]>> = {}): FusionCounts =>
  Object.fromEntries(FUSION_COUNTED_TABLES.map((t) => [t, { draft: (over[t] ?? [0, 0])[0], official: (over[t] ?? [0, 0])[1] }])) as FusionCounts;
const coll = (w: string, targetStage: string | null, legacyStage: string | null): ApplicationCollision => ({
  draftApplicationId: `l-${w}`, officialApplicationId: `t-${w}`, workerId: w, officialStage: targetStage, draftStage: legacyStage,
});

const legacyRow = (o: Record<string, unknown> = {}) => ({ id: 'old', is_draft: false, contracted_service_id: null, patient_id: 'p1', status: 'SEARCHING', ...o });
const targetRow = (o: Record<string, unknown> = {}) => ({ id: 'svc-vaga', is_draft: true, contracted_service_id: 's1', patient_id: 'p1', status: 'PENDING_ACTIVATION', ...o });

function build(over: { collisions?: ApplicationCollision[]; after?: FusionCounts } = {}) {
  const calls: string[] = [];
  const repo = {
    countRows: jest.fn()
      .mockResolvedValueOnce(counts({ worker_job_applications: [3, 1], worker_job_application_stage_history: [5, 2], encuadres: [2, 0] }))
      .mockResolvedValueOnce(over.after ?? counts({ worker_job_applications: [0, 3], worker_job_application_stage_history: [0, 8], encuadres: [0, 2] })), // 5+2 da trilha + 1 por etapa adotada (trigger 169)
    listApplicationCollisions: jest.fn(async () => over.collisions ?? [coll('w1', 'INVITED', 'PRE_SCREENING')]),
    mergeCollidingApplication: jest.fn(async () => { calls.push('mergeApp'); }),
    mergeCollidingEncuadres: jest.fn(async () => 0),
    reparentToOfficial: jest.fn(async () => { calls.push('reparent'); }),
  };
  const cutoffRepo = {
    countBlockedApplications: jest.fn().mockResolvedValueOnce(2).mockResolvedValueOnce(0),
    moveBlockedApplications: jest.fn(async () => ({ moved: 2, left: 0 })),
  };
  const baja = { executeInTx: jest.fn(async () => { calls.push('baja'); return { ok: true as const, baixadas: [{ vacancyId: 'old', statusBefore: 'SEARCHING' }] }; }) };
  const audit = { logFieldChangesSafe: jest.fn(async () => { calls.push('audit'); }) };
  const uc = new MergeLegacyVacancyIntoServiceVacancyUseCase(repo as never, cutoffRepo as never, baja as never, audit as never, actor);
  return { uc, repo, cutoffRepo, baja, audit, calls };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockLock.mockRejectedValue(new ServiceAlreadyRecruitingError('svc-vaga'));
  mockSnapshot.mockImplementation(async (_c: unknown, id: string) => (id === 'old' ? legacyRow() : targetRow()));
});

describe('merge da vaga antiga na vaga do serviço', () => {
  it('feliz: move a antiga → serviço, baixa a antiga (CUTOFF) no mesmo passo e audita; NUNCA apaga', async () => {
    const t = build();
    const out = await t.uc.mergeInTx(client as never, PAIR);

    expect(out.status).toBe('MERGED');
    // direção: a ANTIGA é a origem ("draft" do repositório) e a vaga do SERVIÇO é o destino ("official")
    expect(t.repo.mergeCollidingApplication).toHaveBeenCalledWith(client, expect.anything(), 'old', 'svc-vaga', 'PRE_SCREENING');
    expect(t.repo.reparentToOfficial).toHaveBeenCalledWith(client, 'old', 'svc-vaga');
    expect(t.cutoffRepo.moveBlockedApplications).toHaveBeenCalledWith(client, 'old', 'svc-vaga');
    // baixa da antiga no mesmo passo, motivo CUTOFF, no MESMO client (mesma transação)
    expect(t.baja.executeInTx).toHaveBeenCalledWith(client, ['old'], 'CUTOFF', actor);
    expect(t.calls.indexOf('reparent')).toBeLessThan(t.calls.indexOf('baja'));
    expect(t.audit.logFieldChangesSafe).toHaveBeenCalledWith(client, expect.objectContaining({ jobPostingId: 'svc-vaga' }));
    if (out.status === 'MERGED') {
      expect(out.result.before.worker_job_applications).toEqual({ draft: 3, official: 1 });
      expect(out.result.after.worker_job_applications).toEqual({ draft: 0, official: 3 });
      expect(out.result.blockedBefore).toBe(2);
      expect(out.result.blockedAfter).toBe(0);
    }
  });

  it('etapa: o destino em entrada adota a da antiga; destino decidido + antiga em entrada mantém o destino', async () => {
    const t = build({ collisions: [coll('w1', 'INVITED', 'QUALIFIED'), coll('w2', 'SELECTED', 'INVITED')] });
    await t.uc.mergeInTx(client as never, PAIR).catch(() => undefined);
    const stages = t.repo.mergeCollidingApplication.mock.calls.map((c: unknown[]) => c[4]);
    expect(stages).toEqual(['QUALIFIED', null]);
  });

  it('CONFLITO (as duas decididas e diferentes): nada é escrito e a antiga NÃO é baixada', async () => {
    const t = build({ collisions: [coll('w1', 'SELECTED', 'REJECTED')] });
    const out = await t.uc.mergeInTx(client as never, PAIR);
    expect(out).toEqual({ status: 'CONFLICT', conflicts: [{ workerId: 'w1', officialStage: 'SELECTED', draftStage: 'REJECTED' }] });
    expect(t.repo.mergeCollidingApplication).not.toHaveBeenCalled();
    expect(t.baja.executeInTx).not.toHaveBeenCalled();
  });

  it('contagem que não fecha → FusionCountMismatchError (o chamador faz ROLLBACK) e a antiga não é baixada', async () => {
    const t = build({ after: counts({ worker_job_applications: [1, 3], worker_job_application_stage_history: [0, 8], encuadres: [0, 2] }) });
    await expect(t.uc.mergeInTx(client as never, PAIR)).rejects.toBeInstanceOf(FusionCountMismatchError);
    expect(t.baja.executeInTx).not.toHaveBeenCalled();
  });

  it.each([
    ['destino não é vaga de serviço', () => mockSnapshot.mockImplementation(async (_c: unknown, id: string) => (id === 'old' ? legacyRow() : targetRow({ contracted_service_id: null }))), 'TARGET_NOT_SERVICE_VACANCY'],
    ['antiga ganhou serviço', () => mockSnapshot.mockImplementation(async (_c: unknown, id: string) => (id === 'old' ? legacyRow({ contracted_service_id: 's9' }) : targetRow())), 'LEGACY_CHANGED'],
    ['antiga já não está aberta', () => mockSnapshot.mockImplementation(async (_c: unknown, id: string) => (id === 'old' ? legacyRow({ status: 'CLOSED' }) : targetRow())), 'LEGACY_CHANGED'],
    ['destino já baixado', () => mockSnapshot.mockImplementation(async (_c: unknown, id: string) => (id === 'old' ? legacyRow() : targetRow({ status: 'DE_BAJA' }))), 'TARGET_CHANGED'],
    ['destino de OUTRO paciente', () => mockSnapshot.mockImplementation(async (_c: unknown, id: string) => (id === 'old' ? legacyRow() : targetRow({ patient_id: 'p2' }))), 'DIFFERENT_PATIENT'],
  ])('pula sem escrever: %s', async (_label, arrange, reason) => {
    arrange();
    const t = build();
    const out = await t.uc.mergeInTx(client as never, PAIR);
    expect(out).toEqual({ status: 'SKIPPED', reason });
    expect(t.repo.reparentToOfficial).not.toHaveBeenCalled();
    expect(t.baja.executeInTx).not.toHaveBeenCalled();
  });

  it('a vaga viva do serviço NÃO é o destino escolhido → pula (nunca a um destino por chute)', async () => {
    mockLock.mockRejectedValue(new ServiceAlreadyRecruitingError('outra-vaga'));
    const t = build();
    expect(await t.uc.mergeInTx(client as never, PAIR)).toEqual({ status: 'SKIPPED', reason: 'TARGET_CHANGED' });
    expect(t.baja.executeInTx).not.toHaveBeenCalled();
  });

  it('baixa recusada → erro (o chamador desfaz tudo; nunca meio-merge)', async () => {
    const t = build();
    t.baja.executeInTx.mockResolvedValueOnce({ ok: false, refused: [{ vacancyId: 'old', code: 'VACANCY_HAS_SERVICE' }] } as never);
    await expect(t.uc.mergeInTx(client as never, PAIR)).rejects.toThrow('baixa da antiga recusada');
  });
});
