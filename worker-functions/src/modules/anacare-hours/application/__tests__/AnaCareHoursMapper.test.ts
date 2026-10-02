import { mapShift, groupIntoPatients, buildSnapshot, computeActualHours, computeSnapshotState, joinSourceName, NO_SYNC_RUN_CONCLUSION, resolveDocumentNumberForAxonico } from '../AnaCareHoursMapper';
import type { SourceShiftDTO } from '../../domain/AnaCareShiftsSource';
import type { SyncRunConclusion } from '../../domain/AnaCareHoursSyncPorts';
import type { ValidationRow } from '../../infrastructure/ShiftHoursValidationRepository';
import type { IAnaCarePatientDocumentRepository } from '@modules/integration';

/** Conclusão "sync terminou tudo" — usada nos testes de `buildSnapshot` que não são sobre a conclusão em si (fresco/velho), pra não cair em `desconhecido` por omissão. */
const CONCLUSAO_COMPLETA: SyncRunConclusion = { status: 'done', reservationsTotal: 1, reservationsDone: 1 };

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
  // F2 (migration 457): sem o 4º argumento (conclusão), o sync nunca gravou nada para este mês —
  // isso é `desconhecido`, não mais `fresco` por omissão (mesma régua de `computeSnapshotState`).
  // Por isso estes 2 testes de fresco/velho passam `CONCLUSAO_COMPLETA` explicitamente: o que eles
  // provam é a interação de `stale`/`naoConstruido`, não a conclusão em si (coberta abaixo).
  it('monta o snapshot do mês fresco quando a fonte devolve retrato fresco E a corrida terminou completa', () => {
    const snapshot = buildSnapshot('2026-09', [], { stale: false, circuitBreakerOpen: false }, CONCLUSAO_COMPLETA);
    expect(snapshot.month).toBe('2026-09');
    expect(snapshot.stale).toBe(false);
    expect(snapshot.circuitBreakerOpen).toBe(false);
    expect(snapshot.snapshotState).toBe('fresco');
    expect(typeof snapshot.updatedAt).toBe('string');
  });

  it('repassa stale/circuitBreakerOpen da fonte tal qual — não hardcoda mais false (conserto de conformidade, 15/09)', () => {
    const snapshot = buildSnapshot('2026-09', [], { stale: true, circuitBreakerOpen: true }, CONCLUSAO_COMPLETA);
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

  // `naoConstruido` tem PRECEDÊNCIA sobre a conclusão — mesmo com uma corrida `running` gravada
  // (o mês foi zerado/recomeçado depois da corrida), `nao_construido` ainda vence.
  it('naoConstruido=true vence mesmo com uma corrida `running` gravada para o mês (precedência)', () => {
    const snapshot = buildSnapshot(
      '2026-09',
      [],
      { stale: false, circuitBreakerOpen: false, naoConstruido: true },
      { status: 'running', reservationsTotal: 144, reservationsDone: 49 },
    );
    expect(snapshot.snapshotState).toBe('nao_construido');
  });

  it('retrato sincronizado mas velho (stale=true, naoConstruido=false, corrida completa): snapshotState é `velho`, distinto de `nao_construido`', () => {
    const snapshot = buildSnapshot('2026-09', [], { stale: true, circuitBreakerOpen: false, naoConstruido: false }, CONCLUSAO_COMPLETA);
    expect(snapshot.snapshotState).toBe('velho');
  });

  // F2: sem NENHUMA conclusão gravada (`NO_SYNC_RUN_CONCLUSION`, default do 4º argumento) — é
  // `desconhecido`, mesmo com o retrato "fresco" do ponto de vista da fonte (stale=false). Este é
  // o caso das linhas de agosto/setembro que EXISTIAM antes da migration 457.
  it('sem conclusão gravada (default do 4º argumento) ⇒ desconhecido, nunca fresco por omissão', () => {
    const snapshot = buildSnapshot('2026-09', [], { stale: false, circuitBreakerOpen: false });
    expect(snapshot.snapshotState).toBe('desconhecido');
  });

  it('conclusão `running` ⇒ parcial, e o wire carrega reservationsTotal/reservationsDone', () => {
    const snapshot = buildSnapshot(
      '2026-09',
      [],
      { stale: false, circuitBreakerOpen: false },
      { status: 'running', reservationsTotal: 144, reservationsDone: 49 },
    );
    expect(snapshot.snapshotState).toBe('parcial');
    expect(snapshot.reservationsTotal).toBe(144);
    expect(snapshot.reservationsDone).toBe(49);
  });

  it('parcial sem contagens gravadas ainda (running, sem total/done) NÃO expõe os campos no wire (nunca 0 fingido)', () => {
    const snapshot = buildSnapshot(
      '2026-09',
      [],
      { stale: false, circuitBreakerOpen: false },
      { status: 'running', reservationsTotal: null, reservationsDone: null },
    );
    expect(snapshot.snapshotState).toBe('parcial');
    expect(snapshot.reservationsTotal).toBeUndefined();
    expect(snapshot.reservationsDone).toBeUndefined();
  });

  it('fresco/velho NÃO carregam reservationsTotal/reservationsDone no wire (só `parcial` expõe)', () => {
    const fresco = buildSnapshot('2026-09', [], { stale: false, circuitBreakerOpen: false }, CONCLUSAO_COMPLETA);
    expect(fresco.reservationsTotal).toBeUndefined();
    expect(fresco.reservationsDone).toBeUndefined();
  });
});

describe('computeSnapshotState — precedência fechada (proposal.md §Decisão fechada)', () => {
  const BASE = { naoConstruido: false, stale: false, syncStatus: null as SyncRunConclusion['status'], reservationsTotal: null, reservationsDone: null };

  it('1. nao_construido — vence mesmo com stale=true e syncStatus=done completo', () => {
    expect(computeSnapshotState({ ...BASE, naoConstruido: true, stale: true, syncStatus: 'done', reservationsTotal: 1, reservationsDone: 1 })).toBe(
      'nao_construido',
    );
  });

  it('2. desconhecido — syncStatus IS NULL (naoConstruido=false)', () => {
    expect(computeSnapshotState({ ...BASE, syncStatus: null })).toBe('desconhecido');
  });

  /**
   * 🔴 TESTE-RÉGUA (regra dura da task, proposal.md Decisão 3): as linhas de agosto/setembro que
   * JÁ EXISTEM (status IS NULL) são `desconhecido` e NUNCA `parcial` — mesmo com `stale=true`
   * (elas também não têm base pra afirmar "velho": não sabem se terminaram). Este teste MORRE se
   * alguém trocar `if (input.syncStatus === null) return 'desconhecido'` por qualquer coisa que
   * deixe `status IS NULL` cair em `parcial`.
   */
  it('🔴 RÉGUA — status IS NULL nunca vira parcial, mesmo com stale=true (linhas pré-existentes de ago/set)', () => {
    const estado = computeSnapshotState({ ...BASE, stale: true, syncStatus: null });
    expect(estado).toBe('desconhecido');
    expect(estado).not.toBe('parcial');
  });

  it('3a. parcial — syncStatus=running', () => {
    expect(computeSnapshotState({ ...BASE, syncStatus: 'running', reservationsTotal: 144, reservationsDone: 49 })).toBe('parcial');
  });

  it('3b. parcial — syncStatus=failed', () => {
    expect(computeSnapshotState({ ...BASE, syncStatus: 'failed', reservationsTotal: 144, reservationsDone: 49 })).toBe('parcial');
  });

  /**
   * CONTROLE POSITIVO OBRIGATÓRIO (Decisão 9 da proposta / design.md §F2): sabota o estado para
   * 49 de 144 reservas (`status='done'`, `reservations_done=49`, `reservations_total=144`) — a
   * régua tem que DEIXAR de dizer `fresco`. Sem este teste passando, nada prova que `parcial`
   * detecta uma corrida `done` incompleta.
   */
  it('3c. CONTROLE POSITIVO — done com 49/144 reservas (sabotado) ⇒ parcial, NUNCA fresco', () => {
    const estado = computeSnapshotState({ ...BASE, syncStatus: 'done', reservationsTotal: 144, reservationsDone: 49 });
    expect(estado).toBe('parcial');
    expect(estado).not.toBe('fresco');
  });

  it('3d. done com reservationsDone === reservationsTotal (144/144) NÃO é parcial — segue para velho/fresco', () => {
    expect(computeSnapshotState({ ...BASE, syncStatus: 'done', reservationsTotal: 144, reservationsDone: 144 })).toBe('fresco');
  });

  it('3e. done sem contagens gravadas (total/done null) não tem base pra dizer parcial — segue para velho/fresco', () => {
    expect(computeSnapshotState({ ...BASE, syncStatus: 'done', reservationsTotal: null, reservationsDone: null })).toBe('fresco');
  });

  it('4. velho — done completo mas stale=true (regra de stale continua tendo prioridade sobre fresco)', () => {
    expect(computeSnapshotState({ ...BASE, stale: true, syncStatus: 'done', reservationsTotal: 144, reservationsDone: 144 })).toBe('velho');
  });

  it('5. fresco — done completo e não-stale (só sobra quando nada acima capturou o estado)', () => {
    expect(computeSnapshotState({ ...BASE, stale: false, syncStatus: 'done', reservationsTotal: 144, reservationsDone: 144 })).toBe('fresco');
  });

  it('NO_SYNC_RUN_CONCLUSION exportado é o "desconhecido" canônico (status/contagens null)', () => {
    expect(NO_SYNC_RUN_CONCLUSION).toEqual({ status: null, reservationsTotal: null, reservationsDone: null });
  });
});

/**
 * R1 (achado do gate `revisao-pr`, 25/09/2026): chamando `resolveDocumentNumberForAxonico`
 * DIRETO (sem passar por `AnaCareHoursService.getPatientMonth`) — o stub de fonte usado nos testes
 * do serviço já filtra `listShifts({ patientId })` por paciente, então mascararia este bug. Aqui o
 * array `sourceShifts` carrega turnos de DOIS pacientes de propósito, com o de OUTRO paciente
 * vindo PRIMEIRO — sem o filtro por `anaCarePatientId`, o `.find` pegaria o documento errado.
 */
describe('resolveDocumentNumberForAxonico — R1 (chave do Axonico só do próprio paciente)', () => {
  function mockPatientDocuments(overrides: Partial<jest.Mocked<IAnaCarePatientDocumentRepository>> = {}): jest.Mocked<IAnaCarePatientDocumentRepository> {
    return {
      findByPatientId: jest.fn().mockResolvedValue(null),
      insert: jest.fn(),
      ...overrides,
    } as jest.Mocked<IAnaCarePatientDocumentRepository>;
  }

  const TURNO_OUTRO_PACIENTE: SourceShiftDTO = {
    ...SOURCE,
    sourceShiftId: 'FAKE-2026-09-OUTRO-0',
    anaCarePatientId: 'AC-PAT-OUTRO',
    patientDocumentType: 'DNI',
    patientDocumentNumber: '11111111',
  };

  const TURNO_PACIENTE_CERTO: SourceShiftDTO = {
    ...SOURCE,
    sourceShiftId: 'FAKE-2026-09-CERTO-0',
    anaCarePatientId: 'AC-PAT-CERTO',
    patientDocumentType: 'DNI',
    patientDocumentNumber: '99999999',
  };

  it('🔴 RÉGUA — turno de OUTRO paciente com documento vem ANTES na lista; o documento usado é o do paciente CERTO', async () => {
    const sourceShifts = [TURNO_OUTRO_PACIENTE, TURNO_PACIENTE_CERTO];
    const documentNumber = await resolveDocumentNumberForAxonico(sourceShifts, 'AC-PAT-CERTO', mockPatientDocuments());
    expect(documentNumber).toBe('99999999');
    expect(documentNumber).not.toBe('11111111');
  });

  it('sem turno do paciente certo com documento, cai no fallback do repositório registrado (mesmo com turno de outro paciente na lista)', async () => {
    const patientDocuments = mockPatientDocuments({
      findByPatientId: jest.fn().mockResolvedValue({
        id: 'doc-1',
        anaCarePatientId: 'AC-PAT-CERTO',
        documentNumber: '40111222',
        documentType: 'DNI',
        registeredBy: 'uid-staff-1',
        createdAt: new Date('2026-09-01T00:00:00Z'),
        updatedAt: new Date('2026-09-01T00:00:00Z'),
      }),
    });
    const sourceShifts = [TURNO_OUTRO_PACIENTE, { ...TURNO_PACIENTE_CERTO, patientDocumentNumber: null }];
    const documentNumber = await resolveDocumentNumberForAxonico(sourceShifts, 'AC-PAT-CERTO', patientDocuments);
    expect(documentNumber).toBe('40111222');
    expect(patientDocuments.findByPatientId).toHaveBeenCalledWith('AC-PAT-CERTO');
  });
});
