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

/**
 * Forma crua de um turno de `/api/shifts/` (campos permitidos + os descartados).
 *
 * ⚠️ Nomes MEDIDOS contra a API real 17/09/2026 (paciente 9660, 88 turnos) — `date`,
 * `scheduled_start`, `scheduled_end`, `actual_start`, `actual_end` NÃO EXISTEM na resposta (eram
 * nomes chutados de uma versão anterior/documentação, nunca confirmados contra o payload real).
 * Ler esses nomes inexistentes fazia `minimizeShiftDTO` devolver `undefined` neles — que o
 * repositório gravava como `null`/`NaN` e a coluna `shift_date` (NOT NULL) rejeitava com 500. Os
 * nomes certos são `start`/`end`/`checkin`/`checkout`; não existe campo `date` — o dia do turno é
 * DERIVADO (ver `shiftDayFrom`).
 */
export interface RawAnaCareShift {
  id: number | string;
  /** Início previsto, ISO 8601 com offset — medido: sempre `-06:00` (fuso mexicano da plataforma, não o argentino). */
  start: string;
  /** Fim previsto, mesmo formato de `start`. */
  end: string;
  /** Check-in real, ou `null` sem check-in. */
  checkin: string | null;
  /** Checkout real, ou `null` (sem checkout — turno em andamento ou nunca fechado). */
  checkout: string | null;
  checkin_source: 'app' | 'web_admin' | null;
  /** Origem do CHECKOUT — existe na fonte, hoje não mapeada no DTO (item 5, achado do PR #414). */
  checkout_source: 'app' | 'web_admin' | null;
  /** Atraso do check-in em minutos, afirmação da fonte — existe na fonte, hoje não mapeado no DTO. */
  checkin_delay: number | null;
  /**
   * Horas PREVISTAS (`end - start`) — medido 17/09 contra a API real: vem preenchido mesmo em
   * turno NÃO finalizado com o valor do previsto. Nunca usar para hora trabalhada — ver
   * `is_finalized` e `SourceShiftDTO.isFinalized`.
   */
  duration: number | null;
  /** Afirmação do próprio Ana Care de que o turno fechou (medido: finalizado ⇒ tem check-in). */
  is_finalized: boolean;
  /**
   * `YYYY-MM` afirmado pela PRÓPRIA fonte — medido: presente em 88/88 turnos amostrados. Fonte da
   * verdade para `SourceShiftDTO.sourceMonth` (ver `minimizeShiftDTO`); sem ele, cai no fallback
   * derivado do dia (`monthOfDate`).
   */
  month: string | null;
  patient: RawAnaCarePatient;
  nurse: RawAnaCareNurse;
  // Descartados na borda — nunca saem daqui:
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
 * O dia do turno é DERIVADO do `start` — não existe campo `date` na resposta real (medido
 * 17/09/2026). **Decisão explícita e reversível (pendente do Gabriel):** o turno pertence ao dia
 * em que COMEÇA, pelo prefixo `YYYY-MM-DD` do `start` COMO A FONTE ENVIA (offset `-06:00`), sem
 * converter para o fuso argentino.
 *
 * Por quê: 36% dos turnos cruzam a meia-noite (medido: 32 de 88, noturnos 20:00→08:00), e é o
 * próprio Ana Care que os lista como uma linha só ancorada no início. A tela existe para CONFERIR
 * contra o Ana Care e o operador vai comparar com a tela deles — divergir da apresentação da fonte
 * numa tela de conciliação é pior do que herdar o fuso dela. Nos 88 turnos medidos o resultado do
 * prefixo `-06:00` é IDÊNTICO ao dia em `America/Argentina/Buenos_Aires`; a margem medida é de 1
 * hora (um turno começando 21:00 argentino já viraria o dia se convertido).
 *
 * Função nomeada — não inline — para ter um único dono desta decisão.
 */
export function shiftDayFrom(start: string): string {
  return start.slice(0, 10);
}

/** `YYYY-MM` a partir do dia derivado (`shiftDayFrom`) — fallback quando `raw.month` não vier. */
function monthOfDate(dateStr: string): string {
  return dateStr.slice(0, 7);
}

/**
 * Mapeia o turno cru para o DTO da porta `AnaCareShiftsSource` (spec AnaCareShiftsSource.ts) —
 * as 13 chaves do DTO SÃO o contrato de minimização: qualquer campo fora dessa lista não pode
 * existir no objeto retornado. Nomes de campo do `raw` conferidos contra a API real 17/09/2026
 * (ver comentário de `RawAnaCareShift`) — os 5 antigos (`date`/`scheduled_start`/`scheduled_end`/
 * `actual_start`/`actual_end`) não existem e nunca devem voltar a ser lidos aqui.
 */
export function minimizeShiftDTO(raw: RawAnaCareShift): SourceShiftDTO {
  const date = shiftDayFrom(raw.start);
  return {
    sourceShiftId: String(raw.id),
    anaCarePatientId: String(raw.patient.id),
    anaCareNurseId: String(raw.nurse.id),
    date,
    scheduledStart: raw.start,
    scheduledEnd: raw.end,
    actualStart: raw.checkin,
    actualEnd: raw.checkout,
    checkinSource: raw.checkin_source,
    checkoutSource: raw.checkout_source,
    checkinDelay: raw.checkin_delay,
    isFinalized: raw.is_finalized,
    // `raw.month` é afirmação da fonte (existe em 88/88 medidos); fallback só para um raw sem ele.
    sourceMonth: raw.month ?? monthOfDate(date),
  };
}
