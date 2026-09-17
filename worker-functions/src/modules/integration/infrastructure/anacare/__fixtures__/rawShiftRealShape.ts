/**
 * rawShiftRealShape.ts
 *
 * Fixture cuja FORMA é a real: os NOMES de campo foram capturados da resposta real do Ana Care
 * (`GET /api/shifts/`) em 17/09/2026 (paciente 9660, 88 turnos amostrados) — os VALORES abaixo são
 * SINTÉTICOS (nenhum dado real de paciente/prestador). Existe porque o `FakeAnaCareShiftsSource`
 * implementa a PORTA (`SourceShiftDTO` pronto) e nunca passa pela minimização — por isso a suíte
 * anterior ficava verde com 5 nomes de campo quebrados (`date`/`scheduled_start`/`scheduled_end`/
 * `actual_start`/`actual_end`, que não existem na resposta real). Só esta fixture alimenta
 * `minimizeShiftDTO` com uma FORMA fiel à fonte.
 *
 * Três casos medidos (ver `AnaCareFieldMinimization.ts`, comentário de `RawAnaCareShift`):
 *   - noturno cruzando a meia-noite, com check-in e checkout;
 *   - com check-in e SEM checkout (`checkout: null`);
 *   - sem check-in nenhum, `is_finalized: false`.
 * Offset `-06:00` em 100% dos 88 medidos (fuso da plataforma, não o argentino).
 */
import type { RawAnaCarePatient, RawAnaCareNurse, RawAnaCareShift } from '../AnaCareFieldMinimization';

export function rawPatientRealShape(overrides: Partial<RawAnaCarePatient> = {}): RawAnaCarePatient {
  return {
    id: 9660,
    agency: 116,
    document_type: 'DNI',
    document_number: '30111222',
    first_name: 'Sintético',
    last_name: 'Fixture',
    ...overrides,
  };
}

export function rawNurseRealShape(overrides: Partial<RawAnaCareNurse> = {}): RawAnaCareNurse {
  return {
    id: 91116,
    agency: 116,
    first_name: 'Sintético',
    last_name: 'Prestador',
    ...overrides,
  };
}

function rawShiftBase(overrides: Partial<RawAnaCareShift> = {}): RawAnaCareShift {
  return {
    id: 1858092,
    start: '2026-08-30T20:00:00-06:00',
    end: '2026-08-31T08:00:00-06:00',
    checkin: '2026-08-30T20:12:00-06:00',
    checkout: '2026-08-31T08:00:00-06:00',
    checkin_source: 'app',
    checkout_source: 'app',
    checkin_delay: 12,
    duration: 12,
    is_finalized: true,
    month: '2026-08',
    patient: rawPatientRealShape(),
    nurse: rawNurseRealShape(),
    ...overrides,
  };
}

/** Caso 1 — turno NOTURNO que cruza a meia-noite (20:00→08:00), com check-in e checkout. */
export function rawShiftNoturnoCruzaMeiaNoite(overrides: Partial<RawAnaCareShift> = {}): RawAnaCareShift {
  return rawShiftBase(overrides);
}

/** Caso 2 — turno com check-in e SEM checkout (`checkout: null`, ainda em andamento). */
export function rawShiftComCheckinSemCheckout(overrides: Partial<RawAnaCareShift> = {}): RawAnaCareShift {
  return rawShiftBase({
    id: 1858093,
    start: '2026-08-30T14:00:00-06:00',
    end: '2026-08-30T20:00:00-06:00',
    checkin: '2026-08-30T13:43:00-06:00',
    checkout: null,
    checkin_source: 'web_admin',
    checkout_source: null,
    checkin_delay: -17,
    duration: 6,
    is_finalized: false,
    ...overrides,
  });
}

/** Caso 3 — turno SEM check-in nenhum, `is_finalized: false`. */
export function rawShiftSemCheckin(overrides: Partial<RawAnaCareShift> = {}): RawAnaCareShift {
  return rawShiftBase({
    id: 1858094,
    start: '2026-08-29T20:00:00-06:00',
    end: '2026-08-30T08:00:00-06:00',
    checkin: null,
    checkout: null,
    checkin_source: null,
    checkout_source: null,
    checkin_delay: null,
    duration: 12,
    is_finalized: false,
  });
}
