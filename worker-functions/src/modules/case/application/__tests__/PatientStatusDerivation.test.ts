/**
 * PatientStatusDerivation — cadeia Fase 15 (DX-15.9, DX-15.12): flag, leitura no client do escritor,
 * a conta da Fase 7 (real, não mockada), a função pura e o mover com o MESMO client.
 */
jest.mock('firebase-functions', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import * as functions from 'firebase-functions';
import type { PoolClient } from 'pg';
import { PatientStatusDerivation } from '../PatientStatusDerivation';
import { PatientStatusNotReadyError, PatientStatusTransitionError } from '../PatientStatusWriter';
import type { KanbanServicesRows } from '../../infrastructure/PatientKanbanServicesReader';
import type { ItinerarySlotRow } from '../../infrastructure/PatientItineraryReader';

const PID = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-09-29T15:00:00Z');

/** Faixa de 4 h (08-12); `alocadaDesde` = vigência da alocação ACTIVE, `null` = sem alocação. */
function faixa(serviceId: string, id: string, weekday: number, alocadaDesde: string | null): ItinerarySlotRow {
  return {
    id, contractedServiceId: serviceId, weekday, startTime: '08:00', endTime: '12:00', active: true,
    assignmentId: alocadaDesde ? `as-${id}` : null, workerId: alocadaDesde ? 'w1' : null, applicationId: alocadaDesde ? 'app1' : null,
    validFrom: alocadaDesde, validTo: null, status: alocadaDesde ? 'ACTIVE' : null,
  } as ItinerarySlotRow;
}

/** Serviço de 8 h com 2 faixas de 4 h; `alocadas` quantas estão cobertas (desde 2026-01-01). */
function servico(id: string, alocadas: 0 | 1 | 2, liveVacancyId: string | null = `v-${id}`): Pick<KanbanServicesRows, 'services' | 'slots'> {
  return {
    services: [{ id, serviceCode: 'AT', weeklyHours: 8, authorizedHours: null, liveVacancyId }],
    slots: [faixa(id, `${id}-a`, 1, alocadas >= 1 ? '2026-01-01' : null), faixa(id, `${id}-b`, 3, alocadas >= 2 ? '2026-01-01' : null)],
  };
}

function linhas(...partes: Array<Pick<KanbanServicesRows, 'services' | 'slots'>>): KanbanServicesRows {
  return {
    patientId: PID, country: 'AR',
    services: partes.flatMap((p) => p.services),
    slots: partes.flatMap((p) => p.slots),
  };
}

function montar(opts: {
  subject?: { status: string | null; country: string; montado: boolean } | null;
  rows?: KanbanServicesRows | null;
  move?: jest.Mock;
}) {
  const subjectReader = { readSubjectWith: jest.fn(async () => (opts.subject === undefined ? { status: 'SEARCHING', country: 'AR', montado: true } : opts.subject)) };
  const servicesReader = { readForPatientWith: jest.fn(async () => (opts.rows === undefined ? linhas(servico('s1', 1)) : opts.rows)) };
  const moveStatus = opts.move ?? jest.fn(async (id: string, status: string) => ({ id, status }));
  const derivation = new PatientStatusDerivation({
    subjectReader, servicesReader, moveStatus: moveStatus as never,
  });
  return { derivation, subjectReader, servicesReader, moveStatus };
}

const client = { query: jest.fn() } as unknown as PoolClient;

describe('PatientStatusDerivation', () => {
  beforeEach(() => { jest.clearAllMocks(); });

  it("paciente não encontrado → 'not_subject'", async () => {
    const { derivation, servicesReader, moveStatus } = montar({ subject: null });
    await expect(derivation.run(client, PID, NOW)).resolves.toBe('not_subject');
    expect(servicesReader.readForPatientWith).not.toHaveBeenCalled();
    expect(moveStatus).not.toHaveBeenCalled();
  });

  it("itinerário não montado → 'unchanged' e mover 0×", async () => {
    const { derivation, moveStatus } = montar({ subject: { status: 'SEARCHING', country: 'AR', montado: false } });
    await expect(derivation.run(client, PID, NOW)).resolves.toBe('unchanged');
    expect(moveStatus).not.toHaveBeenCalled();
  });

  it('SEARCHING + 4/8 → mover(PID, REPLACEMENT, { changeSource: system }, client) — o 4º argumento é o MESMO client', async () => {
    const { derivation, subjectReader, servicesReader, moveStatus } = montar({});
    await expect(derivation.run(client, PID, NOW)).resolves.toBe('moved');
    expect(moveStatus).toHaveBeenCalledTimes(1);
    const args = moveStatus.mock.calls[0];
    expect(args.slice(0, 3)).toEqual([PID, 'REPLACEMENT', { changeSource: 'system' }]);
    expect(args[3]).toBe(client);
    expect((subjectReader.readSubjectWith.mock.calls[0] as unknown[])[0]).toBe(client);
    expect((servicesReader.readForPatientWith.mock.calls[0] as unknown[])[0]).toBe(client);
    expect((servicesReader.readForPatientWith.mock.calls[0] as unknown[])[1]).toBe(PID);
    expect(functions.logger.info).not.toHaveBeenCalled();
  });

  it("ACTIVE coberto (8/8) → 'unchanged', mover 0×", async () => {
    const { derivation, moveStatus } = montar({
      subject: { status: 'ACTIVE', country: 'AR', montado: true }, rows: linhas(servico('s1', 2)),
    });
    await expect(derivation.run(client, PID, NOW)).resolves.toBe('unchanged');
    expect(moveStatus).not.toHaveBeenCalled();
  });

  it('serviço sem vacante viva é ignorado: cheio + vazio-sem-vacante → ACTIVE', async () => {
    const { derivation, moveStatus } = montar({
      subject: { status: 'REPLACEMENT', country: 'AR', montado: true },
      rows: linhas(servico('s1', 2), servico('s2', 0, null)),
    });
    await expect(derivation.run(client, PID, NOW)).resolves.toBe('moved');
    expect(moveStatus.mock.calls[0].slice(0, 2)).toEqual([PID, 'ACTIVE']);
  });

  it("sem serviço ativo (leitor devolve null) → 'unchanged'", async () => {
    const { derivation, moveStatus } = montar({ rows: null });
    await expect(derivation.run(client, PID, NOW)).resolves.toBe('unchanged');
    expect(moveStatus).not.toHaveBeenCalled();
  });

  it('borda 9 — alvo ACTIVE recusado pela completude: fica, e a recusa é registrada sem PII', async () => {
    const move = jest.fn(async () => { throw new PatientStatusNotReadyError('ACTIVE', ['ADDRESS']); });
    const { derivation } = montar({
      subject: { status: 'REPLACEMENT', country: 'AR', montado: true }, rows: linhas(servico('s1', 2)), move,
    });
    await expect(derivation.run(client, PID, NOW)).resolves.toBe('not_ready');
    expect(functions.logger.warn).toHaveBeenCalledTimes(1);
    const [evento, payload] = (functions.logger.warn as jest.Mock).mock.calls[0];
    expect(evento).toBe('patient_status.derivation_not_ready');
    expect(payload).toEqual({ patientId: PID, from: 'REPLACEMENT', to: 'ACTIVE', code: 'PATIENT_STATUS_NOT_READY', missing: ['ADDRESS'] });
    expect(Object.keys(payload).sort()).toEqual(['code', 'from', 'missing', 'patientId', 'to']);
    expect(functions.logger.info).not.toHaveBeenCalled();
  });

  it('borda 9 — alvo SEARCHING recusado por SERVICE_SCHEDULE: fica, mesma trilha', async () => {
    const move = jest.fn(async () => { throw new PatientStatusNotReadyError('SEARCHING', ['SERVICE_SCHEDULE']); });
    const { derivation } = montar({
      subject: { status: 'ACTIVE', country: 'AR', montado: true }, rows: linhas(servico('s1', 0)), move,
    });
    await expect(derivation.run(client, PID, NOW)).resolves.toBe('not_ready');
    expect((functions.logger.warn as jest.Mock).mock.calls[0]).toEqual([
      'patient_status.derivation_not_ready',
      { patientId: PID, from: 'ACTIVE', to: 'SEARCHING', code: 'PATIENT_STATUS_NOT_READY', missing: ['SERVICE_SCHEDULE'] },
    ]);
  });

  it('outro erro (PatientStatusTransitionError) propaga — desfaz a transação do escritor', async () => {
    const erro = new PatientStatusTransitionError('SEARCHING', 'REPLACEMENT');
    const move = jest.fn(async () => { throw erro; });
    const { derivation } = montar({ move });
    await expect(derivation.run(client, PID, NOW)).rejects.toBe(erro);
    expect(functions.logger.warn).not.toHaveBeenCalled();
  });

  it('asOf = operationDateOf(AR, now): 2026-10-06T02:30Z é 2026-10-05 em Buenos Aires — a alocação que começa em 06/10 ainda não cobre', async () => {
    const now = new Date('2026-10-06T02:30:00Z');
    expect(now.toISOString().slice(0, 10)).toBe('2026-10-06'); // sanidade: em UTC já é 06/10
    const rows = linhas({
      services: [{ id: 's1', serviceCode: 'AT', weeklyHours: 8, authorizedHours: null, liveVacancyId: 'v-s1' }],
      slots: [faixa('s1', 's1-a', 1, '2026-10-06'), faixa('s1', 's1-b', 3, null)],
    });
    const { derivation, moveStatus } = montar({ subject: { status: 'REPLACEMENT', country: 'AR', montado: true }, rows });
    // asOf 2026-10-05 → a alocação não é vigente → 0/8 → SEARCHING (com asOf UTC seria 4/8 → REPLACEMENT = unchanged)
    await expect(derivation.run(client, PID, now)).resolves.toBe('moved');
    expect(moveStatus.mock.calls[0].slice(0, 2)).toEqual([PID, 'SEARCHING']);
  });

  it('construção sem deps: os leitores e o mover padrão existem (nenhuma query no construtor)', () => {
    expect(() => new PatientStatusDerivation()).not.toThrow();
  });
});
