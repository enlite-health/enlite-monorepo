/**
 * Spec 051 (F3) — `GET /patients/:id/status-options`: a lista de destinos é EXATAMENTE o que o
 * `PUT /status` aceitaria (A6). O writer e a lista rodam de verdade sobre o MESMO banco de mentira
 * (estado atual + FSM entram como dado — `fixtures/fsmClinicaProd20261010`, 27 pares de prd 10/10/2026).
 */
const mockClient = { query: jest.fn(), release: jest.fn() };
jest.mock('../patientTransaction', () => ({
  inPatientTransaction: (fn: (c: unknown) => Promise<unknown>) => fn(mockClient),
}));
jest.mock('firebase-functions', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import type { PoolClient } from 'pg';
import { loadStatusOptions } from '../PatientStatusOptions';
import { movePatientStatus, PatientStatusPermissionError, PatientStatusTransitionError } from '../PatientStatusWriter';
import { CLINICAL_PATIENT_STATUSES, PATIENT_STATUSES, type ClinicalPatientStatus } from '../../domain/enums/PatientStatus';
import { CELULA_DO_DESTINO } from '../../domain/trocaForaDoFluxo';
import { naFsm } from './fixtures/fsmClinicaProd20261010';

const PID = '11111111-1111-4111-8111-111111111111';
const FICHA_COMPLETA = {
  birth_date: '1980-01-01', has_consent: true, insurance_informed: 'OSDE',
  active_address_count: '1', active_responsible_count: '0', active_service_count: '1',
  services_without_address_count: '0', services_without_schedule_count: '0',
};

/** `extraFsm`: linhas fora das 27 clínicas (ex.: funil→SEARCHING) para o teste da D469. */
function banco(de: string | null, ficha: Partial<typeof FICHA_COMPLETA> = {}, extraFsm: Array<[string, string]> = []) {
  const existe = (f: string, t: string) => naFsm(f, t) || extraFsm.some(([a, b]) => a === f && b === t);
  mockClient.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (/services_without_schedule_count/.test(sql)) return { rows: [{ ...FICHA_COMPLETA, ...ficha }], rowCount: 1 };
    if (/FROM patients/.test(sql)) return de === null ? { rows: [], rowCount: 0 } : { rows: [{ status: de }], rowCount: 1 };
    if (/FROM patient_status_transitions WHERE from_status = \$1$/.test(sql.trim())) {
      const [f] = params as [string];
      return { rows: PATIENT_STATUSES.filter((t) => existe(f, t)).map((t) => ({ to_status: t })), rowCount: 0 };
    }
    if (/patient_status_transitions/.test(sql)) {
      const [f, t] = params as [string, string];
      return { rows: existe(f, t) ? [{ ok: 1 }] : [], rowCount: 0 };
    }
    return { rows: [], rowCount: 1 };
  });
}
const lista = (de: string, cells: readonly string[] | null, ficha: Partial<typeof FICHA_COMPLETA> = {}) =>
  (banco(de, ficha), loadStatusOptions(mockClient as unknown as PoolClient, PID, cells));

// Os conjuntos de células testados: nenhuma, cada uma das 7 sozinha, todas, e null (engine neutro).
const TODAS = CLINICAL_PATIENT_STATUSES.map((s) => CELULA_DO_DESTINO[s]);
const CONJUNTOS: Array<{ nome: string; cells: readonly string[] | null }> = [
  { nome: 'nenhuma ([])', cells: [] },
  ...CLINICAL_PATIENT_STATUSES.map((s) => ({ nome: `só ${CELULA_DO_DESTINO[s]}`, cells: ['patient:update', CELULA_DO_DESTINO[s]] })),
  { nome: 'todas as 7', cells: ['patient:update', ...TODAS] },
  { nome: 'null (engine neutro)', cells: null },
];

describe('T6 — a lista de status-options é exatamente o que o PUT /status aceitaria', () => {
  beforeEach(() => jest.clearAllMocks());

  const casos = CLINICAL_PATIENT_STATUSES.flatMap((atual) => CONJUNTOS.map((c) => ({ atual, ...c })));

  it('a matriz tem 7 estados × 10 conjuntos de células = 70 casos', () => {
    expect(CONJUNTOS).toHaveLength(10);
    expect(casos).toHaveLength(70);
  });

  it.each(casos)('estado atual $atual, células: $nome', async ({ atual, cells }) => {
    const { current, options } = await lista(atual, cells);
    expect(current).toBe(atual);

    // O que o writer aceitaria: roda o PUT de verdade para cada destino do vocabulário. Só duas
    // recusas existem nesta guarda (permissão / transição) — qualquer outra falha seria bug do teste.
    const aceitosPeloPut: string[] = [];
    for (const destino of PATIENT_STATUSES.filter((s) => s !== atual)) {
      banco(atual);
      try {
        await movePatientStatus(PID, destino, { changeSource: 'admin_panel', onHoldReason: 'SCHOOL', suspensionExitReason: 'OTHER', cells });
        aceitosPeloPut.push(destino);
      } catch (e) {
        expect([PatientStatusPermissionError, PatientStatusTransitionError].some((k) => e instanceof k)).toBe(true);
      }
    }
    expect(options.map((o) => o.status).sort()).toEqual([...aceitosPeloPut].sort());
    expect(options.map((o) => o.status)).not.toContain(atual);
    // `via` reflete a FSM: fluxo = tem linha; permissão = não tem.
    for (const o of options) expect(o.via).toBe(naFsm(atual, o.status) ? 'fluxo' : 'permissao');
    if (cells === null) expect(options.every((o) => o.via === 'fluxo')).toBe(true);
  });

  it('controle positivo: com a célula do destino a lista TEM um destino fora da FSM (via permissao); sem ela, não', async () => {
    const com = await lista('ACTIVE', ['patient:update', CELULA_DO_DESTINO.SEARCHING]);
    expect(com.options).toContainEqual({ status: 'SEARCHING', via: 'permissao' });
    const sem = await lista('ACTIVE', ['patient:update']);
    expect(sem.options.map((o) => o.status)).not.toContain('SEARCHING');
    expect(sem.options.map((o) => o.status).sort()).toEqual(['ALTA', 'DISCHARGED', 'ON_HOLD', 'REPLACEMENT', 'SUSPENDED']);
  });
});

describe('F3 — regras próprias da lista', () => {
  beforeEach(() => jest.clearAllMocks());

  it('D469: de um estado do funil, SEARCHING não entra (o PUT admin_panel recusaria) mesmo com linha na FSM', async () => {
    banco('ADMISSION', {}, [['ADMISSION', 'SEARCHING'], ['ADMISSION', 'SOLICITANTE']]);
    const r = await loadStatusOptions(mockClient as unknown as PoolClient, PID, ['patient:update', ...TODAS]);
    expect(r.options.map((o) => o.status)).toEqual(['SOLICITANTE']);
  });

  it('de estado do funil nenhum destino clínico "fora da FSM" é oferecido, nem com todas as células', async () => {
    banco('SOLICITANTE');
    const r = await loadStatusOptions(mockClient as unknown as PoolClient, PID, ['patient:update', ...TODAS]);
    expect(r.options).toEqual([]);
  });

  it('blockedBy (SEARCHING fora do fluxo): serviço ativo + endereço + horário, na ordem do domínio', async () => {
    const r = await lista('ACTIVE', ['patient:update', CELULA_DO_DESTINO.SEARCHING], { active_service_count: '0', services_without_schedule_count: '0' });
    expect(r.options.find((o) => o.status === 'SEARCHING')).toEqual({ status: 'SEARCHING', via: 'permissao', blockedBy: ['CONTRACTED_SERVICE'] });
    const r2 = await lista('DISCHARGED', ['patient:update', CELULA_DO_DESTINO.SEARCHING], { services_without_address_count: '1', services_without_schedule_count: '1' });
    expect(r2.options.find((o) => o.status === 'SEARCHING')?.blockedBy).toEqual(['SERVICE_ADDRESS', 'SERVICE_SCHEDULE']);
  });

  it('SEARCHING DENTRO do fluxo (ON_HOLD → SEARCHING) segue com a regra de hoje: sem serviço não bloqueia; sem horário bloqueia só SERVICE_SCHEDULE', async () => {
    const semServico = await lista('ON_HOLD', null, { active_service_count: '0' });
    expect(semServico.options.find((o) => o.status === 'SEARCHING')).toEqual({ status: 'SEARCHING', via: 'fluxo' });
    const semHorario = await lista('ON_HOLD', null, { services_without_schedule_count: '1', active_service_count: '0' });
    expect(semHorario.options.find((o) => o.status === 'SEARCHING')?.blockedBy).toEqual(['SERVICE_SCHEDULE']);
  });

  it('blockedBy de ACTIVE = o checklist de ativação (ADDRESS aqui); ficha completa → a chave nem aparece', async () => {
    const r = await lista('DISCHARGED', null, { active_address_count: '0' });
    expect(r.options.find((o) => o.status === 'ACTIVE')?.blockedBy).toEqual(['ADDRESS']);
    const ok = await lista('DISCHARGED', null);
    expect(ok.options.find((o) => o.status === 'ACTIVE')).toEqual({ status: 'ACTIVE', via: 'fluxo' });
  });

  it('motivo de ON_HOLD e de saída de SUSPENDED NÃO entram em blockedBy (a tela coleta)', async () => {
    const r = await lista('SUSPENDED', ['patient:update', ...TODAS], { active_service_count: '0', services_without_schedule_count: '1' });
    const todosOsCodigos = r.options.flatMap((o) => o.blockedBy ?? []);
    expect(todosOsCodigos.every((c) => ['ADDRESS', 'CONTRACTED_SERVICE', 'SERVICE_ADDRESS', 'SERVICE_SCHEDULE'].includes(c))).toBe(true);
    expect(r.options.find((o) => o.status === 'ON_HOLD')).toEqual({ status: 'ON_HOLD', via: 'fluxo' });
  });

  it('a completude só é lida quando algum destino a cobra (ALTA/DISCHARGED/ON_HOLD/SUSPENDED não cobram)', async () => {
    await lista('ACTIVE', null); // ACTIVE → ALTA, DISCHARGED, ON_HOLD, REPLACEMENT(cobra), SUSPENDED
    expect(mockClient.query.mock.calls.some(([s]) => /services_without_schedule_count/.test(String(s)))).toBe(true);
    jest.clearAllMocks();
    await lista('ALTA', null); // ALTA → DISCHARGED só
    expect(mockClient.query.mock.calls.some(([s]) => /services_without_schedule_count/.test(String(s)))).toBe(false);
  });

  it('paciente inexistente/deletado → "Patient not found" (o controller devolve 404)', async () => {
    banco(null);
    await expect(loadStatusOptions(mockClient as unknown as PoolClient, PID, null)).rejects.toThrow(/Patient not found/);
  });

  it('só leitura: nenhuma escrita, nenhum set_config', async () => {
    await lista('ACTIVE', ['patient:update', ...TODAS]);
    expect(mockClient.query.mock.calls.every(([s]) => /^\s*SELECT/i.test(String(s)) && !/set_config/.test(String(s)))).toBe(true);
  });
});
