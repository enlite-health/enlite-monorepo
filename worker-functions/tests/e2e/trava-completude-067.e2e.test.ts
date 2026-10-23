/**
 * trava-completude-067.e2e.test.ts — spec 067 F7 (A2, FR-11, A3, A4/FR-13, A6, A11), API VIVA + banco REAL.
 *
 * Candidatura em etapa de Completado (COMPLETED/QUALIFIED/IN_DOUBT) de prestador que NÃO está apto (documento obrigatório apagado,
 * desvalidado ou reenviado) aparece em BLOQUEADOS no funil e NÃO é convocável — lido da completude VIVA, sem esperar recálculo de
 * `status` e sem tocar na candidatura:
 *   A2 / FR-11  DELETE admin, DELETE self-service, invalidate e reenvio → Bloqueados + fora de `available-workers`, lidos logo
 *               após a resposta; o `status` só cai no DELETE
 *   A3          validar o último documento pendente → volta a Completado com etapa, nota e linha da candidatura IDÊNTICAS
 *               (0 escrita em worker_job_applications) e 0 `worker.mirror_requested` novo
 *   A4 / FR-13  o webhook da Talentum com prestador incompleto responde EXATAMENTE como antes (corpo gravado de `origin/main`,
 *               fixtures/trava-completude-067-webhook-referencia.json) e grava prescreening, encuadre e candidatura
 *   A6          a soma das 9 colunas = total de candidaturas da vaga, antes e depois
 *   A11         o admin esvazia um campo obrigatório de um REGISTERED → INCOMPLETE_REGISTER → o card vai a Bloqueados
 *
 * Outbound mapeado (plan §6): validate/invalidate não saem; o DELETE usa caminho fora do prefixo do prestador (o controller
 * registra "record_only" e NÃO chama o GCS); o webhook grava e pode enfileirar mensagem de etapa em domain_events (pending, sem
 * Pub/Sub nem Twilio nesta stack); A11 roda o caso de uso em processo (mirror fica `pending`). Rede do jest e da API bloqueada
 * (scripts/rede-bloqueada-em-teste.cjs). Dados SINTÉTICOS (@example.test), sem PII em asserção.
 */
import { Pool } from 'pg';
import * as fs from 'fs';
import * as path from 'path';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
process.env.DATABASE_URL = DATABASE_URL;

import { createApiClient, getMockToken, waitForBackend } from './helpers';
import { completeWorkerProfile, cleanWorkerProfile, type AptoDocs } from './helpers/aptoWorkerFixture';

/** As 9 colunas do quadro da vaga (VACANCY_BOARD_COLUMNS). IN_PROGRESS é dobrada em PRE_SCREENING e não conta. */
const NOVE_COLUNAS = ['COMPATIBLE', 'INVITED', 'INICIADO', 'PRE_SCREENING', 'BLOQUEADO', 'COMPLETED', 'SELECTED', 'QUICK_RESPONSE_TEAM', 'REJECTED'];
const REFERENCIA = path.join(__dirname, 'fixtures', 'trava-completude-067-webhook-referencia.json');
/** Gravar a resposta de referência: `GRAVAR_REFERENCIA_067=1` contra uma API de `origin/main`. Nunca no CI. */
const GRAVAR = process.env.GRAVAR_REFERENCIA_067 === '1';

const RUN = Date.now().toString(36);
const CASE_FUNIL = 99067200; // vaga dos cenários A2/A3/A11
const CASE_A6 = 99067201;
const CASE_A4 = 99067202;
const ID = {
  patient: 'a0670000-0000-4000-d001-000000000001',
  vagaFunil: 'a0670000-0000-4000-d002-000000000001',
  vagaA6: 'a0670000-0000-4000-d002-000000000002',
  vagaA4: 'a0670000-0000-4000-d002-000000000003',
};
const VAGAS = [ID.vagaFunil, ID.vagaA6, ID.vagaA4];

type Card = { id: string; workerId: string | null; internalStage?: string; isBlocked?: boolean };

const api = createApiClient();
let pool: Pool;
let adminAuth: { headers: { Authorization: string } };
let seq = 0;
const workers: string[] = [];

// ── semeadura ────────────────────────────────────────────────────────────────

async function novoPrestador(tag: string, docs: AptoDocs, status: 'REGISTERED' | 'INCOMPLETE_REGISTER' = 'REGISTERED'): Promise<{ id: string; authUid: string; email: string }> {
  seq += 1;
  const authUid = `uid-067-${tag}-${RUN}-${seq}`;
  const email = `p067-${tag}-${RUN}-${seq}@example.test`;
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO workers (auth_uid, email, status, country, timezone) VALUES ($1, $2, 'INCOMPLETE_REGISTER', 'AR', 'America/Argentina/Buenos_Aires') RETURNING id`,
    [authUid, email],
  );
  const id = rows[0].id;
  workers.push(id);
  // o guard só deixa virar REGISTERED com cadastro completo; "sem documento" é o REGISTERED legado que perdeu o arquivo depois
  await completeWorkerProfile(pool, id, docs === 'none' && status === 'REGISTERED' ? 'unvalidated' : docs);
  if (status === 'REGISTERED') await pool.query(`UPDATE workers SET status = 'REGISTERED' WHERE id = $1`, [id]);
  if (docs === 'none' && status === 'REGISTERED') await pool.query(`DELETE FROM worker_documents WHERE worker_id = $1`, [id]);
  return { id, authUid, email };
}

async function candidatar(workerId: string, vaga: string, stage: string, score: number | null = null): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_funnel_stage, source, match_score)
     VALUES ($1, $2, $3, 'talentum', $4) RETURNING id`,
    [workerId, vaga, stage, score],
  );
  return rows[0].id;
}

async function semearVaga(id: string, caseNumber: number, title: string): Promise<void> {
  const { rows } = await pool.query<{ vn: string }>("SELECT nextval('job_postings_vacancy_number_seq') AS vn");
  await pool.query(
    `INSERT INTO job_postings (id, vacancy_number, case_number, patient_id, title, description, country, status, is_draft, is_test)
     VALUES ($1, $2, $3, $4, $5, '', 'AR', 'SEARCHING', false, true)`,
    [id, parseInt(rows[0].vn, 10), caseNumber, ID.patient, title],
  );
}

async function limpar(): Promise<void> {
  await pool.query(`DELETE FROM worker_blocked_applications WHERE job_posting_id = ANY($1::uuid[])`, [VAGAS]).catch(() => undefined);
  await pool.query(`DELETE FROM talentum_prescreenings WHERE job_posting_id = ANY($1::uuid[])`, [VAGAS]).catch(() => undefined);
  await pool.query(`DELETE FROM encuadres WHERE job_posting_id = ANY($1::uuid[])`, [VAGAS]);
  await pool.query(`DELETE FROM worker_job_applications WHERE job_posting_id = ANY($1::uuid[])`, [VAGAS]);
  await pool.query(`DELETE FROM job_postings WHERE id = ANY($1::uuid[])`, [VAGAS]);
  const ws = (await pool.query<{ id: string }>(`SELECT id FROM workers WHERE email LIKE 'p067-%@example.test'`)).rows.map((r) => r.id);
  await cleanWorkerProfile(pool, ws);
  await pool.query(`DELETE FROM domain_events WHERE payload->>'workerId' = ANY($1::text[])`, [ws]).catch(() => undefined);
  await pool.query(`DELETE FROM worker_status_history WHERE worker_id = ANY($1::uuid[])`, [ws]).catch(() => undefined);
  await pool.query(`DELETE FROM workers WHERE id = ANY($1::uuid[])`, [ws]);
  await pool.query(`DELETE FROM patients WHERE id = $1`, [ID.patient]);
}

// ── leituras (a API viva; o mesmo que o front lê) ────────────────────────────

async function stagesDoFunil(vaga: string): Promise<Record<string, Card[]>> {
  const res = await api.get(`/api/admin/vacancies/${vaga}/funnel`, adminAuth);
  expect(res.status).toBe(200);
  return res.data.data.stages as Record<string, Card[]>;
}

/** Coluna(s) do quadro em que o prestador aparece (esperado: exatamente uma). */
async function colunaDe(vaga: string, workerId: string): Promise<string[]> {
  const stages = await stagesDoFunil(vaga);
  return Object.entries(stages).filter(([, cs]) => cs.some((c) => c.workerId === workerId)).map(([col]) => col);
}

async function convocaveis(vaga: string): Promise<string[]> {
  const res = await api.get(`/api/admin/vacancies/${vaga}/enquadre-events/available-workers`, adminAuth);
  expect(res.status).toBe(200);
  return (res.data.data.workers as Array<{ id: string }>).map((w) => w.id);
}

async function tabela(vaga: string): Promise<{ colunas: Record<string, number>; soma: number }> {
  const res = await api.get(`/api/admin/vacancies/${vaga}/funnel-table`, adminAuth);
  expect(res.status).toBe(200);
  const colunas = res.data.data.counts.columns as Record<string, number>;
  expect(colunas.IN_PROGRESS ?? 0).toBe(0); // dobrada em PRE_SCREENING: a soma das 9 é a soma de tudo
  return { colunas, soma: NOVE_COLUNAS.reduce((a, c) => a + colunas[c], 0) };
}

const linhaWja = async (id: string): Promise<Record<string, unknown>> =>
  (await pool.query(`SELECT to_jsonb(w) AS j FROM worker_job_applications w WHERE id = $1`, [id])).rows[0].j;
const statusDe = async (w: string): Promise<string> => (await pool.query(`SELECT status FROM workers WHERE id = $1`, [w])).rows[0].status;
const nEventos = async (evento: string, w: string): Promise<number> =>
  (await pool.query(`SELECT count(*)::int AS n FROM domain_events WHERE event = $1 AND payload->>'workerId' = $2`, [evento, w])).rows[0].n;

beforeAll(async () => {
  await waitForBackend(api);
  pool = new Pool({ connectionString: DATABASE_URL });
  const token = await getMockToken(api, { uid: 'admin-067', email: 'admin-067@e2e.local', role: 'admin' });
  adminAuth = { headers: { Authorization: `Bearer ${token}` } };
  await limpar();
  await pool.query(`INSERT INTO patients (id, clickup_task_id, country, first_name, last_name) VALUES ($1, 'trava-067', 'AR', 'Ficticia', 'Teste')`, [ID.patient]);
  await semearVaga(ID.vagaFunil, CASE_FUNIL, `067 funil ${RUN}`);
  await semearVaga(ID.vagaA6, CASE_A6, `067 a6 ${RUN}`);
  await semearVaga(ID.vagaA4, CASE_A4, `CASO ${CASE_A4}-base`);
});

afterAll(async () => {
  await limpar();
  await pool.end();
  const { DatabaseConnection } = await import('@shared/database/DatabaseConnection');
  await DatabaseConnection.getInstance().getPool().end().catch(() => undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
describe('A2 + FR-11 — apagar, desvalidar ou reenviar documento obrigatório leva o card a Bloqueados NA HORA', () => {
  type Caso = { nome: string; statusDepois: string; agir: (p: { id: string; authUid: string; email: string }) => Promise<void> };
  const casos: Caso[] = [
    {
      nome: 'DELETE admin /documents/:type',
      statusDepois: 'INCOMPLETE_REGISTER',
      agir: async (p) => {
        const r = await api.delete(`/api/admin/workers/${p.id}/documents/identity_document`, adminAuth);
        expect(r.status).toBe(200);
      },
    },
    {
      nome: 'DELETE self-service /workers/me/documents/:type',
      statusDepois: 'INCOMPLETE_REGISTER',
      agir: async (p) => {
        const t = await getMockToken(api, { uid: p.authUid, email: p.email, role: 'worker' });
        const r = await api.delete('/api/workers/me/documents/identity_document', { headers: { Authorization: `Bearer ${t}` } });
        expect(r.status).toBe(200);
      },
    },
    {
      nome: 'invalidate (DELETE /documents/:type/validate)',
      statusDepois: 'REGISTERED',
      agir: async (p) => {
        const r = await api.delete(`/api/admin/workers/${p.id}/documents/identity_document/validate`, adminAuth);
        expect(r.status).toBe(200);
      },
    },
    {
      nome: 'reenvio (POST /documents/save troca o arquivo)',
      statusDepois: 'REGISTERED',
      agir: async (p) => {
        const r = await api.post(
          `/api/admin/workers/${p.id}/documents/save`,
          { docType: 'identity_document', filePath: `workers/${p.id}/identity-novo.pdf` },
          adminAuth,
        );
        expect(r.status).toBe(200);
      },
    },
  ];

  it.each(casos)('$nome — Bloqueados e fora de available-workers logo após a resposta; etapa e nota intactas; status $statusDepois', async (caso) => {
    const p = await novoPrestador('a2', 'validated');
    const wja = await candidatar(p.id, ID.vagaFunil, 'COMPLETED', 77);
    const antes = await linhaWja(wja);

    // controle (o teste sabe dizer "apto"): antes da ação o card está em Completado e o prestador é convocável
    expect(await colunaDe(ID.vagaFunil, p.id)).toEqual(['COMPLETED']);
    expect(await convocaveis(ID.vagaFunil)).toContain(p.id);

    await caso.agir(p);

    // FR-11: lido LOGO DEPOIS da resposta — sem esperar recálculo, evento ou cron
    expect(await colunaDe(ID.vagaFunil, p.id)).toEqual(['BLOQUEADO']);
    expect(await convocaveis(ID.vagaFunil)).not.toContain(p.id);
    expect(await statusDe(p.id)).toBe(caso.statusDepois);

    // FR-12: a candidatura (etapa, nota) não foi tocada
    const depois = await linhaWja(wja);
    expect(depois.application_funnel_stage).toBe('COMPLETED');
    expect(Number(depois.match_score)).toBe(77);
    expect(depois).toEqual(antes);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('A3 — validar o último documento pendente devolve o card a Completado sem escrever na candidatura', () => {
  it('Bloqueados (QUALIFIED, nota 80) → valida os 2 obrigatórios → Completado; linha da candidatura idêntica; 0 worker.mirror_requested novo', async () => {
    const p = await novoPrestador('a3', 'unvalidated');
    const wja = await candidatar(p.id, ID.vagaFunil, 'QUALIFIED', 80);

    expect(await colunaDe(ID.vagaFunil, p.id)).toEqual(['BLOQUEADO']); // controle: começa em Bloqueados
    expect(await convocaveis(ID.vagaFunil)).not.toContain(p.id);

    const linhaAntes = await linhaWja(wja);
    const mirrorAntes = await nEventos('worker.mirror_requested', p.id);
    const histAntes = (await pool.query(`SELECT count(*)::int AS n FROM worker_job_application_stage_history WHERE application_id = $1`, [wja])).rows[0].n;

    const v1 = await api.post(`/api/admin/workers/${p.id}/documents/identity_document/validate`, {}, adminAuth);
    expect(v1.status).toBe(200);
    expect(await colunaDe(ID.vagaFunil, p.id)).toEqual(['BLOQUEADO']); // ainda falta um: continua bloqueado
    const v2 = await api.post(`/api/admin/workers/${p.id}/documents/criminal_record/validate`, {}, adminAuth);
    expect(v2.status).toBe(200);

    expect(await colunaDe(ID.vagaFunil, p.id)).toEqual(['COMPLETED']);
    expect(await convocaveis(ID.vagaFunil)).toContain(p.id);
    const linhaDepois = await linhaWja(wja);
    expect(linhaDepois).toEqual(linhaAntes); // etapa, match_score, updated_at… tudo igual: 0 escrita
    expect(linhaDepois.application_funnel_stage).toBe('QUALIFIED');
    expect(Number(linhaDepois.match_score)).toBe(80);
    expect((await pool.query(`SELECT count(*)::int AS n FROM worker_job_application_stage_history WHERE application_id = $1`, [wja])).rows[0].n).toBe(histAntes);
    expect(await nEventos('worker.mirror_requested', p.id)).toBe(mirrorAntes);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('A6 — a soma das 9 colunas = total de candidaturas da vaga, antes e depois', () => {
  it('vaga com todas as colunas povoadas: soma == total (WJA + tentativas barradas) e == cards do Kanban; idem depois de uma desvalidação', async () => {
    const aptoCompleted = await novoPrestador('a6a', 'validated');
    const aptoQualified = await novoPrestador('a6b', 'validated');
    const naoAptoInDoubt = await novoPrestador('a6c', 'unvalidated');
    const naoAptoCompleted = await novoPrestador('a6d', 'none');
    const invited = await novoPrestador('a6e', 'validated');
    const preScreening = await novoPrestador('a6f', 'validated');
    const selected = await novoPrestador('a6g', 'validated');
    const rejected = await novoPrestador('a6h', 'validated');
    const barrado = await novoPrestador('a6i', 'none', 'INCOMPLETE_REGISTER');
    await candidatar(aptoCompleted.id, ID.vagaA6, 'COMPLETED', 70);
    await candidatar(aptoQualified.id, ID.vagaA6, 'QUALIFIED', 90);
    await candidatar(naoAptoInDoubt.id, ID.vagaA6, 'IN_DOUBT', 55);
    await candidatar(naoAptoCompleted.id, ID.vagaA6, 'COMPLETED', 60);
    await candidatar(invited.id, ID.vagaA6, 'INVITED');
    await candidatar(preScreening.id, ID.vagaA6, 'PRE_SCREENING');
    await candidatar(selected.id, ID.vagaA6, 'SELECTED');
    await candidatar(rejected.id, ID.vagaA6, 'REJECTED');
    await pool.query(
      `INSERT INTO worker_blocked_applications
         (worker_id, job_posting_id, blocked_reason_at_attempt, missing_fields_at_attempt, acquisition_channel, attempt_count, first_attempted_at, last_attempted_at)
       VALUES ($1, $2, 'registration_incomplete', '["profession"]', 'site', 1, NOW(), NOW())`,
      [barrado.id, ID.vagaA6],
    );

    const total = async (): Promise<number> =>
      (await pool.query(`SELECT (SELECT count(*) FROM worker_job_applications WHERE job_posting_id = $1) + (SELECT count(*) FROM worker_blocked_applications WHERE job_posting_id = $1 AND promoted_at IS NULL AND dismissed_at IS NULL) AS n`, [ID.vagaA6])).rows[0].n * 1;
    const cards = async (): Promise<number> => Object.values(await stagesDoFunil(ID.vagaA6)).reduce((a, cs) => a + cs.length, 0);

    expect(await total()).toBe(9); // controle: 8 candidaturas + 1 tentativa barrada
    const antes = await tabela(ID.vagaA6);
    expect(NOVE_COLUNAS.every((c) => typeof antes.colunas[c] === 'number')).toBe(true); // as 9 existem, inclusive Bloqueados
    expect(antes.colunas.BLOQUEADO).toBe(2); // IN_DOUBT sem validação + COMPLETED sem documento
    expect(antes.colunas.COMPLETED).toBe(2);
    expect(antes.soma).toBe(await total());
    expect(await cards()).toBe(antes.soma);

    // depois: um apto perde a validação — a soma não muda, o card muda de coluna
    const inv = await api.delete(`/api/admin/workers/${aptoCompleted.id}/documents/criminal_record/validate`, adminAuth);
    expect(inv.status).toBe(200);
    const depois = await tabela(ID.vagaA6);
    expect(depois.colunas.BLOQUEADO).toBe(3);
    expect(depois.colunas.COMPLETED).toBe(1);
    expect(depois.soma).toBe(await total());
    expect(depois.soma).toBe(antes.soma);
    expect(await cards()).toBe(depois.soma);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('A11 — o admin esvazia um campo obrigatório de um REGISTERED → INCOMPLETE_REGISTER → o card vai a Bloqueados', () => {
  it('UpdateWorkerProfileFieldsUseCase com campo vazio rebaixa o status e o funil lê Bloqueados; completar de novo promove (volta a Completado só se apto)', async () => {
    const { UpdateWorkerProfileFieldsUseCase } = await import('../../src/modules/worker/application/UpdateWorkerProfileFieldsUseCase');
    const p = await novoPrestador('a11', 'validated');
    const wja = await candidatar(p.id, ID.vagaFunil, 'COMPLETED', 66);
    const antes = await linhaWja(wja);
    expect(await colunaDe(ID.vagaFunil, p.id)).toEqual(['COMPLETED']); // controle
    expect(await statusDe(p.id)).toBe('REGISTERED');

    await new UpdateWorkerProfileFieldsUseCase().execute(
      { workerId: p.id, titleCertificate: '' },
      { source: 'admin_panel', actorUid: 'staff-uid-067' },
    );

    expect(await statusDe(p.id)).toBe('INCOMPLETE_REGISTER');
    expect(await colunaDe(ID.vagaFunil, p.id)).toEqual(['BLOQUEADO']);
    expect(await convocaveis(ID.vagaFunil)).not.toContain(p.id);
    expect(await linhaWja(wja)).toEqual(antes); // a candidatura não foi tocada

    // a volta: preencher o campo promove (SÓ PROMOVE era a regra antiga; agora promove E rebaixa)
    await new UpdateWorkerProfileFieldsUseCase().execute(
      { workerId: p.id, titleCertificate: 'DEGREE' },
      { source: 'admin_panel', actorUid: 'staff-uid-067' },
    );
    expect(await statusDe(p.id)).toBe('REGISTERED');
    expect(await colunaDe(ID.vagaFunil, p.id)).toEqual(['COMPLETED']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
describe('A4 + FR-13 — o webhook da Talentum com prestador incompleto responde como antes e grava tudo', () => {
  it('prestador REGISTERED sem documento validado: INITIATED e ANALYZED+QUALIFIED respondem idêntico à referência de origin/main; prescreening, encuadre e candidatura gravados; card em Bloqueados', async () => {
    const p = await novoPrestador('a4', 'unvalidated');
    const phone = (await pool.query<{ phone: string }>(`SELECT phone FROM workers WHERE id = $1`, [p.id])).rows[0].phone;
    const prescreeningId = `p067-psc-${RUN}`;
    const envio = async (subtype: string, extra: Record<string, unknown> = {}) => {
      const res = await api.post('/api/webhooks/talentum/prescreening', {
        action: 'PRESCREENING_RESPONSE',
        subtype,
        data: {
          prescreening: { id: prescreeningId, name: `CASO ${CASE_A4}-base` },
          profile: { id: `p067-prof-${RUN}`, firstName: 'Ficticia', lastName: 'Teste', email: p.email, phoneNumber: phone, registerQuestions: [] },
          response: { id: `resp-${prescreeningId}-${subtype}`, state: [], ...extra },
        },
      });
      return { status: res.status, body: res.data };
    };

    const iniciado = await envio('INITIATED');
    const qualificado = await envio('ANALYZED', { statusLabel: 'QUALIFIED', score: 85 });
    // ids gerados por execução viram marcadores (depois de provar que são os da execução); a FORMA, as chaves, a ordem e o status ficam
    const prescreening = (await pool.query<{ id: string }>(`SELECT id FROM talentum_prescreenings WHERE job_posting_id = $1 AND worker_id = $2`, [ID.vagaA4, p.id])).rows[0].id;
    const normalizar = (r: { status: number; body: Record<string, unknown> }) => {
      expect(r.body.prescreeningId).toBe(prescreening);
      expect(r.body.talentumPrescreeningId).toBe(prescreeningId);
      expect(r.body.workerId).toBe(p.id);
      expect(r.body.jobPostingId).toBe(ID.vagaA4);
      return { status: r.status, body: { ...r.body, prescreeningId: '<id da linha em talentum_prescreenings>', talentumPrescreeningId: '<id do prescreening na Talentum>', workerId: '<id do prestador>', jobPostingId: '<id da vaga>' } };
    };
    const gravado = { INITIATED: normalizar(iniciado), ANALYZED_QUALIFIED: normalizar(qualificado) };

    if (GRAVAR) {
      fs.mkdirSync(path.dirname(REFERENCIA), { recursive: true });
      fs.writeFileSync(REFERENCIA, JSON.stringify(gravado, null, 2) + '\n');
    }
    // o mesmo cenário, o mesmo corpo e o mesmo status que a API de origin/main devolveu (A4: "exatamente como antes")
    const referencia = JSON.parse(fs.readFileSync(REFERENCIA, 'utf8'));
    expect(JSON.stringify(gravado)).toBe(JSON.stringify(referencia)); // byte a byte: chaves, ordem, tipos, status
    expect(iniciado.status).toBe(200);
    expect(qualificado.status).toBe(200);

    // FR-13: prescreening, encuadre e candidatura gravados mesmo com o prestador incompleto
    const wja = (await pool.query(`SELECT application_funnel_stage AS s, match_score FROM worker_job_applications WHERE worker_id = $1 AND job_posting_id = $2`, [p.id, ID.vagaA4])).rows;
    expect(wja).toHaveLength(1);
    expect(wja[0].s).toBe('QUALIFIED');
    expect((await pool.query(`SELECT count(*)::int AS n FROM encuadres WHERE worker_id = $1 AND job_posting_id = $2`, [p.id, ID.vagaA4])).rows[0].n).toBe(1);
    expect((await pool.query(`SELECT count(*)::int AS n FROM talentum_prescreenings WHERE job_posting_id = $1 AND worker_id = $2`, [ID.vagaA4, p.id])).rows[0].n).toBe(1);

    // A4: e a candidatura aparece em Bloqueados; ao validar, volta (o resultado da Talentum foi preservado)
    expect(await colunaDe(ID.vagaA4, p.id)).toEqual(['BLOQUEADO']);
    for (const doc of ['identity_document', 'criminal_record']) {
      expect((await api.post(`/api/admin/workers/${p.id}/documents/${doc}/validate`, {}, adminAuth)).status).toBe(200);
    }
    expect(await colunaDe(ID.vagaA4, p.id)).toEqual(['COMPLETED']);
  });
});
