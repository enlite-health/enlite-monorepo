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
import { MANUAL_CHANGE_SOURCES, type ManualChangeSource } from '../../domain/enums/PatientChangeSource';
import { loadStatusOptions } from '../PatientStatusOptions';
import { movePatientStatus, trocaPassaPelaGuarda, PatientStatusPermissionError, PatientStatusTransitionError } from '../PatientStatusWriter';
import { CLINICAL_PATIENT_STATUSES, PATIENT_STATUSES, isClinicalPatientStatus, type PatientStatus } from '../../domain/enums/PatientStatus';
import { CELULA_DO_DESTINO } from '../../domain/trocaForaDoFluxo';
import { naFsm, destinosNaFsm, PARES_FSM_36 } from './fixtures/fsmClinicaProd20261010';

const PID = '11111111-1111-4111-8111-111111111111';
const FICHA_COMPLETA = {
  birth_date: '1980-01-01', has_consent: true, insurance_informed: 'OSDE',
  active_address_count: '1', active_responsible_count: '0', active_service_count: '1',
  services_without_address_count: '0', services_without_schedule_count: '0',
};

/** `de` = status atual; `existe=false` = paciente inexistente/deletado; `de=null` com `existe` = paciente com status NULO. */
function banco(de: string | null, ficha: Partial<typeof FICHA_COMPLETA> = {}, existe = de !== null) {
  mockClient.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (/services_without_schedule_count/.test(sql)) return { rows: [{ ...FICHA_COMPLETA, ...ficha }], rowCount: 1 };
    if (/FROM patients/.test(sql)) return !existe ? { rows: [], rowCount: 0 } : { rows: [{ status: de }], rowCount: 1 };
    if (/FROM patient_status_transitions WHERE from_status = \$1$/.test(sql.trim())) {
      const [f] = params as [string];
      return { rows: destinosNaFsm(f).map((t) => ({ to_status: t })), rowCount: 0 };
    }
    if (/patient_status_transitions/.test(sql)) {
      const [f, t] = params as [string, string];
      return { rows: naFsm(f, t) ? [{ ok: 1 }] : [], rowCount: 0 };
    }
    return { rows: [], rowCount: 1 };
  });
}
const lista = (de: string | null, cells: readonly string[] | null, ficha: Partial<typeof FICHA_COMPLETA> = {}, origem: ManualChangeSource = 'admin_panel') =>
  (banco(de, ficha, true), loadStatusOptions(mockClient as unknown as PoolClient, PID, cells, origem));

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

  // 10 estados de origem (3 do funil + 7 clínicos) + origem NULA, × 2 origens manuais × 10 conjuntos de células.
  const ORIGENS_DE_ESTADO: Array<PatientStatus | null> = [...PATIENT_STATUSES, null];
  const casos = ORIGENS_DE_ESTADO.flatMap((atual) =>
    MANUAL_CHANGE_SOURCES.flatMap((origem) => CONJUNTOS.map((c) => ({ atual, origem, ...c }))));
  const nomeDe = (s: string | null): string => s ?? 'NULO';

  it('a FSM da fixture tem as 36 linhas de prd; a matriz tem (10 estados + nulo) × 2 origens × 10 conjuntos = 220 casos', () => {
    const funilFunil = casos.filter((c) => c.atual !== null && !isClinicalPatientStatus(c.atual)).length;
    const nulos = casos.filter((c) => c.atual === null).length;
    // eslint-disable-next-line no-console
    console.log(`T6: casos=${casos.length}; FSM=${PARES_FSM_36.length} linhas; casos com origem no funil (funil↔funil entre os destinos)=${funilFunil}; casos com status NULO=${nulos}`);
    expect(PARES_FSM_36).toHaveLength(36);
    expect(PATIENT_STATUSES).toHaveLength(10);
    expect(casos).toHaveLength(220);
    expect(funilFunil).toBe(3 * 2 * 10);
    expect(nulos).toBe(2 * 10);
  });

  it.each(casos.map((c) => ({ ...c, nome: c.nome, de: nomeDe(c.atual) })))('estado atual $de, origem $origem, células: $nome', async ({ atual, origem, cells }) => {
    const { current, changeSource, options } = await lista(atual, cells, {}, origem);
    expect(current).toBe(atual);
    expect(changeSource).toBe(origem);

    // IGUALDADE nos dois sentidos: roda o PUT de verdade para CADA um dos destinos possíveis (todo o
    // vocabulário menos o estado atual). Só duas recusas existem na guarda (permissão / transição) —
    // qualquer outra falha seria bug do teste. Funil↔funil é livre no writer e a lista o espelha.
    const aceitosPeloPut: string[] = [];
    const destinos = PATIENT_STATUSES.filter((s) => s !== atual);
    for (const destino of destinos) {
      banco(atual, {}, true);
      try {
        await movePatientStatus(PID, destino, { changeSource: origem, onHoldReason: 'SCHOOL', suspensionExitReason: 'OTHER', cells });
        aceitosPeloPut.push(destino);
      } catch (e) {
        expect([PatientStatusPermissionError, PatientStatusTransitionError].some((k) => e instanceof k)).toBe(true);
      }
    }
    expect(destinos).toHaveLength(atual === null ? 10 : 9);
    expect(options.map((o) => o.status).sort()).toEqual([...aceitosPeloPut].sort());
    expect(options.map((o) => o.status)).not.toContain(atual);
    // `via`: sem linha na FSM e com ponta clínica = permissão; o resto (FSM e funil↔funil) = fluxo.
    for (const o of options) {
      const esperado = trocaPassaPelaGuarda(atual, o.status) && !naFsm(atual ?? '', o.status) ? 'permissao' : 'fluxo';
      expect(o.via).toBe(esperado);
    }
    if (cells === null) expect(options.every((o) => o.via === 'fluxo')).toBe(true);
  });

  it('funil↔funil e status nulo, em concreto: a lista oferece os outros 2 estados do funil com via fluxo; nulo oferece só o funil', async () => {
    const funil = await lista('ADMISSION', []);
    expect(funil.options.filter((o) => ['SOLICITANTE', 'PENDING_ADMISSION'].includes(o.status))).toEqual([
      { status: 'SOLICITANTE', via: 'fluxo' }, { status: 'PENDING_ADMISSION', via: 'fluxo' },
    ]);
    const nulo = await lista(null, ['patient:update', ...TODAS]);
    expect(nulo.current).toBeNull();
    expect(nulo.options).toEqual([
      { status: 'SOLICITANTE', via: 'fluxo' }, { status: 'ADMISSION', via: 'fluxo' }, { status: 'PENDING_ADMISSION', via: 'fluxo' },
    ]);
    banco(null, {}, true);
    await expect(movePatientStatus(PID, 'ADMISSION', { changeSource: 'kanban', cells: [] })).resolves.toEqual({ id: PID, status: 'ADMISSION' });
    banco(null, {}, true);
    await expect(movePatientStatus(PID, 'SEARCHING', { changeSource: 'kanban', cells: ['patient:update', ...TODAS] })).rejects.toBeInstanceOf(PatientStatusTransitionError);
  });

  it('controle positivo (D469): ADMISSION + kanban → SEARCHING ESTÁ na lista; ADMISSION + admin_panel → NÃO está; e o writer concorda nos dois', async () => {
    const kanban = await lista('ADMISSION', ['patient:update'], {}, 'kanban');
    const painel = await lista('ADMISSION', ['patient:update'], {}, 'admin_panel');
    expect(kanban.options).toContainEqual({ status: 'SEARCHING', via: 'fluxo' });
    expect(painel.options.map((o) => o.status)).not.toContain('SEARCHING');

    banco('ADMISSION');
    await expect(movePatientStatus(PID, 'SEARCHING', { changeSource: 'kanban', cells: ['patient:update'] })).resolves.toEqual({ id: PID, status: 'SEARCHING' });
    banco('ADMISSION');
    await expect(movePatientStatus(PID, 'SEARCHING', { changeSource: 'admin_panel', cells: ['patient:update'] })).rejects.toBeInstanceOf(PatientStatusTransitionError);
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
    const r = await lista('ADMISSION', ['patient:update', ...TODAS]);
    expect(r.options.map((o) => o.status).sort()).toEqual(['ALTA', 'DISCHARGED', 'PENDING_ADMISSION', 'SOLICITANTE']);
  });

  it('de estado do funil nenhum destino clínico "fora da FSM" é oferecido, nem com todas as células', async () => {
    const r = await lista('SOLICITANTE', ['patient:update', ...TODAS]);
    expect(r.options.map((o) => o.status).sort()).toEqual(['ADMISSION', 'ALTA', 'DISCHARGED', 'PENDING_ADMISSION']); // FSM (498) + funil livre; nada "fora da FSM"
    expect(r.options.every((o) => o.via === 'fluxo')).toBe(true);
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

  it('paciente com status null (sem estado) → sem candidatos além da FSM, sem quebrar', async () => {
    await expect(lista(null, null)).resolves.toMatchObject({ current: null, changeSource: 'admin_panel' });
  });

  it('paciente inexistente/deletado → "Patient not found" (o controller devolve 404)', async () => {
    banco(null, {}, false);
    await expect(loadStatusOptions(mockClient as unknown as PoolClient, PID, null, 'admin_panel')).rejects.toThrow(/Patient not found/);
  });

  it('só leitura: nenhuma escrita, nenhum set_config', async () => {
    await lista('ACTIVE', ['patient:update', ...TODAS]);
    expect(mockClient.query.mock.calls.every(([s]) => /^\s*SELECT/i.test(String(s)) && !/set_config/.test(String(s)))).toBe(true);
  });
});
