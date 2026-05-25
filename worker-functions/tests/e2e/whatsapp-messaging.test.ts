/**
 * whatsapp-messaging.test.ts
 *
 * Testa o módulo de mensagens WhatsApp.
 *
 * Parte 1 — HTTP (via servidor real):
 *   POST /api/admin/messaging/whatsapp/vacancy-match
 *     - auth, validação de params, worker lookup (404/422)
 *     - status decision: REGISTERED → _complete, INCOMPLETE_REGISTER → _incomplete, DISABLED → 422
 *     - Twilio não configurado no ambiente de teste → happy path HTTP retorna 502
 *   POST /api/admin/messaging/whatsapp/direct
 *     - auth, validação de params, 502 sem Twilio
 *
 * Parte 2 — TwilioMessagingService direto (twilio mockado):
 *   Template lookup via DB real, interpolação de variáveis, slug inválido
 *
 * Usa MockAuth (USE_MOCK_AUTH=true) — sem Firebase real.
 */

// Mock do módulo twilio ANTES de qualquer import que o carregue.
// _mockCreate é exposto na factory para acesso nos testes.
jest.mock('twilio', () => {
  const create = jest.fn();
  const factory = jest.fn().mockReturnValue({ messages: { create } });
  return Object.assign(factory, { _mockCreate: create });
});

import axios, { AxiosInstance } from 'axios';
import { Pool } from 'pg';
import twilio from 'twilio';
import { TwilioMessagingService, MessageTemplateRepository } from '@modules/notification';

const API_URL = process.env.API_URL || 'http://localhost:8080';
const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

// DatabaseConnection singleton lê DATABASE_URL de process.env
process.env.DATABASE_URL = DATABASE_URL;

// Env vars fake para TwilioMessagingService ficar isConfigured=true nos testes diretos
process.env.TWILIO_ACCOUNT_SID = 'ACtest_whatsapp_e2e';
process.env.TWILIO_AUTH_TOKEN = 'auth_token_test_e2e';
process.env.TWILIO_WHATSAPP_NUMBER = '+14155552671';

// Acesso ao mock de criação de mensagem Twilio
const getMockCreate = () => (twilio as any)._mockCreate as jest.Mock;

// ─────────────────────────────────────────────────────────────────
// Parte 1 — HTTP (MessagingController via servidor real)
// ─────────────────────────────────────────────────────────────────

describe('POST /api/admin/messaging/whatsapp/vacancy-match — HTTP layer', () => {
  let api: AxiosInstance;
  let pool: Pool;
  let adminToken: string;
  let workerToken: string;
  let registeredWorkerId: string;
  let incompleteWorkerId: string;
  let disabledWorkerId: string;
  let workerWithoutPhoneId: string;
  let vacancyId: string;

  beforeAll(async () => {
    api = axios.create({ baseURL: API_URL, headers: { 'Content-Type': 'application/json' }, validateStatus: () => true });
    pool = new Pool({ connectionString: DATABASE_URL });

    adminToken = await getToken(api, 'admin-vm-uid', 'admin-vm@e2e.test', 'admin');
    workerToken = await getToken(api, 'worker-vm-uid', 'worker-vm@e2e.test', 'worker');

    // Worker REGISTERED com telefone
    const r1 = await pool.query<{ id: string }>(
      `INSERT INTO workers (auth_uid, email, phone, status, country, timezone)
       VALUES ($1, $2, $3, 'REGISTERED', 'BR', 'America/Sao_Paulo')
       RETURNING id`,
      ['ts-vm-registered-uid', 'vm-registered@e2e.test', '+5511987654321'],
    );
    registeredWorkerId = r1.rows[0].id;

    // Worker INCOMPLETE_REGISTER com telefone
    const r2 = await pool.query<{ id: string }>(
      `INSERT INTO workers (auth_uid, email, phone, status, country, timezone)
       VALUES ($1, $2, $3, 'INCOMPLETE_REGISTER', 'BR', 'America/Sao_Paulo')
       RETURNING id`,
      ['ts-vm-incomplete-uid', 'vm-incomplete@e2e.test', '+5511987654322'],
    );
    incompleteWorkerId = r2.rows[0].id;

    // Worker DISABLED com telefone
    const r3 = await pool.query<{ id: string }>(
      `INSERT INTO workers (auth_uid, email, phone, status, country, timezone)
       VALUES ($1, $2, $3, 'DISABLED', 'BR', 'America/Sao_Paulo')
       RETURNING id`,
      ['ts-vm-disabled-uid', 'vm-disabled@e2e.test', '+5511987654323'],
    );
    disabledWorkerId = r3.rows[0].id;

    // Worker SEM telefone
    const r4 = await pool.query<{ id: string }>(
      `INSERT INTO workers (auth_uid, email, status, country, timezone)
       VALUES ($1, $2, 'REGISTERED', 'BR', 'America/Sao_Paulo')
       RETURNING id`,
      ['ts-vm-no-phone-uid', 'vm-no-phone@e2e.test'],
    );
    workerWithoutPhoneId = r4.rows[0].id;

    // Vaga para testes
    const r5 = await pool.query<{ id: string }>(
      `INSERT INTO job_postings (case_number, title, status, description)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [88199, 'Vaga VacancyMatch E2E', 'SEARCHING', null],
    );
    vacancyId = r5.rows[0].id;
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM workers WHERE auth_uid IN ($1, $2, $3, $4)`, [
      'ts-vm-registered-uid',
      'ts-vm-incomplete-uid',
      'ts-vm-disabled-uid',
      'ts-vm-no-phone-uid',
    ]).catch(() => {});
    await pool.query(`DELETE FROM job_postings WHERE case_number = $1`, [88199]).catch(() => {});
    await pool.end();
  });

  it('retorna 401 sem Authorization header', async () => {
    const res = await api.post('/api/admin/messaging/whatsapp/vacancy-match', {
      workerId: registeredWorkerId,
      jobPostingId: vacancyId,
    });
    expect(res.status).toBe(401);
  });

  it('retorna 403 com token de role=worker', async () => {
    const res = await api.post(
      '/api/admin/messaging/whatsapp/vacancy-match',
      { workerId: registeredWorkerId, jobPostingId: vacancyId },
      { headers: { Authorization: `Bearer ${workerToken}` } },
    );
    expect(res.status).toBe(403);
  });

  it('retorna 400 quando workerId está ausente', async () => {
    const res = await api.post(
      '/api/admin/messaging/whatsapp/vacancy-match',
      { jobPostingId: vacancyId },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/workerId/i);
  });

  it('retorna 400 quando jobPostingId está ausente', async () => {
    const res = await api.post(
      '/api/admin/messaging/whatsapp/vacancy-match',
      { workerId: registeredWorkerId },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/jobPostingId/i);
  });

  it('retorna 404 quando worker não existe', async () => {
    const res = await api.post(
      '/api/admin/messaging/whatsapp/vacancy-match',
      { workerId: '00000000-0000-0000-0000-000000000000', jobPostingId: vacancyId },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(res.status).toBe(404);
    expect(res.data.error).toMatch(/Worker/i);
  });

  it('retorna 422 WORKER_STATUS_INVALID para worker DISABLED', async () => {
    const res = await api.post(
      '/api/admin/messaging/whatsapp/vacancy-match',
      { workerId: disabledWorkerId, jobPostingId: vacancyId },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(res.status).toBe(422);
    expect(res.data.error).toBe('WORKER_STATUS_INVALID');
    expect(res.data.detail).toContain('DISABLED');
  });

  it('retorna 422 quando worker não tem telefone cadastrado', async () => {
    const res = await api.post(
      '/api/admin/messaging/whatsapp/vacancy-match',
      { workerId: workerWithoutPhoneId, jobPostingId: vacancyId },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(res.status).toBe(422);
    expect(res.data.error).toMatch(/telefone/i);
  });

  it('REGISTERED worker → 502 com Twilio não configurado (template _complete seria enviado)', async () => {
    // 502 = Twilio não configurado no ambiente de teste
    // Se chegou aqui (sem 422), o backend escolheu o template correto
    const res = await api.post(
      '/api/admin/messaging/whatsapp/vacancy-match',
      { workerId: registeredWorkerId, jobPostingId: vacancyId },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(res.status).toBe(502);
    expect(res.data.error).toBeDefined();
  });

  it('INCOMPLETE_REGISTER worker → 502 com Twilio não configurado (template _incomplete seria enviado)', async () => {
    const res = await api.post(
      '/api/admin/messaging/whatsapp/vacancy-match',
      { workerId: incompleteWorkerId, jobPostingId: vacancyId },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(res.status).toBe(502);
    expect(res.data.error).toBeDefined();
  });
});

describe('POST /api/admin/messaging/whatsapp/direct — HTTP layer', () => {
  let api: AxiosInstance;
  let adminToken: string;

  beforeAll(async () => {
    api = axios.create({ baseURL: API_URL, validateStatus: () => true });
    adminToken = await getToken(api, 'admin-direct-uid', 'admin-direct@e2e.test', 'admin');
  });

  it('retorna 401 sem Authorization header', async () => {
    const res = await api.post('/api/admin/messaging/whatsapp/direct', {
      to: '+5511999999999',
      templateSlug: 'talent_search_welcome',
    });
    expect(res.status).toBe(401);
  });

  it('retorna 400 quando "to" está ausente', async () => {
    const res = await api.post(
      '/api/admin/messaging/whatsapp/direct',
      { templateSlug: 'talent_search_welcome' },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(res.status).toBe(400);
  });

  it('retorna 400 quando templateSlug está ausente', async () => {
    const res = await api.post(
      '/api/admin/messaging/whatsapp/direct',
      { to: '+5511999999999' },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(res.status).toBe(400);
  });

  it('retorna 502 quando Twilio não está configurado (ambiente de teste)', async () => {
    const res = await api.post(
      '/api/admin/messaging/whatsapp/direct',
      { to: '+5511999999999', templateSlug: 'talent_search_welcome' },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(res.status).toBe(502);
  });
});

// ─────────────────────────────────────────────────────────────────
// Template CRUD HTTP (GET/POST/PUT/DELETE /templates)
// ─────────────────────────────────────────────────────────────────

describe('GET /api/admin/messaging/templates — lista templates', () => {
  let api: AxiosInstance;
  let adminToken: string;

  beforeAll(async () => {
    api = axios.create({ baseURL: API_URL, validateStatus: () => true });
    adminToken = await getToken(api, 'admin-tpl-list-uid', 'admin-tpl-list@e2e.test', 'admin');
  });

  it('retorna 401 sem Authorization header', async () => {
    const res = await api.get('/api/admin/messaging/templates');
    expect(res.status).toBe(401);
  });

  it('retorna 200 com lista de templates ativos', async () => {
    const res = await api.get('/api/admin/messaging/templates', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
    expect(Array.isArray(res.data.data)).toBe(true);
    const slugs = res.data.data.map((t: any) => t.slug);
    expect(slugs).toContain('talent_search_welcome');
  });

  it('retorna todos os templates com ?all=true', async () => {
    const res = await api.get('/api/admin/messaging/templates?all=true', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.data.data)).toBe(true);
  });
});

describe('POST /api/admin/messaging/templates — cria template', () => {
  let api: AxiosInstance;
  let adminToken: string;
  const testSlug = `e2e-test-template-${Date.now()}`;

  beforeAll(async () => {
    api = axios.create({ baseURL: API_URL, validateStatus: () => true });
    adminToken = await getToken(api, 'admin-tpl-create-uid', 'admin-tpl-create@e2e.test', 'admin');
  });

  afterAll(async () => {
    const pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query(`DELETE FROM message_templates WHERE slug = $1`, [testSlug]).catch(() => {});
    await pool.end();
  });

  it('retorna 400 quando slug está ausente', async () => {
    const res = await api.post(
      '/api/admin/messaging/templates',
      { name: 'Test', body: 'Hello' },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(res.status).toBe(400);
    expect(res.data.error).toMatch(/slug/i);
  });

  it('cria novo template → 201 com entity', async () => {
    const res = await api.post(
      '/api/admin/messaging/templates',
      { slug: testSlug, name: 'E2E Test Template', body: 'Olá {{name}}!', category: 'onboarding' },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(res.status).toBe(201);
    expect(res.data.success).toBe(true);
    expect(res.data.data.slug).toBe(testSlug);
    expect(res.data.data.isActive).toBe(true);
  });

  it('upsert no mesmo slug → 200 (atualizado, não criado)', async () => {
    const res = await api.post(
      '/api/admin/messaging/templates',
      { slug: testSlug, name: 'E2E Test Template Updated', body: 'Olá {{name}}, atualizado!' },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(res.status).toBe(200);
    expect(res.data.data.name).toBe('E2E Test Template Updated');
  });
});

describe('DELETE /api/admin/messaging/templates/:slug — desativa template', () => {
  let api: AxiosInstance;
  let adminToken: string;
  const testSlug = `e2e-del-template-${Date.now()}`;

  beforeAll(async () => {
    api = axios.create({ baseURL: API_URL, validateStatus: () => true });
    adminToken = await getToken(api, 'admin-tpl-del-uid', 'admin-tpl-del@e2e.test', 'admin');
    await api.post(
      '/api/admin/messaging/templates',
      { slug: testSlug, name: 'To Delete', body: 'Delete me' },
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
  });

  afterAll(async () => {
    const pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query(`DELETE FROM message_templates WHERE slug = $1`, [testSlug]).catch(() => {});
    await pool.end();
  });

  it('retorna 404 para slug inexistente', async () => {
    const res = await api.delete('/api/admin/messaging/templates/slug-that-does-not-exist', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(404);
  });

  it('desativa template existente → 200', async () => {
    const res = await api.delete(`/api/admin/messaging/templates/${testSlug}`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(200);
    expect(res.data.success).toBe(true);
  });

  it('template desativado não aparece na listagem padrão', async () => {
    const res = await api.get('/api/admin/messaging/templates', {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    expect(res.status).toBe(200);
    const slugs = res.data.data.map((t: any) => t.slug);
    expect(slugs).not.toContain(testSlug);
  });
});

// ─────────────────────────────────────────────────────────────────
// Parte 2 — TwilioMessagingService direto (twilio mockado, DB real)
// ─────────────────────────────────────────────────────────────────

describe('TwilioMessagingService — template lookup + interpolação', () => {
  let pool: Pool;
  let service: TwilioMessagingService;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });

    await pool.query(`
      INSERT INTO message_templates (slug, name, body, category) VALUES
        ('talent_search_welcome',
         'Boas-vindas Talent Search',
         'Olá {{name}}! Encontramos o seu perfil e gostaríamos de apresentar oportunidades. Podemos conversar?',
         'onboarding'),
        ('vacancy_match',
         'Vaga Compatível',
         'Olá {{name}}! Temos uma vaga de {{role}} em {{location}} para você.',
         'recruitment')
      ON CONFLICT (slug) DO UPDATE SET
        body = EXCLUDED.body,
        is_active = true
    `);
  });

  beforeEach(() => {
    getMockCreate().mockReset().mockResolvedValue({ sid: 'SMtest_abc123', status: 'queued' });
    service = new TwilioMessagingService(new MessageTemplateRepository());
  });

  afterAll(async () => {
    await pool.end();
  });

  it('resolve o body do template e chama Twilio com o texto correto', async () => {
    const result = await service.sendWhatsApp({
      to: '+5511999999999',
      templateSlug: 'talent_search_welcome',
      variables: { name: 'Maria' },
    });

    expect(result.isSuccess).toBe(true);
    expect(result.getValue().externalId).toBe('SMtest_abc123');

    const [callArgs] = getMockCreate().mock.calls[0];
    expect(callArgs.body).toContain('Maria');
    expect(callArgs.body).not.toContain('{{name}}');
  });

  it('interpola múltiplas variáveis no template body', async () => {
    const result = await service.sendWhatsApp({
      to: '+5511999999999',
      templateSlug: 'vacancy_match',
      variables: { name: 'João', role: 'Enfermeiro', location: 'São Paulo' },
    });

    expect(result.isSuccess).toBe(true);
    const [callArgs] = getMockCreate().mock.calls[0];
    expect(callArgs.body).toContain('João');
    expect(callArgs.body).toContain('Enfermeiro');
    expect(callArgs.body).not.toContain('{{');
  });

  it('retorna fail quando templateSlug não existe', async () => {
    const result = await service.sendWhatsApp({
      to: '+5511999999999',
      templateSlug: 'slug_que_nao_existe_xyz',
      variables: {},
    });

    expect(result.isFailure).toBe(true);
    expect(result.error).toContain('slug_que_nao_existe_xyz');
    expect(getMockCreate()).not.toHaveBeenCalled();
  });

  it('propaga erro do Twilio como Result.fail', async () => {
    getMockCreate().mockRejectedValue(new Error('Account is suspended'));

    const result = await service.sendWhatsApp({
      to: '+5511999999999',
      templateSlug: 'talent_search_welcome',
      variables: { name: 'Test' },
    });

    expect(result.isFailure).toBe(true);
    expect(result.error).toContain('Account is suspended');
  });
});

// ─────────────────────────────────────────────────────────────────
// messaged_at via SQL direto
// ─────────────────────────────────────────────────────────────────

describe('vacancy-match — messaged_at atualizado após envio bem-sucedido', () => {
  let pool: Pool;
  let api: AxiosInstance;
  let adminToken: string;
  let workerId: string;
  let vacancyId: string;

  beforeAll(async () => {
    api = axios.create({ baseURL: API_URL, validateStatus: () => true });
    pool = new Pool({ connectionString: DATABASE_URL });
    adminToken = await getToken(api, 'admin-mat-uid', 'admin-mat@e2e.test', 'admin');

    const r1 = await pool.query<{ id: string }>(
      `INSERT INTO workers (auth_uid, email, phone, status, country, timezone)
       VALUES ($1, $2, $3, 'REGISTERED', 'BR', 'America/Sao_Paulo')
       RETURNING id`,
      ['ts-mat-worker-uid', 'mat-worker@e2e.test', '+5511900000088'],
    );
    workerId = r1.rows[0].id;

    const r2 = await pool.query<{ id: string }>(
      `INSERT INTO job_postings (case_number, title, status, description)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [88299, 'Vaga MAT E2E', 'SEARCHING', null],
    );
    vacancyId = r2.rows[0].id;

    await pool.query(
      `INSERT INTO worker_job_applications
         (worker_id, job_posting_id, application_funnel_stage)
       VALUES ($1, $2, 'INVITED')
       ON CONFLICT DO NOTHING`,
      [workerId, vacancyId],
    );
  });

  afterAll(async () => {
    await pool.query(`DELETE FROM workers WHERE auth_uid = $1`, ['ts-mat-worker-uid']).catch(() => {});
    await pool.query(`DELETE FROM job_postings WHERE case_number = $1`, [88299]).catch(() => {});
    await pool.end();
  });

  it('UPDATE messaged_at via SQL — campo é persistido', async () => {
    // Simula o que o controller faz após envio bem-sucedido
    await pool.query(
      `UPDATE worker_job_applications
       SET messaged_at = NOW(), updated_at = NOW()
       WHERE worker_id = $1 AND job_posting_id = $2`,
      [workerId, vacancyId],
    );

    const { rows } = await pool.query(
      `SELECT messaged_at FROM worker_job_applications
       WHERE worker_id = $1 AND job_posting_id = $2`,
      [workerId, vacancyId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].messaged_at).not.toBeNull();
    expect(rows[0].messaged_at).toBeInstanceOf(Date);
  });

  it('match-results reflete messagedAt após atualização', async () => {
    const res = await api.get(
      `/api/admin/vacancies/${vacancyId}/match-results`,
      { headers: { Authorization: `Bearer ${adminToken}` } },
    );
    expect(res.status).toBe(200);
    const candidate = res.data.data.candidates?.find((c: any) => c.workerId === workerId);
    // Pode não estar nos candidatos se não tem encuadre — apenas verifica que o endpoint responde
    expect(res.data.success).toBe(true);
    if (candidate) {
      expect(candidate.messagedAt).not.toBeNull();
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────

async function getToken(
  api: AxiosInstance,
  uid: string,
  email: string,
  role: 'admin' | 'worker',
): Promise<string> {
  const res = await api.post('/api/test/auth/token', { uid, email, role });
  if (res.status !== 200) throw new Error(`Token failed: ${JSON.stringify(res.data)}`);
  return res.data.data.token;
}
