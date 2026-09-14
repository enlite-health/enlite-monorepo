/**
 * PatientAddressQueryHelper — spec 019. Molde: PatientContractedServiceRepository.test.ts
 * (client mockado; `withActorContext` roda de verdade — sem ALS no processo de teste ele reduz
 * a BEGIN/.../COMMIT no mesmo client, carimbando só o ator quando houver um explícito. Hoje não
 * há RLS de país neste ambiente (migration 411 ainda não chegou aqui); quando chegar, o mesmo
 * helper passa a aplicar o país via `SET LOCAL` e um e2e com RLS ligada prova o isolamento).
 */
import type { Pool, PoolClient } from 'pg';
import type { GeocodingService } from '../../../../infrastructure/services/GeocodingService';
import {
  insertPatientAddress,
  fetchPatientAddresses,
  patientHasActiveDefaultAddress,
  type CreatePatientAddressInput,
} from '../PatientAddressQueryHelper';

const PATIENT_ID = 'pat-1';

function cliente(responses: Record<string, unknown> = {}) {
  const chamadas: Array<{ sql: string; params: unknown[] }> = [];
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    chamadas.push({ sql, params });
    if (/^BEGIN$|^COMMIT$|^ROLLBACK$/.test(sql.trim())) return { rows: [], rowCount: 0 };
    if (/^UPDATE patient_addresses SET is_default = false/.test(sql)) return { rows: [], rowCount: 0 };
    if (/^SELECT EXISTS/.test(sql)) return { rows: [{ exists: responses.hasDefault ?? false }], rowCount: 1 };
    if (/^INSERT INTO patient_addresses/.test(sql)) {
      if (responses.insertRejects) throw responses.insertRejects;
      return { rows: [responses.insertRow ?? { id: 'addr-1', patient_id: PATIENT_ID, address_formatted: 'x', address_raw: null, is_default: params[9] }], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  });
  const client = { query, release: jest.fn() } as unknown as PoolClient;
  return { client, chamadas };
}

function fakePool(client: PoolClient): Pool {
  return { connect: jest.fn().mockResolvedValue(client) } as unknown as Pool;
}

function fakeGeocoder(impl?: () => Promise<{ latitude: number; longitude: number } | null>): GeocodingService {
  return { geocode: jest.fn(impl ?? (async () => null)) } as unknown as GeocodingService;
}

function baseInput(overrides: Partial<CreatePatientAddressInput> = {}): CreatePatientAddressInput {
  return {
    patientId: PATIENT_ID,
    addressFormatted: 'Av. Siempreviva 742',
    addressRaw: null,
    displayOrder: null,
    neighborhood: null,
    logisticsCorridor: null,
    accessNotes: null,
    ...overrides,
  };
}

describe('patientHasActiveDefaultAddress', () => {
  it('lê o EXISTS e devolve o booleano da linha', async () => {
    const { client } = cliente({ hasDefault: true });
    await expect(patientHasActiveDefaultAddress(client as unknown as PoolClient, PATIENT_ID)).resolves.toBe(true);
  });
});

describe('insertPatientAddress', () => {
  it('isDefault omitido, paciente SEM principal ativo → nasce principal (regra de nascimento); geocode falha (best-effort, lat/lng null)', async () => {
    const { client, chamadas } = cliente({ hasDefault: false });
    const pool = fakePool(client);
    const geocoder = fakeGeocoder(async () => {
      throw new Error('geocoding indisponível');
    });
    const out = await insertPatientAddress(pool, geocoder, baseInput());
    expect(out.id).toBe('addr-1');
    const ins = chamadas.find((c) => /^INSERT INTO patient_addresses/.test(c.sql))!;
    expect(ins.params[9]).toBe(true); // isDefault calculado
    expect(ins.params[4]).toBeNull(); // lat
    expect(ins.params[5]).toBeNull(); // lng
    expect(chamadas[0].sql).toBe('BEGIN');
    expect(chamadas.at(-1)!.sql).toBe('COMMIT');
  });

  it('isDefault omitido, paciente JÁ tem principal ativo → nasce NÃO principal', async () => {
    const { client, chamadas } = cliente({ hasDefault: true });
    const pool = fakePool(client);
    const out = await insertPatientAddress(pool, fakeGeocoder(), baseInput());
    expect(out).toBeDefined();
    const ins = chamadas.find((c) => /^INSERT INTO patient_addresses/.test(c.sql))!;
    expect(ins.params[9]).toBe(false);
  });

  it('isDefault: true explícito → demove o principal anterior NA MESMA TRANSAÇÃO, antes do INSERT', async () => {
    const { client, chamadas } = cliente();
    const pool = fakePool(client);
    await insertPatientAddress(pool, fakeGeocoder(), baseInput({ isDefault: true }));
    expect(chamadas[0].sql).toBe('BEGIN');
    const demoteIdx = chamadas.findIndex((c) => /^UPDATE patient_addresses SET is_default = false/.test(c.sql));
    const insertIdx = chamadas.findIndex((c) => /^INSERT INTO patient_addresses/.test(c.sql));
    expect(demoteIdx).toBeGreaterThan(-1);
    expect(demoteIdx).toBeLessThan(insertIdx);
    expect(chamadas[demoteIdx].params).toEqual([PATIENT_ID]);
    const ins = chamadas[insertIdx];
    expect(ins.params[9]).toBe(true);
  });

  it('isDefault: false explícito → nasce NÃO principal, sem demote', async () => {
    const { client, chamadas } = cliente();
    const pool = fakePool(client);
    await insertPatientAddress(pool, fakeGeocoder(), baseInput({ isDefault: false }));
    expect(chamadas.some((c) => /^UPDATE patient_addresses SET is_default = false/.test(c.sql))).toBe(false);
    const ins = chamadas.find((c) => /^INSERT INTO patient_addresses/.test(c.sql))!;
    expect(ins.params[9]).toBe(false);
  });

  it('geocode com sucesso → lat/lng do resultado entram no INSERT', async () => {
    const { client, chamadas } = cliente({ hasDefault: true });
    const pool = fakePool(client);
    const geocoder = fakeGeocoder(async () => ({ latitude: -34.6, longitude: -58.4 }));
    await insertPatientAddress(pool, geocoder, baseInput());
    const ins = chamadas.find((c) => /^INSERT INTO patient_addresses/.test(c.sql))!;
    expect(ins.params[4]).toBe(-34.6);
    expect(ins.params[5]).toBe(-58.4);
  });

  it('geocode devolve null (endereço não encontrado) → lat/lng ficam null, sem lançar', async () => {
    const { client, chamadas } = cliente({ hasDefault: true });
    const pool = fakePool(client);
    await insertPatientAddress(pool, fakeGeocoder(async () => null), baseInput());
    const ins = chamadas.find((c) => /^INSERT INTO patient_addresses/.test(c.sql))!;
    expect(ins.params[4]).toBeNull();
    expect(ins.params[5]).toBeNull();
  });

  it('erro no INSERT propaga e desfaz a transação (ROLLBACK) — withActorContext quem cuida', async () => {
    const boom = new Error('constraint violation');
    const { client, chamadas } = cliente({ hasDefault: true, insertRejects: boom });
    const pool = fakePool(client);
    await expect(insertPatientAddress(pool, fakeGeocoder(), baseInput())).rejects.toBe(boom);
    expect(chamadas.at(-1)!.sql).toBe('ROLLBACK');
  });
});

describe('fetchPatientAddresses', () => {
  it('lê os endereços ativos do paciente, sem address_type, ordenado', async () => {
    const rows = [{ id: 'a1', address_formatted: 'x', address_raw: null, is_default: true, display_order: 1, source: 'admin_manual', complement: null, lat: null, lng: null }];
    const pool = { query: jest.fn().mockResolvedValue({ rows }) } as unknown as Pool;
    const out = await fetchPatientAddresses(pool, PATIENT_ID);
    expect(out).toEqual(rows);
    const [sql, params] = (pool.query as jest.Mock).mock.calls[0];
    expect(sql).not.toMatch(/address_type/);
    expect(sql).toMatch(/archived_at IS NULL/);
    expect(params).toEqual([PATIENT_ID]);
  });
});
