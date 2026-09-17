import { mapShift, groupIntoPatients, buildSnapshot, computeActualHours } from '../AnaCareHoursMapper';
import type { SourceShiftDTO } from '../../domain/AnaCareShiftsSource';
import type { ValidationRow } from '../../infrastructure/ShiftHoursValidationRepository';

// Previsto (`scheduledStart`→`scheduledEnd`) = 12h. Real (`actualStart`→`actualEnd`) = 11,8h —
// mesmo padrão medido 17/09 contra a API real (paciente 9660: previsto 12,0 / real 11,8). O
// propósito do fixture é NUNCA deixar previsto e real coincidirem, para que um `mapShift` que
// volte a ler o previsto (o defeito original) quebre o teste.
const SOURCE: SourceShiftDTO = {
  sourceShiftId: 'FAKE-2026-09-0-0-0',
  anaCarePatientId: 'AC-PAT-0',
  anaCareNurseId: 'AC-NURSE-0-0',
  date: '2026-09-10',
  scheduledStart: '2026-09-10T08:00:00.000Z',
  scheduledEnd: '2026-09-10T20:00:00.000Z',
  actualStart: '2026-09-10T08:00:00.000Z',
  actualEnd: '2026-09-10T19:48:00.000Z',
  checkinSource: 'app',
  isFinalized: true,
};

/** Turno NÃO finalizado e SEM check-in (23/30 da amostra medida 17/09) — sem actual, sem `duration` a copiar. */
const SOURCE_SEM_CHECKIN: SourceShiftDTO = {
  ...SOURCE,
  sourceShiftId: 'FAKE-2026-09-0-0-1',
  actualStart: null,
  actualEnd: null,
  checkinSource: null,
  isFinalized: false,
};

const VALIDATED: ValidationRow = {
  sourceShiftId: SOURCE.sourceShiftId,
  status: 'validado',
  approvedHours: 4,
  approvedCheckinAt: SOURCE.actualStart,
  approvedCheckoutAt: SOURCE.actualEnd,
  approvedCheckinSource: 'app',
  validatedBy: 'uid-1',
  validatedByName: 'Fulana QA',
  validatedAt: '2026-09-11T00:00:00.000Z',
  reason: null,
  noteEncrypted: null,
};

const CONTESTED: ValidationRow = {
  sourceShiftId: SOURCE.sourceShiftId,
  status: 'contestado',
  approvedHours: null,
  approvedCheckinAt: null,
  approvedCheckoutAt: null,
  approvedCheckinSource: null,
  validatedBy: null,
  validatedByName: null,
  validatedAt: null,
  reason: 'no_asistio',
  noteEncrypted: 'Y2lmcmE=',
};

describe('mapShift', () => {
  it('sem validação (pendente virtual): hoursActual vem do REAL (actualStart→actualEnd), NUNCA do previsto — morre se `mapShift` voltar a ler um campo de previsto da fonte', () => {
    const shift = mapShift(SOURCE, undefined, false, null);
    expect(shift.status).toBe('pendiente');
    expect(shift.hoursScheduled).toBe(12);
    expect(shift.hoursActual).toBe(11.8);
    expect(shift.hoursActual).not.toBe(shift.hoursScheduled);
    expect(shift.origin).toBe('app');
    expect(shift.validatedBy).toBeUndefined();
    expect(shift.contestReason).toBeUndefined();
  });

  it('turno NÃO finalizado e sem check-in: hoursActual null (nunca o previsto) — medido 17/09: `duration` vem preenchida mesmo sem check-in, e não pode vazar como hora trabalhada', () => {
    const shift = mapShift(SOURCE_SEM_CHECKIN, undefined, false, null);
    expect(shift.origin).toBe('sin_checkin');
    expect(shift.hoursActual).toBeNull();
  });

  it('turno com check-in mas SEM checkout ainda (em andamento): hoursActual null — falta actualEnd', () => {
    const emAndamento: SourceShiftDTO = { ...SOURCE, actualEnd: null };
    const shift = mapShift(emAndamento, undefined, false, null);
    expect(shift.hoursActual).toBeNull();
  });

  it('validado: hoursActual CONGELA no approvedHours, mesmo com um `actualEnd` da fonte que daria uma hora real BEM diferente', () => {
    const sourceComOutroReal: SourceShiftDTO = { ...SOURCE, actualStart: '2026-09-10T00:00:00.000Z', actualEnd: '2026-09-10T23:00:00.000Z' };
    const shift = mapShift(sourceComOutroReal, VALIDATED, false, null);
    expect(shift.status).toBe('validado');
    expect(shift.hoursActual).toBe(4);
    expect(shift.hoursActual).not.toBe(computeActualHours(sourceComOutroReal));
    expect(shift.validatedBy).toEqual({ id: 'uid-1', name: 'Fulana QA' });
    expect(shift.validatedAt).toBe('2026-09-11T00:00:00.000Z');
  });

  it('validado sem nome resolvido usa o id como fallback do nome', () => {
    const shift = mapShift(SOURCE, { ...VALIDATED, validatedByName: null }, false, null);
    expect(shift.validatedBy).toEqual({ id: 'uid-1', name: 'uid-1' });
  });

  it('contestado com célula clínica: mostra o motivo e a nota decifrada', () => {
    const shift = mapShift(SOURCE, CONTESTED, true, 'nota decifrada');
    expect(shift.contestReason).toBe('no_asistio');
    expect(shift.contestNote).toBe('nota decifrada');
  });

  it('contestado SEM célula clínica: mostra o motivo, mas NUNCA a nota (mesmo se decifrada foi passada por engano)', () => {
    const shift = mapShift(SOURCE, CONTESTED, false, 'nota decifrada');
    expect(shift.contestReason).toBe('no_asistio');
    expect(shift.contestNote).toBeUndefined();
  });

  it('contestado com célula clínica mas SEM nota (contestação sem texto livre): contestNote fica undefined, não string vazia', () => {
    const shift = mapShift(SOURCE, CONTESTED, true, null);
    expect(shift.contestReason).toBe('no_asistio');
    expect(shift.contestNote).toBeUndefined();
  });

  it('validado sem validatedAt na linha: validatedAt do shift fica undefined (nunca null)', () => {
    const shift = mapShift(SOURCE, { ...VALIDATED, validatedAt: null }, false, null);
    expect(shift.validatedAt).toBeUndefined();
  });
});

describe('groupIntoPatients', () => {
  it('agrupa turnos por paciente e depois por prestador', () => {
    const shiftA = mapShift(SOURCE, undefined, false, null);
    const shiftB = mapShift({ ...SOURCE, sourceShiftId: 'x2', anaCareNurseId: 'AC-NURSE-0-1' }, undefined, false, null);
    const shiftC = mapShift({ ...SOURCE, sourceShiftId: 'x3', anaCarePatientId: 'AC-PAT-1' }, undefined, false, null);

    const patients = groupIntoPatients([
      { shift: shiftA, anaCarePatientId: 'AC-PAT-0', anaCareNurseId: 'AC-NURSE-0-0' },
      { shift: shiftB, anaCarePatientId: 'AC-PAT-0', anaCareNurseId: 'AC-NURSE-0-1' },
      { shift: shiftC, anaCarePatientId: 'AC-PAT-1', anaCareNurseId: 'AC-NURSE-0-0' },
    ]);

    expect(patients).toHaveLength(2);
    const p0 = patients.find((p) => p.anaCareId === 'AC-PAT-0')!;
    expect(p0.linked).toBe(false);
    expect(p0.providers).toHaveLength(2);
    const p1 = patients.find((p) => p.anaCareId === 'AC-PAT-1')!;
    expect(p1.providers).toHaveLength(1);
  });

  it('lista vazia devolve nenhum paciente', () => {
    expect(groupIntoPatients([])).toEqual([]);
  });

  it('D349: prestador presente em providerLinks vem linked=true com o nome', () => {
    const shiftA = mapShift(SOURCE, undefined, false, null);
    const patients = groupIntoPatients(
      [{ shift: shiftA, anaCarePatientId: 'AC-PAT-0', anaCareNurseId: 'AC-NURSE-0-0' }],
      new Map([['AC-NURSE-0-0', 'Rocío García QA']]),
    );
    const provider = patients[0].providers[0];
    expect(provider.linked).toBe(true);
    expect(provider.name).toBe('Rocío García QA');
  });

  it('D349/D344: prestador vinculado mas SEM worker_contact:read vem linked=true e name undefined', () => {
    const shiftA = mapShift(SOURCE, undefined, false, null);
    const patients = groupIntoPatients(
      [{ shift: shiftA, anaCarePatientId: 'AC-PAT-0', anaCareNurseId: 'AC-NURSE-0-0' }],
      new Map([['AC-NURSE-0-0', undefined]]),
    );
    const provider = patients[0].providers[0];
    expect(provider.linked).toBe(true);
    expect(provider.name).toBeUndefined();
  });

  it('prestador AUSENTE de providerLinks (sem match em workers.ana_care_id) vem linked=false', () => {
    const shiftA = mapShift(SOURCE, undefined, false, null);
    const patients = groupIntoPatients(
      [{ shift: shiftA, anaCarePatientId: 'AC-PAT-0', anaCareNurseId: 'AC-NURSE-0-0' }],
      new Map([['AC-NURSE-OUTRO', 'Outra Pessoa']]),
    );
    const provider = patients[0].providers[0];
    expect(provider.linked).toBe(false);
    expect(provider.name).toBeUndefined();
  });

  it('paciente permanece SEMPRE linked=false, mesmo quando o prestador do grupo está vinculado (D349 item 2, bloqueado)', () => {
    const shiftA = mapShift(SOURCE, undefined, false, null);
    const patients = groupIntoPatients(
      [{ shift: shiftA, anaCarePatientId: 'AC-PAT-0', anaCareNurseId: 'AC-NURSE-0-0' }],
      new Map([['AC-NURSE-0-0', 'Rocío García QA']]),
    );
    expect(patients[0].linked).toBe(false);
    expect(patients[0].name).toBeUndefined();
  });
});

describe('buildSnapshot', () => {
  it('monta o snapshot do mês fresco quando a fonte devolve retrato fresco (fase 1: adapter falso)', () => {
    const snapshot = buildSnapshot('2026-09', [], { stale: false, circuitBreakerOpen: false });
    expect(snapshot.month).toBe('2026-09');
    expect(snapshot.stale).toBe(false);
    expect(snapshot.circuitBreakerOpen).toBe(false);
    expect(typeof snapshot.updatedAt).toBe('string');
  });

  it('repassa stale/circuitBreakerOpen da fonte tal qual — não hardcoda mais false (conserto de conformidade, 15/09)', () => {
    const snapshot = buildSnapshot('2026-09', [], { stale: true, circuitBreakerOpen: true });
    expect(snapshot.stale).toBe(true);
    expect(snapshot.circuitBreakerOpen).toBe(true);
  });
});
