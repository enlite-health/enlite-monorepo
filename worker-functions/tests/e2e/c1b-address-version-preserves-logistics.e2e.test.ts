/**
 * c1b-address-version-preserves-logistics.e2e.test.ts @integration — C2 do relatório F5 (BLOCKER B2).
 *
 * `PatientRelatedWriter.replacePatientAddresses` tem UM só INSERT, e ele lista 10 colunas:
 * `access_notes` e `logistics_corridor` ficavam de fora. No "Path 2: VERSION" a linha anterior é
 * ARQUIVADA e uma nova é inserida — logo os dois campos sumiam da linha ATIVA a cada sync.
 * `country` sobrevive por trigger (migration 316); estes dois não têm trigger nenhum.
 *
 * O gatilho medido no relatório: NÃO é preciso mudar o endereço. Uma vaga PUBLICADA
 * (`is_draft = false`) apontando para a linha força o Path 2 sozinho — ou seja, TODO `taskUpdated`
 * do ClickUp num paciente com vaga publicada apagava os dois, em silêncio.
 *
 * Postgres REAL: o caminho de produção roda inteiro (mesma função que `PatientService.upsertRelated`
 * chama), e a asserção lê a LINHA ATIVA de volta do banco.
 */
import { Pool } from 'pg';
import { replacePatientAddresses } from '@modules/case/application/PatientRelatedWriter';
import type { GeocodingService } from '../../src/infrastructure/services/GeocodingService';
import type { PatientAddress } from '../../src/infrastructure/repositories/PatientRepository';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const TAG = 'C1B-address-logistics-%';
const ACCESS = 'C1B: portero 24h, timbre 4B roto — llamar al 11-5555-0000; perro suelto en el patio';
const CORRIDOR = 'C1B: Corredor Norte — Vicente López / San Isidro';

/** O geocoder nunca é a peça sob teste aqui: devolve "não resolvi" sem tocar rede. */
const geocoder = { geocodeBatch: async (queries: string[]) => queries.map(() => null) } as unknown as GeocodingService;

const addressInput = (formatted: string): PatientAddress => ({
  addressType: 'primary',
  addressFormatted: formatted,
  addressRaw: null,
  displayOrder: 1,
  state: 'Buenos Aires',
  city: 'Vicente López',
  neighborhood: 'Florida',
} as unknown as PatientAddress);

describe('C2 — versionar endereço preserva access_notes e logistics_corridor (Postgres real) @integration', () => {
  let pool: Pool;
  let patientId = '';
  let addressId = '';

  /** job_postings tem FK ON DELETE RESTRICT para patient_addresses — a vaga sai primeiro. */
  const limpar = async (): Promise<void> => {
    await pool.query(`DELETE FROM job_postings WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id LIKE $1)`, [TAG]);
    await pool.query('DELETE FROM patients WHERE clickup_task_id LIKE $1', [TAG]);
  };

  const activeRow = async () => (await pool.query<{ id: string; access_notes: string | null; logistics_corridor: string | null; country: string; address_formatted: string | null }>(
    `SELECT id, access_notes, logistics_corridor, country, address_formatted
       FROM patient_addresses WHERE patient_id = $1 AND archived_at IS NULL`, [patientId])).rows;

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();
  });

  beforeEach(async () => {
    await limpar();
    patientId = (await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
       VALUES ('C1B-address-logistics-1', 'C1B', 'Logistica QA', 'AR', 'ACTIVE') RETURNING id`,
    )).rows[0].id;
    addressId = (await pool.query<{ id: string }>(
      `INSERT INTO patient_addresses (patient_id, address_type, address_formatted, display_order, state, city, neighborhood, logistics_corridor, access_notes)
       VALUES ($1, 'primary', 'Av. Maipú 1234, Vicente López', 1, 'Buenos Aires', 'Vicente López', 'Florida', $2, $3) RETURNING id`,
      [patientId, CORRIDOR, ACCESS],
    )).rows[0].id;
  });

  afterAll(async () => {
    await limpar();
    await pool.end();
  });

  it('a. vaga PUBLICADA força o Path 2 SEM mudar o endereço: a linha ATIVA preserva os dois campos', async () => {
    await pool.query(
      `INSERT INTO job_postings (title, patient_id, patient_address_id, is_draft) VALUES ('C1B vaga publicada', $1, $2, false)`,
      [patientId, addressId],
    );
    const [antes] = await activeRow();
    expect({ access_notes: antes.access_notes, logistics_corridor: antes.logistics_corridor }).toEqual({ access_notes: ACCESS, logistics_corridor: CORRIDOR });

    const client = await pool.connect();
    try {
      // Mesmo endereço, mesmo texto — o `taskUpdated` mais inócuo que existe.
      await replacePatientAddresses(patientId, [addressInput('Av. Maipú 1234, Vicente López')], client, geocoder);
    } finally { client.release(); }

    const depois = await activeRow();
    expect(depois).toHaveLength(1);
    expect(depois[0].id).not.toBe(addressId); // provou que versionou (linha nova)
    expect(depois[0].access_notes).toBe(ACCESS);
    expect(depois[0].logistics_corridor).toBe(CORRIDOR);
    expect(depois[0].country).toBe('AR');
  });

  it('b. mudança REAL de rua também versiona e também preserva os dois campos', async () => {
    const client = await pool.connect();
    try {
      await replacePatientAddresses(patientId, [addressInput('Av. del Libertador 500, Vicente López')], client, geocoder);
    } finally { client.release(); }

    const depois = await activeRow();
    expect(depois).toHaveLength(1);
    expect(depois[0].address_formatted).toBe('Av. del Libertador 500, Vicente López');
    expect(depois[0].access_notes).toBe(ACCESS);
    expect(depois[0].logistics_corridor).toBe(CORRIDOR);
  });

  it('c. slot NOVO (sem linha anterior) nasce sem os dois campos — não há de onde copiar', async () => {
    const client = await pool.connect();
    try {
      await replacePatientAddresses(
        patientId,
        [addressInput('Av. Maipú 1234, Vicente López'), { ...addressInput('Calle Nueva 900'), displayOrder: 2 } as PatientAddress],
        client,
        geocoder,
      );
    } finally { client.release(); }

    const rows = await activeRow();
    const novo = rows.find((r) => r.address_formatted === 'Calle Nueva 900');
    expect(novo).toBeDefined();
    expect(novo?.access_notes).toBeNull();
    expect(novo?.logistics_corridor).toBeNull();
  });
});
