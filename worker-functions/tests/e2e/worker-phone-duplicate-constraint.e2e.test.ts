/**
 * E2E (regressão): constraint idx_workers_phone_unique no update de perfil
 *
 * Reproduz contra Postgres real o bug que vazava
 *   "duplicate key value violates unique constraint \"idx_workers_phone_unique\""
 * para o worker ao completar o perfil (PUT /api/workers/me/general-info).
 *
 * Causa raiz: a base tem workers DUPLICADOS pelo mesmo número em formatos
 * históricos diferentes. O update gravava o telefone CRU, sem normalizar e sem
 * checar colisão → quando o form reenviava o número num formato que casava com
 * uma linha duplicada, estourava a constraint e o SQL cru aparecia na tela.
 *
 * Garantias verificadas aqui:
 *   1. Round-trip do próprio número (mesmo humano, formato diferente) com uma
 *      duplicata existente → 200, NUNCA vaza 23505 (cenário exato da tela).
 *   2. Troca real para um número que pertence a OUTRO worker → 409 com código
 *      PHONE_NOT_AVAILABLE e mensagem amigável, SEM revelar a outra conta e SEM
 *      vazar SQL.
 *   3. Troca real para um número livre → 200 e grava o número canônico.
 */

import axios, { AxiosInstance } from 'axios';
import { Pool } from 'pg';

const API_URL = process.env.API_URL || 'http://localhost:8080';
const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

// Sufixo de 7 dígitos único por execução (evita colidir com dados pré-existentes).
// Cada número usa um prefixo local distinto (100/200/300) para garantir que A, C
// e o número "livre" sejam números humanos DIFERENTES entre si.
const SUFFIX = String(Date.now()).slice(-7);
const LOCAL_A = '100' + SUFFIX; // A (10 díg, formato legado como está no banco)
const CANON_A = '549' + LOCAL_A; // mesmo número humano de A, canônico 13 díg (duplicata D)
const CANON_C = '549' + '200' + SUFFIX; // número DIFERENTE, dono = worker C
const LOCAL_FREE = '300' + SUFFIX; // número livre (ninguém possui)
const CANON_FREE = '549' + LOCAL_FREE;
const LOCAL_M = '400' + SUFFIX; // número cujo único "dono" é um registro MERGED
const CANON_M = '549' + LOCAL_M;

const basePayload = {
  firstName: 'Eliana',
  lastName: 'Juarez',
  sex: 'female',
  gender: 'female',
  birthDate: '1990-04-18',
  documentType: 'DNI',
  documentNumber: '30111222',
  languages: ['es'],
  profession: 'CAREGIVER',
  knowledgeLevel: 'SECONDARY',
  titleCertificate: 'Cert',
  experienceTypes: ['adicciones'],
  yearsExperience: '3_5',
  preferredTypes: ['adicciones'],
  preferredAgeRange: ['adults'],
  termsAccepted: true,
  privacyAccepted: true,
};

describe('Worker phone duplicate constraint — regressão idx_workers_phone_unique', () => {
  let api: AxiosInstance;
  let db: Pool;
  let workerAId: string;
  let workerDId: string;
  let workerCId: string;
  let workerMId: string;
  let tokenA: string;

  const stamp = Date.now();
  const uidA = `phone-dup-A-${stamp}`;
  const uidD = `phone-dup-D-${stamp}`;
  const uidC = `phone-dup-C-${stamp}`;
  const uidM = `phone-dup-M-${stamp}`;

  beforeAll(async () => {
    api = axios.create({ baseURL: API_URL, headers: { 'Content-Type': 'application/json' } });
    db = new Pool({ connectionString: DATABASE_URL });
    await waitForBackend();

    // Worker A (quem completa o perfil) — começa SEM phone via API.
    workerAId = await initWorker(uidA, `phone-dup-a-${stamp}@example.com`);
    // Worker D: DUPLICATA de A (mesmo número humano, formato canônico).
    workerDId = await initWorker(uidD, `phone-dup-d-${stamp}@example.com`);
    // Worker C: número DIFERENTE, dono legítimo.
    workerCId = await initWorker(uidC, `phone-dup-c-${stamp}@example.com`);
    // Worker M: DUPLICATA MERGED — segura um número mas está marcada como merged,
    // logo NÃO pode ser tratada como "dona" do número (mig 219/dedup).
    workerMId = await initWorker(uidM, `phone-dup-m-${stamp}@example.com`);

    // Simula os formatos históricos diretamente no banco (a API normalizaria).
    await db.query('UPDATE workers SET phone = $1 WHERE id = $2', [LOCAL_A, workerAId]); // A: 10 díg
    await db.query('UPDATE workers SET phone = $1 WHERE id = $2', [CANON_A, workerDId]); // D: 13 díg (mesmo nº de A)
    await db.query('UPDATE workers SET phone = $1 WHERE id = $2', [CANON_C, workerCId]); // C: outro nº
    // M segura LOCAL_M e é merged para dentro de C.
    await db.query('UPDATE workers SET phone = $1, merged_into_id = $2 WHERE id = $3', [
      LOCAL_M,
      workerCId,
      workerMId,
    ]);

    tokenA = await mockToken(uidA, `phone-dup-a-${stamp}@example.com`);
  });

  afterAll(async () => {
    // M aponta para C via merged_into_id (FK) — limpa M antes de C.
    for (const id of [workerAId, workerDId, workerMId, workerCId]) {
      if (id) await db.query('DELETE FROM workers WHERE id = $1', [id]);
    }
    await db.end();
  });

  async function waitForBackend(maxRetries = 30) {
    for (let i = 0; i < maxRetries; i++) {
      try {
        await api.get('/health');
        return;
      } catch {
        await new Promise((r) => setTimeout(r, 1000));
      }
    }
    throw new Error('Backend not ready after 30 seconds');
  }

  async function initWorker(authUid: string, email: string): Promise<string> {
    const res = await api.post('/api/workers/init', { authUid, email, country: 'AR' });
    return res.data.data.worker.id;
  }

  async function mockToken(uid: string, email: string): Promise<string> {
    const res = await api.post('/api/test/auth/token', { uid, email, role: 'worker' });
    return res.data.data.token;
  }

  function authA() {
    return { headers: { Authorization: `Bearer ${tokenA}` } };
  }

  it('CENÁRIO DA TELA: round-trip do próprio número (formato canônico) com duplicata existente → 200, sem 23505', async () => {
    // A está gravado como LOCAL_A; uma duplicata D tem o MESMO número em CANON_A.
    // O form reenvia o número em formato canônico (≠ string de A, = string de D).
    // Antes do fix isso gravava CANON_A e colidia com D. Agora normaliza, vê que
    // é o mesmo número, e NÃO toca no phone → salva o resto sem colidir.
    const res = await api.put(
      '/api/workers/me/general-info',
      { ...basePayload, phone: CANON_A },
      authA(),
    );

    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);

    // O phone de A permanece intacto (não foi sobrescrito por um valor colidente).
    const row = await db.query('SELECT phone FROM workers WHERE id = $1', [workerAId]);
    expect(row.rows[0].phone).toBe(LOCAL_A);

    // E o resto do perfil foi salvo.
    const prof = await db.query('SELECT profession FROM workers WHERE id = $1', [workerAId]);
    expect(prof.rows[0].profession).toBe('CAREGIVER');
  });

  it('troca real para número de OUTRO worker → 409 PHONE_NOT_AVAILABLE, sem vazar SQL nem citar outra conta', async () => {
    // A tenta mudar o phone para o número de C (em formato local, normaliza p/ CANON_C).
    const localOfC = CANON_C.slice(3); // 10 dígitos do número de C
    let caught: any;
    try {
      await api.put('/api/workers/me/general-info', { ...basePayload, phone: localOfC }, authA());
    } catch (err: any) {
      caught = err;
    }

    expect(caught).toBeDefined();
    expect(caught.response.status).toBe(409);
    expect(caught.response.data.code).toBe('PHONE_NOT_AVAILABLE');

    const errText = JSON.stringify(caught.response.data).toLowerCase();
    expect(errText).not.toContain('duplicate key');
    expect(errText).not.toContain('constraint');
    expect(errText).not.toContain('idx_workers_phone_unique');
    // Privacidade: não revela que pertence a outra conta.
    expect(errText).not.toContain('cuenta');
    expect(errText).not.toContain('account');
    expect(errText).not.toContain('otro');

    // Garante que NÃO alterou o phone de A.
    const row = await db.query('SELECT phone FROM workers WHERE id = $1', [workerAId]);
    expect(row.rows[0].phone).toBe(LOCAL_A);
  });

  it('troca real para número LIVRE → 200 e grava o número canônico', async () => {
    const res = await api.put(
      '/api/workers/me/general-info',
      { ...basePayload, phone: LOCAL_FREE },
      authA(),
    );

    expect(res.status).toBe(200);
    const row = await db.query('SELECT phone FROM workers WHERE id = $1', [workerAId]);
    expect(row.rows[0].phone).toBe(CANON_FREE);
  });

  it('colisão informada já em formato canônico também é bloqueada sem vazar SQL', async () => {
    // Submete exatamente o número canônico de C. A checagem prévia bloqueia com
    // 409; e, como rede de segurança, o catch do repo traduziria um eventual
    // 23505 para o mesmo código — em nenhum caminho a mensagem crua do Postgres
    // chega ao cliente.
    let caught: any;
    try {
      await api.put('/api/workers/me/general-info', { ...basePayload, phone: CANON_C }, authA());
    } catch (err: any) {
      caught = err;
    }
    expect(caught).toBeDefined();
    expect(caught.response.status).toBe(409);
    expect(JSON.stringify(caught.response.data).toLowerCase()).not.toContain('duplicate key');
  });

  it('FOLLOW-UP 2: número cujo único dono é um registro MERGED → 200 (não bloqueia)', async () => {
    // A muda para o número humano de M (informa o local; normaliza p/ CANON_M).
    // M segura esse número mas está MERGED → não conta como dona. Antes do fix,
    // findByPhoneCandidates ignorava merged_into_id, retornava M e bloqueava com
    // um 409 PHONE_NOT_AVAILABLE falso. Agora o lookup exclui merged → libera.
    const res = await api.put(
      '/api/workers/me/general-info',
      { ...basePayload, phone: LOCAL_M },
      authA(),
    );

    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);

    // A passou a ter o número canônico; M (merged) permanece com o formato local.
    const a = await db.query('SELECT phone FROM workers WHERE id = $1', [workerAId]);
    expect(a.rows[0].phone).toBe(CANON_M);
    const m = await db.query('SELECT phone, merged_into_id FROM workers WHERE id = $1', [workerMId]);
    expect(m.rows[0].phone).toBe(LOCAL_M);
    expect(m.rows[0].merged_into_id).toBe(workerCId);
  });

  it('FOLLOW-UP 1: UPDATE PARCIAL — payload sem firstName/profession PRESERVA os campos atuais', async () => {
    // 1. Grava um perfil completo (firstName + profession etc.).
    const full = await api.put(
      '/api/workers/me/general-info',
      { ...basePayload, firstName: 'Eliana', lastName: 'Juarez', profession: 'CAREGIVER', phone: LOCAL_M },
      authA(),
    );
    expect(full.status).toBe(200);

    const before = await db.query(
      'SELECT first_name_encrypted, last_name_encrypted, profession, name_trgm_bidx FROM workers WHERE id = $1',
      [workerAId],
    );
    expect(before.rows[0].first_name_encrypted).not.toBeNull();
    expect(before.rows[0].profession).toBe('CAREGIVER');

    // 2. Envia um payload PARCIAL — só muda yearsExperience, OMITE o resto
    //    (firstName, lastName, profession, phone, sex, languages...).
    const partial = await api.put(
      '/api/workers/me/general-info',
      { yearsExperience: '6_10', termsAccepted: true, privacyAccepted: true },
      authA(),
    );
    expect(partial.status).toBe(200);

    const after = await db.query(
      'SELECT first_name_encrypted, last_name_encrypted, profession, years_experience, name_trgm_bidx FROM workers WHERE id = $1',
      [workerAId],
    );
    // Campos OMITIDOS preservados (antes do fix viravam NULL = "campo some").
    expect(after.rows[0].first_name_encrypted).toBe(before.rows[0].first_name_encrypted);
    expect(after.rows[0].last_name_encrypted).toBe(before.rows[0].last_name_encrypted);
    expect(after.rows[0].profession).toBe('CAREGIVER');
    // Blind index do nome também preservado (não recomputado sem o par de nomes).
    expect(after.rows[0].name_trgm_bidx).toEqual(before.rows[0].name_trgm_bidx);
    // Campo realmente enviado foi atualizado.
    expect(after.rows[0].years_experience).toBe('6_10');
  });
});
