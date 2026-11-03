/**
 * Spec 083 (Fase 1, T-14) — a FILA de importação do Tactiq para o bloqueio que só uma pessoa resolve, contra Postgres REAL (nunca mock):
 * `AdmissionImportRepository.listDueIds` e `EnquadreImportRepository.listDueIds` (mesmo fragmento, `importHumanBlockSql.ts`).
 * PARIDADE: cada instante é comparado com a política pura (`decideStandingBlock`): listado ⇔ decisão ≠ 'wait'. Os dois lados juntos
 * pegam o instrumento morto (o SQL ou a política sozinhos poderiam errar de forma consistente com o teste).
 *
 * Fica em `tests/e2e/` porque é o que o CI roda COM banco (`backend-e2e.yml:138`, `npm run test:e2e` = `jest.config.e2e.js`,
 * roots `tests/e2e`, testMatch "qualquer .test.ts"); o `jest.config.repo.js` (`tests/repo/`) não é chamado por nenhum workflow.
 *
 *   docker run -d --name e083-pg --label compose.project=e083 -p 127.0.0.1:55083:5432 -e POSTGRES_USER=enlite_admin \
 *     -e POSTGRES_PASSWORD=enlite_password -e POSTGRES_DB=enlite_e2e postgis/postgis:16-3.4
 *   DATABASE_URL=postgresql://enlite_admin:enlite_password@127.0.0.1:55083/enlite_e2e node scripts/run-migrations-docker.js
 *   (stub de /health em API_URL, exigido por tests/e2e/setup.ts)
 *   DATABASE_URL=... API_URL=http://127.0.0.1:58083 npx jest --config jest.config.e2e.js \
 *     tests/e2e/admission-083-import-human-block-sql.e2e.test.ts --maxWorkers=2
 */
import { Pool } from 'pg';
import { AdmissionImportRepository } from '../../src/modules/matching/infrastructure/AdmissionImportRepository';
import { EnquadreImportRepository } from '../../src/modules/matching/infrastructure/EnquadreImportRepository';
import { TactiqLinkRepository } from '../../src/modules/matching/infrastructure/TactiqLinkRepository';
import { decideStandingBlock, IMPORT_REMINDER_EVENT } from '../../src/modules/matching/domain/importBlockPolicy';

const DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const EMAIL_SUFFIX = '@083-sql.test';
const MIN = 60_000;
const H = 60 * MIN;
/** Fim real da call. O job só olha 10 min depois; `now` de todos os cenários é bem depois disso. */
const ENDED = new Date('2026-10-01T12:00:00Z');
const at = (deltaMs: number): Date => new Date(ENDED.getTime() + deltaMs);

interface Scenario {
  name: string;
  reason: string;
  /** Instante do `import_blocked`, em ms depois do fim da call. */
  blockedAfterEnd: number;
  /** `import_reminder` gravados (k-ésimo em bloqueio + 24 h × k). */
  reminders?: number;
  /** `status_changed_at` do vínculo `linked` do host, em ms depois do fim da call (ausente = sem vínculo). */
  linkedAfterEnd?: number;
  importStatus?: 'blocked' | 'waiting';
  /** `now` desta rodada, em ms depois do bloqueio. */
  nowAfterBlock: number;
  listed: boolean;
}

const B10 = 10 * MIN;
const SCENARIOS: Scenario[] = [
  { name: 'bloqueio + 1 min', reason: 'no_link', blockedAfterEnd: B10, nowAfterBlock: MIN, listed: false },
  { name: 'bloqueio + 14 min (próxima rodada)', reason: 'no_link', blockedAfterEnd: B10, nowAfterBlock: 14 * MIN, listed: false },
  { name: 'wrong_account: bloqueio + 1 min', reason: 'wrong_account', blockedAfterEnd: B10, nowAfterBlock: MIN, listed: false },
  { name: 'bloqueio + 24 h, 0 lembretes', reason: 'no_link', blockedAfterEnd: B10, nowAfterBlock: 24 * H, listed: true },
  { name: 'bloqueio + 24 h com 1 lembrete gravado', reason: 'no_link', blockedAfterEnd: B10, reminders: 1, nowAfterBlock: 24 * H, listed: false },
  { name: 'bloqueio + 47 h com 1 lembrete', reason: 'no_link', blockedAfterEnd: B10, reminders: 1, nowAfterBlock: 47 * H, listed: false },
  { name: 'bloqueio + 48 h com 1 lembrete', reason: 'no_link', blockedAfterEnd: B10, reminders: 1, nowAfterBlock: 48 * H, listed: true },
  { name: 'bloqueio + 48 h com 2 lembretes (teto)', reason: 'no_link', blockedAfterEnd: B10, reminders: 2, nowAfterBlock: 48 * H, listed: false },
  { name: 'bloqueio + 71 h com 2 lembretes', reason: 'no_link', blockedAfterEnd: B10, reminders: 2, nowAfterBlock: 71 * H, listed: false },
  { name: 'fim + 72 h (expira), 1 lembrete', reason: 'no_link', blockedAfterEnd: B10, reminders: 1, nowAfterBlock: 72 * H - B10, listed: true },
  { name: 'fim + 72 h - 1 min, 2 lembretes', reason: 'no_link', blockedAfterEnd: B10, reminders: 2, nowAfterBlock: 72 * H - B10 - MIN, listed: false },
  { name: 'vínculo linked mais novo que o bloqueio', reason: 'no_link', blockedAfterEnd: B10, linkedAfterEnd: B10 + H, nowAfterBlock: 2 * H, listed: true },
  { name: 'vínculo linked MAIS VELHO que o bloqueio (controle: não reabre)', reason: 'no_link', blockedAfterEnd: B10, linkedAfterEnd: B10 - H, nowAfterBlock: 2 * H, listed: false },
  { name: 'bloqueio tardio em fim + 30 h: lembrete em +24 h', reason: 'no_link', blockedAfterEnd: 30 * H, nowAfterBlock: 24 * H, listed: true },
  { name: 'bloqueio em fim + 50 h: nenhum lembrete cabe (+21 h = fim + 71 h)', reason: 'no_link', blockedAfterEnd: 50 * H, nowAfterBlock: 21 * H, listed: false },
  { name: 'bloqueio em fim + 50 h: fim + 72 h expira', reason: 'no_link', blockedAfterEnd: 50 * H, nowAfterBlock: 22 * H, listed: true },
  { name: 'regressão: rehearsal_bucket_missing + 1 min continua listado', reason: 'rehearsal_bucket_missing', blockedAfterEnd: B10, nowAfterBlock: MIN, listed: true },
  { name: 'regressão: estado waiting (não blocked) continua listado', reason: 'no_link', blockedAfterEnd: B10, importStatus: 'waiting', nowAfterBlock: MIN, listed: true },
];

const HUMAN = new Set(['no_link', 'wrong_account']);

let pool: Pool;
let counter = 0;
const code = (prefix: string): string => `${prefix}-${(1_000_000 + Date.now() % 9_000_000 + counter).toString(36).toUpperCase().slice(-6).padStart(6, '0')}`;

async function seedTrail(table: 'admission_events' | 'enquadre_event_trail', fk: string, id: string, s: Scenario, blockedAt: Date): Promise<void> {
  const ins = (kind: string, reason: string | null, when: Date): Promise<unknown> =>
    pool.query(`INSERT INTO ${table} (${fk}, at, kind, reason) VALUES ($1, $2, $3, $4)`, [id, when, kind, reason]);
  await ins('import_blocked', s.reason, blockedAt);
  for (let k = 1; k <= (s.reminders ?? 0); k += 1) await ins(IMPORT_REMINDER_EVENT, s.reason, new Date(blockedAt.getTime() + 24 * H * k));
}

async function seedLink(email: string, s: Scenario): Promise<void> {
  if (s.linkedAfterEnd === undefined) return;
  await pool.query(`INSERT INTO tactiq_links (host_email, firebase_uid, status, status_changed_at) VALUES ($1, $2, 'linked', $3)`, [email, `uid-${email}`, at(s.linkedAfterEnd)]);
}

async function seedAdmission(s: Scenario, email: string): Promise<string> {
  counter += 1;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO admission_appointments (country, host_email, slot_start, slot_end, status, admission_code, conference_ended_at, import_status)
     VALUES ('AR', $1, $2, $3, 'booked', $4, $5, $6) RETURNING id`,
    [email, at(-H), at(-30 * MIN), code('ADM'), ENDED, s.importStatus ?? 'blocked'],
  );
  await seedTrail('admission_events', 'appointment_id', rows[0].id, s, at(s.blockedAfterEnd));
  return rows[0].id;
}

async function seedEnquadre(s: Scenario, email: string, jobPostingId: string): Promise<string> {
  counter += 1;
  const reason = (s.importStatus ?? 'blocked') === 'blocked' ? s.reason : null;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO enquadre_events (job_posting_id, country, host_email, host_display_name, starts_at, ends_at, event_code, created_by_uid,
                                  status, conference_ended_at, import_status, blocked_reason)
     VALUES ($1, 'AR', $2, 'Host Sintetico', $3, $4, $5, 'uid-083', 'open', $6, $7, $8) RETURNING id`,
    [jobPostingId, email, at(-H), at(-30 * MIN), code('ENC'), ENDED, s.importStatus ?? 'blocked', reason],
  );
  await seedTrail('enquadre_event_trail', 'event_id', rows[0].id, s, at(s.blockedAfterEnd));
  return rows[0].id;
}

describe('fila de importação × bloqueio humano (spec 083) — Postgres real, paridade com decideStandingBlock', () => {
  let jobPostingId: string;
  const admission = { repo: undefined as unknown as AdmissionImportRepository };
  const enquadre = { repo: undefined as unknown as EnquadreImportRepository };

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL, max: 2 });
    admission.repo = new AdmissionImportRepository(pool);
    enquadre.repo = new EnquadreImportRepository(pool);
    const jp = await pool.query<{ id: string }>(
      `INSERT INTO job_postings (title, status, is_draft, country, is_test) VALUES ('083 sql', 'SEARCHING', false, 'AR', true) RETURNING id`,
    );
    jobPostingId = jp.rows[0].id;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM admission_appointments WHERE host_email LIKE $1`, [`%${EMAIL_SUFFIX}`]);
    await pool.query(`DELETE FROM enquadre_events WHERE job_posting_id = $1`, [jobPostingId]);
    await pool.query(`DELETE FROM job_postings WHERE id = $1`, [jobPostingId]);
    await pool.query(`DELETE FROM tactiq_links WHERE host_email LIKE $1`, [`%${EMAIL_SUFFIX}`]);
    await pool.end();
  });

  type Kind = 'admissão' | 'enquadre';
  const cases = SCENARIOS.flatMap((s) => (['admissão', 'enquadre'] as Kind[]).map((k) => [k, s.name, s] as const));

  it.each(cases)('%s — %s', async (kind, _name, s) => {
    const email = `h${counter + 1}-${kind === 'admissão' ? 'a' : 'e'}${EMAIL_SUFFIX}`;
    await seedLink(email, s);
    const id = kind === 'admissão' ? await seedAdmission(s, email) : await seedEnquadre(s, email, jobPostingId);
    const blockedAt = at(s.blockedAfterEnd);
    const now = new Date(blockedAt.getTime() + s.nowAfterBlock);

    const repo = kind === 'admissão' ? admission.repo : enquadre.repo;
    const ids = await repo.listDueIds(now, 1000);
    expect(ids.includes(id)).toBe(s.listed); // o SQL, contra o esperado escrito à mão

    // PARIDADE: onde a política se aplica (bloqueado por motivo humano), listado ⇔ decisão ≠ 'wait'.
    if ((s.importStatus ?? 'blocked') === 'blocked' && HUMAN.has(s.reason)) {
      const decision = decideStandingBlock({
        now, endedAt: ENDED, blockedAt, remindersSent: s.reminders ?? 0,
        linkedSinceBlock: s.linkedAfterEnd !== undefined && s.linkedAfterEnd > s.blockedAfterEnd,
      });
      expect(decision !== 'wait').toBe(s.listed);
      expect(ids.includes(id)).toBe(decision !== 'wait');
    }

    // Os dois métodos de leitura enxergam o mesmo que a fila.
    const last = await repo.lastBlockedEvent(id);
    expect(last?.reason).toBe(s.reason);
    expect(last?.at.getTime()).toBe(blockedAt.getTime());
    expect(await repo.countRemindersSince(id, blockedAt)).toBe(s.reminders ?? 0);
  });

  it('novo bloqueio zera o contador (DF-8): lembrete é contado só DEPOIS do último import_blocked', async () => {
    const email = `zera${EMAIL_SUFFIX}`;
    const s: Scenario = { name: 'x', reason: 'no_link', blockedAfterEnd: B10, reminders: 2, nowAfterBlock: 0, listed: false };
    const id = await seedAdmission(s, email);
    const second = at(B10 + 100 * H);
    await pool.query(`INSERT INTO admission_events (appointment_id, at, kind, reason) VALUES ($1, $2, 'import_blocked', 'no_link')`, [id, second]);
    expect(await admission.repo.countRemindersSince(id, at(B10))).toBe(2);
    expect(await admission.repo.countRemindersSince(id, second)).toBe(0);
    expect((await admission.repo.lastBlockedEvent(id))?.at.getTime()).toBe(second.getTime());
  });

  it('item sem nenhum import_blocked na trilha continua listado (controle do alcance)', async () => {
    const email = `semtrilha${EMAIL_SUFFIX}`;
    counter += 1;
    const { rows } = await pool.query<{ id: string }>(
      `INSERT INTO admission_appointments (country, host_email, slot_start, slot_end, status, admission_code, conference_ended_at, import_status)
       VALUES ('AR', $1, $2, $3, 'booked', $4, $5, 'blocked') RETURNING id`, [email, at(-H), at(-30 * MIN), code('ADM'), ENDED]);
    expect(await admission.repo.lastBlockedEvent(rows[0].id)).toBeNull();
    expect((await admission.repo.listDueIds(at(H), 1000)).includes(rows[0].id)).toBe(true);
  });

  it('TactiqLinkRepository.hasLinkedSince: só linked, só mais novo que `since`, e-mail sem caixa', async () => {
    const email = `link${EMAIL_SUFFIX}`;
    const repo = new TactiqLinkRepository(pool);
    expect(await repo.hasLinkedSince(email, at(0))).toBe(false); // sem vínculo
    await pool.query(`INSERT INTO tactiq_links (host_email, firebase_uid, status, status_changed_at) VALUES ($1, 'uid-link', 'linked', $2)`, [email, at(2 * H)]);
    expect(await repo.hasLinkedSince(email.toUpperCase(), at(H))).toBe(true);
    expect(await repo.hasLinkedSince(email, at(2 * H))).toBe(false); // igual não é "mais novo"
    await pool.query(`UPDATE tactiq_links SET status = 'broken' WHERE host_email = $1`, [email]);
    expect(await repo.hasLinkedSince(email, at(H))).toBe(false); // não está mais linked
  });
});
