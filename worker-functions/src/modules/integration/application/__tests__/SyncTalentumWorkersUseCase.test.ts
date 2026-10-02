/**
 * SyncTalentumWorkersUseCase.test.ts (spec 040 / F3 — API v2)
 *
 * O sync lê candidatos por projeto IN_PROGRESS ligado a vaga nossa e os grava em `workers`.
 * Cenários: criação só com telefone (e-mail NULL), casamento por telefone normalizado, e-mail do
 * `ready-for-interview` como complemento, conflito de telefone vira relatório (sem duplicar), projeto
 * sem vaga ignorado, idempotência, paginação e — acima de tudo — PII fora do log.
 *
 * Banco: `FakeWorkersDb` (lógica). Postgres de verdade: `tests/e2e/sync-talentum-workers.test.ts`.
 * Dados sintéticos; nenhum nome/telefone/e-mail aqui é de pessoa real.
 */

import * as crypto from 'crypto';
import { FakeWorkersDb } from './fakeWorkersDb';

const fake = new FakeWorkersDb();

jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: (...a: unknown[]) => (fake.query as any)(...a) }) }) },
}));

const mockClient = {
  listAllPrescreenings: jest.fn(),
  listCandidates: jest.fn(),
  listReadyForInterview: jest.fn(),
};
jest.mock('../../infrastructure/TalentumApiClient', () => ({
  TalentumApiClient: { create: jest.fn(async () => mockClient) },
}));

import { SyncTalentumWorkersUseCase, parseSyncOptions } from '../SyncTalentumWorkersUseCase';
import { logger } from '@shared/logging';
import type { TalentumCandidate } from '../../domain/ITalentumApiClient';

// ── Dados sintéticos ─────────────────────────────────────────────

const PHONE_RAW = '1151265663';          // 10 dígitos: o formato que a v2 devolve
const PHONE_CANON = '5491151265663';
const OTHER_PHONE = '5491166667777';
const MAIL = 'Candidata.Sintetica@Example.test';
const FIRST = 'Zulema';
const LAST = 'Sintetica';

function cand(profileId: string, o: Partial<TalentumCandidate> & { status?: unknown } = {}): TalentumCandidate {
  return { profileId, firstName: FIRST, lastName: LAST, phoneNumber: PHONE_RAW, status: { value: 'in_progress' }, ...o };
}

function project(id: string, status = 'IN_PROGRESS') {
  return { projectId: id, title: `titulo-${id}`, status, active: status === 'IN_PROGRESS' };
}

/** Cliente com 12 candidatos por página, como a v2. */
function serve(byProject: Record<string, { candidates: TalentumCandidate[]; ready?: TalentumCandidate[] }>, pageSize = 12) {
  const slice = (all: TalentumCandidate[], page: number) => ({ candidates: all.slice((page - 1) * pageSize, page * pageSize), total: all.length });
  mockClient.listCandidates.mockImplementation(async (pid: string, page: number) => slice(byProject[pid]?.candidates ?? [], page));
  mockClient.listReadyForInterview.mockImplementation(async (pid: string, page: number) => slice(byProject[pid]?.ready ?? [], page));
}

function allLogged(): string {
  const calls = [
    ...(logger.info as jest.Mock).mock.calls, ...(logger.warn as jest.Mock).mock.calls,
    ...(logger.error as jest.Mock).mock.calls, ...(console.log as jest.Mock).mock.calls,
    ...(console.error as jest.Mock).mock.calls, ...(console.warn as jest.Mock).mock.calls,
  ];
  return JSON.stringify(calls);
}

function expectNoPii(logged: string): void {
  for (const secret of [PHONE_RAW, PHONE_CANON, OTHER_PHONE, MAIL, MAIL.toLowerCase(), FIRST, LAST]) {
    expect(logged).not.toContain(secret);
  }
}

describe('SyncTalentumWorkersUseCase (v2)', () => {
  let useCase: SyncTalentumWorkersUseCase;

  beforeEach(() => {
    jest.restoreAllMocks();
    fake.workers = []; fake.vacancies = []; fake.wja = new Set(); fake.encuadres = []; fake.sqlLog = [];
    fake.uniqueViolationOnInsert = false; fake.concurrentWorkerWins = false; fake.failOn = null; fake.vanishOnRead = false; fake.vanishOnStatus = false;
    fake.query.mockClear();
    Object.values(mockClient).forEach((m) => m.mockReset());
    jest.spyOn(logger, 'info').mockImplementation();
    jest.spyOn(logger, 'warn').mockImplementation();
    jest.spyOn(logger, 'error').mockImplementation();
    jest.spyOn(console, 'log').mockImplementation();
    jest.spyOn(console, 'warn').mockImplementation();
    jest.spyOn(console, 'error').mockImplementation();
    fake.vacancies = [{ id: 'jp-A', talentumProjectId: 'proj-A', caseNumber: 681 }, { id: 'jp-B', talentumProjectId: 'proj-B', caseNumber: 682 }];
    useCase = new SyncTalentumWorkersUseCase();
  });

  // ── criação ────────────────────────────────────────────────────

  describe('criar worker', () => {
    it('candidato SEM e-mail (só telefone) vira worker com e-mail NULL e telefone normalizado', async () => {
      mockClient.listAllPrescreenings.mockResolvedValue([project('proj-A')]);
      serve({ 'proj-A': { candidates: [cand('pf-1')] } });

      const report = await useCase.execute();

      expect(report.created).toBe(1);
      expect(report.errors).toEqual([]);
      expect(fake.workers).toHaveLength(1);
      expect(fake.workers[0]).toMatchObject({ email: null, phone: PHONE_CANON, authUid: 'talentum_pf-1', status: 'INCOMPLETE_REGISTER' });
      expect(fake.workers[0].firstNameEnc).toBe(Buffer.from(FIRST).toString('base64'));
    });

    it('telefone digitado em outro formato é gravado normalizado (normalizePhoneAR)', async () => {
      mockClient.listAllPrescreenings.mockResolvedValue([project('proj-A')]);
      serve({ 'proj-A': { candidates: [cand('pf-1', { phoneNumber: '+54 11 5126-5663' })] } });

      await useCase.execute();

      // 12 dígitos começando com 54 sem o 9 do móvel → 549 + número (só normalizePhoneAR faz isso)
      expect(fake.workers[0].phone).toBe(PHONE_CANON);
    });

    it('sem telefone válido mas com e-mail: cria só com e-mail; telefone vira NULL', async () => {
      mockClient.listAllPrescreenings.mockResolvedValue([project('proj-A')]);
      serve({ 'proj-A': { candidates: [cand('pf-1', { phoneNumber: 'abc', email: MAIL })] } });

      await useCase.execute();

      expect(fake.workers[0]).toMatchObject({ email: MAIL.toLowerCase(), phone: null });
    });

    it('sem nome: cria sem criptografar nada e sem quebrar', async () => {
      mockClient.listAllPrescreenings.mockResolvedValue([project('proj-A')]);
      serve({ 'proj-A': { candidates: [cand('pf-1', { firstName: ' ', lastName: undefined })] } });

      const report = await useCase.execute();

      expect(report.created).toBe(1);
      expect(fake.workers[0]).toMatchObject({ firstNameEnc: null, lastNameEnc: null });
    });

    it('sem e-mail E sem telefone: ignora (skipped), não cria', async () => {
      mockClient.listAllPrescreenings.mockResolvedValue([project('proj-A')]);
      serve({ 'proj-A': { candidates: [cand('pf-1', { phoneNumber: undefined })] } });

      const report = await useCase.execute();

      expect(report).toMatchObject({ total: 1, created: 0, skipped: 1 });
      expect(fake.workers).toHaveLength(0);
    });

    it('corrida de criação (23505) devolve o worker que já existe', async () => {
      mockClient.listAllPrescreenings.mockResolvedValue([project('proj-A')]);
      serve({ 'proj-A': { candidates: [cand('pf-1')] } });
      fake.uniqueViolationOnInsert = true;
      fake.concurrentWorkerWins = true;

      const report = await useCase.execute();

      expect(report.created).toBe(1);
      expect(report.errors).toEqual([]);
      expect(fake.workers).toHaveLength(1);
    });

    it('23505 sem worker existente: o erro vira linha de relatório com o profileId (não derruba o sync)', async () => {
      mockClient.listAllPrescreenings.mockResolvedValue([project('proj-A')]);
      serve({ 'proj-A': { candidates: [cand('pf-1'), cand('pf-2', { phoneNumber: OTHER_PHONE })] } });
      fake.uniqueViolationOnInsert = true;

      const report = await useCase.execute();

      expect(report.errors.map((e) => e.profileId)).toEqual(['pf-1', 'pf-2']);
      expect(report.created).toBe(0);
    });
  });

  // ── casamento ──────────────────────────────────────────────────

  describe('casar worker existente', () => {
    it('casa por TELEFONE normalizado (cadastrado com +549…) e liga à vaga do PRÓPRIO projeto', async () => {
      const w = fake.addWorker({ phone: `+${PHONE_CANON}`, email: 'ja@existe.test', authUid: 'fb-uid', status: 'REGISTERED', firstNameEnc: 'x', lastNameEnc: 'y' });
      mockClient.listAllPrescreenings.mockResolvedValue([project('proj-A'), project('proj-B')]);
      serve({ 'proj-A': { candidates: [cand('pf-1')] }, 'proj-B': { candidates: [] } });

      const report = await useCase.execute();

      expect(report).toMatchObject({ created: 0, linked: 1, projects: 2 });
      expect(fake.workers).toHaveLength(1);
      expect([...fake.wja]).toEqual([`${w.id}|jp-A`]);
      expect(fake.encuadres).toEqual([expect.objectContaining({ workerId: w.id, jobPostingId: 'jp-A' })]);
    });

    it('o mesmo candidato em DOIS projetos liga às DUAS vagas certas (uma por projeto)', async () => {
      const w = fake.addWorker({ phone: PHONE_CANON, email: 'a@b.test', authUid: 'fb', firstNameEnc: 'x', lastNameEnc: 'y' });
      mockClient.listAllPrescreenings.mockResolvedValue([project('proj-A'), project('proj-B')]);
      serve({ 'proj-A': { candidates: [cand('pf-1')] }, 'proj-B': { candidates: [cand('pf-1')] } });

      const report = await useCase.execute();

      expect(report.linked).toBe(2);
      expect([...fake.wja].sort()).toEqual([`${w.id}|jp-A`, `${w.id}|jp-B`]);
    });

    it('casa por e-mail (vindo do ready-for-interview) quando o telefone não bate e telefone do cadastro é NULL: completa o telefone, sem conflito', async () => {
      const w = fake.addWorker({ phone: null, email: MAIL.toLowerCase(), authUid: 'fb', firstNameEnc: 'x', lastNameEnc: 'y' });
      mockClient.listAllPrescreenings.mockResolvedValue([project('proj-A')]);
      serve({ 'proj-A': { candidates: [cand('pf-1', { status: { value: 'qualified' } })], ready: [cand('pf-1', { email: MAIL })] } });

      const report = await useCase.execute();

      expect(report).toMatchObject({ created: 0, updated: 1, conflicts: [] });
      expect(w.phone).toBe(PHONE_CANON);
    });

    it('casa por auth_uid talentum_<profileId> quando telefone e e-mail não batem (e completa o telefone)', async () => {
      const w = fake.addWorker({ phone: null, email: null, authUid: 'talentum_pf-1', firstNameEnc: 'x', lastNameEnc: 'y' });
      mockClient.listAllPrescreenings.mockResolvedValue([project('proj-A')]);
      serve({ 'proj-A': { candidates: [cand('pf-1', { phoneNumber: OTHER_PHONE })] } });

      const report = await useCase.execute();

      expect(report).toMatchObject({ created: 0, updated: 1, conflicts: [] });
      expect(fake.workers).toEqual([w]);
      expect(w.phone).toBe(OTHER_PHONE);
    });

    it('DUPLICIDADE: telefone diferente do cadastrado vira relatório, não worker duplicado nem sobrescrita', async () => {
      const w = fake.addWorker({ phone: OTHER_PHONE, email: MAIL.toLowerCase(), authUid: 'fb', firstNameEnc: 'x', lastNameEnc: 'y' });
      mockClient.listAllPrescreenings.mockResolvedValue([project('proj-A')]);
      serve({ 'proj-A': { candidates: [cand('pf-9', { status: { value: 'qualified' } })], ready: [cand('pf-9', { email: MAIL })] } });

      const report = await useCase.execute();

      expect(fake.workers).toHaveLength(1);
      expect(w.phone).toBe(OTHER_PHONE);
      expect(report.created).toBe(0);
      expect(report.conflicts).toEqual([{ profileId: 'pf-9', reason: 'PHONE_DIFFERS_FROM_REGISTERED' }]);
      expectNoPii(JSON.stringify(report));
    });

    it('preenche só o que falta: nome, e-mail e auth_uid ausentes; recalcula o índice de nome', async () => {
      const w = fake.addWorker({ phone: PHONE_CANON, email: null, authUid: null, firstNameEnc: null, lastNameEnc: null });
      mockClient.listAllPrescreenings.mockResolvedValue([project('proj-A')]);
      serve({ 'proj-A': { candidates: [cand('pf-1', { status: { value: 'qualified' } })], ready: [cand('pf-1', { email: MAIL })] } });

      const report = await useCase.execute();

      expect(report.updated).toBe(1);
      expect(w).toMatchObject({ email: MAIL.toLowerCase(), authUid: 'talentum_pf-1', firstNameEnc: Buffer.from(FIRST).toString('base64'), lastNameEnc: Buffer.from(LAST).toString('base64') });
      expect(fake.sqlLog.some((s) => s.includes('name_trgm_bidx'))).toBe(true);
    });

    it('nome parcial: completa só o sobrenome e decifra o primeiro nome para o índice', async () => {
      const w = fake.addWorker({ phone: PHONE_CANON, email: 'a@b.test', authUid: 'fb', firstNameEnc: Buffer.from('Existente').toString('base64'), lastNameEnc: null });
      mockClient.listAllPrescreenings.mockResolvedValue([project('proj-A')]);
      serve({ 'proj-A': { candidates: [cand('pf-1', { firstName: 'Outro' })] } });

      await useCase.execute();

      expect(w.firstNameEnc).toBe(Buffer.from('Existente').toString('base64')); // não sobrescreve
      expect(w.lastNameEnc).toBe(Buffer.from(LAST).toString('base64'));
    });

    it('completa só o sobrenome quando não há nome no candidato e o cadastro não tem nenhum', async () => {
      const w = fake.addWorker({ phone: PHONE_CANON, email: 'a@b.test', authUid: 'fb', firstNameEnc: null, lastNameEnc: null });
      mockClient.listAllPrescreenings.mockResolvedValue([project('proj-A')]);
      serve({ 'proj-A': { candidates: [cand('pf-1', { firstName: undefined })] } });

      await useCase.execute();

      expect(w).toMatchObject({ firstNameEnc: null, lastNameEnc: Buffer.from(LAST).toString('base64') });
    });

    it('completa só o primeiro nome quando o sobrenome já existe', async () => {
      const w = fake.addWorker({ phone: PHONE_CANON, email: 'a@b.test', authUid: 'fb', firstNameEnc: null, lastNameEnc: Buffer.from('Existente').toString('base64') });
      mockClient.listAllPrescreenings.mockResolvedValue([project('proj-A')]);
      serve({ 'proj-A': { candidates: [cand('pf-1')] } });

      await useCase.execute();

      expect(w).toMatchObject({ firstNameEnc: Buffer.from(FIRST).toString('base64'), lastNameEnc: Buffer.from('Existente').toString('base64') });
    });

    it('sobrenome vazio no cadastro e ausente no candidato: completa o nome e indexa sem sobrenome', async () => {
      const w = fake.addWorker({ phone: PHONE_CANON, email: 'a@b.test', authUid: 'fb', firstNameEnc: null, lastNameEnc: '' });
      mockClient.listAllPrescreenings.mockResolvedValue([project('proj-A')]);
      serve({ 'proj-A': { candidates: [cand('pf-1', { lastName: undefined })] } });

      await useCase.execute();

      expect(w.firstNameEnc).toBe(Buffer.from(FIRST).toString('base64'));
    });

    it('worker completo e sem novidade: skipped, nada atualizado', async () => {
      fake.addWorker({ phone: PHONE_CANON, email: 'a@b.test', authUid: 'fb', firstNameEnc: 'x', lastNameEnc: 'y' });
      mockClient.listAllPrescreenings.mockResolvedValue([project('proj-A')]);
      serve({ 'proj-A': { candidates: [cand('pf-1')] } });

      const report = await useCase.execute();

      expect(report).toMatchObject({ updated: 0, skipped: 1 });
      expect(fake.sqlLog.some((s) => s.startsWith('UPDATE workers'))).toBe(false);
    });

    it('worker some entre o casamento e a leitura: conta como skipped', async () => {
      fake.addWorker({ phone: PHONE_CANON });
      fake.vanishOnRead = true;
      mockClient.listAllPrescreenings.mockResolvedValue([project('proj-A')]);
      serve({ 'proj-A': { candidates: [cand('pf-1')] } });

      expect((await useCase.execute()).skipped).toBe(1);
    });
  });

  // ── escopo: projetos ───────────────────────────────────────────

  describe('escopo de projetos', () => {
    it('projeto IN_PROGRESS sem vaga par é IGNORADO (candidatos nem são lidos); PAUSED também', async () => {
      mockClient.listAllPrescreenings.mockResolvedValue([project('proj-A'), project('proj-sem-vaga'), project('proj-B', 'PAUSED')]);
      serve({ 'proj-A': { candidates: [cand('pf-1')] }, 'proj-sem-vaga': { candidates: [cand('pf-2')] }, 'proj-B': { candidates: [cand('pf-3')] } });

      const report = await useCase.execute();

      expect(report).toMatchObject({ projects: 1, projectsWithoutVacancy: 1, total: 1 });
      expect(mockClient.listCandidates.mock.calls.map((c) => c[0])).toEqual(['proj-A']);
    });

    it('nenhum projeto IN_PROGRESS: não consulta o banco de vagas', async () => {
      mockClient.listAllPrescreenings.mockResolvedValue([project('proj-A', 'PAUSED')]);

      const report = await useCase.execute();

      expect(report).toMatchObject({ projects: 0, total: 0 });
      expect(fake.query).not.toHaveBeenCalled();
    });

    it('projeto sem candidato: não pede ready-for-interview', async () => {
      mockClient.listAllPrescreenings.mockResolvedValue([project('proj-A')]);
      serve({ 'proj-A': { candidates: [] } });

      await useCase.execute();

      expect(mockClient.listReadyForInterview).not.toHaveBeenCalled();
    });

    it('ready-for-interview só é pedido quando há QUALIFICADO (e e-mail ausente no item é ignorado)', async () => {
      mockClient.listAllPrescreenings.mockResolvedValue([project('proj-A'), project('proj-B')]);
      serve({
        'proj-A': { candidates: [cand('pf-1', { status: { value: 'in_doubt' } }), cand('pf-0', { status: undefined })] },
        'proj-B': { candidates: [cand('pf-2', { status: { value: 'qualified' } })], ready: [cand('pf-2', { email: undefined })] },
      });

      await useCase.execute();

      expect(mockClient.listReadyForInterview.mock.calls.map((c) => c[0])).toEqual(['proj-B']);
      expect(fake.workers.every((w) => w.email === null)).toBe(true);
    });

    it('e-mail no próprio item do candidato também vale', async () => {
      mockClient.listAllPrescreenings.mockResolvedValue([project('proj-A')]);
      serve({ 'proj-A': { candidates: [cand('pf-1', { email: MAIL })] } });

      await useCase.execute();

      expect(fake.workers[0].email).toBe(MAIL.toLowerCase());
    });
  });

  // ── paginação e contagem ───────────────────────────────────────

  describe('paginação', () => {
    it('lê as páginas até `total` (25 candidatos, 12 por página = 3 requests) e conta os requests', async () => {
      const many = Array.from({ length: 25 }, (_, i) => cand(`pf-${i}`, { phoneNumber: `54911${String(10000000 + i)}` }));
      mockClient.listAllPrescreenings.mockResolvedValue([project('proj-A')]);
      serve({ 'proj-A': { candidates: many } });

      const report = await useCase.execute();

      expect(mockClient.listCandidates.mock.calls.map((c) => c[1])).toEqual([1, 2, 3]);
      expect(report).toMatchObject({ total: 25, created: 25, requests: 3 });
    });

    it('página vazia encerra a leitura mesmo com `total` maior', async () => {
      mockClient.listAllPrescreenings.mockResolvedValue([project('proj-A')]);
      mockClient.listCandidates.mockImplementation(async (_p: string, page: number) => (page === 1 ? { candidates: [cand('pf-1')], total: 99 } : { candidates: [], total: 99 }));

      const report = await useCase.execute();

      expect(mockClient.listCandidates).toHaveBeenCalledTimes(2);
      expect(report.total).toBe(1);
    });

    it('trava de 500 páginas contra `total` inconsistente', async () => {
      mockClient.listAllPrescreenings.mockResolvedValue([project('proj-A')]);
      mockClient.listCandidates.mockResolvedValue({ candidates: [cand('pf-1')], total: 1_000_000 });

      await useCase.execute();

      expect(mockClient.listCandidates).toHaveBeenCalledTimes(500);
    });
  });

  // ── lote por projeto (T3.4) ────────────────────────────────────

  describe('lote por projeto', () => {
    function threeProjects() {
      fake.vacancies = ['proj-1', 'proj-2', 'proj-3'].map((id, i) => ({ id: `jp-${i}`, talentumProjectId: id, caseNumber: i }));
      mockClient.listAllPrescreenings.mockResolvedValue([project('proj-3'), project('proj-1'), project('proj-2')]);
      serve({
        'proj-1': { candidates: [cand('pf-1', { phoneNumber: '1100000001' })] },
        'proj-2': { candidates: [cand('pf-2', { phoneNumber: '1100000002' })] },
        'proj-3': { candidates: [cand('pf-3', { phoneNumber: '1100000003' })] },
      });
    }

    it('sem maxProjects lê TUDO e nextCursor = null', async () => {
      threeProjects();
      const report = await useCase.execute();
      expect(report).toMatchObject({ projects: 3, projectsEligible: 3, nextCursor: null, created: 3 });
    });

    it('maxProjects fatia por ordem estável de id e devolve o cursor; a última fatia fecha com null', async () => {
      threeProjects();

      const r1 = await useCase.execute({ maxProjects: 2 });
      expect(mockClient.listCandidates.mock.calls.map((c) => c[0])).toEqual(['proj-1', 'proj-2']);
      expect(r1).toMatchObject({ projects: 2, projectsEligible: 3, nextCursor: 2, created: 2 });

      mockClient.listCandidates.mockClear();
      const r2 = await useCase.execute({ cursor: r1.nextCursor!, maxProjects: 2 });
      expect(mockClient.listCandidates.mock.calls.map((c) => c[0])).toEqual(['proj-3']);
      expect(r2).toMatchObject({ projects: 1, nextCursor: null, created: 1 });
      expect(fake.workers).toHaveLength(3);
    });

    it('parseSyncOptions aceita só inteiros válidos; o resto vira "sem lote"', () => {
      expect(parseSyncOptions({ cursor: 4, maxProjects: 50 })).toEqual({ cursor: 4, maxProjects: 50 });
      expect(parseSyncOptions({ cursor: 0 })).toEqual({ cursor: 0 });
      expect(parseSyncOptions({ cursor: -1, maxProjects: 0 })).toEqual({});
      expect(parseSyncOptions({ cursor: '3', maxProjects: 1.5 })).toEqual({});
      expect(parseSyncOptions(undefined)).toEqual({});
      expect(parseSyncOptions('x')).toEqual({});
    });
  });

  // ── status do worker / idempotência ────────────────────────────

  describe('ligação à vaga', () => {
    it('worker recém-criado (INCOMPLETE_REGISTER) NÃO é ligado: skippedIncompleteRegistration', async () => {
      mockClient.listAllPrescreenings.mockResolvedValue([project('proj-A')]);
      serve({ 'proj-A': { candidates: [cand('pf-1')] } });

      const report = await useCase.execute();

      expect(report).toMatchObject({ created: 1, linked: 0, skippedIncompleteRegistration: 1 });
      expect(fake.wja.size).toBe(0);
    });

    it('worker sem linha de status: tratado como incompleto', async () => {
      fake.addWorker({ phone: PHONE_CANON, email: 'a@b.test', authUid: 'fb', firstNameEnc: 'x', lastNameEnc: 'y' });
      fake.vanishOnStatus = true;
      mockClient.listAllPrescreenings.mockResolvedValue([project('proj-A')]);
      serve({ 'proj-A': { candidates: [cand('pf-1')] } });

      expect((await useCase.execute()).skippedIncompleteRegistration).toBe(1);
    });

    it('IDEMPOTENTE: rodar 2x não duplica WJA nem encuadre; a 2ª não liga nada de novo', async () => {
      fake.addWorker({ phone: PHONE_CANON, email: 'a@b.test', authUid: 'fb', firstNameEnc: 'x', lastNameEnc: 'y' });
      mockClient.listAllPrescreenings.mockResolvedValue([project('proj-A')]);
      serve({ 'proj-A': { candidates: [cand('pf-1')] } });

      const r1 = await useCase.execute();
      const r2 = await useCase.execute();

      expect(r1.linked).toBe(1);
      expect(r2).toMatchObject({ linked: 0, created: 0, updated: 0 });
      expect(fake.wja.size).toBe(1);
      expect(fake.encuadres).toHaveLength(1);
    });

    it('encuadre usa o mesmo dedup_hash do sync legado (dashboard|profileId|case)', async () => {
      fake.addWorker({ phone: PHONE_CANON, email: 'a@b.test', authUid: 'fb', firstNameEnc: 'x', lastNameEnc: 'y' });
      mockClient.listAllPrescreenings.mockResolvedValue([project('proj-A')]);
      serve({ 'proj-A': { candidates: [cand('pf-1')] } });

      await useCase.execute();

      expect(fake.encuadres[0].dedupHash).toBe(crypto.createHash('md5').update('dashboard|pf-1|681').digest('hex'));
    });
  });

  // ── resiliência ────────────────────────────────────────────────

  describe('resiliência', () => {
    it('erro em UM candidato não derruba os outros; relatório só com profileId + mensagem', async () => {
      mockClient.listAllPrescreenings.mockResolvedValue([project('proj-A')]);
      serve({ 'proj-A': { candidates: [cand('pf-1'), cand('pf-2', { phoneNumber: OTHER_PHONE })] } });
      fake.failOn = 'INSERT INTO workers';
      let first = true;
      const orig = fake.query.getMockImplementation()!;
      fake.query.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (sql.includes('INSERT INTO workers') && first) { first = false; throw 'quebrou-como-string'; }
        fake.failOn = null;
        return orig(sql, params);
      });

      const report = await useCase.execute();

      expect(report.errors).toEqual([{ profileId: 'pf-1', error: 'quebrou-como-string' }]);
      expect(report.created).toBe(1);
      fake.query.mockImplementation(orig);
    });

    it('erro de leitura de um projeto vira linha `project:<id>` e o próximo projeto segue', async () => {
      mockClient.listAllPrescreenings.mockResolvedValue([project('proj-A'), project('proj-B')]);
      mockClient.listCandidates.mockImplementation(async (pid: string) => {
        if (pid === 'proj-A') throw new Error('[TalentumApiClient] GET /projects/proj-A/prescreening/candidates?page=1 — HTTP 500');
        return { candidates: [cand('pf-2')], total: 1 };
      });

      const report = await useCase.execute();

      expect(report.errors).toHaveLength(1);
      expect(report.errors[0].profileId).toBe('project:proj-A');
      expect(report.created).toBe(1);
    });

    it('erro de projeto que não é Error também é registrado', async () => {
      mockClient.listAllPrescreenings.mockResolvedValue([project('proj-A')]);
      mockClient.listCandidates.mockRejectedValue('texto-solto');

      const report = await useCase.execute();

      expect(report.errors).toEqual([{ profileId: 'project:proj-A', error: 'texto-solto' }]);
    });
  });

  // ── PII ────────────────────────────────────────────────────────

  describe('PII fora do log (T3.2)', () => {
    it('nenhum log/console do sync carrega telefone, e-mail ou nome — nem em erro, aviso ou sucesso', async () => {
      fake.addWorker({ phone: OTHER_PHONE, email: MAIL.toLowerCase(), authUid: 'fb', firstNameEnc: 'x', lastNameEnc: 'y' }); // conflito
      mockClient.listAllPrescreenings.mockResolvedValue([project('proj-A'), project('proj-B')]);
      serve({
        'proj-A': { candidates: [cand('pf-9', { status: { value: 'qualified' } }), cand('pf-8', { phoneNumber: '1177778888' })], ready: [cand('pf-9', { email: MAIL })] },
        'proj-B': { candidates: [cand('pf-7', { phoneNumber: '1133334444' })] },
      });
      fake.failOn = null;
      const orig = fake.query.getMockImplementation()!;
      fake.query.mockImplementation(async (sql: string, params?: unknown[]) => {
        if (sql.includes('INSERT INTO workers') && String(params?.[0]) === 'talentum_pf-7') {
          throw Object.assign(new Error(`falha com ${PHONE_RAW} ${MAIL}`), { code: '23514' });
        }
        return orig(sql, params);
      });

      await useCase.execute();
      fake.query.mockImplementation(orig);

      const logged = allLogged();
      expect(logged).toContain('pf-7');          // o profileId aparece...
      expect(logged).toContain('Error processing profile');
      expectNoPii(logged);                        // ...e nada pessoal
    });

    it('instrumento: o detector ACUSA um log que vaza o telefone (controle positivo)', () => {
      logger.info({ msg: `ligou ${PHONE_CANON}` });
      expect(() => expectNoPii(allLogged())).toThrow();
    });
  });
});
