/**
 * talentum-v2-publish.test.ts — E2E backend SEM mock do cliente, contra um stub da Talentum v2
 * (spec 040 / F2 / T2.6, SC-003).
 *
 * A API (container) usa o `TalentumApiClient` REAL; `TALENTUM_API_BASE_URL` aponta para um servidor HTTP
 * em memória subido AQUI, no processo do jest (porta `TALENTUM_STUB_PORT`, default 9914 — a mesma que o
 * `docker-compose.test.yml` entrega ao container via `host.docker.internal`). O stub tem as regras
 * medidas na v2 real (`name` ≤ 50, PATCH exige `type`, DRAFT → IN_PROGRESS só pelo `init`, 404/403).
 * Nada sai para a Talentum de verdade.
 *
 * Fluxo: publicar → ler o status → editar a descrição (in-place) → despublicar. Provas:
 *  - o link gravado é o WEB do publicId (nunca `wa.me`), o projeto fica IN_PROGRESS;
 *  - a FAQ do banco NÃO vai à Talentum e sobrevive à publicação e à despublicação;
 *  - título > 50 caracteres publica (nome cortado em 50);
 *  - id gravado morto (404 na v2): editar a descrição → 409 claro; despublicar limpa o vínculo (200).
 *
 * Sabotagem (T2.6): trocar o path do stub `/projects` por `/pre-screening/projects` DEVE derrubar este e2e.
 */

import { Pool } from 'pg';
import { createApiClient, createPatientFixture, getMockToken, waitForBackend } from './helpers';
import { TalentumV2Stub } from '../../src/modules/integration/infrastructure/__tests__/talentumV2Stub';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const STUB_PORT = Number(process.env.TALENTUM_STUB_PORT ?? 9914);
const WEB_LINK = /^https:\/\/www\.v2\.talentum\.chat\/public\/pre-screening\/[0-9a-f-]{36}\/chat$/;

describe('Talentum v2 — publicar / editar descrição / despublicar (stub, sem mock do cliente)', () => {
  const api = createApiClient();
  const stub = new TalentumV2Stub();
  let closeStub: () => Promise<void>;
  let adminToken: string;
  let pool: Pool;
  let patientId: string;

  const auth = () => ({ headers: { Authorization: `Bearer ${adminToken}` } });

  async function newVacancy(caseNumber: number, title: string): Promise<string> {
    const res = await api.post(
      '/api/admin/vacancies',
      {
        patient_id: patientId,
        case_number: caseNumber,
        title,
        worker_profile_sought: 'AT con experiencia en TEA',
        schedule_days_hours: 'Lunes a Viernes 09-17hs',
        providers_needed: 1,
      },
      auth(),
    );
    const id = res.data.data?.id as string;
    expect(id).toBeTruthy();
    // pergunta + FAQ + descrição pronta (evita a geração por IA no publish)
    await pool.query(
      `INSERT INTO job_posting_prescreening_questions
         (job_posting_id, question_order, question, desired_response, weight)
       VALUES ($1, 1, '¿Tiene experiencia?', 'Sí', 5)`,
      [id],
    );
    await pool.query(
      `INSERT INTO job_posting_prescreening_faq (job_posting_id, faq_order, question, answer)
       VALUES ($1, 1, '¿Horario?', 'L a V')`,
      [id],
    );
    await pool.query(`UPDATE job_postings SET talentum_description = 'Descripción inicial' WHERE id = $1`, [id]);
    return id;
  }

  async function row(id: string) {
    const r = await pool.query(
      `SELECT talentum_project_id, talentum_public_id, talentum_whatsapp_url, talentum_slug, is_draft
       FROM job_postings WHERE id = $1`,
      [id],
    );
    return r.rows[0] as {
      talentum_project_id: string | null;
      talentum_public_id: string | null;
      talentum_whatsapp_url: string | null;
      talentum_slug: string | null;
      is_draft: boolean;
    };
  }

  async function faqCount(id: string): Promise<number> {
    const r = await pool.query(`SELECT count(*)::int AS n FROM job_posting_prescreening_faq WHERE job_posting_id = $1`, [id]);
    return r.rows[0].n;
  }

  beforeAll(async () => {
    closeStub = (await stub.serve(STUB_PORT)).close;
    await waitForBackend(api);
    adminToken = await getMockToken(api, { uid: 'talentum-v2-admin', email: 'talentum-v2@e2e.local', role: 'admin' });
    pool = new Pool({ connectionString: DATABASE_URL });
    patientId = await createPatientFixture(pool, 'talentum-v2-publish');
  });

  afterAll(async () => {
    if (pool) await pool.end();
    if (closeStub) await closeStub();
  });

  it('publicar → status → editar descrição → despublicar (fluxo completo no stub v2)', async () => {
    const id = await newVacancy(77801, 'EN 77801#1');

    // ── publicar ──
    const pub = await api.post(`/api/admin/vacancies/${id}/publish-talentum`, {}, auth());
    expect(pub.status).toBe(200);
    const saved = await row(id);
    expect(saved.talentum_project_id).toMatch(/^stub-proj-\d+$/);
    expect(saved.talentum_whatsapp_url).toMatch(WEB_LINK); // link web do publicId, nunca wa.me
    expect(saved.talentum_whatsapp_url).not.toContain('wa.me');
    expect(saved.talentum_whatsapp_url).toContain(saved.talentum_public_id!);
    expect(saved.is_draft).toBe(false);
    const proj = stub.projects.get(saved.talentum_project_id!)!;
    expect(proj.status).toBe('IN_PROGRESS'); // o create já ativa (complete-submodule + init)
    expect(proj.description).toBe('Descripción inicial');
    expect(proj.questions).toHaveLength(1);
    expect(JSON.stringify(proj)).not.toContain('¿Horario?'); // a FAQ não vai à Talentum
    expect(await faqCount(id)).toBe(1);

    // ── status ao vivo ──
    const st = await api.get(`/api/admin/vacancies/${id}/talentum-status`, auth());
    expect(st.status).toBe(200);
    expect(st.data.data).toMatchObject({ published: true, exists: true, whatsappUrl: saved.talentum_whatsapp_url });

    // ── editar a descrição (in-place) ──
    const upd = await api.put(`/api/admin/vacancies/${id}/talentum-description`, { description: 'Descripción editada' }, auth());
    expect(upd.status).toBe(200);
    expect(upd.data.data).toMatchObject({ propagated: true });
    expect(stub.projects.get(saved.talentum_project_id!)!.description).toBe('Descripción editada');
    expect(stub.projects.get(saved.talentum_project_id!)!.questions).toHaveLength(1); // perguntas preservadas
    expect((await row(id)).talentum_whatsapp_url).toBe(saved.talentum_whatsapp_url); // link intacto

    // ── despublicar ──
    const del = await api.delete(`/api/admin/vacancies/${id}/publish-talentum`, auth());
    expect(del.status).toBe(200);
    expect(stub.projects.has(saved.talentum_project_id!)).toBe(false);
    const cleared = await row(id);
    expect(cleared).toMatchObject({ talentum_project_id: null, talentum_public_id: null, talentum_whatsapp_url: null, is_draft: true });
    expect(await faqCount(id)).toBe(1); // a FAQ do banco sobrevive

    // depois de apagado o projeto, o status ao vivo da vaga não acusa publicação
    const st2 = await api.get(`/api/admin/vacancies/${id}/talentum-status`, auth());
    expect(st2.data.data).toMatchObject({ published: false, exists: false });
  });

  it('título > 50 caracteres publica (nome cortado em 50; sem isso a v2 devolveria 400 → 502)', async () => {
    const longTitle = 'EN 77802#1 - Acompañante terapéutico para paciente con TEA nivel 2';
    expect(longTitle.length).toBeGreaterThan(50);
    const id = await newVacancy(77802, longTitle);
    // a API gera o título da vaga ("CASO EN<n>-<m>") e ignora o enviado: o título longo entra direto no banco
    await pool.query(`UPDATE job_postings SET title = $1 WHERE id = $2`, [longTitle, id]);

    const pub = await api.post(`/api/admin/vacancies/${id}/publish-talentum`, {}, auth());

    expect(pub.status).toBe(200);
    const proj = stub.projects.get((await row(id)).talentum_project_id!)!;
    expect(proj.name.length).toBeLessThanOrEqual(50);
    expect(proj.name).toBe(longTitle.slice(0, 50).trimEnd());
    await api.delete(`/api/admin/vacancies/${id}/publish-talentum`, auth());
  });

  it('id gravado que não existe na v2 (404): editar a descrição → 409 claro e nada é persistido', async () => {
    const id = await newVacancy(77803, 'EN 77803#1');
    await pool.query(`UPDATE job_postings SET talentum_project_id = 'id-antigo-v1-morto' WHERE id = $1`, [id]);

    const upd = await api.put(`/api/admin/vacancies/${id}/talentum-description`, { description: 'No debería guardarse' }, auth());

    expect(upd.status).toBe(409);
    expect(JSON.stringify(upd.data)).toContain('reconciliação');
    const d = await pool.query(`SELECT talentum_description FROM job_postings WHERE id = $1`, [id]);
    expect(d.rows[0].talentum_description).toBe('Descripción inicial');

    // despublicar o id morto: o projeto já não existe na v2 → 200 e o vínculo é limpo (spec 040)
    const del = await api.delete(`/api/admin/vacancies/${id}/publish-talentum`, auth());
    expect(del.status).toBe(200);
    expect(await row(id)).toMatchObject({ talentum_project_id: null, talentum_public_id: null, is_draft: true });
  });
});
