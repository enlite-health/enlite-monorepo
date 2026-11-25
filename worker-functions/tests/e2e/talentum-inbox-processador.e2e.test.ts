/**
 * talentum-inbox-processador.e2e.test.ts — spec 095 §3.2 e §3.4 (T-095-35).
 *
 * O processador da inbox pela borda (HTTP real em `/api/internal/talentum/inbox/process|redrive`, banco real, trilha e
 * gatilhos reais), só com payload sintético. O ack guarda a linha RECEIVED; quem grava espelho, WJA e encuadre é o processador.
 *
 *  T6   3 linhas da mesma chave com `received_at` fora de ordem → processadas por `received_at`; espelho final = veredito
 *  T7   o evento novo recolhe a órfã RECEIVED mais antiga da chave
 *  T8   campo extra → REJECTED_SCHEMA, nada no espelho
 *  T9   subtype desconhecido → UNSUPPORTED; depois do "deploy que aceita o formato", o redrive → PROCESSED
 *  T10  manual (marcador `source: 'MANUAL'`) sobre REJECTED automático → QUALIFIED com `changed_by = 'talentum:manual'`;
 *       a EXPIRAÇÃO automática depois dele não rejeita (AFTER_MANUAL); e o ANALYZED sem marcador é INFERIDO como manual
 *  T11  manual contra a última linha da trilha de uid humano NOSSO → só o espelho muda + aviso CONFLITO_HUMANO
 *  T12  expiração → EXPIRED / REJECTED / TALENTUM_EXPIRED / auto_expired; depois ANALYZED/QUALIFIED automático reverte
 *  T16  os `domain_events` pendentes de COMPLETED → QUALIFIED pela inbox são só `funnel_stage.qualified`
 *
 * Canal real: nenhum. `PubSubClient` é mock em NODE_ENV=test (o ack não dispara o processador; quem processa é a rota interna
 * chamada aqui), o KMS é passthrough base64, a API de teste não alcança terceiro (extra_hosts) e o Talentum nunca é chamado.
 *
 * Prova do aviso CONFLITO_HUMANO (T11): o default do port `ITalentumConflictNotifier` é o sino (T-095-42). O teste lê a TABELA:
 * `notification_events` (`TALENTUM_WEBHOOK_ALARM`, payload `{alarme:'CONFLITO_HUMANO', quantidade, desde}`) e `notifications`
 * dos destinatários semeados aqui (1 do Acesso Master e 1 com a célula `talentum:update`). Nenhum canal externo: o sino é só banco.
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { TALENTUM_WEBHOOK_TEST } from './helpers/talentumWebhook';
import { envelope, type ResponseBlock } from '../fixtures/talentumPayload';
import { computeBodyHash } from '../../src/modules/integration/domain/TalentumInbox';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const PROCESS = '/api/internal/talentum/inbox/process';
const REDRIVE = '/api/internal/talentum/inbox/redrive';
const RUN = Date.now().toString(36);
const HUMAN_UID = `uid-humano-p95-${RUN}`;
const TENANT = '00000000-0000-0000-0000-000000000001';
const MASTER_GROUP = 'a0000000-0000-0000-0000-000000000001';
const MASTER_UID = `uid-master-p95-${RUN}`;
const COORD_UID = `uid-coord-p95-${RUN}`;
const COORD_GROUP = `E2E Talentum sino ${RUN}`;

const internalHeaders = () => ({ 'X-Internal-Secret': process.env.INTERNAL_TOKEN_SECRET || 'test-secret-for-e2e-only' });

type Subtype = 'INITIATED' | 'IN_PROGRESS' | 'COMPLETED' | 'ANALYZED' | 'EXPIRED';
type Label = 'QUALIFIED' | 'NOT_QUALIFIED' | 'IN_DOUBT' | 'PENDING' | 'EXPIRED';
type Payload = ReturnType<typeof envelope>;

describe('Talentum — processador da inbox (spec 095 §3.2/§3.4)', () => {
  const api = createApiClient();
  let pool: Pool;

  // Cada caso tem a sua chave (prescreening + profile), seu worker e sua vaga: nada é compartilhado entre casos.
  const CASES = ['T6', 'T7', 'T8', 'T9', 'T10A', 'T10C', 'T11', 'T12', 'T16'] as const;
  type Case = (typeof CASES)[number];
  const PSC = (c: Case) => `proc95-${RUN}-psc-${c}`;
  const PROF = (c: Case) => `proc95-${RUN}-prof-${c}`;
  const EMAIL = (c: Case) => `proc95.${RUN}.${c.toLowerCase()}@e2e.local`;
  const TITLE = (c: Case) => `CASO PROC95 ${RUN} ${c}`;
  const PHONE = (c: Case) => `+54911${String(7000000 + CASES.indexOf(c) * 111).padStart(7, '0')}`;
  const wid = {} as Record<Case, string>;
  const jid = {} as Record<Case, string>;

  let seq = 0;
  /** Corpo sintético do evento; `response.id` único por chamada (o corpo vira o `body_hash` da inbox). */
  const body = (c: Case, subtype: Subtype, extra: Record<string, unknown> = {}): Payload =>
    envelope({
      subtype: subtype as never,
      prescreening: { id: PSC(c), name: TITLE(c) },
      profile: { id: PROF(c), email: EMAIL(c), phoneNumber: PHONE(c), cuil: `20-9${PHONE(c).slice(-7)}-1` },
      response: { id: `proc95-${RUN}-resp-${c}-${(seq += 1)}`, state: [], ...extra } as ResponseBlock,
    });
  const analyzed = (c: Case, label: Label, extra: Record<string, unknown> = {}) =>
    body(c, 'ANALYZED', { score: 80, statusLabel: label, ...extra });

  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');

  /** Linha da inbox INSERIDA DIRETO (KMS de teste = base64), com `received_at` explícito. */
  const insertInbox = async (c: Case, payload: unknown, receivedAt: Date): Promise<string> => {
    const p = payload as { action: string; subtype?: string; data?: { response?: { statusLabel?: string } } };
    const { rows } = await pool.query(
      `INSERT INTO talentum_webhook_inbox
         (body_hash, action, subtype, status_label, talentum_prescreening_id, talentum_profile_id, environment, state, payload_enc, received_at)
       VALUES ($1, $2, $3, $4, $5, $6, 'test', 'RECEIVED', $7, $8) RETURNING id`,
      [computeBodyHash(payload), p.action, p.subtype ?? null, p.data?.response?.statusLabel ?? null, PSC(c), PROF(c), b64(payload), receivedAt],
    );
    return rows[0].id;
  };

  /** Ack real do webhook (guarda RECEIVED, não toca o espelho). Devolve o id da linha da inbox. */
  const ack = async (c: Case, payload: unknown): Promise<string> => {
    await pool.query(`DELETE FROM talentum_webhook_inbox WHERE body_hash = $1`, [computeBodyHash(payload)]);
    const res = await api.post(TALENTUM_WEBHOOK_TEST, payload);
    expect(res.status).toBe(200);
    const { rows } = await pool.query(`SELECT id FROM talentum_webhook_inbox WHERE body_hash = $1`, [computeBodyHash(payload)]);
    expect(rows).toHaveLength(1);
    void c;
    return rows[0].id;
  };

  /** Push do Pub/Sub de uma linha: o processador leva a ela e a todas as RECEIVED da chave. */
  const processRow = (inboxId: string) =>
    api.post(PROCESS, { message: { data: b64({ inboxId }), messageId: '1' }, subscription: 'sub' }, { headers: internalHeaders() });

  /** ack + processamento (o evento chega e é processado, como em prod). */
  const send = async (c: Case, payload: unknown) => {
    const id = await ack(c, payload);
    const res = await processRow(id);
    expect(res.status).toBe(200);
    return { id, res };
  };

  const inbox = async (c: Case) =>
    (await pool.query(`SELECT id, state, error_code, subtype FROM talentum_webhook_inbox WHERE talentum_prescreening_id = $1 ORDER BY received_at, id`, [PSC(c)])).rows as Array<{ id: string; state: string; error_code: string | null; subtype: string | null }>;
  const mirror = async (c: Case) =>
    (await pool.query(`SELECT status FROM talentum_prescreenings WHERE talentum_prescreening_id = $1`, [PSC(c)])).rows as Array<{ status: string }>;
  const stage = async (c: Case) =>
    (await pool.query(`SELECT application_funnel_stage AS s FROM worker_job_applications WHERE worker_id=$1 AND job_posting_id=$2`, [wid[c], jid[c]])).rows[0]?.s as string | undefined;
  const encuadre = async (c: Case) =>
    (await pool.query(`SELECT resultado, rejection_reason_category AS cat FROM encuadres WHERE worker_id=$1 AND job_posting_id=$2`, [wid[c], jid[c]])).rows[0];
  const trail = async (c: Case) =>
    (await pool.query(
      `SELECT h.new_value, h.changed_by, h.reason_category
         FROM worker_job_application_stage_history h JOIN worker_job_applications a ON a.id = h.application_id
        WHERE a.worker_id=$1 AND a.job_posting_id=$2 AND h.field_name='application_funnel_stage'
        ORDER BY h.created_at, h.id`, [wid[c], jid[c]])).rows as Array<{ new_value: string; changed_by: string | null; reason_category: string | null }>;
  const events = async (c: Case, event: string) =>
    (await pool.query(`SELECT status, payload FROM domain_events WHERE event=$1 AND payload->>'workerId'=$2 AND payload->>'jobPostingId'=$3`, [event, wid[c], jid[c]])).rows;

  /** "Mover a…" humano: UPDATE do WJA (+ encuadre) com `app.current_uid` carimbado, como o `withActorContext` (molde do requalifica). */
  const humanMove = async (c: Case, target: 'REJECTED') => {
    const cl = await pool.connect();
    try {
      await cl.query('BEGIN');
      await cl.query(`SELECT set_config('app.current_uid', $1, true)`, [HUMAN_UID]);
      await cl.query(`UPDATE worker_job_applications SET application_funnel_stage=$3, updated_at=NOW() WHERE worker_id=$1 AND job_posting_id=$2`, [wid[c], jid[c], target]);
      await cl.query(`UPDATE encuadres SET resultado='RECHAZADO', rejection_reason_category='DISTANCE', updated_at=NOW() WHERE worker_id=$1 AND job_posting_id=$2`, [wid[c], jid[c]]);
      await cl.query('COMMIT');
    } catch (e) {
      await cl.query('ROLLBACK');
      throw e;
    } finally {
      cl.release();
    }
  };

  async function clean() {
    const w = Object.values(wid).filter(Boolean);
    if (w.length) {
      await pool.query(`DELETE FROM worker_job_applications WHERE worker_id = ANY($1::uuid[])`, [w]);
      await pool.query(`DELETE FROM encuadres WHERE worker_id = ANY($1::uuid[])`, [w]);
      await pool.query(`DELETE FROM domain_events WHERE payload->>'workerId' = ANY($1::text[])`, [w]);
    }
    await pool.query(`DELETE FROM talentum_prescreening_responses WHERE prescreening_id IN (SELECT id FROM talentum_prescreenings WHERE talentum_prescreening_id LIKE $1)`, [`proc95-${RUN}-%`]);
    await pool.query(`DELETE FROM talentum_prescreenings WHERE talentum_prescreening_id LIKE $1`, [`proc95-${RUN}-%`]);
    await pool.query(`DELETE FROM talentum_webhook_inbox WHERE talentum_prescreening_id LIKE $1`, [`proc95-${RUN}-%`]);
  }

  /** Destinatários do sino: 1 no Acesso Master e 1 num grupo DESTE teste com a célula `talentum:update` (nada da operação é tocado). */
  async function seedRecipients() {
    await pool.query(
      `INSERT INTO users (firebase_uid, email, role, status, is_active, tenant_id) VALUES
         ($1, $3, 'admin', 'ACTIVE', true, $5), ($2, $4, 'recruiter', 'ACTIVE', true, $5)`,
      [MASTER_UID, COORD_UID, `${MASTER_UID}@e2e.local`, `${COORD_UID}@e2e.local`, TENANT],
    );
    await pool.query(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ($1, $2, $3)`, [MASTER_UID, MASTER_GROUP, TENANT]);
    const g = await pool.query<{ id: string }>(
      `INSERT INTO iam.permission_groups (tenant_id, name, description, is_system) VALUES ($1, $2, 'e2e sino talentum', false) RETURNING id`,
      [TENANT, COORD_GROUP],
    );
    const granted = await pool.query(
      `INSERT INTO iam.group_permissions (group_id, permission_id) SELECT $1, id FROM iam.permissions WHERE resource = 'talentum' AND action = 'update'`,
      [g.rows[0].id],
    );
    expect(granted.rowCount).toBe(1); // a célula existe no catálogo do stack: contagem 0 seria "não semeei", não sucesso
    await pool.query(`INSERT INTO iam.user_groups (user_id, group_id, tenant_id) VALUES ($1, $2, $3)`, [COORD_UID, g.rows[0].id, TENANT]);
  }

  async function cleanRecipients() {
    const uids = [MASTER_UID, COORD_UID];
    await pool.query(`DELETE FROM notifications WHERE recipient_uid = ANY($1::text[])`, [uids]);
    await pool.query(`DELETE FROM iam.user_groups WHERE user_id = ANY($1::text[])`, [uids]);
    await pool.query(`DELETE FROM iam.group_permissions WHERE group_id IN (SELECT id FROM iam.permission_groups WHERE name = $1)`, [COORD_GROUP]);
    await pool.query(`DELETE FROM iam.permission_groups WHERE name = $1`, [COORD_GROUP]);
    await pool.query(`DELETE FROM users WHERE firebase_uid = ANY($1::text[])`, [uids]);
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await waitForBackend(api);
    await cleanRecipients();
    await seedRecipients();
    for (const c of CASES) {
      wid[c] = (await pool.query(`INSERT INTO workers (auth_uid, email, status) VALUES ($1, $2, 'INCOMPLETE_REGISTER') RETURNING id`, [`talentum_${PROF(c)}`, EMAIL(c)])).rows[0].id;
      jid[c] = (await pool.query(`INSERT INTO job_postings (title, description, status) VALUES ($1, 'test', 'SEARCHING') RETURNING id`, [TITLE(c)])).rows[0].id;
    }
  });

  afterAll(async () => {
    await clean();
    await cleanRecipients();
    await pool.query(`DELETE FROM job_postings WHERE id = ANY($1::uuid[])`, [Object.values(jid)]);
    await pool.query(`DELETE FROM workers WHERE id = ANY($1::uuid[])`, [Object.values(wid)]);
    await pool.end();
  });

  // ── T6 ────────────────────────────────────────────────────────────────────────────────────────────────
  it('T6: 3 linhas da mesma chave com received_at fora de ordem → processadas por received_at; espelho final = o veredito', async () => {
    const t0 = Date.now() - 60 * 60 * 1000;
    // Inseridas na ordem FÍSICA contrária à cronológica: COMPLETED primeiro, depois ANALYZED, depois INITIATED.
    const completed = await insertInbox('T6', body('T6', 'COMPLETED'), new Date(t0 + 3000));
    const verdict = await insertInbox('T6', analyzed('T6', 'QUALIFIED'), new Date(t0 + 2000)); // ANTES do COMPLETED
    // O INITIATED é o mais PESADO (200 respostas, gravadas em série): processado em paralelo com os outros, o veredito
    // chegaria ao WJA antes dele. Em ordem (e sob o lock) o degrau PRE_SCREENING vem primeiro, sempre.
    const heavy = Array.from({ length: 200 }, (_, i) => ({ questionId: `q${i}`, question: `pergunta ${i}`, answer: `resposta ${i}`, responseType: 'text' }));
    const initiated = await insertInbox('T6', body('T6', 'INITIATED', { state: heavy }), new Date(t0 + 1000));
    expect(await mirror('T6')).toHaveLength(0);

    const res = await processRow(completed);
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ inboxId: completed, outcome: 'PROCESSED', processed: 3 });

    expect((await inbox('T6')).map((r) => [r.id, r.state])).toEqual([
      [initiated, 'PROCESSED'],
      [verdict, 'PROCESSED'],
      [completed, 'PROCESSED'],
    ]);
    expect((await mirror('T6')).map((r) => r.status)).toEqual(['QUALIFIED']);
    // A ordem de processamento ficou na trilha do WJA: INITIATED (PRE_SCREENING) → veredito. Fora de ordem, o 1º degrau seria outro.
    expect((await trail('T6')).map((r) => r.new_value)).toEqual(['PRE_SCREENING', 'QUALIFIED']);
    expect(await stage('T6')).toBe('QUALIFIED');
  });

  // ── T7 ────────────────────────────────────────────────────────────────────────────────────────────────
  it('T7: o evento novo recolhe a órfã RECEIVED mais antiga da chave (as duas viram PROCESSED)', async () => {
    const orphan = await ack('T7', body('T7', 'INITIATED')); // o publish "falhou": ninguém a processou
    await pool.query(`UPDATE talentum_webhook_inbox SET received_at = now() - interval '2 hours' WHERE id = $1`, [orphan]);
    expect((await inbox('T7')).map((r) => r.state)).toEqual(['RECEIVED']);
    expect(await mirror('T7')).toHaveLength(0);

    const fresh = await ack('T7', body('T7', 'COMPLETED'));
    const res = await processRow(fresh);
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ inboxId: fresh, outcome: 'PROCESSED', processed: 2 });

    expect((await inbox('T7')).map((r) => [r.id, r.state])).toEqual([
      [orphan, 'PROCESSED'],
      [fresh, 'PROCESSED'],
    ]);
    expect((await mirror('T7')).map((r) => r.status)).toEqual(['COMPLETED']);
  });

  // ── T8 ────────────────────────────────────────────────────────────────────────────────────────────────
  it('T8: campo extra no response (schema strict) → REJECTED_SCHEMA e nada no espelho', async () => {
    const { id, res } = await send('T8', body('T8', 'COMPLETED', { campoInventado: 'x' }));
    expect(res.data).toEqual({ inboxId: id, outcome: 'PROCESSED', processed: 0 });
    const rows = await inbox('T8');
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('REJECTED_SCHEMA');
    expect(rows[0].error_code).toBe('SCHEMA_INVALID');
    expect(await mirror('T8')).toHaveLength(0);
  });

  // ── T9 ────────────────────────────────────────────────────────────────────────────────────────────────
  it('T9: subtype desconhecido → UNSUPPORTED; depois do "deploy" que aceita o formato, o redrive por estado → PROCESSED', async () => {
    const unknown = body('T9', 'COMPLETED');
    (unknown as { subtype: string }).subtype = 'FORMATO_NOVO_DO_TALENTUM';
    const { id, res } = await send('T9', unknown);
    expect(res.data).toEqual({ inboxId: id, outcome: 'PROCESSED', processed: 0 });
    let row = (await inbox('T9'))[0];
    expect(row.state).toBe('UNSUPPORTED');
    expect(row.error_code).toBe('UNSUPPORTED_SUBTYPE');
    expect(await mirror('T9')).toHaveLength(0);

    // Reprocessar sem nada mudar não resolve: o redrive só leva adiante o que o código passou a aceitar.
    // SIMULAÇÃO do "deploy que aceita o formato": a MESMA linha tem o corpo trocado pelo formato aceito (subtype COMPLETED).
    // `payload_enc` é o corpo cifrado (KMS de teste = base64); `subtype` da coluna acompanha.
    const accepted = body('T9', 'COMPLETED');
    await pool.query(`UPDATE talentum_webhook_inbox SET payload_enc = $2, subtype = 'COMPLETED' WHERE id = $1`, [id, b64(accepted)]);

    // `limit: 500` (o teto) cobre linhas UNSUPPORTED alheias no mesmo banco; a minha tem de estar entre as processadas.
    const drive = await api.post(REDRIVE, { state: 'UNSUPPORTED', limit: 500 }, { headers: internalHeaders() });
    expect(drive.status).toBe(200);
    expect(drive.data.selected).toBeGreaterThanOrEqual(1);
    expect(drive.data.failed).toBe(0);

    row = (await inbox('T9'))[0];
    expect(row.state).toBe('PROCESSED');
    expect((await mirror('T9')).map((r) => r.status)).toEqual(['COMPLETED']);
  });

  // ── T10 ───────────────────────────────────────────────────────────────────────────────────────────────
  describe('T10: manual × automático (spec §3.4; contrato do Ioni NÃO confirmado)', () => {
    it('T10a: rejeição automática e depois mudança manual com marcador → WJA QUALIFIED, e a última linha da trilha é talentum:manual', async () => {
      await send('T10A', analyzed('T10A', 'NOT_QUALIFIED'));
      expect(await stage('T10A')).toBe('REJECTED');
      expect(await encuadre('T10A')).toEqual({ resultado: 'RECHAZADO', cat: 'TALENTUM_NOT_QUALIFIED' });

      await send('T10A', analyzed('T10A', 'QUALIFIED', { source: 'MANUAL' }));

      expect((await mirror('T10A')).map((r) => r.status)).toEqual(['QUALIFIED']);
      expect(await stage('T10A')).toBe('QUALIFIED');
      expect(await encuadre('T10A')).toEqual({ resultado: null, cat: null });
      const t = await trail('T10A');
      expect(t[t.length - 1]).toMatchObject({ new_value: 'QUALIFIED', changed_by: 'talentum:manual' });
    });

    it('T10b: depois do T10a, uma EXPIRAÇÃO automática muda o espelho mas NÃO rejeita o WJA nem o encuadre (AFTER_MANUAL)', async () => {
      const before = await trail('T10A');
      expect(before[before.length - 1].changed_by).toBe('talentum:manual');

      // Forma por `statusLabel` (a outra, por subtype, é o T12): as duas são aceitas pelo schema (T-095-34).
      await send('T10A', analyzed('T10A', 'EXPIRED'));

      expect((await mirror('T10A')).map((r) => r.status)).toEqual(['EXPIRED']);
      expect(await stage('T10A')).toBe('QUALIFIED');
      expect(await encuadre('T10A')).toEqual({ resultado: null, cat: null });
      expect(await trail('T10A')).toEqual(before); // nenhuma linha nova na trilha
      expect(await events('T10A', 'funnel_stage.rejected')).toHaveLength(1); // só o da NQ automática do T10a
      expect((await events('T10A', 'funnel_stage.rejected'))[0].payload.source).toBe('auto_not_qualified');
    });

    it('T10c: sem marcador, um ANALYZED com veredito diferente do gravado é INFERIDO como manual (changed_by = talentum:manual)', async () => {
      // Comportamento esperado ATÉ o Ioni definir o marcador (spec §3.4 "Sem marcador" e §14): sem `source`, todo ANALYZED com
      // veredito ≠ gravado é tratado como reclassificação manual, então um "NQ automático" posterior não é distinguível dela.
      await send('T10C', analyzed('T10C', 'NOT_QUALIFIED'));
      await send('T10C', analyzed('T10C', 'QUALIFIED', { source: 'MANUAL' }));
      expect(await stage('T10C')).toBe('QUALIFIED');

      await send('T10C', analyzed('T10C', 'NOT_QUALIFIED')); // SEM marcador

      expect((await mirror('T10C')).map((r) => r.status)).toEqual(['NOT_QUALIFIED']);
      expect(await stage('T10C')).toBe('REJECTED');
      const t = await trail('T10C');
      expect(t[t.length - 1]).toMatchObject({ new_value: 'REJECTED', changed_by: 'talentum:manual' });
    });
  });

  // ── T11 ───────────────────────────────────────────────────────────────────────────────────────────────
  it('T11: manual com a última linha da trilha de uid humano NOSSO → só o espelho muda, o WJA fica, e o aviso CONFLITO_HUMANO entra no sino (tabela)', async () => {
    const t11Start = new Date();
    await send('T11', body('T11', 'COMPLETED'));
    expect(await stage('T11')).toBe('COMPLETED');
    await humanMove('T11', 'REJECTED');
    const before = await trail('T11');
    expect(before[before.length - 1]).toMatchObject({ new_value: 'REJECTED', changed_by: HUMAN_UID });

    await send('T11', analyzed('T11', 'QUALIFIED', { source: 'MANUAL' }));

    expect((await mirror('T11')).map((r) => r.status)).toEqual(['QUALIFIED']); // o espelho muda
    expect(await stage('T11')).toBe('REJECTED'); // o movimento humano nosso vence
    expect(await encuadre('T11')).toEqual({ resultado: 'RECHAZADO', cat: 'DISTANCE' });
    expect(await trail('T11')).toEqual(before);

    // Prova do aviso: a TABELA do sino (não o log). Só enum + inteiro + data; os dois destinatários semeados recebem.
    const { rows: ev } = await pool.query(
      `SELECT e.id, e.actor_uid, e.patient_id, e.payload, e.payload::text AS raw,
              (SELECT array_agg(n.recipient_uid ORDER BY n.recipient_uid) FROM notifications n WHERE n.event_id = e.id) AS uids
         FROM notification_events e
        WHERE e.type_code = 'TALENTUM_WEBHOOK_ALARM' AND e.payload->>'alarme' = 'CONFLITO_HUMANO' AND e.created_at >= $1`,
      [t11Start],
    );
    expect(ev).toHaveLength(1); // um aviso por evento: 1 conflito → 1 evento
    expect(ev[0].actor_uid).toBe('system:talentum-webhook');
    expect(ev[0].patient_id).toBeNull();
    expect(Object.keys(ev[0].payload).sort()).toEqual(['alarme', 'desde', 'quantidade']);
    expect(ev[0].payload.quantidade).toBe(1);
    expect(ev[0].uids).toEqual(expect.arrayContaining([MASTER_UID, COORD_UID].sort()));
    // sem PII (nem o e-mail do candidato, nem os ids de worker/vaga)
    for (const forbidden of [EMAIL('T11'), PSC('T11'), wid.T11, jid.T11]) expect(ev[0].raw).not.toContain(forbidden);
  });

  // ── T12 ───────────────────────────────────────────────────────────────────────────────────────────────
  it('T12: expiração → EXPIRED/REJECTED/TALENTUM_EXPIRED/auto_expired; depois ANALYZED/QUALIFIED automático reverte', async () => {
    await send('T12', body('T12', 'COMPLETED')); // etapa ≤ QUALIFIED, última movimentação automática
    expect(await stage('T12')).toBe('COMPLETED');

    await send('T12', body('T12', 'EXPIRED')); // forma por subtype

    expect((await mirror('T12')).map((r) => r.status)).toEqual(['EXPIRED']);
    expect(await stage('T12')).toBe('REJECTED');
    expect(await encuadre('T12')).toEqual({ resultado: 'RECHAZADO', cat: 'TALENTUM_EXPIRED' });
    const t = await trail('T12');
    expect(t[t.length - 1]).toMatchObject({ new_value: 'REJECTED', reason_category: 'TALENTUM_EXPIRED' });
    const rejected = await events('T12', 'funnel_stage.rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0].payload.source).toBe('auto_expired');
    expect(rejected[0].status).toBe('processed'); // audit-only: nenhuma mensagem ao prestador

    // O espelho gravado é EXPIRED: a inferência de manual só compara com QUALIFIED/NOT_QUALIFIED/IN_DOUBT, então NÃO dispara.
    await send('T12', analyzed('T12', 'QUALIFIED'));

    expect((await mirror('T12')).map((r) => r.status)).toEqual(['QUALIFIED']);
    expect(await stage('T12')).toBe('QUALIFIED');
    expect(await encuadre('T12')).toEqual({ resultado: null, cat: null });
    expect(await events('T12', 'funnel_stage.rejection_reverted')).toHaveLength(1);
    const after = await trail('T12');
    expect(after[after.length - 1].changed_by ?? '').not.toBe('talentum:manual'); // foi reversão AUTOMÁTICA
  });

  // ── T16 ───────────────────────────────────────────────────────────────────────────────────────────────
  it('T16: COMPLETED → QUALIFIED pela inbox cria os mesmos domain_events pendentes de antes: só funnel_stage.qualified', async () => {
    await send('T16', body('T16', 'COMPLETED'));
    await send('T16', analyzed('T16', 'QUALIFIED'));
    expect(await stage('T16')).toBe('QUALIFIED');

    const { rows } = await pool.query(
      `SELECT event, count(*)::int AS n FROM domain_events
        WHERE payload->>'workerId' = $1 AND payload->>'jobPostingId' = $2 AND status = 'pending'
        GROUP BY event ORDER BY event`,
      [wid.T16, jid.T16],
    );
    expect(rows).toEqual([{ event: 'funnel_stage.qualified', n: 1 }]);
    expect((await events('T16', 'funnel_stage.qualified'))[0].payload.source).toBe('talentum');
    // Nenhum outro evento de funil, pendente ou não, nasceu na transição.
    const all = await pool.query(
      `SELECT event, status, count(*)::int AS n FROM domain_events WHERE payload->>'workerId' = $1 GROUP BY event, status ORDER BY event`,
      [wid.T16],
    );
    expect(all.rows.map((r) => `${r.event}:${r.status}:${r.n}`)).toEqual([expect.stringMatching(/^funnel_stage\.qualified:[a-z_]+:1$/)]);
  });
});
