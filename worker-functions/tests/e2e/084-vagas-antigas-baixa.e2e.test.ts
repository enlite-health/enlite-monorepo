/**
 * 084-vagas-antigas-baixa.e2e.test.ts @integration — spec 084 (vagas antigas: baixa sem apagar, volta só pelo serviço).
 *
 * API real + Postgres real. Nenhum side-effect outbound: o Talentum só é alcançado se a vaga tiver `talentum_project_id`
 * (as vagas deste teste NÃO têm) e o processo é bloqueado de rede (`rede-bloqueada`); nada de Twilio/WhatsApp/Ana Care.
 *
 * Cenários (feliz + alternativos por fase):
 *   F1  baixar uma / em lote → some das listas, nunca apaga, guarda status anterior + motivo + auditoria;
 *       lote com vaga de serviço → recusado inteiro; baixar de novo → recusado.
 *   R17 PUT de status em vaga baixada → 409 e segue baixada; a reativação do serviço devolve SÓ a baixada por ele.
 *   F2  lista esconde as baixadas; include_baja=true e filtro de status as mostram.
 *   F5  "En espera" (ON_HOLD) é aceito e retoma ao status anterior; encerrar vaga de serviço ativo → 409; sem serviço encerra.
 *   F6  o #NN é a ordem do serviço; vaga sem serviço sem número; vaga nova do mesmo serviço repete o número (R12).
 *   leaks  Match recusa em vaga baixada; o Kanban abre em leitura.
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { staffAuth } from './helpers/staffAuth';
import { buildInsertQuery, buildInsertParams } from '../../src/modules/matching/interfaces/controllers/vacancyCrudHelpers';

const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
process.env.DATABASE_URL = process.env.DATABASE_URL ?? DATABASE_URL;
const TAG = '084-vagas-%';
const HORARIO = '[{"dayOfWeek":2,"startTime":"09:00","durationMinutes":240}]';

describe('Spec 084 — baixa de vaga antiga, volta só pelo serviço @integration', () => {
  const api = createApiClient();
  let pool: Pool;
  let asAdmin: { headers: { Authorization: string } };
  let seq = 0;

  const limpar = async (): Promise<void> => {
    await pool.query(`DELETE FROM job_posting_audit_log WHERE job_posting_id IN (SELECT id FROM job_postings WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id LIKE $1))`, [TAG]);
    await pool.query(`DELETE FROM job_postings WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id LIKE $1)`, [TAG]);
    await pool.query(`DELETE FROM patient_contracted_services WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id LIKE $1)`, [TAG]);
    await pool.query(`DELETE FROM patients WHERE clickup_task_id LIKE $1`, [TAG]);
  };

  const criarPaciente = async (tag: string, caseNumber: number): Promise<string> =>
    (await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status, case_number)
       VALUES ($1, 'Baja084', 'E2E', 'AR', 'ACTIVE', $2) RETURNING id`,
      [`084-vagas-${tag}`, caseNumber],
    )).rows[0].id;

  const criarServico = async (patientId: string): Promise<string> => {
    const svc = await api.post(`/api/admin/patients/${patientId}/contracted-services`, { serviceCode: 'AT', schedule: JSON.parse(HORARIO) }, asAdmin);
    expect(svc.status).toBe(201);
    return svc.data.data.id as string;
  };

  /** Vaga viva por SQL (o dono bypassa RLS). `serviceId` null = vaga antiga, sem serviço. */
  const criarVaga = async (o: { patientId: string; caseNumber: number; status?: string; serviceId?: string | null; isDraft?: boolean; title?: string }): Promise<string> => {
    const n = Math.floor(Math.random() * 900000) + 100000 + ++seq;
    return (await pool.query<{ id: string }>(
      `INSERT INTO job_postings (case_number, vacancy_number, title, status, patient_id, contracted_service_id, country, is_draft, is_test, social_short_links)
       VALUES ($1, $2, $3, $4, $5, $6, 'AR', $7, false, '{}'::jsonb) RETURNING id`,
      [o.caseNumber, n, o.title ?? `CASO 084E2E-${n}`, o.status ?? 'SEARCHING', o.patientId, o.serviceId ?? null, o.isDraft ?? false],
    )).rows[0].id;
  };

  const linha = async (id: string) =>
    (await pool.query<Record<string, unknown>>(
      `SELECT status, status_before_baja, baja_reason, status_before_hold, deleted_at, case_ordinal FROM job_postings WHERE id = $1`, [id],
    )).rows[0];

  beforeAll(async () => {
    await waitForBackend(api);
    asAdmin = await staffAuth('084-vagas-admin', 'admin');
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();
  });
  afterAll(async () => {
    await limpar();
    await pool.end();
  });

  describe('F1 + F2 — dar baixa (uma e em lote), listas e auditoria', () => {
    it('FELIZ: baixa individual → DE_BAJA com status anterior e motivo MANUAL, nada apagado, some da lista, aparece com include_baja, audita', async () => {
      const patientId = await criarPaciente('feliz', 884001);
      const vagaId = await criarVaga({ patientId, caseNumber: 884001, status: 'SEARCHING_REPLACEMENT', title: 'CASO 084E2E feliz-f1' });

      const antes = await api.get('/api/admin/vacancies?search=084E2E%20feliz-f1&limit=50', asAdmin);
      expect((antes.data.data as Array<{ id: string }>).map((v) => v.id)).toContain(vagaId);

      const baja = await api.post('/api/admin/vacancies/baja', { vacancyIds: [vagaId] }, asAdmin);
      expect(baja.status).toBe(200);
      expect(baja.data.data.baixadas).toEqual([{ vacancyId: vagaId, statusBefore: 'SEARCHING_REPLACEMENT' }]);

      const row = await linha(vagaId);
      expect(row.status).toBe('DE_BAJA');
      expect(row.status_before_baja).toBe('SEARCHING_REPLACEMENT');
      expect(row.baja_reason).toBe('MANUAL');
      expect(row.deleted_at).toBeNull(); // R2: nunca apaga

      const escondida = await api.get('/api/admin/vacancies?search=084E2E%20feliz-f1&limit=50', asAdmin);
      expect((escondida.data.data as Array<{ id: string }>).map((v) => v.id)).not.toContain(vagaId);

      const mostrada = await api.get('/api/admin/vacancies?search=084E2E%20feliz-f1&include_baja=true&limit=50', asAdmin);
      const item = (mostrada.data.data as Array<{ id: string; statusRaw: string; bajaReason: string; hasService: boolean }>).find((v) => v.id === vagaId);
      expect(item).toMatchObject({ statusRaw: 'DE_BAJA', bajaReason: 'MANUAL', hasService: false });

      const porStatus = await api.get('/api/admin/vacancies?search=084E2E%20feliz-f1&status=DE_BAJA&limit=50', asAdmin);
      expect((porStatus.data.data as Array<{ id: string }>).map((v) => v.id)).toContain(vagaId);

      // o link/página pública segue servindo, mostrando "desativada"
      const publica = await api.get(`/api/vacancies/${vagaId}`);
      expect(publica.status).toBe(200);
      expect(publica.data.data.is_disabled).toBe(true);

      // P6: auditoria com quem, antes, depois e motivo
      const audit = (await pool.query<{ changes: { before: { status: string }; after: { status: string; baja_reason: string } } }>(
        `SELECT changes FROM job_posting_audit_log WHERE job_posting_id = $1 AND event_type = 'STATUS_CHANGED'`, [vagaId],
      )).rows;
      expect(audit).toHaveLength(1);
      expect(audit[0].changes).toMatchObject({ before: { status: 'SEARCHING_REPLACEMENT' }, after: { status: 'DE_BAJA', baja_reason: 'MANUAL' } });
    });

    it('ALTERNATIVO lote: duas vagas sem serviço baixam juntas; uma COM serviço recusa o lote INTEIRO (nada é baixado)', async () => {
      const patientId = await criarPaciente('lote', 884002);
      const serviceId = await criarServico(patientId);
      const v1 = await criarVaga({ patientId, caseNumber: 884002 });
      const v2 = await criarVaga({ patientId, caseNumber: 884002, status: 'CLOSED' });
      const vServico = await criarVaga({ patientId, caseNumber: 884002, serviceId });

      const recusado = await api.post('/api/admin/vacancies/baja', { vacancyIds: [v1, v2, vServico] }, asAdmin);
      expect(recusado.status).toBe(409);
      expect(recusado.data.code).toBe('BAJA_REFUSED');
      expect(recusado.data.refused).toEqual([
        expect.objectContaining({ vacancyId: vServico, code: 'VACANCY_HAS_SERVICE', messages: expect.objectContaining({ es: expect.any(String), 'pt-BR': expect.any(String) }) }),
      ]);
      for (const id of [v1, v2, vServico]) expect((await linha(id)).status).not.toBe('DE_BAJA');

      const ok = await api.post('/api/admin/vacancies/baja', { vacancyIds: [v1, v2] }, asAdmin);
      expect(ok.status).toBe(200);
      expect((await linha(v1)).status).toBe('DE_BAJA');
      expect((await linha(v2)).status_before_baja).toBe('CLOSED');
    });

    it('ALTERNATIVO: baixar de novo uma vaga já baixada → 409 e status_before_baja NÃO é sobrescrito', async () => {
      const patientId = await criarPaciente('duas-vezes', 884003);
      const vagaId = await criarVaga({ patientId, caseNumber: 884003 });
      expect((await api.post('/api/admin/vacancies/baja', { vacancyIds: [vagaId] }, asAdmin)).status).toBe(200);
      const de_novo = await api.post('/api/admin/vacancies/baja', { vacancyIds: [vagaId] }, asAdmin);
      expect(de_novo.status).toBe(409);
      expect(de_novo.data.refused[0].code).toBe('VACANCY_ALREADY_DE_BAJA');
      expect((await linha(vagaId)).status_before_baja).toBe('SEARCHING');
    });

    it('corpo inválido → 400', async () => {
      expect((await api.post('/api/admin/vacancies/baja', { vacancyIds: [] }, asAdmin)).status).toBe(400);
      expect((await api.post('/api/admin/vacancies/baja', { vacancyIds: ['x'] }, asAdmin)).status).toBe(400);
    });
  });

  describe('R17 — a vaga baixada NÃO volta por ação de usuário; só pela reativação do serviço que a baixou', () => {
    it('PUT de status em vaga baixada sem serviço → 409 com es/pt-BR e ela segue DE_BAJA (teste-chave R17)', async () => {
      const patientId = await criarPaciente('r17', 884004);
      const vagaId = await criarVaga({ patientId, caseNumber: 884004 });
      await api.post('/api/admin/vacancies/baja', { vacancyIds: [vagaId] }, asAdmin);

      for (const status of ['SEARCHING', 'ACTIVE', 'ON_HOLD', 'CLOSED']) {
        const put = await api.put(`/api/admin/vacancies/${vagaId}`, { status }, asAdmin);
        expect(put.status).toBe(409);
        expect(put.data.code).toBe('VACANCY_DE_BAJA_NO_REACTIVATION');
        expect(put.data.messages.es).toBeTruthy();
        expect(put.data.messages['pt-BR']).toBeTruthy();
      }
      const row = await linha(vagaId);
      expect(row.status).toBe('DE_BAJA');
      expect(row.baja_reason).toBe('MANUAL');
    });

    it('baixa do serviço marca SERVICE; reativar o serviço devolve SÓ a vaga baixada por ele (a MANUAL fica)', async () => {
      const patientId = await criarPaciente('volta', 884005);
      const serviceId = await criarServico(patientId);
      const porServico = await criarVaga({ patientId, caseNumber: 884005, status: 'SEARCHING', serviceId });
      const porMao = await criarVaga({ patientId, caseNumber: 884005, status: 'SEARCHING_REPLACEMENT', serviceId });
      await pool.query(`UPDATE job_postings SET status_before_baja = 'SEARCHING_REPLACEMENT', status = 'DE_BAJA', baja_reason = 'MANUAL' WHERE id = $1`, [porMao]);

      const patch = await api.patch(`/api/admin/patients/${patientId}/contracted-services/${serviceId}`, { active: false }, asAdmin);
      expect(patch.status).toBe(200);
      const baixada = await linha(porServico);
      expect(baixada.status).toBe('DE_BAJA');
      expect(baixada.baja_reason).toBe('SERVICE');
      expect(baixada.status_before_baja).toBe('SEARCHING');

      // O HTTP só aceita `active:false` (reabrir não existe); a volta é o repositório (mesmo caminho do gatilho).
      const { PatientContractedServiceRepository } = await import('../../src/modules/case/infrastructure/PatientContractedServiceRepository');
      await new PatientContractedServiceRepository().update(serviceId, { active: true, actorUid: '084-vagas-admin' }, new Date());

      const volta = await linha(porServico);
      expect(volta.status).toBe('SEARCHING');
      expect(volta.baja_reason).toBeNull();
      expect(volta.status_before_baja).toBeNull();
      const fica = await linha(porMao);
      expect(fica.status).toBe('DE_BAJA'); // baixada à mão: NUNCA volta
      expect(fica.baja_reason).toBe('MANUAL');
      const audits = (await pool.query(`SELECT 1 FROM job_posting_audit_log WHERE job_posting_id = $1 AND event_type = 'STATUS_CHANGED'`, [porServico])).rows;
      expect(audits).toHaveLength(2); // a baixa e a volta (P6)
    });
  });

  describe('F5 — pausar com "En espera"', () => {
    it('FELIZ: ON_HOLD aceito (guarda o status anterior) e retomar volta a ele', async () => {
      const patientId = await criarPaciente('hold', 884006);
      const serviceId = await criarServico(patientId);
      const vagaId = await criarVaga({ patientId, caseNumber: 884006, status: 'SEARCHING', serviceId });

      const pausa = await api.put(`/api/admin/vacancies/${vagaId}`, { status: 'ON_HOLD' }, asAdmin);
      expect(pausa.status).toBe(200);
      let row = await linha(vagaId);
      expect(row.status).toBe('ON_HOLD');
      expect(row.status_before_hold).toBe('SEARCHING');

      const retoma = await api.put(`/api/admin/vacancies/${vagaId}`, { status: 'SEARCHING' }, asAdmin);
      expect(retoma.status).toBe(200);
      row = await linha(vagaId);
      expect(row.status).toBe('SEARCHING');
      expect(row.status_before_hold).toBeNull();
    });

    it('ALTERNATIVO: encerrar vaga de serviço ATIVO → 409 pelo servidor; vaga SEM serviço ainda encerra', async () => {
      const patientId = await criarPaciente('close', 884007);
      const serviceId = await criarServico(patientId);
      const comServico = await criarVaga({ patientId, caseNumber: 884007, serviceId });
      const semServico = await criarVaga({ patientId, caseNumber: 884007 });

      const recusa = await api.put(`/api/admin/vacancies/${comServico}`, { status: 'CLOSED' }, asAdmin);
      expect(recusa.status).toBe(409);
      expect(recusa.data.code).toBe('CLOSE_ACTIVE_SERVICE_VACANCY_REFUSED');
      expect((await linha(comServico)).status).toBe('SEARCHING');

      expect((await api.put(`/api/admin/vacancies/${semServico}`, { status: 'CLOSED' }, asAdmin)).status).toBe(200);
      expect((await linha(semServico)).status).toBe('CLOSED');
    });
  });

  describe('F6 — o #NN é a ordem do serviço', () => {
    it('3 serviços → vagas #1, #2, #3; vaga sem serviço sem número; vaga nova do serviço #2 repete o 2 (R12), sem violar índice', async () => {
      const patientId = await criarPaciente('ordinal', 884008);
      const s1 = await criarServico(patientId);
      const s2 = await criarServico(patientId);
      const s3 = await criarServico(patientId);

      const inserir = async (contractedServiceId: string | null): Promise<string> => {
        const n = Math.floor(Math.random() * 900000) + 100000 + ++seq;
        const res = await pool.query<{ id: string }>(
          buildInsertQuery(),
          buildInsertParams({
            vacancyNumber: n, case_number: 884008, computedTitle: `CASO 084E2E-${n}`, patient_id: patientId,
            required_professions: [], required_sex: null, age_range_min: null, age_range_max: null, worker_profile_sought: null,
            required_experience: null, worker_attributes: null, schedule: null, work_schedule: null, providers_needed: null,
            salary_text: null, payment_day: null, daily_obs: null, patient_address_id: null, contracted_service_id: contractedServiceId,
          }),
        );
        return res.rows[0].id;
      };

      const antiga = await inserir(null);
      const v1 = await inserir(s1);
      const v2 = await inserir(s2);
      const v3 = await inserir(s3);
      expect((await linha(antiga)).case_ordinal).toBeNull(); // sem serviço, sem número (R16)
      expect([(await linha(v1)).case_ordinal, (await linha(v2)).case_ordinal, (await linha(v3)).case_ordinal]).toEqual([1, 2, 3]);

      // a vaga #2 é encerrada/baixada e o serviço ganha uma NOVA: repete o número do serviço (R12)
      await pool.query(`UPDATE job_postings SET status = 'CLOSED' WHERE id = $1`, [v2]);
      const v2b = await inserir(s2);
      expect((await linha(v2b)).case_ordinal).toBe(2);
    });
  });

  describe('vazamento — vaga baixada é só consulta', () => {
    it('Match recusa (409) e o Kanban abre em leitura (readOnly)', async () => {
      const patientId = await criarPaciente('leitura', 884009);
      const vagaId = await criarVaga({ patientId, caseNumber: 884009 });
      await api.post('/api/admin/vacancies/baja', { vacancyIds: [vagaId] }, asAdmin);

      const match = await api.post(`/api/admin/vacancies/${vagaId}/match`, {}, asAdmin);
      expect(match.status).toBe(409);
      expect(match.data.code).toBe('VACANCY_DE_BAJA_READ_ONLY');

      const funil = await api.get(`/api/admin/vacancies/${vagaId}/funnel`, asAdmin);
      expect(funil.status).toBe(200);
      expect(funil.data.data.readOnly).toBe(true);
      expect(funil.data.data.vacancyStatus).toBe('DE_BAJA');
    });
  });
});
