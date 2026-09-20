import { mapShift, groupIntoPatients, buildSnapshot, computeActualHours, joinSourceName } from '../AnaCareHoursMapper';
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

  /**
   * Item 7 (revisão de PR): antes, `AnaCareShiftRepository.toDTO` mascarava `planned_start`/
   * `planned_end` ausentes como `''`, e `hoursBetween('', '')` devolvia `NaN` — que o JSON
   * serializa como `null` num campo tipado `number` (`hoursScheduled`), mentindo silenciosamente
   * sobre o contrato. Este teste MORRE se `mapShift` voltar a computar `hoursScheduled` direto de
   * `source.scheduledStart`/`scheduledEnd` sem passar pelo guard de `null`.
   */
  it('scheduledStart/scheduledEnd nulos (retrato sem o previsto gravado): hoursScheduled é 0, nunca NaN — e o wire mantém string vazia, não null', () => {
    const semPrevisto: SourceShiftDTO = { ...SOURCE, scheduledStart: null, scheduledEnd: null };
    const shift = mapShift(semPrevisto, undefined, false, null);
    expect(shift.hoursScheduled).toBe(0);
    expect(Number.isNaN(shift.hoursScheduled)).toBe(false);
    expect(shift.scheduledStart).toBe('');
    expect(shift.scheduledEnd).toBe('');
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

  it('D349: prestador presente em linkedNurseIds vem linked=true; nome vem de `nurseName` (item 1, da FONTE)', () => {
    const shiftA = mapShift(SOURCE, undefined, false, null);
    const patients = groupIntoPatients(
      [{ shift: shiftA, anaCarePatientId: 'AC-PAT-0', anaCareNurseId: 'AC-NURSE-0-0', nurseName: 'Rocío García QA' }],
      new Set(['AC-NURSE-0-0']),
    );
    const provider = patients[0].providers[0];
    expect(provider.linked).toBe(true);
    expect(provider.name).toBe('Rocío García QA');
  });

  it('D349/D344: `nurseName` ausente (chamador já aplicou o gate `worker_contact:read`) vem name undefined, MESMO linked=true', () => {
    const shiftA = mapShift(SOURCE, undefined, false, null);
    const patients = groupIntoPatients(
      [{ shift: shiftA, anaCarePatientId: 'AC-PAT-0', anaCareNurseId: 'AC-NURSE-0-0', nurseName: undefined }],
      new Set(['AC-NURSE-0-0']),
    );
    const provider = patients[0].providers[0];
    expect(provider.linked).toBe(true);
    expect(provider.name).toBeUndefined();
  });

  it('prestador AUSENTE de linkedNurseIds (sem match em workers.ana_care_id) vem linked=false — MESMO com nome da fonte (item 1: nome é independente de linked)', () => {
    const shiftA = mapShift(SOURCE, undefined, false, null);
    const patients = groupIntoPatients(
      [{ shift: shiftA, anaCarePatientId: 'AC-PAT-0', anaCareNurseId: 'AC-NURSE-0-0', nurseName: 'Carla Suárez QA' }],
      new Set(['AC-NURSE-OUTRO']),
    );
    const provider = patients[0].providers[0];
    expect(provider.linked).toBe(false);
    expect(provider.name).toBe('Carla Suárez QA');
  });

  it('paciente permanece SEMPRE linked=false (D349 item 2, bloqueado), mas o NOME vem da fonte independente disso (item 1)', () => {
    const shiftA = mapShift(SOURCE, undefined, false, null);
    const patients = groupIntoPatients(
      [{ shift: shiftA, anaCarePatientId: 'AC-PAT-0', anaCareNurseId: 'AC-NURSE-0-0', patientName: 'Lucía Fernández QA', nurseName: 'Rocío García QA' }],
      new Set(['AC-NURSE-0-0']),
    );
    expect(patients[0].linked).toBe(false);
    expect(patients[0].name).toBe('Lucía Fernández QA');
  });

  it('patientName ausente (fonte não mandou nome para o turno) vem name undefined — nunca um placeholder inventado', () => {
    const shiftA = mapShift(SOURCE, undefined, false, null);
    const patients = groupIntoPatients([{ shift: shiftA, anaCarePatientId: 'AC-PAT-0', anaCareNurseId: 'AC-NURSE-0-0' }]);
    expect(patients[0].name).toBeUndefined();
  });
});

describe('joinSourceName', () => {
  it('POSITIVO — junta first_name + last_name com espaço', () => {
    expect(joinSourceName('Lucía', 'Fernández QA')).toBe('Lucía Fernández QA');
  });

  it('NEGATIVO — os dois ausentes/null devolvem undefined, nunca string vazia', () => {
    expect(joinSourceName(null, null)).toBeUndefined();
    expect(joinSourceName(undefined, undefined)).toBeUndefined();
    expect(joinSourceName('', '')).toBeUndefined();
  });

  it('POSITIVO — só um dos dois presente ainda devolve algo (sem juntar com espaço sobrando)', () => {
    expect(joinSourceName('Lucía', null)).toBe('Lucía');
    expect(joinSourceName(null, 'Fernández QA')).toBe('Fernández QA');
  });
});

describe('buildSnapshot', () => {
  it('monta o snapshot do mês fresco quando a fonte devolve retrato fresco (fase 1: adapter falso)', () => {
    const snapshot = buildSnapshot('2026-09', [], { stale: false, circuitBreakerOpen: false });
    expect(snapshot.month).toBe('2026-09');
    expect(snapshot.stale).toBe(false);
    expect(snapshot.circuitBreakerOpen).toBe(false);
    expect(snapshot.snapshotState).toBe('fresco');
    expect(typeof snapshot.updatedAt).toBe('string');
  });

  it('repassa stale/circuitBreakerOpen da fonte tal qual — não hardcoda mais false (conserto de conformidade, 15/09)', () => {
    const snapshot = buildSnapshot('2026-09', [], { stale: true, circuitBreakerOpen: true });
    expect(snapshot.stale).toBe(true);
    expect(snapshot.circuitBreakerOpen).toBe(true);
  });

  /**
   * Item 3 (revisão de PR): `stale=true` sozinho não diz SE o retrato já foi construído — a tela
   * mostrava "há mais de 24 horas" mesmo quando o sync nunca rodou (mensagem falsa). Este teste
   * MORRE se `snapshotState` voltar a colapsar em só `stale`/`fresco`.
   */
  it('mês sem linha no banco (naoConstruido=true): snapshotState é `nao_construido`, mesmo com stale=false', () => {
    const snapshot = buildSnapshot('2026-09', [], { stale: false, circuitBreakerOpen: false, naoConstruido: true });
    expect(snapshot.snapshotState).toBe('nao_construido');
  });

  it('retrato sincronizado mas velho (stale=true, naoConstruido=false): snapshotState é `velho`, distinto de `nao_construido`', () => {
    const snapshot = buildSnapshot('2026-09', [], { stale: true, circuitBreakerOpen: false, naoConstruido: false });
    expect(snapshot.snapshotState).toBe('velho');
  });
});
