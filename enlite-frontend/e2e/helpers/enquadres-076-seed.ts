/**
 * enquadres-076-seed.ts — massa SINTÉTICA da lista global de enquadres (spec 076), compartilhada pelo e2e de tela
 * (`group-simulation-enquadres-076`) e pelo spec de prints (`enquadres-076-prints`). Tudo por SQL, como dona do banco de teste:
 * nenhum clique cria/convoca/cancela/encerra evento (a lista só LÊ; o seed não passa pela API, então nenhum Calendar/Meet/WhatsApp é tocado).
 *
 * 1 vaga ("Ficticio", caso >= 960000) e 8 prestadores APTOS (e-mails `@example.test`). 5 eventos, 2 na semana atual de Buenos Aires
 * (a "semana atual" do servidor: `date_trunc('week', now() AT TIME ZONE BA)`, segunda a domingo) e 2 na seguinte:
 *   semana atual   e1 aberto (2 ativos) · e2 FECHADO (1 devolvido + 1 retirado, que NÃO conta) · e3 aberto com importação travada (1 ativo)
 *   semana seguinte n1 aberto (2 ativos) · n2 CANCELADO (1 `cancelled`, que conta)
 * Convocados (definição da spec §5.3: tudo menos `removed`): semana atual 4, semana seguinte 3.
 */
import { insertTestPatient, insertBaseVacancy, cleanupTestPatient } from './db-test-helper';
import { psql, scalar, safeSql } from './abac-stack-helper';
import { insertAptoWorker, cleanupEligibilityWorkerChildren } from './eligibility-worker-helper';

const BA = 'America/Argentina/Buenos_Aires';
const b64 = (v: string): string => Buffer.from(v, 'utf8').toString('base64');

export interface Seed076 {
  patientId: string;
  vacancyId: string;
  caseNumber: number;
  workerIds: string[];
  hostA: string;
  hostB: string;
  events: { e1: string; e2: string; e3: string; n1: string; n2: string };
  codes: { e1: string; e2: string; e3: string; n1: string; n2: string };
}

/** Instante `weekStart + dias + horas` (hora de Buenos Aires) como expressão SQL de `timestamptz`. */
const at = (dias: number, horas: number): string =>
  `((date_trunc('week', now() AT TIME ZONE '${BA}') + interval '${dias} days ${horas} hours') AT TIME ZONE '${BA}')`;

export function seedEnquadres076(runId: string, staffUid: string, hostAName: string, hostBName: string): Seed076 {
  const { patientId, addressId } = insertTestPatient({ withAddress: true, firstName: 'Ficticio', lastName: `Enq076${runId}` });
  const caseNumber = 960_000 + Math.floor(Math.random() * 30_000);
  const vacancyId = insertBaseVacancy({ patientId, patientAddressId: addressId!, caseNumber, status: 'SEARCHING', isDraft: false });
  const workerIds: string[] = [];
  for (let i = 1; i <= 8; i++) {
    const id = insertAptoWorker({ docs: 'validated' }).workerId;
    psql(`UPDATE workers SET auth_uid = 'e2e076-${runId}-${i}', email = 'prestador${i}.e2e076-${runId}@example.test',
      first_name_encrypted = '${b64(`Ficticio ${String(i).padStart(2, '0')}`)}', last_name_encrypted = '${b64('E2E076')}' WHERE id = '${id}'`);
    psql(`INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source) VALUES ('${id}', '${vacancyId}', 'COMPLETED', 'talentum')`);
    workerIds.push(id);
  }
  const hostA = `ana.e2e076-${runId}@example.test`;
  const hostB = `beto.e2e076-${runId}@example.test`;
  const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const usados = new Set<string>();
  const codigo = (): string => {
    for (;;) {
      const c = `ENC-${Array.from({ length: 6 }, () => alfabeto[Math.floor(Math.random() * alfabeto.length)]).join('')}`;
      if (!usados.has(c)) { usados.add(c); return c; }
    }
  };
  const codes = { e1: codigo(), e2: codigo(), e3: codigo(), n1: codigo(), n2: codigo() };
  const ev = (dias: number, horas: number, code: string, host: string, name: string, extra = ''): string =>
    scalar(`INSERT INTO enquadre_events (job_posting_id, host_email, host_display_name, starts_at, ends_at, event_code, created_by_uid ${extra ? ', ' + extra.split('|')[0] : ''})
      VALUES ('${vacancyId}', '${host}', '${name}', ${at(dias, horas)}, ${at(dias, horas + 1)}, '${code}', '${staffUid}' ${extra ? ', ' + extra.split('|')[1] : ''}) RETURNING id`);
  const e1 = ev(1, 10, codes.e1, hostA, hostAName);
  const e2 = ev(2, 11, codes.e2, hostB, hostBName, `status, closed_at, closed_by_uid|'closed', now(), '${staffUid}'`);
  const e3 = ev(3, 9, codes.e3, hostA, hostAName, `import_status, blocked_reason|'blocked', 'no_link'`);
  const n1 = ev(8, 10, codes.n1, hostA, hostAName);
  const n2 = ev(9, 15, codes.n2, hostB, hostBName, `status, cancelled_at, cancelled_by_uid|'cancelled', now(), '${staffUid}'`);
  const [w1, w2, w3, w4, w5, w6, w7, w8] = workerIds;
  const part = (event: string, worker: string, rel = ''): void => {
    psql(`INSERT INTO enquadre_event_participants (event_id, job_posting_id, worker_id, added_by_uid ${rel ? ', released_at, release_kind' + (rel === 'closed' ? ', outcome' : '') : ''})
      VALUES ('${event}', '${vacancyId}', '${worker}', '${staffUid}' ${rel ? `, now(), '${rel}'` + (rel === 'closed' ? ", 'returned'" : '') : ''})`);
  };
  part(e1, w1); part(e1, w2);
  part(e2, w3, 'closed'); part(e2, w4, 'removed');
  part(e3, w5);
  part(n1, w6); part(n1, w7);
  part(n2, w8, 'cancelled');
  return { patientId, vacancyId, caseNumber, workerIds, hostA, hostB, events: { e1, e2, e3, n1, n2 }, codes };
}

export function cleanupEnquadres076(s: Seed076 | undefined): void {
  if (!s) return;
  safeSql(`DELETE FROM enquadre_events WHERE job_posting_id = '${s.vacancyId}'`); // participações saem em cascata
  safeSql(`DELETE FROM worker_job_applications WHERE job_posting_id = '${s.vacancyId}'`);
  safeSql(`DELETE FROM encuadres WHERE job_posting_id = '${s.vacancyId}'`);
  for (const w of s.workerIds) { try { cleanupEligibilityWorkerChildren(w); } catch (err) { console.error('[cleanup] satélites do apto falharam (seguindo)', err); } }
  safeSql(`DELETE FROM workers WHERE id IN (${s.workerIds.map((w) => `'${w}'`).join(',') || "''"})`);
  try { cleanupTestPatient(s.patientId); } catch (err) { console.error('[cleanup] paciente/vaga falhou (seguindo)', err); }
}

/** Contagem SQL (a "régua" independente da tela) de eventos e convocados entre dois dias de Buenos Aires, país AR. */
export function contagemSql(from: string, to: string): { eventos: number; convocados: number } {
  const win = `ev.country = 'AR' AND ev.starts_at >= ('${from}'::timestamp AT TIME ZONE '${BA}') AND ev.starts_at < (('${to}'::date + 1)::timestamp AT TIME ZONE '${BA}')`;
  return {
    eventos: Number(scalar(`SELECT count(*) FROM enquadre_events ev WHERE ${win}`)),
    convocados: Number(scalar(`SELECT count(*) FROM enquadre_event_participants p JOIN enquadre_events ev ON ev.id = p.event_id
      WHERE p.release_kind IS DISTINCT FROM 'removed' AND ${win}`)),
  };
}

/** `YYYY-MM-DD` + N dias (aritmética de calendário, sem fuso). */
export const somaDias = (iso: string, n: number): string => {
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
/** O que uma pessoa digita num `<input type=date>` do Chrome en-US para chegar em `iso`: `MMDDYYYY`. */
export const digitadoDe = (iso: string): string => `${iso.slice(5, 7)}${iso.slice(8, 10)}${iso.slice(0, 4)}`;
