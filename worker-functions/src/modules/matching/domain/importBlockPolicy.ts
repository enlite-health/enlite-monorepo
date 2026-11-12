import { IMPORT_EXPIRE_AFTER_MS } from './admissionImport';

/**
 * Política do bloqueio que SÓ uma pessoa resolve (spec 083, DF-3). Pura: sem relógio, sem banco. É a ÚNICA fonte da regra no
 * TypeScript; o SQL da fila (`infrastructure/importHumanBlockSql.ts`) a replica e o teste de paridade amarra os dois.
 */

/** Motivos de `import_blocked` que exigem ação humana (refazer o vínculo do Tactiq). Conjunto fechado (DF-2). */
export const HUMAN_BLOCK_REASONS = ['no_link', 'wrong_account'] as const;
export type HumanBlockReason = (typeof HUMAN_BLOCK_REASONS)[number];

/** `kind` do lembrete na trilha (admissão e enquadre): só novo valor de TEXT livre, sem coluna nem migration. */
export const IMPORT_REMINDER_EVENT = 'import_reminder';

/** ⚙️ (proposta minha, DF-3): intervalo entre lembretes do bloqueio humano. */
export const IMPORT_REMINDER_EVERY_MS = 24 * 60 * 60 * 1000;
/** No máximo 2 lembretes depois do aviso inicial (24 h e 48 h). */
export const MAX_IMPORT_REMINDERS = 2;

export type StandingBlockDecision = 'reopen' | 'expire' | 'remind' | 'wait';

export interface StandingBlockFacts {
  now: Date;
  /** Fim real da call (`conference_ended_at`). */
  endedAt: Date;
  /** Instante do último `import_blocked`. */
  blockedAt: Date;
  /** `import_reminder` gravados DEPOIS desse `import_blocked`. */
  remindersSent: number;
  /** Existe vínculo `linked` mais novo que o bloqueio (a causa mudou). */
  linkedSinceBlock: boolean;
}

const ms = (d: Date): number => d.getTime();
/** Instante da expiração: fim real + 72 h. */
const expiresAt = (endedAt: Date): number => ms(endedAt) + IMPORT_EXPIRE_AFTER_MS;
/** Instante nominal do lembrete de número `n + 1` (n = já enviados). */
const nextReminderAt = (blockedAt: Date, n: number): number => ms(blockedAt) + IMPORT_REMINDER_EVERY_MS * (n + 1);

/** O que fazer com um item `blocked` por motivo humano, nesta rodada. Ordem: reabrir > expirar > lembrar > esperar. */
export function decideStandingBlock(f: StandingBlockFacts): StandingBlockDecision {
  if (f.linkedSinceBlock) return 'reopen';
  if (ms(f.now) >= expiresAt(f.endedAt)) return 'expire';
  const due = nextReminderAt(f.blockedAt, f.remindersSent);
  if (f.remindersSent < MAX_IMPORT_REMINDERS && ms(f.now) >= due && due < expiresAt(f.endedAt)) return 'remind';
  return 'wait';
}

/** O lembrete de número `n` é o último? O nº `MAX`, ou aquele depois do qual o próximo já cairia na/além da expiração (bloqueio tardio). */
export function isLastReminder(n: number, blockedAt: Date, endedAt: Date): boolean {
  return n === MAX_IMPORT_REMINDERS || nextReminderAt(blockedAt, n) >= expiresAt(endedAt);
}

/** Nenhum lembrete cabe antes da expiração: o aviso inicial já leva a cópia da gestão. */
export function noReminderFits(blockedAt: Date, endedAt: Date): boolean {
  return nextReminderAt(blockedAt, 0) >= expiresAt(endedAt);
}
