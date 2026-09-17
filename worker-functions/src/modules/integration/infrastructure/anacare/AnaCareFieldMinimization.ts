/**
 * AnaCareFieldMinimization — minimização na borda (spec §Minimização, fase-2.md).
 *
 * O payload cru do Ana Care (turno com `patient`/`nurse` aninhados) traz telefone, endereço,
 * `location`/`initial_location`, valor de pagamento, observação clínica e CURP/RFC do
 * prestador. Nada disso pode chegar ao domínio — as funções aqui são o ÚNICO ponto de tradução
 * bruto→minimizado; `AnaCareShiftsSourceReal` nunca lê o raw fora daqui (ver
 * AnaCareShiftsSourceReal.ts). Consumidor adicional planejado (`AnaCarePatientApiReal`, porta de
 * reconciliação de paciente) ficou de fora deste módulo por ora — reconciliação de paciente
 * passou a ser manual (decisão do Gabriel, 16/09), não portada pra stage.
 *
 * `POISON_MARKER` só existe para o teste de contrato — não é usado fora de fixture.
 */

import type { SourceShiftDTO } from '../../../anacare-hours/domain/AnaCareShiftsSource';

export const POISON_MARKER = '__POISON__';

/** Forma crua de um paciente aninhado em `/api/shifts/` (campos permitidos + os descartados). */
export interface RawAnaCarePatient {
  id: number | string;
  agency: number | null;
  document_type: string | null;
  document_number: string | null;
  first_name: string;
  last_name: string;
  // Descartados na borda — nunca saem daqui:
  phone?: unknown;
  address?: unknown;
  location?: unknown;
  initial_location?: unknown;
}

/** Forma crua de um turno de `/api/shifts/` (campos permitidos + os descartados). */
export interface RawAnaCareShift {
  id: number | string;
  date: string;
  scheduled_start: string;
  scheduled_end: string;
  actual_start: string | null;
  actual_end: string | null;
  checkin_source: 'app' | 'web_admin' | null;
  /**
   * Horas PREVISTAS (`scheduled_end - scheduled_start`) — medido 17/09 contra a API real (paciente
   * 9660, 88 turnos): o campo cru chama `duration`, não `duration_hours` (que não existe na
   * resposta), e vem preenchido mesmo em turno NÃO finalizado com o valor do previsto. Nunca usar
   * para hora trabalhada — ver `is_finalized` e `SourceShiftDTO.isFinalized`.
   */
  duration: number | null;
  /** Afirmação do próprio Ana Care de que o turno fechou (medido: finalizado ⇒ tem check-in). */
  is_finalized: boolean;
  patient: RawAnaCarePatient;
  nurse: RawAnaCareNurse;
  // Descartados na borda — nunca saem daqui:
  delay_minutes?: unknown;
  payment_amount?: unknown;
  observations?: unknown;
}

/**
 * Forma crua do prestador aninhado no turno — CURP/RFC/telefone existem no raw, nunca no DTO.
 * `agency` é o campo de agência do PRESTADOR (`shift.nurse.agency`, inteiro direto — não objeto
 * aninhado; fato medido F7/F13, `docs/funcionalidades/ana-care/tela-conferencia-de-horas.md`
 * linha 91) — necessário para a 2ª perna do OR de universo D340 (paciente com `agency` nula E
 * prestador `agency===116`).
 */
export interface RawAnaCareNurse {
  id: number | string;
  agency: number | null;
  first_name: string;
  last_name: string;
  curp?: unknown;
  rfc?: unknown;
  phone?: unknown;
}

/**
 * Campos crus do paciente que sobrevivem à minimização — reflete literalmente
 * fase-2.md: "só passam ids, nomes (quando a porta precisar), ... documento/agência" (F13).
 * Nenhum outro campo do `RawAnaCarePatient` é copiado, mesmo que apareça no raw.
 */
export function minimizePatientFields(raw: RawAnaCarePatient): Readonly<Record<string, unknown>> {
  return Object.freeze({
    id: raw.id,
    agency: raw.agency,
    document_type: raw.document_type,
    document_number: raw.document_number,
    first_name: raw.first_name,
    last_name: raw.last_name,
  });
}

/**
 * Mapeia o turno cru para o DTO da porta `AnaCareShiftsSource` (spec AnaCareShiftsSource.ts) —
 * as 10 chaves do DTO SÃO o contrato de minimização: qualquer campo fora dessa lista não pode
 * existir no objeto retornado.
 */
export function minimizeShiftDTO(raw: RawAnaCareShift): SourceShiftDTO {
  return {
    sourceShiftId: String(raw.id),
    anaCarePatientId: String(raw.patient.id),
    anaCareNurseId: String(raw.nurse.id),
    date: raw.date,
    scheduledStart: raw.scheduled_start,
    scheduledEnd: raw.scheduled_end,
    actualStart: raw.actual_start,
    actualEnd: raw.actual_end,
    checkinSource: raw.checkin_source,
    isFinalized: raw.is_finalized,
  };
}
