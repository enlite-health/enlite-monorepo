/**
 * 058b-regra-05.e2e.test.ts @integration — 058b/B2 (T248): REGRA-05 — o endereço do serviço (`address_id`) fica TRAVADO
 * enquanto o serviço tem vaga viva ou alocação vigente. `PATCH /api/admin/patients/:id/contracted-services/:sid` com
 * `addressId`: recusa 422 `SERVICE_ADDRESS_LOCKED { details.reason }`; aceita o mesmo valor, ou a troca sem uso.
 * Passa pela API HTTP real (`staffAuth`); a semente é SQL como dono. O stack roda a API como dono (bypassa RLS): prova o FLUXO.
 */
import { Pool } from 'pg';
import { createApiClient, waitForBackend } from './helpers';
import { staffAuth } from './helpers/staffAuth';
import { seedB2, hojeAr, limparB2, type SeedB2 } from './helpers/seedItinerarioB2';

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';
const RUN = Date.now();
const TASK_PREFIX = `058b-r05-${RUN}-`;

describe('PATCH …/contracted-services/:sid — REGRA-05 (endereço travado) @integration', () => {
  const api = createApiClient();
  let asAdmin: { headers: { Authorization: string } };
  const pool = new Pool({ connectionString: DATABASE_URL, max: 3 });
  let seq = 0;

  beforeAll(async () => {
    await waitForBackend(api);
    asAdmin = await staffAuth(`058b-r05-admin-${RUN}`, 'admin');
    await hojeAr(pool); // falha cedo se o banco não responde
  });

  afterAll(async () => {
    await limparB2(pool, TASK_PREFIX);
  });

  const nextTag = (): string => {
    seq += 1;
    return `${TASK_PREFIX}${seq}`;
  };

  /** Endereço do MESMO paciente (a FK composta `pcs_address_same_patient_fk` exige). */
  async function outroEndereco(patientId: string): Promise<string> {
    const r = await pool.query<{ id: string }>(
      `INSERT INTO patient_addresses (patient_id, country, lat, lng) VALUES ($1, 'AR', -34.61, -58.41) RETURNING id`,
      [patientId],
    );
    return r.rows[0].id;
  }
  const enderecoAtual = async (s: SeedB2): Promise<string> =>
    (await pool.query<{ address_id: string }>(`SELECT address_id FROM patient_contracted_services WHERE id = $1`, [s.serviceId])).rows[0].address_id;
  const apagarVaga = async (s: SeedB2): Promise<void> => {
    await pool.query(`UPDATE job_postings SET deleted_at = now() WHERE id = $1`, [s.vacancyId]);
  };
  const patch = (s: SeedB2, body: Record<string, unknown>) =>
    api.patch(`/api/admin/patients/${s.patientId}/contracted-services/${s.serviceId}`, body, { headers: asAdmin.headers });

  it('REGRA-05 recusa: vaga viva → 422 SERVICE_ADDRESS_LOCKED { reason: LIVE_VACANCY }; address_id inalterado', async () => {
    const s = await seedB2(pool, nextTag(), { schedule: 'ONE', providersNeeded: 1, titularesSeg: 0 });
    const antes = await enderecoAtual(s);
    const res = await patch(s, { addressId: await outroEndereco(s.patientId) });
    expect(res.status).toBe(422);
    expect(res.data.code).toBe('SERVICE_ADDRESS_LOCKED');
    expect(res.data.details).toEqual({ reason: 'LIVE_VACANCY' });
    expect(await enderecoAtual(s)).toBe(antes);
  });

  it('REGRA-05 recusa: só alocação vigente (vaga apagada por SQL: UPDATE job_postings SET deleted_at = now()) → 422 { reason: ALLOCATION }', async () => {
    const s = await seedB2(pool, nextTag(), { schedule: 'ONE', providersNeeded: 1, titularesSeg: 1 });
    await apagarVaga(s);
    const antes = await enderecoAtual(s);
    const res = await patch(s, { addressId: await outroEndereco(s.patientId) });
    expect(res.status).toBe(422);
    expect(res.data.code).toBe('SERVICE_ADDRESS_LOCKED');
    expect(res.data.details).toEqual({ reason: 'ALLOCATION' });
    expect(await enderecoAtual(s)).toBe(antes);
  });

  it('REGRA-05 recusa: addressId null com alocação vigente → 422 ALLOCATION', async () => {
    const s = await seedB2(pool, nextTag(), { schedule: 'ONE', providersNeeded: 1, titularesSeg: 1 });
    await apagarVaga(s);
    const antes = await enderecoAtual(s);
    const res = await patch(s, { addressId: null });
    expect(res.status).toBe(422);
    expect(res.data.code).toBe('SERVICE_ADDRESS_LOCKED');
    expect(res.data.details).toEqual({ reason: 'ALLOCATION' });
    expect(await enderecoAtual(s)).toBe(antes);
  });

  it('REGRA-05 aceita: addressId IGUAL ao atual (o formulário reenvia) → 200 mesmo com vaga viva e alocação', async () => {
    const s = await seedB2(pool, nextTag(), { schedule: 'ONE', providersNeeded: 1, titularesSeg: 1 });
    const atual = await enderecoAtual(s);
    const res = await patch(s, { addressId: atual });
    expect(res.status).toBe(200);
    expect(await enderecoAtual(s)).toBe(atual);
  });

  it('REGRA-05 aceita: sem vaga viva e sem alocação → 200 e address_id muda', async () => {
    const s = await seedB2(pool, nextTag(), { schedule: 'ONE', providersNeeded: 1, titularesSeg: 0 });
    await apagarVaga(s);
    const novo = await outroEndereco(s.patientId);
    const res = await patch(s, { addressId: novo });
    expect(res.status).toBe(200);
    expect(await enderecoAtual(s)).toBe(novo);
  });

  it('REGRA-05 aceita: PATCH sem addressId (só providersNeeded) com vaga viva → 200', async () => {
    const s = await seedB2(pool, nextTag(), { schedule: 'ONE', providersNeeded: 1, titularesSeg: 1 });
    const antes = await enderecoAtual(s);
    const res = await patch(s, { providersNeeded: 3 });
    expect(res.status).toBe(200);
    expect(await enderecoAtual(s)).toBe(antes);
    const n = await pool.query<{ providers_needed: number }>(`SELECT providers_needed FROM patient_contracted_services WHERE id = $1`, [s.serviceId]);
    expect(n.rows[0].providers_needed).toBe(3);
  });
});
