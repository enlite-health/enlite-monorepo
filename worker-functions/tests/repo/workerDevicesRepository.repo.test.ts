/**
 * PgWorkerDeviceRepository contra POSTGRES REAL como `enlite_app` (migration 593): o SQL dos 4 movimentos do aparelho.
 *   DATABASE_URL=postgresql://enlite_app:...@127.0.0.1:<porta>/enlite_e2e npx jest --config jest.config.repo.js workerDevicesRepository --maxWorkers=2
 */
import { Pool } from 'pg';
import crypto from 'crypto';
import { PgWorkerDeviceRepository } from '../../src/modules/identity/infrastructure/PgWorkerDeviceRepository';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_app:app@127.0.0.1:5611/enlite_e2e';

describe('PgWorkerDeviceRepository (Postgres real)', () => {
  let pool: Pool;
  let repo: PgWorkerDeviceRepository;
  let workerId: string;
  let authUid: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    repo = new PgWorkerDeviceRepository(pool);
    authUid = `repo-dev-${crypto.randomUUID()}`;
    const w = await pool.query<{ id: string }>(`INSERT INTO workers (auth_uid, email) VALUES ($1, $2) RETURNING id`, [authUid, `${authUid}@enlite.test`]);
    workerId = w.rows[0].id;
  });
  afterAll(async () => {
    await pool.query(`DELETE FROM workers WHERE id = $1`, [workerId]);
    await pool.end();
  });

  const reg = (installationId = crypto.randomUUID()) =>
    repo.registerReplacingActive({ workerId, installationId, publicKey: 'pk', fcmTokenEnc: 'enc' });

  it('registrar o 2º aparelho revoga o 1º por substituição e deixa UM ativo', async () => {
    const a = await reg();
    const b = await reg();
    expect(b.replacedDeviceId).toBe(a.deviceId);
    const { rows } = await pool.query(`SELECT status, revoked_reason, revoked_by FROM worker_devices WHERE worker_id = $1 ORDER BY registered_at`, [workerId]);
    expect(rows).toEqual([
      { status: 'revogado', revoked_reason: 'substituido', revoked_by: null },
      { status: 'ativo', revoked_reason: null, revoked_by: null },
    ]);
    expect((await repo.findActive(workerId))?.deviceId).toBe(b.deviceId);
  });

  it('revogar registra quem pediu, não mexe em `workers` e a 2ª revogação não acha aparelho', async () => {
    const before = await pool.query(`SELECT status, updated_at FROM workers WHERE id = $1`, [workerId]);
    const r = await repo.revokeActive(workerId, 'op-uid');
    expect(r?.fcmTokenEnc).toBe('enc');
    expect(await repo.revokeActive(workerId, 'op-uid')).toBeNull();
    const row = (await pool.query(`SELECT revoked_by, revoked_reason, revoked_at FROM worker_devices WHERE id = $1`, [r!.deviceId])).rows[0];
    expect(row).toMatchObject({ revoked_by: 'op-uid', revoked_reason: 'operador' });
    expect(row.revoked_at).not.toBeNull();
    const after = await pool.query(`SELECT status, updated_at FROM workers WHERE id = $1`, [workerId]);
    expect(after.rows).toEqual(before.rows);
    expect(await repo.findAuthUid(workerId)).toBe(authUid);
  });

  it('confirmar o apagamento grava wiped_at uma só vez', async () => {
    const inst = crypto.randomUUID();
    await reg(inst);
    expect(await repo.confirmWipe(workerId, inst)).toBe(true);
    const first = (await pool.query(`SELECT wiped_at FROM worker_devices WHERE installation_id = $1`, [inst])).rows[0].wiped_at;
    expect(await repo.confirmWipe(workerId, inst)).toBe(false);
    const second = (await pool.query(`SELECT wiped_at FROM worker_devices WHERE installation_id = $1`, [inst])).rows[0].wiped_at;
    expect(second).toEqual(first);
    expect(await repo.confirmWipe(workerId, crypto.randomUUID())).toBe(false);
  });

  describe('findStatus (painel "Celular perdido", D795) — lido do banco, nome de quem pediu, nunca o uid', () => {
    let w: string;
    let opUid: string;
    beforeAll(async () => {
      const uid = `repo-dev-st-${crypto.randomUUID()}`;
      w = (await pool.query<{ id: string }>(`INSERT INTO workers (auth_uid, email) VALUES ($1, $2) RETURNING id`, [uid, `${uid}@enlite.test`])).rows[0].id;
      opUid = `repo-op-${crypto.randomUUID()}`;
      await pool.query(
        `INSERT INTO users (firebase_uid, email, display_name, role, account_type) VALUES ($1, $2, 'Operadora Teste', 'admin', 'staff')`,
        [opUid, `${opUid}@enlite.test`],
      );
    });
    afterAll(async () => {
      await pool.query(`DELETE FROM workers WHERE id = $1`, [w]);
      await pool.query(`DELETE FROM users WHERE firebase_uid = $1`, [opUid]);
    });

    it('sem aparelho e sem revogação → { false, null }', async () => {
      expect(await repo.findStatus(w)).toEqual({ hasActiveDevice: false, lastOperatorRevocation: null });
    });

    it('substituição (login em outro celular) NÃO conta como revogação de operador', async () => {
      await repo.registerReplacingActive({ workerId: w, installationId: crypto.randomUUID(), publicKey: 'pk', fcmTokenEnc: null });
      await repo.registerReplacingActive({ workerId: w, installationId: crypto.randomUUID(), publicKey: 'pk', fcmTokenEnc: null });
      expect(await repo.findStatus(w)).toEqual({ hasActiveDevice: true, lastOperatorRevocation: null });
    });

    it('revogado por operador sem wipedAt → pedido com o NOME de quem pediu, wipedAt null', async () => {
      await repo.revokeActive(w, opUid);
      const st = await repo.findStatus(w);
      expect(st.hasActiveDevice).toBe(false);
      expect(st.lastOperatorRevocation).toMatchObject({ wipedAt: null, requestedByName: 'Operadora Teste' });
      expect(Number.isNaN(Date.parse(st.lastOperatorRevocation!.revokedAt))).toBe(false);
      expect(JSON.stringify(st)).not.toContain(opUid);
    });

    it('o app confirma o apagamento → wipedAt preenchido', async () => {
      const { rows } = await pool.query<{ installation_id: string }>(
        `SELECT installation_id FROM worker_devices WHERE worker_id = $1 AND revoked_reason = 'operador'`, [w],
      );
      await repo.confirmWipe(w, rows[0].installation_id);
      const st = await repo.findStatus(w);
      expect(st.lastOperatorRevocation?.wipedAt).not.toBeNull();
    });

    it('operador sem linha em users → requestedByName null (nunca cai no uid)', async () => {
      await repo.registerReplacingActive({ workerId: w, installationId: crypto.randomUUID(), publicKey: 'pk', fcmTokenEnc: null });
      await repo.revokeActive(w, 'uid-sem-users');
      const st = await repo.findStatus(w);
      expect(st.lastOperatorRevocation).toMatchObject({ wipedAt: null, requestedByName: null }); // a MAIS RECENTE, ainda sem wiped
    });
  });

  describe('replacedPrevious (aviso "celular novo", D795) — vem do UPDATE da transação', () => {
    let otherWorker: string;
    beforeAll(async () => {
      const uid = `repo-dev-rp-${crypto.randomUUID()}`;
      const w = await pool.query<{ id: string }>(`INSERT INTO workers (auth_uid, email) VALUES ($1, $2) RETURNING id`, [uid, `${uid}@enlite.test`]);
      otherWorker = w.rows[0].id;
    });
    afterAll(async () => {
      await pool.query(`DELETE FROM workers WHERE id = $1`, [otherWorker]);
    });
    const regOther = (installationId: string) =>
      repo.registerReplacingActive({ workerId: otherWorker, installationId, publicKey: 'pk', fcmTokenEnc: null });

    it('primeiro aparelho da cuidadora -> false', async () => {
      const first = await regOther(crypto.randomUUID());
      expect(first.replacedPrevious).toBe(false);
      expect(first.replacedDeviceId).toBeNull();
    });

    it('aparelho novo com o antigo ativo -> true, e o antigo fica revogado por substituição', async () => {
      const old = await repo.findActive(otherWorker);
      const next = await regOther(crypto.randomUUID());
      expect(next.replacedPrevious).toBe(true);
      const row = (await pool.query(`SELECT status, revoked_reason FROM worker_devices WHERE id = $1`, [old!.deviceId])).rows[0];
      expect(row).toEqual({ status: 'revogado', revoked_reason: 'substituido' });
      expect((await repo.findActive(otherWorker))?.deviceId).toBe(next.deviceId);
    });

    it('o MESMO aparelho registrando de novo (mesmo installationId, até em maiúsculas) -> false', async () => {
      const active = await repo.findActive(otherWorker);
      const again = await regOther(active!.installationId.toUpperCase());
      expect(again.replacedPrevious).toBe(false);
      expect(again.replacedDeviceId).toBe(active!.deviceId); // o tratamento de antes se mantém: a linha velha é trocada
      const { rows } = await pool.query(`SELECT count(*)::int AS n FROM worker_devices WHERE worker_id = $1 AND status = 'ativo'`, [otherWorker]);
      expect(rows[0].n).toBe(1);
    });
  });
});
