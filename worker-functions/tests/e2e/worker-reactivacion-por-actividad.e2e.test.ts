/**
 * worker-reactivacion-por-actividad.e2e.test.ts
 *
 * O prestador arquivado por ERRO NOSSO volta sozinho quando dá sinal de vida; o que pediu BAIXA
 * não volta nunca. Contra Postgres + API reais — a distinção mora numa string em
 * `worker_status_history.changed_by`, e unit test com pool mockado não prova que a rota autenticada
 * de fato escreve (nem que o trigger de histórico registra a autoria).
 *
 * Contexto (D245): o arquivamento em massa de 10/08 mediu a antiguidade do REGISTRO e não a
 * atividade da PESSOA. 32 prestadores seguiram usando o app enquanto o painel os escondia, e dois
 * viraram chamado do time. A trava aqui protege as 4 pessoas que realmente pediram para sair.
 *
 * É o par simétrico de `worker-disabled-oculto.e2e.test.ts`: lá, a baixa some da tela e CONTINUA
 * sumida; aqui, o arquivamento indevido se desfaz — e a baixa legítima segue intocada.
 */

import { Pool } from 'pg';
import { createApiClient, getMockToken, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('Reativação por atividade — só desfaz o que foi ato administrativo nosso', () => {
  const api = createApiClient();
  let pool: Pool;
  const suffix = `react-${Date.now()}`;

  /** Worker DISABLED com histórico de arquivamento e opt-out, como em produção. */
  async function createArchivedWorker(
    tag: string,
    archivedBy: string,
    optOutReason: 'admin' | 'user_request',
  ): Promise<{ workerId: string; uid: string; email: string }> {
    const uid = `uid-${tag}-${suffix}`;
    const email = `worker-${tag}-${suffix}@reactivacion.test`;

    const res = await pool.query(
      `INSERT INTO workers (auth_uid, email, phone, country, timezone, status)
       VALUES ($1, $2, $3, 'AR', 'America/Argentina/Buenos_Aires', 'DISABLED')
       RETURNING id`,
      [uid, email, `54911${Math.floor(Math.random() * 90000000 + 10000000)}`],
    );
    const workerId = res.rows[0].id as string;

    // A transição que arquivou. `changed_by` é o dado que decide tudo.
    await pool.query(
      `INSERT INTO worker_status_history (worker_id, field_name, old_value, new_value, changed_by)
       VALUES ($1, 'status', 'INCOMPLETE_REGISTER', 'DISABLED', $2)`,
      [workerId, archivedBy],
    );

    await pool.query(
      `INSERT INTO messaging_opt_out (worker_id, phone, reason, source, opted_out_at)
       SELECT id, phone, $2, $3, NOW() FROM workers WHERE id = $1`,
      [
        workerId,
        optOutReason,
        optOutReason === 'admin' ? 'bulk_archive_stale_2026_01_30' : 'luz_conversation',
      ],
    );

    return { workerId, uid, email };
  }

  async function readState(workerId: string) {
    const w = await pool.query('SELECT status FROM workers WHERE id = $1', [workerId]);
    const o = await pool.query(
      'SELECT reason, source, opted_in_at FROM messaging_opt_out WHERE worker_id = $1',
      [workerId],
    );
    const h = await pool.query(
      `SELECT changed_by, old_value, new_value FROM worker_status_history
        WHERE worker_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [workerId],
    );
    return { status: w.rows[0]?.status, optOut: o.rows[0], lastHistory: h.rows[0] };
  }

  /** O prestador abrindo o app: GET autenticado no próprio cadastro. */
  async function workerOpensApp(uid: string, email: string) {
    const token = await getMockToken(api, { uid, email, role: 'worker' });
    return api.get('/api/workers/me', {
      headers: { Authorization: `Bearer ${token}` },
      validateStatus: () => true,
    });
  }

  beforeAll(async () => {
    await waitForBackend(api);
    pool = new Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('arquivado pelo lote (system:) → volta a INCOMPLETE_REGISTER ao abrir o app', async () => {
    const { workerId, uid, email } = await createArchivedWorker(
      'lote',
      'system:bulk-archive-stale-2026-01-30',
      'admin',
    );

    expect((await readState(workerId)).status).toBe('DISABLED');

    const res = await workerOpensApp(uid, email);
    expect(res.status).toBe(200);

    // A rota devolve o estado NOVO, não o que estava em memória antes da escrita.
    expect(res.data.data.status).toBe('INCOMPLETE_REGISTER');

    const after = await readState(workerId);
    expect(after.status).toBe('INCOMPLETE_REGISTER');

    // O trigger gravou a autoria — é o que permite isolar/reverter a coorte depois.
    expect(after.lastHistory).toMatchObject({
      old_value: 'DISABLED',
      new_value: 'INCOMPLETE_REGISTER',
      changed_by: 'system:reactivacion-por-actividad',
    });

    // O opt-out NÃO é tocado (parecer `lex`): `reason='admin'` não prova origem administrativa,
    // porque o lote sobrescreveu `reason` via ON CONFLICT numa tabela sem histórico.
    expect(after.optOut.opted_in_at).toBeNull();
    expect(after.optOut.reason).toBe('admin');
    expect(after.optOut.source).toBe('bulk_archive_stale_2026_01_30');
  });

  it('arquivado por job system: FORA da allow-list → NÃO reativa', async () => {
    const { workerId, uid, email } = await createArchivedWorker(
      'job-novo',
      'system:algum-job-futuro-nao-classificado',
      'admin',
    );

    await workerOpensApp(uid, email);

    // `changed_by` é VARCHAR livre: prefixo é convenção de quem escreveu, não garantia do banco.
    // O padrão é não reativar — job novo só entra depois de ser classificado.
    const after = await readState(workerId);
    expect(after.status).toBe('DISABLED');
  });

  it('pediu baixa no PASSADO e o lote arquivou por cima → NÃO reativa', async () => {
    const { workerId, uid, email } = await createArchivedWorker(
      'baixa-antes',
      'system:bulk-archive-stale-2026-01-30',
      'admin',
    );

    // Uma baixa a pedido ANTES do lote: a última transição é nossa, mas a vontade dela está lá.
    await pool.query(
      `INSERT INTO worker_status_history (worker_id, field_name, old_value, new_value, changed_by, created_at)
       VALUES ($1, 'status', 'REGISTERED', 'DISABLED', 'luz:baja-cuenta', NOW() - INTERVAL '60 days')`,
      [workerId],
    );

    await workerOpensApp(uid, email);

    const after = await readState(workerId);
    expect(after.status).toBe('DISABLED');
  });

  it('deu BAIXA pela Luz (luz:baja-cuenta) → continua DISABLED, opt-out intacto', async () => {
    const { workerId, uid, email } = await createArchivedWorker(
      'baja',
      'luz:baja-cuenta',
      'user_request',
    );

    const res = await workerOpensApp(uid, email);
    expect([200, 404]).toContain(res.status);

    const after = await readState(workerId);
    expect(after.status).toBe('DISABLED');
    expect(after.optOut.opted_in_at).toBeNull();
    expect(after.optOut.reason).toBe('user_request');

    // Nenhuma transição nova: o histórico continua sendo o da baixa dela.
    expect(after.lastHistory.changed_by).toBe('luz:baja-cuenta');
  });

  it('baixa por direito do titular (lgpd:) → continua DISABLED', async () => {
    const { workerId, uid, email } = await createArchivedWorker(
      'lgpd',
      'lgpd:baja-solicitada:e2e',
      'user_request',
    );

    await workerOpensApp(uid, email);

    const after = await readState(workerId);
    expect(after.status).toBe('DISABLED');
    expect(after.optOut.opted_in_at).toBeNull();
  });

  it('é idempotente: abrir o app de novo não gera nova transição', async () => {
    const { workerId, uid, email } = await createArchivedWorker(
      'idem',
      'system:redisable-30d-cut-2026-08-11',
      'admin',
    );

    await workerOpensApp(uid, email);
    await workerOpensApp(uid, email);

    const count = await pool.query(
      `SELECT COUNT(*)::int AS n FROM worker_status_history
        WHERE worker_id = $1 AND changed_by = 'system:reactivacion-por-actividad'`,
      [workerId],
    );
    expect(count.rows[0].n).toBe(1);
  });
});
