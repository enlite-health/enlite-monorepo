import { IMPORT_EXPIRE_AFTER_MS } from '../domain/admissionImport';
import { HUMAN_BLOCK_REASONS, IMPORT_REMINDER_EVENT, IMPORT_REMINDER_EVERY_MS, MAX_IMPORT_REMINDERS } from '../domain/importBlockPolicy';

/**
 * Fragmento SQL ÚNICO (spec 083, DF-1/DF-3, D-2) da fila de importação para o bloqueio que SÓ uma pessoa resolve. Admissão e enquadre
 * usam ESTE fragmento (parametrizado por tabela/alias/trilha/coluna), para as duas filas nunca discordarem. É a réplica em SQL de
 * `decideStandingBlock` (`domain/importBlockPolicy.ts`): mesmos `>=`/`<`; o teste de paridade amarra os dois.
 *
 * Devolve uma expressão booleana "o item está parado, à espera de uma pessoa, e NADA está vencido": a fila a usa como `AND NOT (...)`.
 * Fica de fora (isto é, o item é LISTADO) quando: o estado não é `blocked`; o último motivo não é humano (ou não há `import_blocked`);
 * há vínculo `linked` mais novo que o bloqueio (a causa mudou, DF-1); chegou `fim + 72 h` (expiração); ou há lembrete vencido.
 * Sem chamada externa: a consulta só lê a trilha e `tactiq_links`.
 *
 * Todos os argumentos são valores fixos do código, nunca entrada de usuário. `nowSql` é a expressão do relógio (`$1::timestamptz`).
 */
export interface HumanBlockSource {
  /** Alias SQL da tabela do sujeito (`a`, `e`); precisa expor `id`, `host_email`, `import_status` e `conference_ended_at`. */
  alias: string;
  /** Tabela da trilha (`admission_events`, `enquadre_event_trail`). */
  trail: string;
  /** Coluna da trilha que aponta para o sujeito (`appointment_id`, `event_id`). */
  fk: string;
}

const secs = (ms: number): number => ms / 1000;

export function standingHumanBlockSql(src: HumanBlockSource, nowSql: string): string {
  const { alias: x, trail, fk } = src;
  const reasons = HUMAN_BLOCK_REASONS.map((r) => `'${r}'`).join(', ');
  const expires = `(${x}.conference_ended_at + make_interval(secs => ${secs(IMPORT_EXPIRE_AFTER_MS)}))`;
  const nextAt = `(lb.at + make_interval(secs => ${secs(IMPORT_REMINDER_EVERY_MS)}) * (rc.n + 1))`;
  return `EXISTS (
            SELECT 1
              FROM (SELECT b.at, b.reason FROM ${trail} b
                     WHERE b.${fk} = ${x}.id AND b.kind = 'import_blocked'
                     ORDER BY b.at DESC LIMIT 1) lb
             CROSS JOIN LATERAL (SELECT count(*) AS n FROM ${trail} r
                                  WHERE r.${fk} = ${x}.id AND r.kind = '${IMPORT_REMINDER_EVENT}' AND r.at > lb.at) rc
             WHERE ${x}.import_status = 'blocked'
               AND lb.reason IN (${reasons})
               AND NOT EXISTS (SELECT 1 FROM tactiq_links l
                                WHERE lower(l.host_email) = lower(${x}.host_email) AND l.status = 'linked' AND l.status_changed_at > lb.at)
               AND ${nowSql} < ${expires}
               AND NOT (rc.n < ${MAX_IMPORT_REMINDERS} AND ${nowSql} >= ${nextAt} AND ${nextAt} < ${expires}))`;
}

/** O último `import_blocked` do sujeito (motivo + instante), ou `null`. A trilha é só-acréscimo: o mais recente governa. */
export function lastBlockedEventSql(src: Pick<HumanBlockSource, 'trail' | 'fk'>): string {
  return `SELECT b.reason, b.at FROM ${src.trail} b WHERE b.${src.fk} = $1 AND b.kind = 'import_blocked' ORDER BY b.at DESC LIMIT 1`;
}

/** Lembretes gravados DEPOIS de `$2` (o instante do último `import_blocked`): o contador recomeça a cada novo bloqueio (DF-8). */
export function countRemindersSinceSql(src: Pick<HumanBlockSource, 'trail' | 'fk'>): string {
  return `SELECT count(*) AS n FROM ${src.trail} r WHERE r.${src.fk} = $1 AND r.kind = '${IMPORT_REMINDER_EVENT}' AND r.at > $2::timestamptz`;
}
