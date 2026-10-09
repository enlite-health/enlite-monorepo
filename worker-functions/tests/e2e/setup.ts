import { Pool } from 'pg';
import axios from 'axios';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const API_URL = process.env.API_URL || 'http://localhost:8080';

// Truncate em ordem para respeitar FK constraints (filhos antes de pais)
// Todas as tabelas usam TRUNCATE CASCADE — a ordem é defensiva, não estrita.
const TABLES_TO_TRUNCATE = [
  'worker_status_history',
  'talentum_prescreening_responses',
  'talentum_prescreenings',
  'talentum_questions',
  'worker_availability',
  'worker_service_areas',
  'worker_quiz_responses',
  'worker_documents',
  'worker_payment_info',
  'worker_employment_history',
  'worker_job_applications',
  'worker_placement_audits',
  'coordinator_weekly_schedules',
  'encuadres',
  'interview_slots',
  'blacklist',
  'publications',
  'import_job_errors',
  'import_jobs',
  'job_postings',
  // 049 (aba Admissão): filhas das reuniões; TRUNCATE CASCADE já leva, a ordem é defensiva.
  'admission_events',
  'admission_messages',
  'tactiq_links',
  'messaging_variable_tokens',
  'messaging_outbox',
  'domain_events',
  'workers',
  'coordinators',
  'message_templates',
  // webhook_partners contém dados de seed (parceiros configurados) — não truncar
];

async function waitForApi(retries = 30): Promise<void> {
  for (let i = 0; i < retries; i++) {
    try {
      await axios.get(`${API_URL}/health`);
      return;
    } catch {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  throw new Error('API not ready after 30s');
}

async function waitForFirebaseEmulator(retries = 30): Promise<void> {
  const host = process.env.FIREBASE_AUTH_EMULATOR_HOST || 'localhost:9099';
  for (let i = 0; i < retries; i++) {
    try {
      await axios.get(`http://${host}`);
      return;
    } catch {
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  throw new Error('Firebase Auth Emulator not ready after 30s');
}

async function truncateTestData(pool: Pool): Promise<void> {
  for (const table of TABLES_TO_TRUNCATE) {
    await pool.query(`TRUNCATE ${table} CASCADE`).catch(() => {
      // Tabela pode não existir em schema antigo — ignorar
    });
  }
}

let pool: Pool;

beforeAll(async () => {
  if (process.env.USE_FIREBASE_EMULATOR === 'true') {
    await waitForFirebaseEmulator();
  }
  await waitForApi();
  pool = new Pool({ connectionString: DATABASE_URL });
  await truncateTestData(pool);
});

afterAll(async () => {
  if (pool) await pool.end();
});
