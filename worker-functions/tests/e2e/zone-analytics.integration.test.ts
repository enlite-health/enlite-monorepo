/**
 * zone-analytics.integration.test.ts
 *
 * Teste de integração com banco REAL para o bloco "Analytics por Zona" do
 * Dashboard para Gestão à Vista (ClickUp 86ajb4qnw). Exercita
 * GetZoneAnalyticsUseCase.execute() contra o Postgres de teste (schema real,
 * migrations aplicadas) e prova, com dado semeado real, que:
 *   1. as duas queries compilam e retornam contra o schema real (join
 *      job_postings↔patient_addresses via patient_address_id,
 *      worker_service_areas via LEFT JOIN, workers.sex_bidx, required_professions);
 *   2. worker com 2 worker_service_areas na MESMA província canônica (CABA vs
 *      "Capital Federal", bairros diferentes) conta 1 vez (dedup por
 *      Set<id>, não soma de rows);
 *   3. worker SEM worker_service_areas (LEFT JOIN) cai em "Não informado";
 *   4. filtro ?profession= funciona end-to-end (SQL real, não mock);
 *   5. bairros diferentes da MESMA província (Lanús vs San Isidro, ambos
 *      "Provincia de Buenos Aires") somam na mesma zona — "zona" é a
 *      PROVÍNCIA, não o bairro (decisão do user, 2026-07-13);
 *   6. state lixo (CPA postal, "B1748 AEJ") cai em "Não informado" (guard
 *      isJunkLocation sobre o resultado de canonicalProvince, contra Postgres
 *      real — não só mock).
 *
 * Espelha o padrão de tests/e2e/management-dashboard.integration.test.ts:
 * instancia o use case com o pool direto (mesma agregação do endpoint
 * GET /analytics/dashboard/zone-analytics), sem passar pela API HTTP.
 *
 * O setup global (tests/e2e/setup.ts, via setupFilesAfterEnv) faz TRUNCATE
 * CASCADE em `workers`, `worker_service_areas` e `job_postings` ANTES desta
 * suite rodar — por isso as asserções abaixo são EXATAS (não
 * toBeGreaterThanOrEqual): não sobra lixo de outra suite. `patients` e
 * `patient_addresses` NÃO são truncadas globalmente, mas só entram na query
 * via LEFT JOIN a partir de job_postings — órfãs de runs anteriores não
 * aparecem porque não há job_posting ativo apontando pra elas.
 *
 * INVARIANTES: migrations 107 (required_professions TEXT[]), 149
 * (patient_address_id FK), 218 (sex_bidx blind index).
 *
 * Rodar isolado com:
 *   docker compose -f docker-compose.yml -f docker-compose.test.yml up -d postgres api
 *   node scripts/wait-for-health.js
 *   DATABASE_URL=postgresql://enlite_admin:enlite_password@localhost:5433/enlite_e2e \
 *     npx jest --config jest.config.e2e.js zone-analytics.integration
 */

import { Pool } from 'pg';
import { GetZoneAnalyticsUseCase } from '../../src/modules/matching/application/GetZoneAnalyticsUseCase';
import { BlindIndexService } from '../../src/shared/security/BlindIndexService';
import { normalizeSexValue } from '../../src/shared/utils/normalizeSexValue';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

const pool = new Pool({ connectionString: DATABASE_URL });
const SUFFIX = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;

const PATIENT_IDS: string[] = [];
const PATIENT_ADDRESS_IDS: string[] = [];
const JOB_POSTING_IDS: string[] = [];
const WORKER_IDS: string[] = [];

let maleBidx: Buffer;
let femaleBidx: Buffer;

async function makePatient(tag: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO patients (clickup_task_id, country) VALUES ($1, 'AR') RETURNING id`,
    [`zone-analytics-${SUFFIX}-${tag}`],
  );
  PATIENT_IDS.push(rows[0].id);
  return rows[0].id;
}

async function makeAddress(patientId: string, state: string | null, city: string | null): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO patient_addresses (patient_id, address_type, state, city)
     VALUES ($1, 'primary', $2, $3) RETURNING id`,
    [patientId, state, city],
  );
  PATIENT_ADDRESS_IDS.push(rows[0].id);
  return rows[0].id;
}

async function makeJob(
  patientId: string,
  addressId: string | null,
  status: string,
  requiredProfessions: string[],
  tag: string,
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO job_postings (title, patient_id, patient_address_id, status, is_draft, is_test, required_professions)
     VALUES ($1, $2, $3, $4, false, false, $5) RETURNING id`,
    [`Caso zone-analytics ${tag} ${SUFFIX}`, patientId, addressId, status, requiredProfessions],
  );
  JOB_POSTING_IDS.push(rows[0].id);
  return rows[0].id;
}

async function makeWorker(
  profession: string,
  sexBidx: Buffer | null,
  status: 'REGISTERED' | 'INCOMPLETE_REGISTER',
  tag: string,
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO workers (auth_uid, email, status, profession, sex_bidx, is_test)
     VALUES ($1, $2, $3, $4, $5, false) RETURNING id`,
    [`uid-zone-${SUFFIX}-${tag}`, `zone-${SUFFIX}-${tag}@dash.test`, status, profession, sexBidx],
  );
  WORKER_IDS.push(rows[0].id);
  return rows[0].id;
}

async function makeServiceArea(workerId: string, state: string | null, city: string | null): Promise<void> {
  await pool.query(
    `INSERT INTO worker_service_areas (worker_id, latitude, longitude, radius_km, state, city)
     VALUES ($1, -34.6, -58.4, 20, $2, $3)`,
    [workerId, state, city],
  );
}

beforeAll(async () => {
  const bidx = new BlindIndexService();
  maleBidx = (await bidx.generateValueBidx(normalizeSexValue('male'))) as Buffer;
  femaleBidx = (await bidx.generateValueBidx(normalizeSexValue('female'))) as Buffer;

  // ── Cenário 1: dedup por PROVÍNCIA — bairros diferentes (Lanús vs San
  // Isidro), MESMA província "Provincia de Buenos Aires" ─────────────────
  const p1 = await makePatient('pba-p1');
  const a1 = await makeAddress(p1, 'Provincia de Buenos Aires', 'Lanús');
  await makeJob(p1, a1, 'SEARCHING', ['AT'], 'pba-1');

  const p2 = await makePatient('pba-p2');
  const a2 = await makeAddress(p2, 'Provincia de Buenos Aires', 'San Isidro');
  await makeJob(p2, a2, 'CLOSED', ['CAREGIVER'], 'pba-2'); // status fechado — não conta em demand

  // ── Cenário 2: worker com 2 service_areas na MESMA província canônica ───
  // (CABA vs "Capital Federal" — mesmo alias — bairros diferentes: Palermo
  // vs Villa Crespo — prova que bairro não fragmenta mais a zona)
  const wCaba = await makeWorker('AT', maleBidx, 'REGISTERED', 'caba-dup');
  await makeServiceArea(wCaba, 'CABA', 'Palermo');
  await makeServiceArea(wCaba, 'Capital Federal', 'Villa Crespo');

  // ── Cenário 3: worker SEM nenhuma worker_service_areas (LEFT JOIN) ──────
  await makeWorker('CAREGIVER', femaleBidx, 'REGISTERED', 'no-area');

  // ── Cenário 4: profession filter — worker de profissão diferente na
  // MESMA província "Provincia de Buenos Aires", para provar que o filtro
  // exclui quando não bate ────────────────────────────────────────────────
  const wPbaNurse = await makeWorker('NURSE', maleBidx, 'REGISTERED', 'pba-nurse');
  await makeServiceArea(wPbaNurse, 'Provincia de Buenos Aires', 'Lanús');

  // ── Cenário 5: state LIXO (CPA postal) → "Não informado" ────────────────
  // canonicalProvince("B1748 AEJ") não retorna null (é "resto → inalterado"),
  // então o guard isJunkLocation em resolveZoneKey precisa capturar isso.
  const p3 = await makePatient('junk-p3');
  const a3 = await makeAddress(p3, 'B1748 AEJ', null);
  await makeJob(p3, a3, 'SEARCHING', ['AT'], 'junk-1');
});

afterAll(async () => {
  if (JOB_POSTING_IDS.length) {
    await pool.query(`DELETE FROM job_postings WHERE id = ANY($1::uuid[])`, [JOB_POSTING_IDS]);
  }
  if (WORKER_IDS.length) {
    await pool.query(`DELETE FROM worker_service_areas WHERE worker_id = ANY($1::uuid[])`, [WORKER_IDS]);
    await pool.query(`DELETE FROM workers WHERE id = ANY($1::uuid[])`, [WORKER_IDS]);
  }
  if (PATIENT_ADDRESS_IDS.length) {
    await pool.query(`DELETE FROM patient_addresses WHERE id = ANY($1::uuid[])`, [PATIENT_ADDRESS_IDS]);
  }
  if (PATIENT_IDS.length) {
    await pool.query(`DELETE FROM patients WHERE id = ANY($1::uuid[])`, [PATIENT_IDS]);
  }
  await pool.end();
});

describe('GetZoneAnalyticsUseCase (integration — banco real)', () => {
  it('roda as duas queries reais sem erro de coluna/schema', async () => {
    await expect(new GetZoneAnalyticsUseCase(pool).execute()).resolves.toBeDefined();
  });

  it('agrega bairros diferentes da MESMA província juntos (Lanús + San Isidro → "Provincia de Buenos Aires")', async () => {
    const data = await new GetZoneAnalyticsUseCase(pool).execute();
    const pba = data.zones.find((z) => z.zone === 'Provincia de Buenos Aires');

    expect(pba).toBeDefined();
    // patients: p1 (Lanús) + p2 (San Isidro) = 2; demand: só o job SEARCHING (p1) conta = 1.
    expect(pba?.patients).toBe(2);
    expect(pba?.demand).toBe(1);
  });

  it('dedupa worker com 2 worker_service_areas na mesma província canônica (CABA/Capital Federal, bairros diferentes → conta 1)', async () => {
    const data = await new GetZoneAnalyticsUseCase(pool).execute();
    const caba = data.zones.find((z) => z.zone === 'CABA');

    expect(caba).toBeDefined();
    expect(caba?.workersMale).toBe(1);
    expect(caba?.availability).toBe(1);
  });

  it('worker sem worker_service_areas (LEFT JOIN) cai em "Não informado" — não some', async () => {
    const data = await new GetZoneAnalyticsUseCase(pool).execute();
    const naoInformado = data.zones.find((z) => z.zone === 'Não informado');

    expect(naoInformado).toBeDefined();
    expect(naoInformado?.workersFemale).toBeGreaterThanOrEqual(1);
    expect(data.unresolvedCount).toBeGreaterThanOrEqual(1);
  });

  it('state lixo (CPA postal "B1748 AEJ") cai em "Não informado" — guard isJunkLocation contra Postgres real', async () => {
    const data = await new GetZoneAnalyticsUseCase(pool).execute();
    const naoInformado = data.zones.find((z) => z.zone === 'Não informado');

    expect(naoInformado).toBeDefined();
    // patient da vaga com state lixo entra no "Não informado" (mais o worker sem área do cenário 3).
    expect(naoInformado?.patients).toBeGreaterThanOrEqual(1);
  });

  it('filtro profession=AT exclui worker NURSE da província "Provincia de Buenos Aires" end-to-end', async () => {
    const dataFiltered = await new GetZoneAnalyticsUseCase(pool).execute({ profession: 'AT' });
    const pbaFiltered = dataFiltered.zones.find((z) => z.zone === 'Provincia de Buenos Aires');

    // Com profession=AT: worker NURSE semeado em PBA é excluído.
    expect(pbaFiltered?.workersMale ?? 0).toBe(0);

    const dataUnfiltered = await new GetZoneAnalyticsUseCase(pool).execute();
    const pbaUnfiltered = dataUnfiltered.zones.find((z) => z.zone === 'Provincia de Buenos Aires');

    // Sem filtro: worker NURSE aparece.
    expect(pbaUnfiltered?.workersMale ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('mantém o contrato: inteiros >= 0 em todas as zonas', async () => {
    const data = await new GetZoneAnalyticsUseCase(pool).execute();
    for (const zone of data.zones) {
      for (const [k, v] of Object.entries(zone)) {
        if (k === 'zone') continue;
        expect(v as number).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(v)).toBe(true);
      }
    }
    expect(data.unresolvedCount).toBeGreaterThanOrEqual(0);
  });
});
