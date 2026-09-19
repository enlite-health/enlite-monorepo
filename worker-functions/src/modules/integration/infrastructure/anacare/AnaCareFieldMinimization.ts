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

import { logger } from '@shared/logging';
import type { SourceShiftDTO } from '../../../anacare-hours/domain/AnaCareShiftsSource';

const TAG = '[AnaCareFieldMinimization]';

export const POISON_MARKER = '__POISON__';

const KNOWN_SOURCE_VALUES = ['app', 'web_admin'] as const;
type KnownSourceValue = (typeof KNOWN_SOURCE_VALUES)[number];

/**
 * Valida `checkin_source`/`checkout_source` em RUNTIME — a união `'app' | 'web_admin' | null` do
 * `RawAnaCareShift` é só TIPO, não existe no payload em tempo de execução. A coluna do banco
 * (migration 437) tem `CHECK (... IS NULL OR ... IN ('app','web_admin'))`: um valor novo na fonte
 * rejeita o INSERT em LOTE (o mesmo modo de falha do `shift_date`, pela terceira vez nesta frente).
 * Perder a origem de UM turno (vira `null`) é muito melhor que perder o mês inteiro com um 500
 * opaco — e um valor novo é algo que queremos VER no log, não descobrir por um lote inteiro morto.
 */
function validateSourceField(
  field: 'checkin_source' | 'checkout_source',
  value: string | null,
): KnownSourceValue | null {
  if (value === null) return null;
  if ((KNOWN_SOURCE_VALUES as readonly string[]).includes(value)) {
    return value as KnownSourceValue;
  }
  logger.warn({ msg: `${TAG} valor desconhecido em campo de origem, gravando null`, field, value });
  return null;
}

/**
 * Forma crua de um paciente aninhado em `/api/shifts/` (campos permitidos + os descartados).
 *
 * `surname` — nome medido no payload real 17/09/2026 (decisão do Gabriel: "o nome vem junto na
 * requisição do Ana Care", item 1 da conferência de horas). `last_name` já existia neste tipo
 * como suposição anterior nunca confirmada contra a resposta real (usada só pelo consumidor
 * separado `minimizePatientFields`, sem uso no caminho de turnos) — mantido para não quebrar esse
 * consumidor, mas é `surname` (não `last_name`) o campo que a fonte de fato envia. `second_name` e
 * `mother_last_name` existem no payload e são DESCARTADOS de propósito — só nome e sobrenome vão
 * ao domínio (decisão do Gabriel, item 1).
 *
 * `identification_number`/`identification_type` — nomes REAIS medidos ao vivo contra o payload do
 * Ana Care (18/09/2026: preenchido em 52/168 reservas, 31%). Os nomes antigos `document_type`/
 * `document_number` NUNCA existiram na resposta real — eram suposição nunca confirmada (mesma
 * família de erro dos 5 nomes de turno corrigidos acima, `RawAnaCareShift`). O documento entra no
 * domínio só pelo caminho ao vivo do DETALHE (`minimizeShiftDTO`), atrás do gate `patient_identity:
 * read` (ver `AnaCareHoursController.canReadPatientDocument`) — nunca no retrato agregado.
 */
export interface RawAnaCarePatient {
  id: number | string;
  agency: number | null;
  /** Categoria do documento (ex. "DNI") — nome real do payload, medido 18/09/2026. */
  identification_type: string | null;
  /** Valor do documento — nome real do payload, medido 18/09/2026. */
  identification_number: string | null;
  first_name: string;
  last_name: string;
  /** Sobrenome — campo real medido 17/09/2026, usado para nome de exibição (item 1). */
  surname: string;
  // Descartados na borda — nunca saem daqui:
  second_name?: unknown;
  mother_last_name?: unknown;
  full_name?: unknown;
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
  /**
   * `null` quando o turno não tem paciente vinculado na fonte — medido 0/3.421 na varredura
   * 01–07/09/2026 (nunca visto), mas o TIPO admite porque a fonte não garante o contrário (mesmo
   * racional de `nurse` abaixo). Turno sem paciente não pode ser gravado (mesma família de FK NOT
   * NULL de `nurse` no retrato) — ver `minimizeShiftOrSkip`.
   */
  patient: RawAnaCarePatient | null;
  /**
   * `null` quando o turno está agendado sem prestador designado ainda — medido 15/3.421 (0,4%) na
   * varredura 01–07/09/2026 contra a API real. Causa do 500 em produção (17/09): a 4ª rodada do
   * sync morreu com `Cannot read properties of null (reading 'id')` ao ler `raw.nurse.id` sem
   * checar antes — `isEnliteUniverseShift` (`AnaCareSessionClient`) já tolerava com `?.`, só a
   * minimização não tolerava (instância consertada num lugar, irmã deixada atrás). Turno sem
   * prestador é DESCARTADO, nunca em silêncio — ver `minimizeShiftOrSkip`.
   */
  nurse: RawAnaCareNurse | null;
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
  /** Sobrenome — campo real medido 17/09/2026, usado para nome de exibição (item 1). */
  surname: string;
  curp?: unknown;
  rfc?: unknown;
  phone?: unknown;
  full_name?: unknown;
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
    identification_type: raw.identification_type,
    identification_number: raw.identification_number,
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
 * Erro nomeado — `minimizeShiftDTO` chamado com `raw.nurse === null`. Contrato: quem chama direto
 * garante não-nulo (ver `minimizeShiftOrSkip` para o caminho que TOLERA e conta). Nomeado em vez
 * de deixar o `TypeError` opaco de `raw.nurse.id` — foi esse `TypeError` opaco que apareceu como
 * 500 em produção 17/09 (`Cannot read properties of null (reading 'id')`), sem dizer QUAL campo.
 */
export class AnaCareMissingProviderError extends Error {
  constructor(readonly sourceShiftId: string) {
    super(`${TAG} turno ${sourceShiftId} sem prestador (raw.nurse === null) — minimizeShiftDTO exige não-nulo; use minimizeShiftOrSkip.`);
  }
}

/** Irmã de `AnaCareMissingProviderError` — `raw.patient === null` (medido 0/3.421, tipo admite mesmo assim). */
export class AnaCareMissingPatientError extends Error {
  constructor(readonly sourceShiftId: string) {
    super(`${TAG} turno ${sourceShiftId} sem paciente (raw.patient === null) — minimizeShiftDTO exige não-nulo; use minimizeShiftOrSkip.`);
  }
}

/**
 * Mapeia o turno cru para o DTO da porta `AnaCareShiftsSource` (spec AnaCareShiftsSource.ts) —
 * as 13 chaves do DTO SÃO o contrato de minimização: qualquer campo fora dessa lista não pode
 * existir no objeto retornado. Nomes de campo do `raw` conferidos contra a API real 17/09/2026
 * (ver comentário de `RawAnaCareShift`) — os 5 antigos (`date`/`scheduled_start`/`scheduled_end`/
 * `actual_start`/`actual_end`) não existem e nunca devem voltar a ser lidos aqui.
 *
 * ⚠️ Exige `raw.patient`/`raw.nurse` não-nulos — lança `AnaCareMissingPatientError`/
 * `AnaCareMissingProviderError` se vierem `null` (defesa em profundidade; o caminho que TOLERA e
 * CONTA turno sem paciente/prestador é `minimizeShiftOrSkip`, não este).
 */
export function minimizeShiftDTO(raw: RawAnaCareShift): SourceShiftDTO {
  if (raw.nurse === null) throw new AnaCareMissingProviderError(String(raw.id));
  if (raw.patient === null) throw new AnaCareMissingPatientError(String(raw.id));

  const date = shiftDayFrom(raw.start);
  return {
    sourceShiftId: String(raw.id),
    anaCarePatientId: String(raw.patient.id),
    anaCareNurseId: String(raw.nurse.id),
    // Item 1 (nome e sobrenome, decisão do Gabriel 17/09): a fonte do nome é o PRÓPRIO payload do
    // turno, não o cruzamento com `workers.ana_care_id` — ver AnaCareHoursMapper.
    // Tradução de vocabulário na BORDA (única vez): o campo cru do Ana Care se chama `surname`
    // (ver RawAnaCarePatient/RawAnaCareNurse acima) — tudo que é NOSSO (DTO pra cá) fala
    // `last_name`, convenção da casa (`patients.last_name`/`workers.last_name_encrypted`). Não
    // renomear o `raw.*.surname` — ele espelha o payload da fonte com fidelidade literal.
    patientFirstName: raw.patient.first_name,
    patientLastName: raw.patient.surname,
    // Documento do paciente (item 4 do pedido, PII) — vem do payload do turno, medido 18/09/2026
    // em `identification_type`/`identification_number` (52/168 reservas, 31%). Quem decide se sai
    // no payload HTTP é o gate `patient_identity:read` (AnaCareHoursController), não este mapper —
    // aqui só traduz o campo bruto pra dentro do DTO.
    patientDocumentType: raw.patient.identification_type,
    patientDocumentNumber: raw.patient.identification_number,
    nurseFirstName: raw.nurse.first_name,
    nurseLastName: raw.nurse.surname,
    date,
    scheduledStart: raw.start,
    scheduledEnd: raw.end,
    actualStart: raw.checkin,
    actualEnd: raw.checkout,
    checkinSource: validateSourceField('checkin_source', raw.checkin_source),
    checkoutSource: validateSourceField('checkout_source', raw.checkout_source),
    checkinDelay: raw.checkin_delay,
    isFinalized: raw.is_finalized,
    // `raw.month` é afirmação da fonte (existe em 88/88 medidos); fallback só para um raw sem ele.
    sourceMonth: raw.month ?? monthOfDate(date),
  };
}

/** Motivo do descarte — nomeado, nunca um boolean genérico (quem lê o log/outcome sabe QUAL dos dois). */
export type SkippedShiftReason = 'no-provider' | 'no-patient';

/**
 * Resultado de `minimizeShiftOrSkip` — união discriminada por `ok`. FORÇA o chamador a checar
 * `ok` antes de ler `dto`: não existe forma de um turno sem prestador/paciente vazar para dentro
 * de um `.map()` que ignore o formato (diferente de `minimizeShiftDTO` devolver `null` calado, que
 * um `.map()` inclui sem perceber — a causa raiz do desenho, não só do bug).
 */
export type ShiftMinimizationResult =
  | { ok: true; dto: SourceShiftDTO }
  | { ok: false; reason: SkippedShiftReason; sourceShiftId: string };

/**
 * Único ponto de entrada para minimizar um turno vindo de payload real, que pode faltar
 * `nurse`/`patient` (medido 17/09: 15/3.421 sem `nurse`, 0/3.421 sem `patient`). Nunca lança para
 * esses dois casos — devolve `{ ok: false, reason, sourceShiftId }` para o chamador CONTAR e
 * descartar; qualquer outro defeito de forma (nome de campo errado etc.) continua lançando via
 * `minimizeShiftDTO`, sem mudança de comportamento aí.
 */
export function minimizeShiftOrSkip(raw: RawAnaCareShift): ShiftMinimizationResult {
  const sourceShiftId = String(raw.id);
  if (raw.nurse === null) return { ok: false, reason: 'no-provider', sourceShiftId };
  if (raw.patient === null) return { ok: false, reason: 'no-patient', sourceShiftId };
  return { ok: true, dto: minimizeShiftDTO(raw) };
}
