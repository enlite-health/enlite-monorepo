/**
 * PatientReadRepository — teste de REPOSITÓRIO, banco Postgres REAL (nunca mock), contra a tabela
 * `patients` (`migrations/037_create_patients.sql`), para `findDocumentNumber` (F3,
 * `integracao-axonico`, `IPatientReadPort`).
 *
 * Prova o que o JSDoc de `IPatientReadPort` exige e que um `Pool` mockado não prova: os TRÊS
 * ramos do guard 0 de `LancarPrestacaoAxonicoUseCase` não podem colapsar —
 *   1. patientId sem linha em `patients`               → `null` (o objeto todo)
 *   2. linha existe, `document_number IS NULL`         → `{ documentNumber: null }`
 *   3. linha existe, `document_number` tem DNI          → `{ documentNumber: '<dni>' }`
 * — e os casos 1 e 2 são diferentes: um `Pool` mockado devolveria o que o teste programasse,
 * nunca provando que a query real e o `WHERE id = $1` distinguem "sem linha" de "linha com
 * document_number NULL" contra o schema de verdade.
 *
 * Como rodar (fora da stack completa de `jest.config.e2e.js` — sem API nem Firebase Emulator):
 *   docker run -d --name axonico-f2-postgres -p 127.0.0.1:5543:5432 \
 *     -e POSTGRES_USER=enlite_admin -e POSTGRES_PASSWORD=enlite_password -e POSTGRES_DB=enlite_e2e \
 *     postgis/postgis:16-3.4
 *   DATABASE_URL=postgresql://enlite_admin:enlite_password@127.0.0.1:5543/enlite_e2e \
 *     node scripts/run-migrations-docker.js
 *   DATABASE_URL=postgresql://enlite_admin:enlite_password@127.0.0.1:5543/enlite_e2e \
 *     npx jest --config jest.config.repo.js --runInBand PatientReadRepository
 */
import { randomUUID } from 'crypto';
import { Pool } from 'pg';
import { PatientReadRepository } from '../../src/modules/integration/infrastructure/PatientReadRepository';
import { DatabaseConnection } from '../../src/shared/database/DatabaseConnection';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@127.0.0.1:5543/enlite_e2e';

describe('PatientReadRepository @repo (Postgres real, migrations/037_create_patients.sql)', () => {
  let pool: Pool;
  let repo: PatientReadRepository;
  let patientId: string;

  beforeAll(async () => {
    process.env.DATABASE_URL = DATABASE_URL;
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query('SELECT 1'); // falha cedo e claro se o container não estiver de pé
    // O repositório usa o pool singleton de `DatabaseConnection` (mesmo padrão de
    // `AxonicoLancamentoRepository`) — aponta para o MESMO banco deste teste via DATABASE_URL.
    repo = new PatientReadRepository();
  });

  afterAll(async () => {
    await pool.end();
    await DatabaseConnection.getInstance().getPool().end();
  });

  afterEach(async () => {
    if (patientId) {
      await pool.query('DELETE FROM patients WHERE id = $1', [patientId]);
    }
  });

  it('paciente que NÃO existe (UUID válido, sem linha): findDocumentNumber devolve null (o objeto todo)', async () => {
    patientId = randomUUID();

    const found = await repo.findDocumentNumber(patientId);

    expect(found).toBeNull();
  });

  it('paciente existe e tem document_number IS NULL: devolve { documentNumber: null } — NÃO colapsa com o caso "não existe"', async () => {
    const {
      rows: [p],
    } = await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, document_number) VALUES ($1, NULL) RETURNING id`,
      [`repo-test-${randomUUID()}`],
    );
    patientId = p.id;

    const found = await repo.findDocumentNumber(patientId);

    expect(found).toEqual({ documentNumber: null });
  });

  it('paciente existe e tem DNI: devolve { documentNumber: <o dni> }', async () => {
    const dni = '30111222';
    const {
      rows: [p],
    } = await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, document_number) VALUES ($1, $2) RETURNING id`,
      [`repo-test-${randomUUID()}`, dni],
    );
    patientId = p.id;

    const found = await repo.findDocumentNumber(patientId);

    expect(found).toEqual({ documentNumber: dni });
  });
});
