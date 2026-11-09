/**
 * POST /api/auth/claim/{start,confirm} — a sobrevivente sintética que ABSORVEU um login real não é reclamável (P5/A, T190).
 *
 * Cenário: ficha sintética S (auth_uid `anacareimport_*`) que, num merge, engoliu a ficha A de um login real
 * (A.merged_into_id = S.id, A.auth_uid real). Quem só prova o telefone de S não pode herdar o histórico de A.
 *
 *  (a) start com o telefone de S → 200 { noCandidate: true } (a busca não a oferece; nenhum OTP)
 *  (b) confirm direto por candidateWorkerId = S (2ª porta, findById) → recusado (NOT_IMPORTABLE) e S segue intacta
 *  (c) controle positivo: ficha sintética comum (nada absorvido) continua candidata: sid TEST_ no start
 *
 * Bate na API real e confere o BANCO. CANAL: nenhum OTP real (E2E_OTP_BYPASS no stack; sid `TEST_<uuid>`,
 * api.twilio.com → 127.0.0.1). Mesmo padrão de claim-uid-do-token.e2e.test.ts (H3).
 */
import { Pool } from 'pg';
import { createApiClient, getMockToken, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const OTP = process.env.E2E_OTP_CODE ?? '123456';
const EMULATOR = process.env.USE_FIREBASE_EMULATOR === 'true';

describe('claim — sobrevivente sintética que absorveu login real (P5/A)', () => {
  const api = createApiClient();
  let pool: Pool;
  const stamp = `${Date.now()}`;
  const digits8 = stamp.slice(-8);
  const phoneSobrevivente = `54913${digits8}`;
  const phoneComum = `54914${digits8}`;
  const uidSobrevivente = `anacareimport_p5_${stamp}`;
  const uidComum = `anacareimport_p5c_${stamp}`;
  const uidRealAbsorvido = `uid-real-absorvido-${stamp}`;
  const uidQuemReclama = `uid-reclama-${stamp}`;
  const emailQuemReclama = `reclama-${stamp}@exemplo.test`;
  let sobreviventeId = '';
  let absorvidaId = '';
  let comumId = '';

  // Rate limit por IP (em memória): cada chamada usa um X-Forwarded-For próprio.
  let n = 0;
  const bearer = async () => ({
    headers: {
      'X-Forwarded-For': `203.0.113.${(Number(digits8) + ++n) % 250 + 1}`,
      Authorization: `Bearer ${await getMockToken(api, { uid: uidQuemReclama, email: emailQuemReclama, role: 'worker' })}`,
    },
  });
  const bodyUid = EMULATOR ? {} : { authUid: uidQuemReclama };
  const authUidDe = async (id: string) =>
    (await pool.query('SELECT auth_uid FROM workers WHERE id = $1', [id])).rows[0].auth_uid as string;
  const insert = async (authUid: string, email: string, phone: string | null) =>
    (
      await pool.query(
        `INSERT INTO workers (id, auth_uid, email, phone, status, country, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, 'INCOMPLETE_REGISTER', 'AR', NOW(), NOW()) RETURNING id`,
        [authUid, email, phone],
      )
    ).rows[0].id as string;

  beforeAll(async () => {
    await waitForBackend(api);
    pool = new Pool({ connectionString: DATABASE_URL });
    sobreviventeId = await insert(uidSobrevivente, `sobrev-${stamp}@exemplo.test`, phoneSobrevivente);
    absorvidaId = await insert(uidRealAbsorvido, `absorvida-${stamp}@exemplo.test`, null);
    await pool.query('UPDATE workers SET merged_into_id = $1 WHERE id = $2', [sobreviventeId, absorvidaId]);
    comumId = await insert(uidComum, `comum-${stamp}@exemplo.test`, phoneComum);
  });

  afterAll(async () => {
    for (const id of [absorvidaId, sobreviventeId, comumId]) {
      if (id) await pool.query('DELETE FROM workers WHERE id = $1', [id]).catch(() => {});
    }
    await pool.end();
  });

  it('(a) a busca NÃO oferece a sobrevivente que absorveu login real: 200 noCandidate, sem sid', async () => {
    const res = await api.post(
      '/api/auth/claim/start',
      { ...bodyUid, email: emailQuemReclama, phone: `+${phoneSobrevivente}` },
      await bearer(),
    );
    expect(res.status).toBe(200);
    expect(res.data).toEqual({ success: true, data: { noCandidate: true } });
    expect(JSON.stringify(res.data)).not.toContain(sobreviventeId);
  });

  it('(b) o confirm por candidateWorkerId = sobrevivente é recusado e a ficha segue intacta', async () => {
    const res = await api.post(
      '/api/auth/claim/confirm',
      { ...bodyUid, verificationSid: 'TEST_p5-nao-importa', otp: OTP, email: emailQuemReclama, candidateWorkerId: sobreviventeId },
      await bearer(),
    );
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
    expect(await authUidDe(sobreviventeId)).toBe(uidSobrevivente);
  });

  it('(c) controle positivo: ficha sintética comum continua candidata (sid TEST_, sem canal real)', async () => {
    const res = await api.post(
      '/api/auth/claim/start',
      { ...bodyUid, email: emailQuemReclama, phone: `+${phoneComum}` },
      await bearer(),
    );
    expect(res.status).toBe(200);
    const data = res.data.data as { candidateWorkerId: string; verificationSid: string };
    expect(data.candidateWorkerId).toBe(comumId);
    expect(data.verificationSid).toMatch(/^TEST_/);
  });
});
