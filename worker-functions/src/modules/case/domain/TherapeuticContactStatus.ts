/**
 * Estado explícito dos 4 campos de contato do Projeto Terapêutico (spec 048).
 *
 * `PENDING` = "Todavía no hay registro" (rótulo visível; prazo de 15 dias) · `NOT_NEEDED` = "No necesita"
 * (só o Acesso Master escolhe; tira o campo do prazo e dos lembretes). Lista de contatos vazia SEM status
 * continua significando "nada informado" — o status é sempre explícito, nunca inferido da lista vazia.
 */
import { countryToTimezone } from '@shared/locale/CountryTimezone';

export const CONTACT_STATUS_KINDS = ['RESPONSIBLE', 'EXTERNAL', 'COVERAGE', 'CARE_TEAM'] as const;
export type ContactStatusKind = (typeof CONTACT_STATUS_KINDS)[number];

export const CONTACT_STATUS_VALUES = ['PENDING', 'NOT_NEEDED'] as const;
export type ContactStatusValue = (typeof CONTACT_STATUS_VALUES)[number];

/** Corpo/estado: por campo, o status (ausente = campo tem contatos ou não foi informado). */
export type ContactStatusMap = Partial<Record<ContactStatusKind, ContactStatusValue>>;

/** Prazo para preencher o campo, em dias civis a partir da 1ª versão em que ficou pendente (D479). */
export const CONTACT_PENDING_DEADLINE_DAYS = 15;
/** Lembretes in-app: dias depois do cadastro do ciclo (D479). O 12º também avisa o Acesso Master. */
export const REMINDER_DAY_OFFSETS = [2, 5, 12] as const;
export type ReminderDayOffset = (typeof REMINDER_DAY_OFFSETS)[number];

/** Linha de status como a API devolve — NUNCA o uid de quem marcou. */
export interface ContactStatusView {
  kind: ContactStatusKind;
  status: ContactStatusValue;
  /** ISO; `null` em `NOT_NEEDED`. */
  pendingSince: string | null;
  /** `YYYY-MM-DD` = data local (fuso do país) de `pendingSince` + 15 dias; `null` em `NOT_NEEDED`. */
  deadlineDate: string | null;
}

/** Data civil `YYYY-MM-DD` de um instante no fuso do país (AR/BR via `countryToTimezone`). */
export function localDateOf(instant: Date, country: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: countryToTimezone(country),
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
}

/** Soma `days` dias a uma data civil `YYYY-MM-DD` (aritmética em UTC: sem horário de verão no meio). */
export function addCivilDays(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Vencimento do campo: dia civil local de `pendingSince` + 15. */
export function deadlineDateOf(pendingSince: Date, country: string): string {
  return addCivilDays(localDateOf(pendingSince, country), CONTACT_PENDING_DEADLINE_DAYS);
}

/** Ordem fixa dos campos em qualquer lista (aviso, payload, leitura). */
export function sortKinds<T extends ContactStatusKind>(kinds: readonly T[]): T[] {
  return [...kinds].sort((a, b) => CONTACT_STATUS_KINDS.indexOf(a) - CONTACT_STATUS_KINDS.indexOf(b));
}

/** Estado do campo na versão vigente (o que a nova versão herda). */
export interface PreviousContactStatus {
  kind: ContactStatusKind;
  status: ContactStatusValue;
  pendingSince: Date | null;
  markedByUid: string;
}

export interface PlannedContactStatus {
  kind: ContactStatusKind;
  status: ContactStatusValue;
  /** `null` + PENDING = "agora" (o Postgres grava o `now()` da transação). */
  pendingSince: Date | null;
  markedByUid: string;
}

export interface ContactStatusPlan {
  rows: PlannedContactStatus[];
  /** Campos que ficam PENDING agora e NÃO estavam na vigente — só eles abrem (ou entram em) um ciclo. */
  newlyPending: ContactStatusKind[];
  /** Campos `NOT_NEEDED` que a vigente NÃO tinha: exigem `patient_therapeutic_project:waive_contact`. */
  newlyWaived: ContactStatusKind[];
}

/**
 * Plano de status da versão nova a partir do corpo e da vigente (spec 048, arquitetura §3.3):
 *  · PENDING herdado mantém `pendingSince` e `markedByUid` (salvar outra coisa NÃO dá mais 15 dias) e NÃO abre ciclo;
 *  · PENDING novo ancora em "agora", quem marcou = o ator, e entra em `newlyPending`;
 *  · NOT_NEEDED herdado passa (o operador sem a célula só está salvando outra coisa); novo entra em `newlyWaived`.
 */
export function planContactStatuses(
  requested: ContactStatusMap,
  previous: readonly PreviousContactStatus[],
  actorUid: string,
): ContactStatusPlan {
  const prevByKind = new Map(previous.map((p) => [p.kind, p]));
  const plan: ContactStatusPlan = { rows: [], newlyPending: [], newlyWaived: [] };
  for (const kind of CONTACT_STATUS_KINDS) {
    const status = requested[kind];
    if (!status) continue;
    const prev = prevByKind.get(kind);
    if (status === 'PENDING') {
      const inherited = prev?.status === 'PENDING';
      plan.rows.push({
        kind,
        status,
        pendingSince: inherited ? prev.pendingSince : null,
        markedByUid: inherited ? prev.markedByUid : actorUid,
      });
      if (!inherited) plan.newlyPending.push(kind);
    } else {
      const inherited = prev?.status === 'NOT_NEEDED';
      plan.rows.push({ kind, status, pendingSince: null, markedByUid: inherited ? prev.markedByUid : actorUid });
      if (!inherited) plan.newlyWaived.push(kind);
    }
  }
  return plan;
}
