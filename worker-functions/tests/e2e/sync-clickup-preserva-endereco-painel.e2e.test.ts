/**
 * sync-clickup-preserva-endereco-painel.e2e.test.ts @integration
 *
 * `PatientRelatedWriter.replacePatientAddresses` — chamado pelo sync do ClickUp (webhook
 * `taskUpdated` e `ReconcileClickUpPatientsUseCase`, a cada ~10 min) — lia TODA linha ativa de
 * `patient_addresses` sem filtrar `source`. O ClickUp só emite `display_order` 1/2/3
 * (`ClickUpPatientMapper`); o painel cria linha com `source = 'admin_manual'` e
 * `display_order = MAX+1` (`PatientAddressQueryHelper.insertPatientAddress`). Sem o filtro, o
 * `taskUpdated` mais inócuo (endereço inalterado no ClickUp) podia SOBRESCREVER (Path 1),
 * ARQUIVAR (Path 2) ou APAGAR (bloco "gone") uma linha que o painel tinha acabado de criar.
 *
 * API real (POST /api/admin/patients/:id/addresses, o caminho do painel) + a função de produção
 * do sync chamada direto contra Postgres real (mesmo padrão de
 * `c1b-address-version-preserves-logistics.e2e.test.ts`) — prova que as duas origens convivem.
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { staffAuth } from './helpers/staffAuth';
import { replacePatientAddresses } from '@modules/case/application/PatientRelatedWriter';
import type { GeocodingService } from '../../src/infrastructure/services/GeocodingService';
import type { PatientAddress } from '../../src/infrastructure/repositories/PatientRepository';

const DATABASE_URL = process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const TAG = 'sync-preserva-painel-%';

/** O geocoder nunca é a peça sob teste aqui: devolve "não resolvi" sem tocar rede. */
const geocoder = { geocodeBatch: async (queries: string[]) => queries.map(() => null) } as unknown as GeocodingService;

const clickupSlot = (displayOrder: number, formatted: string): PatientAddress => ({
  addressType: displayOrder === 1 ? 'primary' : 'secondary',
  addressFormatted: formatted,
  addressRaw: null,
  displayOrder,
  state: 'Buenos Aires',
  city: 'Vicente López',
  neighborhood: 'Florida',
} as unknown as PatientAddress);

describe('sync do ClickUp preserva endereço criado no painel @integration', () => {
  const api = createApiClient();
  let asAdmin: { headers: { Authorization: string } };
  let pool: Pool;
  let patientId = '';

  const limpar = async (): Promise<void> => {
    await pool.query(`DELETE FROM job_postings WHERE patient_id IN (SELECT id FROM patients WHERE clickup_task_id LIKE $1)`, [TAG]);
    await pool.query('DELETE FROM patients WHERE clickup_task_id LIKE $1', [TAG]);
  };

  const linhasAtivas = async () => (await pool.query<{
    id: string; display_order: number; source: string; address_formatted: string | null; archived_at: string | null;
  }>(
    `SELECT id, display_order, source, address_formatted, archived_at
       FROM patient_addresses WHERE patient_id = $1 AND archived_at IS NULL
       ORDER BY display_order ASC, source ASC`,
    [patientId],
  )).rows;

  beforeAll(async () => {
    await waitForBackend(api);
    asAdmin = await staffAuth('sync-painel-admin', 'admin');
    pool = new Pool({ connectionString: DATABASE_URL });
    await limpar();
  });

  beforeEach(async () => {
    await limpar();
    patientId = (await pool.query<{ id: string }>(
      `INSERT INTO patients (clickup_task_id, first_name, last_name, country, status)
       VALUES ($1, 'Sync', 'Preserva Painel', 'AR', 'ACTIVE') RETURNING id`,
      [`sync-preserva-painel-${Date.now()}-${Math.floor(Math.random() * 1e6)}`],
    )).rows[0].id;
  });

  afterAll(async () => {
    await limpar();
    await pool.end();
  });

  it('endereço criado pelo painel (fora do slot 1-3) continua ativo e intacto depois do sync trazer só 1-3', async () => {
    // Painel: display_order = MAX+1 (não informado) → nasce em 1, único endereço até aqui.
    const criado = await api.post(`/api/admin/patients/${patientId}/addresses`,
      { address_formatted: 'Rua do Painel 500', address_type: 'secondary', display_order: 4 }, asAdmin);
    expect(criado.status).toBe(201);
    const painelId = criado.data.data.id as string;

    const client = await pool.connect();
    try {
      // O sync do ClickUp só conhece os slots 1, 2 e 3 — nunca o 4.
      await replacePatientAddresses(
        patientId,
        [clickupSlot(1, 'Av. Maipú 1234'), clickupSlot(2, 'Calle Nueva 900'), clickupSlot(3, 'Av. del Libertador 500')],
        client,
        geocoder,
      );
    } finally { client.release(); }

    const rows = await linhasAtivas();
    const painel = rows.find(r => r.id === painelId);
    expect(painel).toBeDefined();
    expect(painel?.archived_at).toBeNull();
    expect(painel?.address_formatted).toBe('Rua do Painel 500');
    expect(painel?.source).toBe('admin_manual');
    // Os 3 slots do ClickUp foram inseridos — nenhum deles é a linha do painel.
    expect(rows.filter(r => r.source === 'clickup')).toHaveLength(3);
    expect(rows).toHaveLength(4);
  });

  it('convivência no MESMO display_order: painel no slot 1 sobrevive ao ClickUp trazer o slot 1 — os dois coexistem', async () => {
    const criado = await api.post(`/api/admin/patients/${patientId}/addresses`,
      { address_formatted: 'Rua do Painel no Slot 1', address_type: 'primary', display_order: 1 }, asAdmin);
    expect(criado.status).toBe(201);
    const painelId = criado.data.data.id as string;

    const client = await pool.connect();
    try {
      await replacePatientAddresses(patientId, [clickupSlot(1, 'Av. Maipú 1234')], client, geocoder);
    } finally { client.release(); }

    const rows = await linhasAtivas();
    expect(rows).toHaveLength(2);
    const painel = rows.find(r => r.id === painelId);
    const clickup = rows.find(r => r.source === 'clickup');
    expect(painel).toBeDefined();
    expect(painel?.archived_at).toBeNull();
    expect(painel?.address_formatted).toBe('Rua do Painel no Slot 1'); // NÃO sobrescrito pelo Path 1
    expect(clickup).toBeDefined();
    expect(clickup?.display_order).toBe(1); // MESMO slot do painel — convivência, não colisão
    expect(clickup?.address_formatted).toBe('Av. Maipú 1234');
  });
});
