import { IMPORT_EXPIRE_AFTER_MS } from '../domain/admissionImport';
import { HUMAN_BLOCK_REASONS, IMPORT_REMINDER_EVENT, IMPORT_REMINDER_EVERY_MS, MAX_IMPORT_REMINDERS } from '../domain/importBlockPolicy';

/**
 * Fragmento SQL ÚNICO (spec 083, DF-1/DF-3, D-2) da fila de importação para o bloqueio que SÓ uma pessoa resolve. Admissão e enquadre
 * usam ESTE fragmento (parametrizado por alias; a trilha e a coluna são NOMES LITERAIS no SQL, um bloco por fonte — o `sql-schema-sync` só valida nome literal), para as duas filas nunca discordarem. É a réplica em SQL de
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
  /** Tabela da trilha: `admission_events` (fk `appointment_id`) ou `enquadre_event_trail` (fk `event_id`). */
  trail: 'admission_events' | 'enquadre_event_trail';
  /** Coluna da trilha que aponta para o sujeito (`appointment_id`, `event_id`); a trilha já a determina. */
  fk: string;
}

const secs = (ms: number): number => ms / 1000;

type Trail = HumanBlockSource['trail'];

const STANDING: Record<Trail, (x: string, reasons: string, expires: string, nextAt: string, nowSql: string) => string> = {
    admission_events: (x, reasons, expires, nextAt, nowSql) => `EXISTS (
            SELECT 1
              FROM (SELECT b.at, b.reason FROM admission_events b
                     WHERE b.appointment_id = ${x}.id AND b.kind = 'import_blocked'
                     ORDER BY b.at DESC LIMIT 1) lb
             CROSS JOIN LATERAL (SELECT count(*) AS n FROM admission_events r
                                  WHERE r.appointment_id = ${x}.id AND r.kind = '${IMPORT_REMINDER_EVENT}' AND r.at > lb.at) rc
             WHERE ${x}.import_status = 'blocked'
               AND lb.reason IN (${reasons})
               AND NOT EXISTS (SELECT 1 FROM tactiq_links l
                                WHERE lower(l.host_email) = lower(${x}.host_email) AND l.status = 'linked' AND l.status_changed_at > lb.at)
               AND ${nowSql} < ${expires}
               AND NOT (rc.n < ${MAX_IMPORT_REMINDERS} AND ${nowSql} >= ${nextAt} AND ${nextAt} < ${expires}))`,
    enquadre_event_trail: (x, reasons, expires, nextAt, nowSql) => `EXISTS (
            SELECT 1
              FROM (SELECT b.at, b.reason FROM enquadre_event_trail b
                     WHERE b.event_id = ${x}.id AND b.kind = 'import_blocked'
                     ORDER BY b.at DESC LIMIT 1) lb
             CROSS JOIN LATERAL (SELECT count(*) AS n FROM enquadre_event_trail r
                                  WHERE r.event_id = ${x}.id AND r.kind = '${IMPORT_REMINDER_EVENT}' AND r.at > lb.at) rc
             WHERE ${x}.import_status = 'blocked'
               AND lb.reason IN (${reasons})
               AND NOT EXISTS (SELECT 1 FROM tactiq_links l
                                WHERE lower(l.host_email) = lower(${x}.host_email) AND l.status = 'linked' AND l.status_changed_at > lb.at)
               AND ${nowSql} < ${expires}
               AND NOT (rc.n < ${MAX_IMPORT_REMINDERS} AND ${nowSql} >= ${nextAt} AND ${nextAt} < ${expires}))`,
};

const LAST_BLOCKED: Record<Trail, string> = {
  admission_events: `SELECT b.reason, b.at FROM admission_events b WHERE b.appointment_id = $1 AND b.kind = 'import_blocked' ORDER BY b.at DESC LIMIT 1`,
  enquadre_event_trail: `SELECT b.reason, b.at FROM enquadre_event_trail b WHERE b.event_id = $1 AND b.kind = 'import_blocked' ORDER BY b.at DESC LIMIT 1`,
};

const COUNT_REMINDERS: Record<Trail, string> = {
  admission_events: `SELECT count(*) AS n FROM admission_events r WHERE r.appointment_id = $1 AND r.kind = '${IMPORT_REMINDER_EVENT}' AND r.at > $2::timestamptz`,
  enquadre_event_trail: `SELECT count(*) AS n FROM enquadre_event_trail r WHERE r.event_id = $1 AND r.kind = '${IMPORT_REMINDER_EVENT}' AND r.at > $2::timestamptz`,
};

export function standingHumanBlockSql(src: HumanBlockSource, nowSql: string): string {
  const x = src.alias;
  const reasons = HUMAN_BLOCK_REASONS.map((r) => `'${r}'`).join(', ');
  const expires = `(${x}.conference_ended_at + make_interval(secs => ${secs(IMPORT_EXPIRE_AFTER_MS)}))`;
  const nextAt = `(lb.at + make_interval(secs => ${secs(IMPORT_REMINDER_EVERY_MS)}) * (rc.n + 1))`;
  return STANDING[src.trail](x, reasons, expires, nextAt, nowSql);
}

/** O último `import_blocked` do sujeito (motivo + instante), ou `null`. A trilha é só-acréscimo: o mais recente governa. */
export function lastBlockedEventSql(src: Pick<HumanBlockSource, 'trail' | 'fk'>): string {
  return LAST_BLOCKED[src.trail];
}

/** Lembretes gravados DEPOIS de `$2` (o instante do último `import_blocked`): o contador recomeça a cada novo bloqueio (DF-8). */
export function countRemindersSinceSql(src: Pick<HumanBlockSource, 'trail' | 'fk'>): string {
  return COUNT_REMINDERS[src.trail];
}
