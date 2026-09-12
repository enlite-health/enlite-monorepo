/**
 * PatientAddressQueryHelper.insertPatientAddress — teste de REPOSITÓRIO, banco Postgres REAL
 * (nunca mock), contra as migrations 433/434 (spec 019) já aplicadas.
 *
 * Cobre a lacuna apontada no contrato desta rodada: `insertPatientAddress` só tinha cobertura
 * indireta via `AdminPatientsController` (mocks). Aqui provamos, com transação de verdade:
 *   1. regra de nascimento — endereço criado para paciente SEM principal ativo nasce principal;
 *   2. segundo endereço do mesmo paciente NÃO nasce principal;
 *   3. `is_default: true` explícito desmarca o principal anterior NA MESMA TRANSAÇÃO — nunca
 *      existe, ao final, mais de um `is_default = true` ativo para o paciente (índice único
 *      parcial `patient_addresses_one_default_per_patient`, migration 433);
 *   4. `address_type` nasce sempre `NULL` — `insertPatientAddress` nunca escreve valor nele
 *      (B4: único escritor de valor é o PATCH, `AdminPatientAddressesController`).
 *
 * Como rodar (fora da stack completa de `jest.config.e2e.js` — sem API nem Firebase Emulator):
 *   docker run -d --name 019loc-postgres -p 127.0.0.1:5541:5432 \
 *     -e POSTGRES_USER=enlite_admin -e POSTGRES_PASSWORD=enlite_password -e POSTGRES_DB=enlite_e2e \
 *     postgis/postgis:16-3.4
 *   DATABASE_URL=postgresql://enlite_admin:enlite_password@127.0.0.1:5541/enlite_e2e \
 *     node scripts/run-migrations-docker.js
 *   DATABASE_URL=postgresql://enlite_admin:enlite_password@127.0.0.1:5541/enlite_e2e \
 *     npx jest --config jest.config.repo.js --runInBand
 */
import { Pool } from 'pg';
import { insertPatientAddress, fetchPatientAddresses } from '../../src/modules/case/infrastructure/PatientAddressQueryHelper';
import type { GeocodingService } from '../../src/infrastructure/services/GeocodingService';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@127.0.0.1:5541/enlite_e2e';

const noGeocode = { geocode: async () => null } as unknown as GeocodingService;

describe('PatientAddressQueryHelper.insertPatientAddress @repo (Postgres real, migrations 433/434)', () => {
  let pool: Pool;
  let patientId: string;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await pool.query('SELECT 1'); // falha cedo e claro se o container não estiver de pé
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    const { rows: [p] } = await pool.query<{ id: string }>('INSERT INTO patients DEFAULT VALUES RETURNING id');
    patientId = p.id;
  });

  afterEach(async () => {
    await pool.query('DELETE FROM patients WHERE id = $1', [patientId]);
  });

  it('regra de nascimento: paciente sem nenhum endereço → o primeiro nasce is_default=true e address_type=NULL', async () => {
    const created = await insertPatientAddress(pool, noGeocode, {
      patientId,
      addressFormatted: 'Av. Corrientes 1234',
      addressRaw: null,
      displayOrder: null,
      neighborhood: null,
      logisticsCorridor: null,
      accessNotes: null,
    });

    expect(created.is_default).toBe(true);

    const { rows } = await pool.query<{ address_type: string | null; is_default: boolean }>(
      'SELECT address_type, is_default FROM patient_addresses WHERE id = $1',
      [created.id],
    );
    expect(rows[0]).toEqual({ address_type: null, is_default: true });
  });

  it('segundo endereço do mesmo paciente (sem is_default explícito) NÃO nasce principal', async () => {
    await insertPatientAddress(pool, noGeocode, {
      patientId, addressFormatted: 'Primeiro', addressRaw: null, displayOrder: null,
      neighborhood: null, logisticsCorridor: null, accessNotes: null,
    });
    const second = await insertPatientAddress(pool, noGeocode, {
      patientId, addressFormatted: 'Segundo', addressRaw: null, displayOrder: null,
      neighborhood: null, logisticsCorridor: null, accessNotes: null,
    });

    expect(second.is_default).toBe(false);

    const { rows } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM patient_addresses WHERE patient_id = $1 AND is_default AND archived_at IS NULL`,
      [patientId],
    );
    expect(rows[0].count).toBe('1');
  });

  it('is_default=true explícito desmarca o principal anterior NA MESMA TRANSAÇÃO — nunca 0 ou 2 principais ao final', async () => {
    const first = await insertPatientAddress(pool, noGeocode, {
      patientId, addressFormatted: 'Primeiro', addressRaw: null, displayOrder: null,
      neighborhood: null, logisticsCorridor: null, accessNotes: null,
    });
    expect(first.is_default).toBe(true);

    const second = await insertPatientAddress(pool, noGeocode, {
      patientId, addressFormatted: 'Segundo', addressRaw: null, displayOrder: null,
      isDefault: true,
      neighborhood: null, logisticsCorridor: null, accessNotes: null,
    });
    expect(second.is_default).toBe(true);

    const { rows: firstRow } = await pool.query<{ is_default: boolean }>(
      'SELECT is_default FROM patient_addresses WHERE id = $1', [first.id],
    );
    expect(firstRow[0].is_default).toBe(false);

    const { rows: countRow } = await pool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM patient_addresses WHERE patient_id = $1 AND is_default AND archived_at IS NULL`,
      [patientId],
    );
    expect(countRow[0].count).toBe('1');
  });

  it('is_default=false explícito nasce sem a marca mesmo sendo o primeiro endereço do paciente', async () => {
    const created = await insertPatientAddress(pool, noGeocode, {
      patientId, addressFormatted: 'Único, mas não principal', addressRaw: null, displayOrder: null,
      isDefault: false,
      neighborhood: null, logisticsCorridor: null, accessNotes: null,
    });
    expect(created.is_default).toBe(false);
  });

  it('índice único parcial (migration 433) rejeita duas linhas is_default=true simultâneas se o helper for contornado', async () => {
    const first = await insertPatientAddress(pool, noGeocode, {
      patientId, addressFormatted: 'Primeiro', addressRaw: null, displayOrder: null,
      neighborhood: null, logisticsCorridor: null, accessNotes: null,
    });
    expect(first.is_default).toBe(true);

    // Contorna o helper de propósito — prova que a trava real é o BANCO (índice), não só o app.
    await expect(
      pool.query(
        `INSERT INTO patient_addresses (patient_id, address_formatted, source, is_default) VALUES ($1, $2, 'admin_manual', true)`,
        [patientId, 'Sabotagem direta'],
      ),
    ).rejects.toThrow(/patient_addresses_one_default_per_patient|duplicate key/);
  });

  it('fetchPatientAddresses devolve is_default e address_type (NULL) para o painel', async () => {
    await insertPatientAddress(pool, noGeocode, {
      patientId, addressFormatted: 'Endereço do painel', addressRaw: null, displayOrder: null,
      neighborhood: null, logisticsCorridor: null, accessNotes: null,
    });
    const rows = await fetchPatientAddresses(pool, patientId);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ address_type: null, is_default: true, address_formatted: 'Endereço do painel' });
  });
});
