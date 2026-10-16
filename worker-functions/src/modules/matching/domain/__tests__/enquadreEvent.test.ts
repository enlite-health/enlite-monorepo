import {
  buildEnquadreEventTitle,
  columnOfStage,
  enquadreEventPhase,
  eventCounters,
  participantColumn,
  type EnquadreParticipantOutcome,
} from '../enquadreEvent';
import { titleHasExactCode } from '../admissionImport';

describe('enquadreEventPhase — a fase é decidida no servidor', () => {
  const endsAt = new Date('2026-10-16T15:00:00.000Z');
  const before = new Date('2026-10-16T14:59:59.999Z');
  const after = new Date('2026-10-16T15:00:00.001Z');

  it('aberto antes do fim = scheduled', () => {
    expect(enquadreEventPhase('open', endsAt, before)).toBe('scheduled');
  });

  it('aberto depois do fim = pending_close (não se encerra sozinho)', () => {
    expect(enquadreEventPhase('open', endsAt, after)).toBe('pending_close');
  });

  it('FRONTEIRA: now == endsAt já é pending_close', () => {
    expect(enquadreEventPhase('open', endsAt, new Date(endsAt))).toBe('pending_close');
  });

  it('encerrado e cancelado ignoram o relógio', () => {
    expect(enquadreEventPhase('closed', endsAt, before)).toBe('closed');
    expect(enquadreEventPhase('cancelled', endsAt, after)).toBe('cancelled');
  });
});

describe('participantColumn — aberto lê o estágio vigente, encerrado lê o carimbo', () => {
  it.each([
    ['SELECTED', 'SELECTED'],
    ['QUICK_RESPONSE_TEAM', 'QUICK_RESPONSE_TEAM'],
    ['REJECTED', 'REJECTED'],
    ['COMPLETED', 'CONVOKED'],
    ['IN_DOUBT', 'CONVOKED'],
    [null, 'CONVOKED'],
  ])('evento ABERTO, estágio %s -> %s', (stage, column) => {
    expect(participantColumn({ eventStatus: 'open', currentStage: stage, outcome: null })).toBe(column);
    expect(columnOfStage(stage)).toBe(column);
  });

  it('evento ENCERRADO vale o carimbo, mesmo com o estágio vigente diferente', () => {
    // o prestador foi marcado Selecionado no evento e HOJE está Rejeitado no funil: o histórico do evento não muda
    expect(participantColumn({ eventStatus: 'closed', currentStage: 'REJECTED', outcome: 'selected' })).toBe('SELECTED');
    expect(participantColumn({ eventStatus: 'closed', currentStage: 'SELECTED', outcome: 'rejected' })).toBe('REJECTED');
    expect(participantColumn({ eventStatus: 'closed', currentStage: 'SELECTED', outcome: 'quick_response' })).toBe('QUICK_RESPONSE_TEAM');
  });

  it('encerrado com carimbo returned volta a Convocados, ainda que o estágio vigente seja outro', () => {
    expect(participantColumn({ eventStatus: 'closed', currentStage: 'SELECTED', outcome: 'returned' })).toBe('CONVOKED');
  });

  it('cancelado: todos em Convocados', () => {
    expect(participantColumn({ eventStatus: 'cancelled', currentStage: 'SELECTED', outcome: null })).toBe('CONVOKED');
  });
});

describe('eventCounters', () => {
  it('conta carimbos, marcados e não marcados', () => {
    const mk = (column: 'CONVOKED' | 'SELECTED' | 'REJECTED' | 'QUICK_RESPONSE_TEAM', outcome: EnquadreParticipantOutcome | null) => ({ column, outcome });
    const c = eventCounters([
      mk('SELECTED', 'selected'),
      mk('SELECTED', 'selected'),
      mk('QUICK_RESPONSE_TEAM', 'quick_response'),
      mk('REJECTED', 'rejected'),
      mk('CONVOKED', 'returned'),
    ]);
    expect(c).toEqual({
      convokedCount: 5,
      markedCount: 4,
      unmarkedCount: 1,
      outcome: { selected: 2, quickResponse: 1, rejected: 1, returned: 1 },
    });
  });

  it('evento aberto: sem carimbo, os contadores de outcome ficam em zero', () => {
    const c = eventCounters([{ column: 'SELECTED', outcome: null }, { column: 'CONVOKED', outcome: null }]);
    expect(c.outcome).toEqual({ selected: 0, quickResponse: 0, rejected: 0, returned: 0 });
    expect(c.markedCount).toBe(1);
    expect(c.unmarkedCount).toBe(1);
  });
});

describe('buildEnquadreEventTitle', () => {
  const FIRST_NAME = 'Primeironome';
  const LAST_NAME = 'Sobrenome Ficticio';
  const input = { caseNumber: 1234, eventCode: 'ENC-AB12CD' };

  it('tem o código do evento e o título casa com o leitor do Tactiq (titleHasExactCode)', () => {
    const title = buildEnquadreEventTitle(input);
    expect(title).toContain('ENC-AB12CD');
    expect(titleHasExactCode(title, 'ENC-AB12CD')).toBe(true);
  });

  it('tem o número do caso e o código, no formato combinado — e nada do paciente', () => {
    expect(buildEnquadreEventTitle(input)).toBe('Encuadre terapéutico — Caso 1234 · ENC-AB12CD');
  });

  it('NÃO contém nome nem sobrenome do paciente, mesmo que alguém os passe (a função nem recebe esses parâmetros)', () => {
    // Regressão de 16/10/2026: o sobrenome aparecia no convite visto por prestadores que ainda não atuam no caso.
    const title = buildEnquadreEventTitle({
      ...input,
      ...({ patientFirstName: FIRST_NAME, patientLastName: LAST_NAME, lastName: LAST_NAME } as object),
    });
    expect(title).not.toContain(FIRST_NAME);
    expect(title).not.toContain(LAST_NAME);
    expect(title).toBe('Encuadre terapéutico — Caso 1234 · ENC-AB12CD');
  });

  it('sem nº do caso omite o trecho: nunca imprime undefined/null', () => {
    for (const t of [buildEnquadreEventTitle({ ...input, caseNumber: null }), buildEnquadreEventTitle({ ...input, caseNumber: Number.NaN })]) {
      expect(t).not.toMatch(/undefined|null|NaN/);
      expect(t).toContain('ENC-AB12CD');
    }
    expect(buildEnquadreEventTitle({ ...input, caseNumber: null })).toBe('Encuadre terapéutico — ENC-AB12CD');
  });
});
