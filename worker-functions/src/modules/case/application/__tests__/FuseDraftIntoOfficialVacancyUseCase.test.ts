/**
 * FuseDraftIntoOfficialVacancyUseCase — dublês dos repositórios e das peças reaproveitadas (lock, guard, delete, vínculo).
 * O runner imita `withActorContext`: exceção dentro da fn = ROLLBACK. A prova com SQL real é o e2e e o ensaio na réplica.
 */
const mockLock = jest.fn();
jest.mock('../recruitmentReadinessContext', () => ({
  ...jest.requireActual('../recruitmentReadinessContext'),
  lockRecruitmentContext: (...a: unknown[]) => mockLock(...a),
}));
const mockBypass = jest.fn(async () => undefined);
jest.mock('../../../matching/application/ReconcileMergedWorkerApplications', () => ({
  ...jest.requireActual('../../../matching/application/ReconcileMergedWorkerApplications'),
  bypassRegisteredGuard: (...a: unknown[]) => (mockBypass as jest.Mock)(...a),
}));
const mockVigente = jest.fn(async () => 0);
jest.mock('../../infrastructure/VacancyAllocationProbe', () => ({
  countVigenteForVacancy: (...a: unknown[]) => (mockVigente as jest.Mock)(...a),
}));
const mockSnapshot = jest.fn();
const mockSoftDelete = jest.fn(async () => true);
const mockAuditDeleted = jest.fn(async () => undefined);
jest.mock('../../../matching/interfaces/controllers/vacancyCrudAuditHelpers', () => ({
  lockLiveVacancySnapshot: (...a: unknown[]) => mockSnapshot(...a),
  softDeleteVacancyRow: (...a: unknown[]) => (mockSoftDelete as jest.Mock)(...a),
  auditVacancyDeleted: (...a: unknown[]) => (mockAuditDeleted as jest.Mock)(...a),
}));

import {
  FuseDraftIntoOfficialVacancyUseCase,
  FusionCountMismatchError,
  type FusionPair,
} from '../FuseDraftIntoOfficialVacancyUseCase';
import {
  PatientNotFoundForRecruitmentError,
  ServiceAlreadyRecruitingError,
  ServiceNotFoundForRecruitmentError,
} from '../recruitmentReadinessContext';
import { LinkBlockedError, VacancyNotLinkableError } from '../LinkExistingVacancyUseCase';
import { FUSION_COUNTED_TABLES, type ApplicationCollision, type FusionCounts } from '../../infrastructure/DraftFusionRepository';

const PAIR: FusionPair = { patientId: 'p1', draftId: 'd1', officialId: 'o1', serviceId: 's1' };
const client = { marker: 'client' };
const actor = { actorUserId: null, actorType: 'CLI' as const, actorLabel: 'fusao-rascunho-oficial', traceId: null };

function counts(over: Partial<Record<keyof FusionCounts, [number, number]>> = {}): FusionCounts {
  return Object.fromEntries(
    FUSION_COUNTED_TABLES.map((t) => {
      const [draft, official] = over[t] ?? [0, 0];
      return [t, { draft, official }];
    }),
  ) as FusionCounts;
}

const coll = (worker: string, officialStage: string | null, draftStage: string | null): ApplicationCollision => ({
  draftApplicationId: `dw-${worker}`,
  officialApplicationId: `ow-${worker}`,
  workerId: worker,
  officialStage,
  draftStage,
});

const draftRow = (over: Record<string, unknown> = {}) => ({
  id: 'd1', is_draft: true, contracted_service_id: 's1', patient_id: 'p1', status: 'PENDING_ACTIVATION', ...over,
});
const officialRow = (over: Record<string, unknown> = {}) => ({
  id: 'o1', is_draft: false, contracted_service_id: null, patient_id: 'p1', status: 'SEARCHING', ...over,
});

function build(opts: { now?: () => Date; actor?: typeof actor | (Omit<typeof actor, 'traceId'>) } = {}) {
  const tx: string[] = [];
  const repo = {
    patientVacancyShape: jest.fn(async () => ({ openLegacy: 1, liveDrafts: 1 })),
    unhandledReferences: jest.fn(async (): Promise<string[]> => []),
    countRows: jest
      .fn()
      // antes: 2 postulações no rascunho (1 colide), 3 na oficial; trilha 4+5; 1 encuadre colidindo
      .mockResolvedValueOnce(counts({
        worker_job_applications: [2, 3], worker_job_application_stage_history: [4, 5],
        encuadres: [1, 3], talentum_prescreenings: [2, 1], funnel_stage_message_log: [1, 0],
      }))
      .mockResolvedValueOnce(counts({
        worker_job_applications: [0, 4], worker_job_application_stage_history: [0, 10],
        encuadres: [0, 3], talentum_prescreenings: [0, 3], funnel_stage_message_log: [0, 1],
      })),
    listApplicationCollisions: jest.fn(async (): Promise<ApplicationCollision[]> => [coll('w1', 'INVITED', 'QUALIFIED')]),
    mergeCollidingApplication: jest.fn(async () => { tx.push('mergeApp'); }),
    mergeCollidingEncuadres: jest.fn(async () => { tx.push('mergeEnc'); return 1; }),
    reparentToOfficial: jest.fn(async () => { tx.push('reparent'); }),
    readServiceLiveAddress: jest.fn(async (): Promise<string | null> => 'addr-s'),
    alignVacancyAddress: jest.fn(async () => { tx.push('align'); }),
  };
  const linkRepo = { readVacancyForLink: jest.fn(async (): Promise<unknown> => ({ patient_address_id: 'addr-s' })) };
  const audit = { logFieldChangesSafe: jest.fn(async () => { tx.push('audit'); }) };
  const confirm = jest.fn(async () => { tx.push('confirm'); return { vacancyId: 'o1', serviceId: 's1', fedFields: [] }; });
  const linkFor = jest.fn(() => ({ confirm }));
  const runner = jest.fn(async (fn: (c: unknown) => Promise<unknown>) => {
    tx.push('BEGIN');
    try {
      const r = await fn(client);
      tx.push('COMMIT');
      return r;
    } catch (e) {
      tx.push('ROLLBACK');
      throw e;
    }
  });
  const uc = new FuseDraftIntoOfficialVacancyUseCase(
    repo as never, linkRepo as never, audit as never, linkFor as never, runner as never,
    (opts.actor ?? actor) as never, ...(opts.now ? [opts.now] : []),
  );
  return { uc, repo, linkRepo, audit, confirm, linkFor, tx };
}

const noWrites = (t: ReturnType<typeof build>) => {
  expect(mockSoftDelete).not.toHaveBeenCalled();
  expect(t.confirm).not.toHaveBeenCalled();
  expect(t.repo.mergeCollidingApplication).not.toHaveBeenCalled();
  expect(t.repo.reparentToOfficial).not.toHaveBeenCalled();
  expect(t.audit.logFieldChangesSafe).not.toHaveBeenCalled();
};

beforeEach(() => {
  jest.clearAllMocks();
  mockLock.mockRejectedValue(new ServiceAlreadyRecruitingError('d1'));
  mockSnapshot.mockImplementation(async (_c: unknown, id: string) => (id === 'd1' ? draftRow() : officialRow()));
  mockSoftDelete.mockResolvedValue(true);
  mockVigente.mockResolvedValue(0);
});

describe('fuse — caminho feliz', () => {
  it('apply: lock → guard → delete do rascunho → vínculo → Kanban → contagem → auditoria; COMMIT', async () => {
    const t = build({ now: () => new Date('2026-11-03T12:00:00Z') });
    const out = await t.uc.fuse(PAIR, { apply: true });

    expect(out).toEqual({
      status: 'FUSED',
      committed: true,
      result: expect.objectContaining({
        merged: { worker_job_applications: 1, encuadres: 1 },
        collisionStages: { QUALIFIED: 1 },
        addressAligned: false,
        vigentesNoServico: 0,
      }),
    });
    expect(mockLock).toHaveBeenCalledWith(client, 'p1', 's1');
    expect(mockBypass).toHaveBeenCalledWith(client);
    expect(mockVigente).toHaveBeenCalledWith(client, 'd1', new Date('2026-11-03T12:00:00Z'));
    expect(mockSoftDelete).toHaveBeenCalledWith(client, 'd1');
    expect(mockAuditDeleted).toHaveBeenCalledWith(client, 'd1', draftRow(), actor);
    expect(t.linkFor).toHaveBeenCalledWith(client);
    expect(t.confirm).toHaveBeenCalledWith('p1', 's1', 'o1', actor);
    // regra do Kanban: oficial INVITED adota QUALIFIED do rascunho
    expect(t.repo.mergeCollidingApplication).toHaveBeenCalledWith(client, coll('w1', 'INVITED', 'QUALIFIED'), 'd1', 'o1', 'QUALIFIED');
    expect(t.tx).toEqual(['BEGIN', 'confirm', 'mergeApp', 'mergeEnc', 'reparent', 'audit', 'COMMIT']);
    expect(t.audit.logFieldChangesSafe).toHaveBeenCalledWith(client, expect.objectContaining({
      jobPostingId: 'o1',
      actorType: 'CLI',
      actorLabel: 'fusao-rascunho-oficial',
      actorUserId: null,
      traceId: null,
      fields: [
        { field: 'fusao_rascunho', before: 'd1', after: 'o1' },
        expect.objectContaining({ field: 'fusao_rascunho_contagens' }),
      ],
    }));
  });

  it('dry-run: executa tudo e dá ROLLBACK, devolvendo o mesmo desfecho com committed=false', async () => {
    const t = build();
    const out = await t.uc.fuse(PAIR, { apply: false });
    expect(out.status).toBe('FUSED');
    expect(out.status === 'FUSED' && out.committed).toBe(false);
    expect(t.tx[t.tx.length - 1]).toBe('ROLLBACK');
    expect(t.audit.logFieldChangesSafe).toHaveBeenCalled();
    expect(mockVigente).toHaveBeenCalledWith(client, 'd1', expect.any(Date));
  });

  it('colisão KEEP sem etapa na oficial (rascunho sem etapa) → stage null, contada como "(sem etapa)"', async () => {
    const t = build();
    t.repo.listApplicationCollisions.mockResolvedValueOnce([coll('w1', null, null)]);
    t.repo.countRows.mockReset()
      .mockResolvedValueOnce(counts({ worker_job_applications: [1, 1] }))
      .mockResolvedValueOnce(counts({ worker_job_applications: [0, 1] }));
    t.repo.mergeCollidingEncuadres.mockResolvedValueOnce(0);
    const out = await t.uc.fuse(PAIR, { apply: true });
    expect(t.repo.mergeCollidingApplication).toHaveBeenCalledWith(client, coll('w1', null, null), 'd1', 'o1', null);
    expect(out.status === 'FUSED' && out.result.collisionStages).toEqual({ '(sem etapa)': 1 });
  });

  it('colisão KEEP com etapa decidida na oficial → contada pela etapa da oficial', async () => {
    const t = build();
    t.repo.listApplicationCollisions.mockResolvedValueOnce([coll('w1', 'SELECTED', 'INVITED')]);
    t.repo.countRows.mockReset()
      .mockResolvedValueOnce(counts({ worker_job_applications: [1, 1] }))
      .mockResolvedValueOnce(counts({ worker_job_applications: [0, 1] }));
    t.repo.mergeCollidingEncuadres.mockResolvedValueOnce(0);
    const out = await t.uc.fuse(PAIR, { apply: true });
    expect(out.status === 'FUSED' && out.result.collisionStages).toEqual({ SELECTED: 1 });
  });

  it('actor sem traceId → auditoria grava traceId null', async () => {
    const t = build({ actor: { actorUserId: null, actorType: 'CLI', actorLabel: 'x' } });
    await t.uc.fuse(PAIR, { apply: true });
    expect(t.audit.logFieldChangesSafe).toHaveBeenCalledWith(client, expect.objectContaining({ traceId: null }));
  });
});

describe('fuse — endereço: vale o do serviço', () => {
  it('vaga e serviço com endereços vivos diferentes → alinha a vaga ANTES do vínculo e audita', async () => {
    const t = build();
    t.linkRepo.readVacancyForLink.mockResolvedValueOnce({ patient_address_id: 'addr-v' });
    const out = await t.uc.fuse(PAIR, { apply: true });
    expect(t.linkRepo.readVacancyForLink).toHaveBeenCalledWith(client, 'o1', { forUpdate: true });
    expect(t.repo.alignVacancyAddress).toHaveBeenCalledWith(client, 'o1', 'addr-s');
    expect(t.tx.indexOf('align')).toBeLessThan(t.tx.indexOf('confirm'));
    expect(out.status === 'FUSED' && out.result.addressAligned).toBe(true);
    const fields = (t.audit.logFieldChangesSafe.mock.calls[0] as unknown as [unknown, { fields: unknown[] }])[1].fields;
    expect(fields).toContainEqual({ field: 'patient_address_id', before: 'addr-v', after: 'addr-s' });
  });

  it.each([
    ['vaga sem endereço vivo', { patient_address_id: null }, 'addr-s'],
    ['vaga não lida', null, 'addr-s'],
    ['serviço sem endereço vivo', { patient_address_id: 'addr-v' }, null],
    ['iguais', { patient_address_id: 'addr-s' }, 'addr-s'],
  ])('%s → não alinha', async (_n, vac, svc) => {
    const t = build();
    t.linkRepo.readVacancyForLink.mockResolvedValueOnce(vac);
    t.repo.readServiceLiveAddress.mockResolvedValueOnce(svc);
    await t.uc.fuse(PAIR, { apply: true });
    expect(t.repo.alignVacancyAddress).not.toHaveBeenCalled();
  });
});

describe('fuse — revalidação (pula e reporta, nada gravado)', () => {
  it('lock sem vaga viva no serviço → DRAFT_NOT_LIVE_ON_SERVICE', async () => {
    mockLock.mockResolvedValueOnce({});
    const t = build();
    await expect(t.uc.fuse(PAIR, { apply: true })).resolves.toEqual({ status: 'SKIPPED', reason: 'DRAFT_NOT_LIVE_ON_SERVICE' });
    expect(mockBypass).not.toHaveBeenCalled();
    expect(t.tx).toEqual(['BEGIN', 'ROLLBACK']);
  });

  it.each([
    [new ServiceAlreadyRecruitingError('outra'), 'SERVICE_HAS_OTHER_VACANCY'],
    [new PatientNotFoundForRecruitmentError('p1'), 'PATIENT_NOT_FOUND'],
    [new ServiceNotFoundForRecruitmentError('p1', 's1'), 'SERVICE_NOT_FOUND'],
  ])('lock lança %p → %s', async (err, reason) => {
    mockLock.mockRejectedValueOnce(err);
    const t = build();
    await expect(t.uc.fuse(PAIR, { apply: true })).resolves.toEqual({ status: 'SKIPPED', reason });
    noWrites(t);
  });

  it('erro inesperado no lock → propaga (ROLLBACK)', async () => {
    mockLock.mockRejectedValueOnce(new Error('boom'));
    const t = build();
    await expect(t.uc.fuse(PAIR, { apply: true })).rejects.toThrow('boom');
    expect(t.tx).toEqual(['BEGIN', 'ROLLBACK']);
  });

  it.each([
    ['apagado', null],
    ['não é mais rascunho', draftRow({ is_draft: false })],
    ['outro serviço', draftRow({ contracted_service_id: 'outro' })],
    ['outro paciente', draftRow({ patient_id: 'outro' })],
  ])('rascunho %s → DRAFT_CHANGED', async (_n, row) => {
    mockSnapshot.mockImplementation(async (_c: unknown, id: string) => (id === 'd1' ? row : officialRow()));
    const t = build();
    await expect(t.uc.fuse(PAIR, { apply: true })).resolves.toEqual({ status: 'SKIPPED', reason: 'DRAFT_CHANGED' });
    noWrites(t);
  });

  it.each([
    ['apagada', null],
    ['virou rascunho', officialRow({ is_draft: true })],
    ['já com serviço', officialRow({ contracted_service_id: 's1' })],
    ['outro paciente', officialRow({ patient_id: 'outro' })],
    ['CLOSED', officialRow({ status: 'CLOSED' })],
    ['DE_BAJA', officialRow({ status: 'DE_BAJA' })],
  ])('oficial %s → OFFICIAL_CHANGED', async (_n, row) => {
    mockSnapshot.mockImplementation(async (_c: unknown, id: string) => (id === 'd1' ? draftRow() : row));
    const t = build();
    await expect(t.uc.fuse(PAIR, { apply: true })).resolves.toEqual({ status: 'SKIPPED', reason: 'OFFICIAL_CHANGED' });
    noWrites(t);
  });

  it.each([
    [{ openLegacy: 2, liveDrafts: 1 }],
    [{ openLegacy: 1, liveDrafts: 2 }],
  ])('paciente fora do PAR_UNICO %j → PATIENT_SHAPE_CHANGED', async (shape) => {
    const t = build();
    t.repo.patientVacancyShape.mockResolvedValueOnce(shape);
    await expect(t.uc.fuse(PAIR, { apply: true })).resolves.toEqual({ status: 'SKIPPED', reason: 'PATIENT_SHAPE_CHANGED' });
    noWrites(t);
  });

  it('referência ao rascunho que a fusão não move → UNHANDLED_REFS (fail-closed)', async () => {
    const t = build();
    t.repo.unhandledReferences.mockResolvedValueOnce(['publications.job_posting_id', 'interview_slots.job_posting_id']);
    await expect(t.uc.fuse(PAIR, { apply: true })).resolves.toEqual({
      status: 'SKIPPED', reason: 'UNHANDLED_REFS:publications.job_posting_id+interview_slots.job_posting_id',
    });
    noWrites(t);
  });

  it('o UPDATE do soft-delete não achou a linha → DRAFT_CHANGED, sem auditoria nem vínculo', async () => {
    mockSoftDelete.mockResolvedValueOnce(false);
    const t = build();
    await expect(t.uc.fuse(PAIR, { apply: true })).resolves.toEqual({ status: 'SKIPPED', reason: 'DRAFT_CHANGED' });
    expect(mockAuditDeleted).not.toHaveBeenCalled();
    expect(t.confirm).not.toHaveBeenCalled();
    expect(t.tx[t.tx.length - 1]).toBe('ROLLBACK');
  });
});

describe('fuse — conflito do Kanban', () => {
  it('as duas etapas decididas e diferentes → CONFLICT do paciente inteiro, nada gravado', async () => {
    const t = build();
    t.repo.listApplicationCollisions.mockResolvedValueOnce([coll('w1', 'INVITED', 'QUALIFIED'), coll('w2', 'SELECTED', 'REJECTED')]);
    await expect(t.uc.fuse(PAIR, { apply: true })).resolves.toEqual({
      status: 'CONFLICT', conflicts: [{ workerId: 'w2', officialStage: 'SELECTED', draftStage: 'REJECTED' }],
    });
    noWrites(t);
    expect(t.tx).toEqual(['BEGIN', 'ROLLBACK']);
  });
});

describe('fuse — vínculo recusado e contagem', () => {
  it('portão do vínculo recusa → SKIPPED LINK_BLOCKED (o rascunho apagado volta: ROLLBACK)', async () => {
    const t = build();
    t.confirm.mockRejectedValueOnce(new LinkBlockedError(['SERVICE_PAYMENT_DAY', 'SERVICE_REQUIRED_SEX'] as never));
    await expect(t.uc.fuse(PAIR, { apply: true })).resolves.toEqual({
      status: 'SKIPPED', reason: 'LINK_BLOCKED:SERVICE_PAYMENT_DAY+SERVICE_REQUIRED_SEX',
    });
    expect(mockSoftDelete).toHaveBeenCalled();
    expect(t.tx[t.tx.length - 1]).toBe('ROLLBACK');
  });

  it('vaga não vinculável → SKIPPED VACANCY_NOT_LINKABLE', async () => {
    const t = build();
    t.confirm.mockRejectedValueOnce(new VacancyNotLinkableError('DE_BAJA'));
    await expect(t.uc.fuse(PAIR, { apply: true })).resolves.toEqual({ status: 'SKIPPED', reason: 'VACANCY_NOT_LINKABLE:DE_BAJA' });
  });

  it('sobrou linha no rascunho depois de mover → FusionCountMismatchError (ROLLBACK)', async () => {
    const t = build();
    t.repo.countRows.mockReset()
      .mockResolvedValueOnce(counts({ talentum_prescreenings: [1, 0] }))
      .mockResolvedValueOnce(counts({ talentum_prescreenings: [1, 0] }));
    t.repo.listApplicationCollisions.mockResolvedValueOnce([]);
    t.repo.mergeCollidingEncuadres.mockResolvedValueOnce(0);
    await expect(t.uc.fuse(PAIR, { apply: true })).rejects.toThrow(new FusionCountMismatchError('talentum_prescreenings'));
    expect(t.tx[t.tx.length - 1]).toBe('ROLLBACK');
  });

  it('a oficial não fecha com antes − fundidas + criadas → FusionCountMismatchError', async () => {
    const t = build();
    t.repo.countRows.mockReset()
      .mockResolvedValueOnce(counts({ worker_job_applications: [1, 1] }))
      .mockResolvedValueOnce(counts({ worker_job_applications: [0, 2] })); // a colisão devia ter fundido 1
    await expect(t.uc.fuse(PAIR, { apply: true })).rejects.toThrow('fusion count mismatch on worker_job_applications');
  });
});
