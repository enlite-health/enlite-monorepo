/**
 * presence-review-seed.ts — massa SINTÉTICA da fila de revisão de presença (emenda 077 §6, T-806-57) para `admin-presence-review.e2e.ts`.
 *
 * Não existe rota que CRIE uma exceção de lugar pendente (quem a cria é o app, pelo `/ops`): o cenário entra por SQL no banco do ATTENDANCE, como
 * os irmãos semeiam pedido/paciente. Um check-in aceito fora do lugar (`server_verdict = OUTSIDE`) + a linha em `presence_exception` (o banco exige as
 * duas na MESMA transação) + um checkout dentro do lugar, para a ocorrência fechar e contar horas. O turno (paciente, prestador, slot) vem do
 * `seedItinerary` do WF — o `occurrence_id` é o MESMO uuid v5 de "slot|data|worker" que o WF calcula, e é por ele que o WF enriquece nome e caso.
 *
 * ⚠️ Escrito sem rodar: o SQL abaixo segue as migrations 001/002/009 do attendance (colunas, trigger de projeção, FORCE RLS por `app.worker_id`), e a
 * 1ª execução é a da F9 (stack local inteiro). Os fatos do attendance são IMUTÁVEIS (nem a dona apaga): não há limpeza — cada rodada usa worker e slot
 * novos (uuid do seed) e `docker compose -p <projeto> down -v` leva tudo.
 */
import { execFileSync } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { scalar } from './abac-stack-helper';

export const ATTENDANCE_DB_URL = process.env.ATTENDANCE_TEST_DB_URL ?? 'postgresql://enlite_admin:enlite_password@localhost:5441/attendance';
export const ATTENDANCE_API_URL = process.env.ATTENDANCE_API_URL ?? 'http://localhost:8090';

/** O MESMO namespace de `OCCURRENCE_ID_NAMESPACE` em `WorkerItineraryReader.ts` (worker-functions). */
const OCCURRENCE_ID_NAMESPACE = '43876dea-477d-4c5b-8b30-127aa6db3f92';

/** uuid v5 (RFC 4122, SHA-1) sem dependência: o front de e2e não tem `uuid`. */
export function occurrenceIdOf(slotId: string, date: string, workerId: string): string {
  const ns = Buffer.from(OCCURRENCE_ID_NAMESPACE.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1').update(ns).update(`${slotId}|${date}|${workerId}`).digest();
  hash[6] = (hash[6] & 0x0f) | 0x50;
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const h = hash.subarray(0, 16).toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** `workerId` entra no `app.worker_id` da transação: as tabelas de fato têm FORCE RLS por esse GUC (até para a dona). */
export function attendancePsql(workerId: string, sql: string): string {
  try {
    return execFileSync('psql', [ATTENDANCE_DB_URL, '-v', 'ON_ERROR_STOP=1', '-t', '-A', '-c', `SELECT set_config('app.worker_id', '${workerId}', true); ${sql}`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString().trim();
  } catch (err: unknown) {
    const e = err as { stderr?: Buffer; message: string };
    throw new Error(`attendance DB error: ${e.stderr?.toString() ?? e.message}`);
  }
}

export interface PendingException {
  eventId: string;
  occurrenceId: string;
  onDate: string;
}

/** `YYYY-MM-DD` + 7 dias (a mesma segunda-feira da semana seguinte). */
export function plusDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * Turno 09:00–11:00 (Buenos Aires = 12:00Z–14:00Z) fechado, com o CHECK_IN aceito fora do lugar (exceção `GEO_DECLARED`, motivo `GPS_INDOOR`,
 * 180 m, precisão 40 m) PENDENTE e o CHECK_OUT dentro do lugar. 120 minutos na view de horas até alguém recusar.
 */
export function seedPendingException(o: { workerId: string; slotId: string; onDate: string; uid: string }): PendingException {
  const occurrenceId = occurrenceIdOf(o.slotId, o.onDate, o.workerId);
  const eventId = randomUUID();
  const checkoutId = randomUUID();
  const cols = `(event_id, worker_id, uid, country, occurrence_id, slot_id, on_date, type, device_at, source, integrity_status, app_version,
      lat, lng, accuracy_m, position_at, is_mock, gate_patient_lat, gate_patient_lng, gate_radius_m, gate_accuracy_ceiling_m, distance_m, geo_verdict, server_distance_m, server_verdict)`;
  const common = `'${o.workerId}', '${o.uid}', 'AR', '${occurrenceId}', '${o.slotId}', '${o.onDate}'`;
  attendancePsql(o.workerId, `
    INSERT INTO attendance.event ${cols} VALUES
      ('${eventId}', ${common}, 'CHECK_IN', '${o.onDate}T12:00:00Z', 'APP', 'UNAVAILABLE', 'e2e', -34.6040000, -58.3810000, 40.0, '${o.onDate}T12:00:00Z', false,
       -34.6037000, -58.3816000, 100, 50, 180.0, 'INSIDE', 180.0, 'OUTSIDE'),
      ('${checkoutId}', ${common}, 'CHECK_OUT', '${o.onDate}T14:00:00Z', 'APP', 'UNAVAILABLE', 'e2e', -34.6037000, -58.3816000, 10.0, '${o.onDate}T14:00:00Z', false,
       -34.6037000, -58.3816000, 100, 50, 5.0, 'INSIDE', 5.0, 'INSIDE');
    INSERT INTO attendance.presence_exception (event_id, kind, reason_code) VALUES ('${eventId}', 'GEO_DECLARED', 'GPS_INDOOR');
  `);
  return { eventId, occurrenceId, onDate: o.onDate };
}

/** `decision|resolution_code|decided_by_uid` da decisão gravada pelo attendance, ou '' se a exceção segue pendente. */
export function decisionOf(workerId: string, eventId: string): string {
  const out = attendancePsql(workerId, `SELECT decision || '|' || resolution_code || '|' || decided_by_uid FROM attendance.presence_exception_decision WHERE event_id = '${eventId}'`);
  // o 1º resultado do `-c` é o `set_config` (ecoa o worker_id, sem `|`): só a linha da decisão tem `|`; sem decisão sobra '' (nunca o eco do set_config)
  return out.split('\n').filter((l) => l.includes('|')).pop() ?? '';
}

export interface MonthHours {
  workedMinutes: number;
  shifts: number;
}

/**
 * As horas do mês LIDAS PELA API de horas do attendance (`GET /internal/v1/sync/hours`, a mesma view `hours_month` que o app lê) — não pelo banco.
 * Os cabeçalhos de auth do stack local vêm de `E2E_ATTENDANCE_HOURS_HEADERS` (JSON, ex.: o JWT do prestador e o `X-Serverless-Authorization`): o
 * stack da F9 é quem sabe como o attendance autentica ali. Sem a variável, falha dizendo isso — nunca devolve zero.
 */
export async function readMonthHours(month: string, workerId?: string): Promise<MonthHours> {
  const headers = hoursHeaders(workerId);
  const res = await fetch(`${ATTENDANCE_API_URL}/internal/v1/sync/hours`, { headers });
  if (!res.ok) throw new Error(`GET /internal/v1/sync/hours respondeu ${res.status}`);
  const body = (await res.json()) as { items: Array<{ month: string; worked_minutes: number; shifts: number }> };
  const row = body.items.find((i) => i.month === month);
  return { workedMinutes: row?.worked_minutes ?? 0, shifts: row?.shifts ?? 0 };
}

/**
 * Auth do prestador na API de horas: `E2E_ATTENDANCE_HOURS_HEADERS` (JSON) manda; sem ela, com `workerId`, monta o token mock do stack local
 * (`mock_<base64>`, o mesmo que o WF e o attendance do stack da F9 aceitam) para o `auth_uid` desse prestador no banco do WF — o uid do titular é
 * aleatório por rodada, então não dá para fixá-lo numa variável de ambiente.
 */
function hoursHeaders(workerId?: string): Record<string, string> {
  const raw = process.env.E2E_ATTENDANCE_HOURS_HEADERS;
  if (raw) return JSON.parse(raw) as Record<string, string>;
  if (!workerId) throw new Error('E2E_ATTENDANCE_HOURS_HEADERS não definida e sem workerId: informe os cabeçalhos de auth do prestador para GET /internal/v1/sync/hours');
  const uid = scalar(`SELECT auth_uid FROM workers WHERE id = '${workerId}'`);
  if (!uid) throw new Error('prestador sem auth_uid no banco do WF: não há como autenticar na API de horas');
  const token = Buffer.from(JSON.stringify({ uid, email: `${uid}@e2e.local`, role: 'worker', country: 'AR' })).toString('base64');
  return { Authorization: `Bearer mock_${token}`, 'x-app-version': 'e2e-presence-review' };
}
