/**
 * E2E: Profile Tabs — novos endpoints por aba
 *
 * Testa os endpoints:
 *   PUT /api/workers/me/general-info
 *   PUT /api/workers/me/service-area
 *   PUT /api/workers/me/availability
 *
 * Esses endpoints usam o authUid do token (header x-auth-uid) para resolver
 * o workerId, sem exigir que o cliente envie workerId no body.
 */

import axios, { AxiosInstance } from 'axios';
import { Pool } from 'pg';

const API_URL = process.env.API_URL || 'http://localhost:8080';
const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('Profile Tabs — Endpoints por aba', () => {
  let api: AxiosInstance;
  let db: Pool;
  let workerId: string;
  let mockToken: string;
  const testAuthUid = `profile-tabs-test-${Date.now()}`;
  const testEmail = `profile-tabs-${Date.now()}@example.com`;

  beforeAll(async () => {
    api = axios.create({
      baseURL: API_URL,
      headers: { 'Content-Type': 'application/json' },
    });

    db = new Pool({ connectionString: DATABASE_URL });

    await waitForBackend();

    // Criar worker para os testes (rota pública, não precisa de token)
    const res = await api.post('/api/workers/init', {
      authUid: testAuthUid,
      email: testEmail,
      country: 'AR',
    });
    workerId = res.data.data.worker.id;

    // Gerar token mock para requests autenticados
    const tokenRes = await api.post('/api/test/auth/token', {
      uid: testAuthUid,
      email: testEmail,
      role: 'worker',
    });
    mockToken = tokenRes.data.data.token;
  });

  afterAll(async () => {
    if (workerId) {
      await db.query('DELETE FROM workers WHERE id = $1', [workerId]);
    }
    await db.end();
  });

  async function waitForBackend(maxRetries = 30) {
    for (let i = 0; i < maxRetries; i++) {
      try {
        await api.get('/health');
        return;
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }
    throw new Error('Backend not ready after 30 seconds');
  }

  function authHeaders() {
    return { headers: { Authorization: `Bearer ${mockToken}` } };
  }

  // ──────────────────────────────────────────────
  // PUT /api/workers/me/general-info
  // ──────────────────────────────────────────────
  describe('PUT /api/workers/me/general-info', () => {
    const payload = {
      firstName: 'Gabriel',
      lastName: 'Stein',
      sex: 'male',
      gender: 'male',
      birthDate: '1990-04-18',
      documentType: 'DNI',
      documentNumber: '12345678',
      phone: '+5491199999999',
      languages: ['pt', 'es'],
      profession: 'CAREGIVER',
      knowledgeLevel: 'SECONDARY',
      titleCertificate: 'Cert XYZ',
      experienceTypes: ['adicciones'],
      yearsExperience: '3_5',
      preferredTypes: ['adicciones'],
      preferredAgeRange: ['adolescents'],
      termsAccepted: true,
      privacyAccepted: true,
    };

    it('deve retornar 200 e o cadastro RELIDO do banco (escrita confirmada)', async () => {
      // Contrato mudou em 08/09/2026 (D302). Antes: `{ message: 'General info
      // saved' }` — o cliente tinha de ACREDITAR. Agora a rota devolve o estado
      // como o banco ficou, porque foi o eco do próprio envio que manteve na
      // tela um telefone que o banco nunca gravou (129 cadastros travados).
      const res = await api.put('/api/workers/me/general-info', payload, authHeaders());

      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.data.id).toBe(workerId);
      expect(res.data.data).not.toHaveProperty('message');
    });

    it('devolve missingFields do BANCO, e o tipo chega como array de string', async () => {
      // Este é o ponto que unit nenhum prova: `fn_worker_missing_fields` devolve
      // JSONB, e o outro leitor do repo (BlockedApplicationRepository) faz
      // `::text` + JSON.parse justamente por isso. Aqui o driver `pg` real
      // responde — se ele entregasse string, o frontend receberia lixo.
      const res = await api.put('/api/workers/me/general-info', payload, authHeaders());

      const missing = res.data.data.missingFields;
      expect(Array.isArray(missing)).toBe(true);
      missing.forEach((t: unknown) => expect(typeof t).toBe('string'));
    });

    it('a vitrine bate com o portão — a lista da rota é a MESMA função do banco', async () => {
      // O defeito da D302 era exatamente os dois discordarem: a tela dizia
      // "cadastro completo" e o portão recusava a postulação. Aqui a rota e a
      // função do banco têm de devolver o MESMO conjunto, sem segunda definição.
      const res = await api.put('/api/workers/me/general-info', payload, authHeaders());
      const gate = await db.query('SELECT fn_worker_missing_fields($1) AS missing', [workerId]);

      expect(new Set(res.data.data.missingFields)).toEqual(new Set(gate.rows[0].missing));
    });

    it('campo do portão que falta aparece, e some quando a prestadora preenche', async () => {
      // Worker PRÓPRIO, criado limpo: os testes acima já gravaram
      // `titleCertificate` no worker do describe, e `title_certificate` é
      // COALESCE no banco — uma vez gravado não dá para "desgravar". Depender
      // da ordem dos testes vizinhos seria fixture frágil.
      const uid = `profile-tabs-missing-${Date.now()}`;
      const init = await api.post('/api/workers/init', {
        authUid: uid, email: `${uid}@example.com`, country: 'AR',
      });
      const novoId = init.data.data.worker.id;
      const tk = await api.post('/api/test/auth/token', { uid, email: `${uid}@example.com`, role: 'worker' });
      const headers = { headers: { Authorization: `Bearer ${tk.data.data.token}`, 'x-auth-uid': uid } };

      try {
        // Telefone PRÓPRIO: o `payload` do describe carrega o número do worker
        // dele, e `resolvePhoneToPersist` recusa número que já pertence a outro
        // (409 PHONE_NOT_AVAILABLE) — o axios estouraria antes da 1ª asserção.
        const semTitulo = { ...payload, phone: `+54911${String(Date.now()).slice(-8)}` };
        delete (semTitulo as Record<string, unknown>).titleCertificate;

        const antes = await api.put('/api/workers/me/general-info', semTitulo, headers);
        expect(antes.data.data.missingFields).toContain('title_certificate');

        await api.put('/api/workers/me/general-info', { ...semTitulo, titleCertificate: 'MP-4321' }, headers);

        const depois = await api.get('/api/workers/me', headers);
        expect(depois.data.data.missingFields).not.toContain('title_certificate');
      } finally {
        await db.query('DELETE FROM workers WHERE id = $1', [novoId]);
      }
    });

    it('deve ter salvo profissão e anos de experiência', async () => {
      const res = await db.query(
        'SELECT profession, years_experience FROM workers WHERE id = $1',
        [workerId],
      );
      expect(res.rows[0].profession).toBe('CAREGIVER');
      expect(res.rows[0].years_experience).toBe('3_5');
    });

    it('deve ter salvo phone normalizado (canônico 549...) na coluna plaintext', async () => {
      // O phone é normalizado na escrita (normalizePhoneAR) para evitar colisões
      // com a constraint idx_workers_phone_unique. '+5491199999999' → '5491199999999'.
      const res = await db.query('SELECT phone FROM workers WHERE id = $1', [workerId]);
      expect(res.rows[0].phone).toBe('5491199999999');
    });

    it('deve ter salvo dados criptografados (first_name_encrypted não nulo)', async () => {
      const res = await db.query(
        'SELECT first_name_encrypted, last_name_encrypted FROM workers WHERE id = $1',
        [workerId],
      );
      expect(res.rows[0].first_name_encrypted).not.toBeNull();
      expect(res.rows[0].last_name_encrypted).not.toBeNull();
    });

    it('deve retornar 401 sem authUid', async () => {
      await expect(
        api.put('/api/workers/me/general-info', payload),
      ).rejects.toMatchObject({ response: { status: 401 } });
    });

    it('deve retornar 404 se authUid não corresponde a nenhum worker', async () => {
      const ghostTokenRes = await api.post('/api/test/auth/token', {
        uid: 'nonexistent-auth-uid',
        email: 'ghost@e2e.local',
        role: 'worker',
      });
      const ghostToken = ghostTokenRes.data.data.token;

      await expect(
        api.put(
          '/api/workers/me/general-info',
          payload,
          { headers: { Authorization: `Bearer ${ghostToken}` } },
        ),
      ).rejects.toMatchObject({ response: { status: 404 } });
    });

    it('deve permitir salvar múltiplas vezes (idempotente)', async () => {
      const res = await api.put(
        '/api/workers/me/general-info',
        { ...payload, titleCertificate: 'Updated Cert' },
        authHeaders(),
      );
      expect(res.status).toBe(200);
    });

    it('deve retornar os dados atualizados via GET /api/workers/me', async () => {
      const res = await api.get('/api/workers/me', authHeaders());
      expect(res.data.data.phone).toBe('5491199999999');
      expect(res.data.data.profession).toBe('CAREGIVER');
    });
  });

  // ──────────────────────────────────────────────
  // PUT /api/workers/me/service-area
  // ──────────────────────────────────────────────
  // ──────────────────────────────────────────────
  // Regressão 31/08: save VAZIO não pode apagar dado bom
  // ──────────────────────────────────────────────
  describe('PUT /api/workers/me/general-info — vazio NÃO sobrescreve', () => {
    it('mantém os campos do gate quando o payload chega com "" e []', async () => {
      // 1) Estado bom, gravado normalmente.
      const cheio = {
        firstName: 'Gabriel', lastName: 'Stein', sex: 'male', gender: 'male',
        birthDate: '1990-04-18', documentType: 'DNI', documentNumber: '12345678',
        phone: '+5491199999999', languages: ['pt', 'es'],
        profession: 'CAREGIVER', knowledgeLevel: 'SECONDARY', titleCertificate: 'Cert XYZ',
        experienceTypes: ['adicciones'], yearsExperience: '3_5',
        preferredTypes: ['adicciones'], preferredAgeRange: ['adolescents'],
        termsAccepted: true, privacyAccepted: true,
      };
      await api.put('/api/workers/me/general-info', cheio, authHeaders());

      // 2) O save que a tela dispara ANTES de hidratar: `campo || ''` e `campo || []`.
      //    Antes deste fix o COALESCE do UPDATE não protegia — '' e [] não são NULL,
      //    então entravam por cima e a pessoa perdia o cadastro em silêncio.
      const vazio = {
        ...cheio,
        profession: '', knowledgeLevel: '', titleCertificate: '', yearsExperience: '',
        experienceTypes: [], preferredTypes: [], preferredAgeRange: [],
      };
      const res = await api.put('/api/workers/me/general-info', vazio, authHeaders());
      expect(res.status).toBe(200);

      // 3) O banco tem de estar intacto.
      const { rows } = await db.query(
        `SELECT profession, knowledge_level, title_certificate, years_experience,
                experience_types, preferred_types, preferred_age_range
           FROM workers WHERE id = $1`,
        [workerId],
      );
      expect(rows[0].profession).toBe('CAREGIVER');
      expect(rows[0].knowledge_level).toBe('SECONDARY');
      expect(rows[0].title_certificate).toBe('Cert XYZ');
      expect(rows[0].years_experience).toBe('3_5');
      expect(rows[0].experience_types).toEqual(['adicciones']);
      expect(rows[0].preferred_types).toEqual(['adicciones']);
      expect(rows[0].preferred_age_range).toEqual(['adolescents']);
    });
  });

  describe('PUT /api/workers/me/service-area', () => {
    const payload = {
      address: 'Av. Corrientes 1234, Buenos Aires',
      addressComplement: 'Piso 3',
      serviceRadiusKm: 10,
      lat: -34.603722,
      lng: -58.381592,
    };

    it('deve retornar 200 e success: true', async () => {
      const res = await api.put('/api/workers/me/service-area', payload, authHeaders());

      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.data.message).toBe('Service area saved');
    });

    it('deve ter criado exatamente 1 registro em worker_service_areas', async () => {
      const res = await db.query(
        'SELECT * FROM worker_service_areas WHERE worker_id = $1',
        [workerId],
      );
      expect(res.rows.length).toBe(1);
      expect(res.rows[0].address_line).toContain('Corrientes');
      expect(res.rows[0].radius_km).toBe(10);
    });

    it('deve fazer upsert: salvar 2x mantém apenas 1 registro', async () => {
      await api.put(
        '/api/workers/me/service-area',
        { ...payload, serviceRadiusKm: 20 },
        authHeaders(),
      );

      const res = await db.query(
        'SELECT * FROM worker_service_areas WHERE worker_id = $1',
        [workerId],
      );
      expect(res.rows.length).toBe(1);
      expect(res.rows[0].radius_km).toBe(20);
    });

    it('deve retornar 401 sem authUid', async () => {
      await expect(
        api.put('/api/workers/me/service-area', payload),
      ).rejects.toMatchObject({ response: { status: 401 } });
    });
  });

  // ──────────────────────────────────────────────
  // PUT /api/workers/me/availability
  // GET /api/workers/me/availability
  // ──────────────────────────────────────────────
  describe('PUT /api/workers/me/availability', () => {
    const payload = {
      availability: [
        { dayOfWeek: 1, startTime: '09:00', endTime: '17:00' },
        { dayOfWeek: 3, startTime: '08:00', endTime: '12:00' },
      ],
    };

    it('deve retornar 200 e success: true', async () => {
      const res = await api.put('/api/workers/me/availability', payload, authHeaders());

      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.data.message).toBe('Availability saved');
    });

    it('deve ter salvo exatamente 2 registros em worker_availability', async () => {
      const res = await db.query(
        'SELECT * FROM worker_availability WHERE worker_id = $1 ORDER BY day_of_week ASC',
        [workerId],
      );
      expect(res.rows.length).toBe(2);
      expect(res.rows[0].day_of_week).toBe(1);
      expect(res.rows[0].start_time).toContain('09:00');
      expect(res.rows[0].end_time).toContain('17:00');
      expect(res.rows[1].day_of_week).toBe(3);
    });

    it('deve ter preenchido timezone não nulo em todos os slots', async () => {
      const res = await db.query(
        'SELECT timezone FROM worker_availability WHERE worker_id = $1',
        [workerId],
      );
      res.rows.forEach((row: any) => {
        expect(row.timezone).toBeTruthy();
      });
    });

    it('deve fazer replace: salvar 2x substitui os registros anteriores', async () => {
      const newPayload = {
        availability: [
          { dayOfWeek: 2, startTime: '10:00', endTime: '18:00' },
        ],
      };

      await api.put('/api/workers/me/availability', newPayload, authHeaders());

      const res = await db.query(
        'SELECT * FROM worker_availability WHERE worker_id = $1',
        [workerId],
      );
      expect(res.rows.length).toBe(1);
      expect(res.rows[0].day_of_week).toBe(2);
    });

    it('deve retornar 401 sem authUid', async () => {
      await expect(
        api.put('/api/workers/me/availability', payload),
      ).rejects.toMatchObject({ response: { status: 401 } });
    });

    it('deve retornar erro ao enviar lista vazia', async () => {
      await expect(
        api.put('/api/workers/me/availability', { availability: [] }, authHeaders()),
      ).rejects.toMatchObject({ response: { status: 400 } });
    });
  });

  describe('GET /api/workers/me/availability', () => {
    beforeAll(async () => {
      // Garante que há dados salvos para o GET
      await api.put('/api/workers/me/availability', {
        availability: [
          { dayOfWeek: 1, startTime: '09:00', endTime: '17:00' },
          { dayOfWeek: 4, startTime: '14:00', endTime: '20:00' },
        ],
      }, authHeaders());
    });

    it('deve retornar 200 com os slots salvos', async () => {
      const res = await api.get('/api/workers/me/availability', authHeaders());

      expect(res.status).toBe(200);
      expect(res.data.success).toBe(true);
      expect(res.data.data).toHaveLength(2);
    });

    it('deve retornar slots ordenados por day_of_week', async () => {
      const res = await api.get('/api/workers/me/availability', authHeaders());

      const slots = res.data.data;
      expect(slots[0].dayOfWeek).toBe(1);
      expect(slots[1].dayOfWeek).toBe(4);
    });

    it('deve retornar campos completos em cada slot', async () => {
      const res = await api.get('/api/workers/me/availability', authHeaders());

      const slot = res.data.data[0];
      expect(slot).toHaveProperty('id');
      expect(slot).toHaveProperty('workerId');
      expect(slot).toHaveProperty('dayOfWeek');
      expect(slot).toHaveProperty('startTime');
      expect(slot).toHaveProperty('endTime');
      expect(slot).toHaveProperty('timezone');
      expect(slot).toHaveProperty('crossesMidnight');
    });

    it('deve retornar 401 sem authUid', async () => {
      await expect(
        api.get('/api/workers/me/availability'),
      ).rejects.toMatchObject({ response: { status: 401 } });
    });
  });

});
