/**
 * O escritor de estado sobre DUBLÊS de port puros (estado-automatico-do-paciente, D7): sem `pg`, sem adapter, sem mock de módulo.
 * Prova que a transação, a completude (COM escopo) e a sonda de alocação entram só por `PatientStatusPorts`.
 */
jest.mock('firebase-functions', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import { createPatientStatusWriter, PatientStatusNotReadyError } from '../PatientStatusWriter';
import type { PatientStatusPorts, StatusTx } from '../ports/patientStatusPorts';
import type { PatientCompletenessCode } from '../../domain/PatientCompleteness';

const PID = '11111111-1111-4111-8111-111111111111';
const SID = '22222222-2222-4222-8222-222222222222';

function montar(missing: PatientCompletenessCode[] = [], de = 'ADMISSION') {
  const queries: string[] = [];
  const tx: StatusTx = {
    query: jest.fn(async (sql: string) => {
      queries.push(sql);
      if (/FROM patients/.test(sql)) return { rows: [{ status: de }], rowCount: 1 };
      if (/patient_status_transitions/.test(sql)) return { rows: [{ ok: 1 }], rowCount: 1 };
      return { rows: [], rowCount: 1 };
    }) as never,
  };
  const ports: PatientStatusPorts = {
    transaction: { run: jest.fn(async (fn) => fn(tx)) },
    completeness: { missingFor: jest.fn(async () => missing) },
    allocation: { countLive: jest.fn(async () => 0) },
    talentum: { mark: jest.fn(async () => []), markVacancyIfPatientPaused: jest.fn(async () => []) },
  };
  return { ports, tx, queries, move: createPatientStatusWriter(ports) };
}

describe('createPatientStatusWriter — por ports', () => {
  beforeEach(() => jest.clearAllMocks());

  it('origem do foguete com serviço informado: a completude é medida no escopo { servico, serviceId } (tabela de origem manda)', async () => {
    const { ports, move } = montar();
    await move(PID, 'SEARCHING', { changeSource: 'recruitment_activation', escopo: { kind: 'servico', serviceId: SID } });
    expect(ports.completeness.missingFor).toHaveBeenCalledWith(expect.anything(), PID, { kind: 'servico', serviceId: SID });
    expect(ports.transaction.run).toHaveBeenCalledTimes(1);
  });

  it('origem manual: o escopo é SEMPRE o paciente inteiro, mesmo que o chamador mande um serviço (a tabela decide, não o chamador)', async () => {
    const { ports, move } = montar([], 'ON_HOLD');
    await move(PID, 'SEARCHING', { changeSource: 'resume', escopo: { kind: 'servico', serviceId: SID } });
    expect(ports.completeness.missingFor).toHaveBeenCalledWith(expect.anything(), PID, { kind: 'paciente' });
  });

  it('item 19 — derivação (system): a completude é medida só nos serviços com vaga viva, e um serviço informado pelo chamador não muda isso', async () => {
    const { ports, move } = montar([], 'SEARCHING');
    await move(PID, 'REPLACEMENT', { changeSource: 'system' });
    expect(ports.completeness.missingFor).toHaveBeenLastCalledWith(expect.anything(), PID, { kind: 'servicos_com_vaga_viva' });
    await move(PID, 'ACTIVE', { changeSource: 'system', escopo: { kind: 'servico', serviceId: SID } });
    expect(ports.completeness.missingFor).toHaveBeenLastCalledWith(expect.anything(), PID, { kind: 'servicos_com_vaga_viva' });
  });

  it('completude faltando no escopo medido → PatientStatusNotReadyError e nenhum UPDATE', async () => {
    const { move, queries } = montar(['SERVICE_SCHEDULE']);
    await expect(move(PID, 'SEARCHING', { changeSource: 'recruitment_activation', escopo: { kind: 'servico', serviceId: SID } }))
      .rejects.toBeInstanceOf(PatientStatusNotReadyError);
    expect(queries.some((q) => /^UPDATE patients/.test(q.trim()))).toBe(false);
  });

  it('com o client de quem chama (txClient): não abre transação própria', async () => {
    const { ports, tx, move } = montar();
    await move(PID, 'SEARCHING', { changeSource: 'recruitment_activation', escopo: { kind: 'servico', serviceId: SID } }, tx);
    expect(ports.transaction.run).not.toHaveBeenCalled();
  });

  it('alocação viva consultada pelo port só em origem humana com troca de estado', async () => {
    const { ports, move } = montar();
    await move(PID, 'SEARCHING', { changeSource: 'recruitment_activation', escopo: { kind: 'servico', serviceId: SID } });
    expect(ports.allocation.countLive).not.toHaveBeenCalled();
    await move(PID, 'SOLICITANTE', { changeSource: 'admin_panel' });
    expect(ports.allocation.countLive).toHaveBeenCalledTimes(1);
  });
});
