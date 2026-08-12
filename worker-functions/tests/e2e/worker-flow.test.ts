import axios, { AxiosInstance } from 'axios';
import { Pool } from 'pg';

const API_URL = process.env.API_URL || 'http://localhost:8080';
const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('Worker E2E Flow', () => {
  let api: AxiosInstance;
  let db: Pool;
  let workerId: string;
  let mockToken: string;
  const testAuthUid = `test-${Date.now()}`;
  const testEmail = `test-${Date.now()}@example.com`;

  beforeAll(async () => {
    api = axios.create({
      baseURL: API_URL,
      headers: {
        'Content-Type': 'application/json',
      },
    });

    db = new Pool({
      connectionString: DATABASE_URL,
    });

    // Aguardar backend estar pronto
    await waitForBackend();

    // Gerar token mock para requests autenticados
    const tokenRes = await api.post('/api/test/auth/token', {
      uid: testAuthUid,
      email: testEmail,
      role: 'worker',
    });
    mockToken = tokenRes.data.data.token;
  });

  afterAll(async () => {
    // Limpar dados de teste
    if (workerId) {
      await db.query('DELETE FROM workers WHERE id = $1', [workerId]);
    }
    await db.end();
  });

  async function waitForBackend(maxRetries = 30) {
    for (let i = 0; i < maxRetries; i++) {
      try {
        await api.get('/health');
        console.log('✅ Backend ready');
        return;
      } catch (error) {
        console.log(`⏳ Waiting for backend... (${i + 1}/${maxRetries})`);
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
    }
    throw new Error('Backend not ready after 30 seconds');
  }

  describe('Step 0: Initialize Worker', () => {
    it('should create a new worker', async () => {
      const response = await api.post('/api/workers/init', {
        authUid: testAuthUid,
        email: testEmail,
        phone: '+5511999999999',
        country: 'AR',
        timezone: 'America/Sao_Paulo',
      });

      expect(response.status).toBe(201);
      expect(response.data.success).toBe(true);
      expect(response.data.data.worker).toHaveProperty('id');
      expect(response.data.data.worker.email).toBe(testEmail);
      // current_step and status removed from init response (migration 028)

      workerId = response.data.data.worker.id;
      console.log(`✅ Worker created: ${workerId}`);
    });

    it('should return existing worker if already exists', async () => {
      const response = await api.post('/api/workers/init', {
        authUid: testAuthUid,
        email: testEmail,
        phone: '+5511999999999',
      });

      expect(response.status).toBe(200);
      expect(response.data.data.worker.id).toBe(workerId);
    });
  });

  describe('Step 2: Personal Information', () => {
    it('should save personal information', async () => {
      const response = await api.put('/api/workers/step', {
        workerId,
        step: 2,
        data: {
          firstName: 'Alberto',
          lastName: 'Marquez',
          sex: 'Masculino',
          gender: 'Masculino',
          birthDate: '1960-03-18',
          documentType: 'CPF',
          documentNumber: '123.456.789-00',
          phone: '+5511920051588',
          profilePhotoUrl: 'https://example.com/photo.jpg',
          languages: ['Português', 'Espanhol'],
          profession: 'CAREGIVER',
          knowledgeLevel: 'Bacharelado',
          titleCertificate: 'Licenciado em psicologia',
          experienceTypes: ['Idosos', 'Portadores de TDAH'],
          yearsExperience: '10 ou +',
          preferredTypes: ['Portadores de TDAH'],
          preferredAgeRange: ['Idosos'],
          termsAccepted: true,
          privacyAccepted: true,
        },
      }, { headers: { Authorization: `Bearer ${mockToken}` } });

      expect(response.status).toBe(200);
      expect(response.data.success).toBe(true);
      console.log('✅ Personal information saved');
    });

    it('should have saved profession to database', async () => {
      // current_step removed in migration 028; first_name/last_name are encrypted
      const result = await db.query(
        'SELECT profession FROM workers WHERE id = $1',
        [workerId]
      );

      expect(result.rows[0].profession).toBe('CAREGIVER');
    });

    it('should have accepted terms and privacy', async () => {
      const result = await db.query(
        'SELECT terms_accepted_at, privacy_accepted_at FROM workers WHERE id = $1',
        [workerId]
      );

      expect(result.rows[0].terms_accepted_at).not.toBeNull();
      expect(result.rows[0].privacy_accepted_at).not.toBeNull();
    });
  });

  describe('Step 3: Service Area', () => {
    it('should save service area', async () => {
      try {
        const response = await api.put('/api/workers/step', {
          workerId,
          step: 3,
          data: {
            address: 'Rua São Bento, 1500 - Centro, São Paulo/SP',
            addressComplement: 'Edifício dos Palmares, ap. 202',
            serviceRadiusKm: 10,
            lat: -23.5505,
            lng: -46.6333,
          },
        }, { headers: { Authorization: `Bearer ${mockToken}` } });

        expect(response.status).toBe(200);
        expect(response.data.success).toBe(true);
        console.log('✅ Service area saved');
      } catch (error: any) {
        console.error('❌ Step 3 Error:', error.response?.data || error.message);
        throw error;
      }
    });

    it('should have saved service area in database', async () => {
      const result = await db.query(
        'SELECT * FROM worker_service_areas WHERE worker_id = $1',
        [workerId]
      );

      expect(result.rows.length).toBe(1);
      expect(result.rows[0].address_line).toContain('São Bento');
      expect(result.rows[0].radius_km).toBe(10);
      expect(parseFloat(result.rows[0].latitude)).toBeCloseTo(-23.5505, 4);
      expect(parseFloat(result.rows[0].longitude)).toBeCloseTo(-46.6333, 4);
    });
  });

  describe('Get Worker Progress', () => {
    it('should return worker progress', async () => {
      const response = await api.get('/api/workers/me', {
        headers: {
          Authorization: `Bearer ${mockToken}`,
        },
      });

      expect(response.status).toBe(200);
      expect(response.data.success).toBe(true);
      expect(response.data.data.id).toBe(workerId);
      // currentStep removed in migration 028
      console.log('✅ Worker progress retrieved');
    });
  });

  describe('Data Validation', () => {
    it('should have all required fields populated', async () => {
      const result = await db.query(
        `SELECT
          profession, years_experience,
          experience_types, preferred_types, preferred_age_range,
          terms_accepted_at, privacy_accepted_at, country
        FROM workers WHERE id = $1`,
        [workerId]
      );

      const worker = result.rows[0];
      expect(worker.profession).toBe('CAREGIVER');
      expect(worker.years_experience).toBe('10 ou +');
      expect(worker.experience_types).toEqual(['Idosos', 'Portadores de TDAH']);
      expect(worker.country).toBe('AR');
      expect(worker.terms_accepted_at).not.toBeNull();
      expect(worker.privacy_accepted_at).not.toBeNull();
    });
  });
});
