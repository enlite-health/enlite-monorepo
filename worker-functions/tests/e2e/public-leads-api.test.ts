/**
 * public-leads-api.test.ts
 *
 * End-to-end tests for POST /api/public/v1/leads — the public, unauthenticated
 * patient-intake surface (D108/F0: jurisdiction + consent are SERVER-enforced).
 *
 * Proves against the real API + Postgres:
 *   • valid AR/BR bodies → 201, row persisted with the exact country + consent
 *   • body without country → 400 (never a silent 'AR' default)
 *   • consent missing/false → 400 (a non-consenting lead is never stored)
 *   • has_consent survives a partial admin PATCH of the clinical section
 *     (COALESCE — the legal record is only changed explicitly)
 *
 * Uses MockAuth (USE_MOCK_AUTH=true) for the admin PATCH; the POSTs are
 * unauthenticated like a real visitor. Cleans up its own rows.
 */

import { Pool } from 'pg';
import { createApiClient, getMockToken, waitForBackend } from './helpers';

const DATABASE_URL =
  process.env.DATABASE_URL ||
  'postgresql://enlite_admin:enlite_password@localhost:5432/enlite_e2e';

describe('Public Leads API (D108/F0)', () => {
  const api = createApiClient();
  let staffToken: string;
  let pool: Pool;
  const insertedIds: string[] = [];

  const validBody = {
    serviceType: 'cuidadores',
    requesterType: 'patient',
    email: 'lead-e2e@example.com',
    phone: '+5491100009999',
    country: 'AR',
    consent: true,
  };

  async function countLeadsByEmailMarker(): Promise<number> {
    // Native leads store the email KMS-encrypted; count by our unique phone
    // marker instead (plaintext column, unique to this suite).
    const r = await pool.query(
      `SELECT count(*)::int AS n FROM patients WHERE phone_whatsapp = $1`,
      [validBody.phone],
    );
    return r.rows[0].n;
  }

  beforeAll(async () => {
    pool = new Pool({ connectionString: DATABASE_URL });
    await waitForBackend(api);
    staffToken = await getMockToken(api, {
      uid: 'leads-staff-e2e',
      email: 'leads-staff@e2e.local',
      role: 'admin',
    });
  });

  afterAll(async () => {
    if (insertedIds.length > 0) {
      await pool.query(`DELETE FROM patients WHERE id = ANY($1::uuid[])`, [insertedIds]);
    }
    await pool.end();
  });

  it('a. valid AR body → 201 and the row carries country=AR, has_consent=true, origin=web_form', async () => {
    const res = await api.post('/api/public/v1/leads', validBody);
    expect(res.status).toBe(201);
    const id = res.data.data.id as string;
    insertedIds.push(id);

    const row = await pool.query(
      `SELECT country, has_consent AS "hasConsent", origin, status
         FROM patients WHERE id = $1`,
      [id],
    );
    expect(row.rows[0]).toEqual({
      country: 'AR',
      hasConsent: true,
      origin: 'web_form',
      status: 'SOLICITANTE',
    });
  });

  it('b. valid BR body → 201 and country=BR reaches the row verbatim', async () => {
    const res = await api.post('/api/public/v1/leads', { ...validBody, country: 'BR' });
    expect(res.status).toBe(201);
    const id = res.data.data.id as string;
    insertedIds.push(id);

    const row = await pool.query(`SELECT country FROM patients WHERE id = $1`, [id]);
    expect(row.rows[0].country).toBe('BR');
  });

  it('c. body WITHOUT country → 400 and nothing is persisted (no silent AR default)', async () => {
    const before = await countLeadsByEmailMarker();
    const { country: _c, ...withoutCountry } = validBody;
    const res = await api.post('/api/public/v1/leads', withoutCountry);
    expect(res.status).toBe(400);
    expect(await countLeadsByEmailMarker()).toBe(before);
  });

  it('d. consent=false → 400 and nothing is persisted (refusal never becomes a lead)', async () => {
    const before = await countLeadsByEmailMarker();
    const res = await api.post('/api/public/v1/leads', { ...validBody, consent: false });
    expect(res.status).toBe(400);
    expect(await countLeadsByEmailMarker()).toBe(before);
  });

  it('e. body WITHOUT consent → 400 (the client-side checkbox is not the gate)', async () => {
    const { consent: _k, ...withoutConsent } = validBody;
    const res = await api.post('/api/public/v1/leads', withoutConsent);
    expect(res.status).toBe(400);
  });

  it('f. has_consent SURVIVES a partial clinical PATCH and only changes explicitly', async () => {
    const leadId = insertedIds[0];
    expect(leadId).toBeDefined();

    // Partial PATCH without hasConsent → legal record preserved (COALESCE).
    const patch = await api.patch(
      `/api/admin/patients/${leadId}/clinical`,
      { diagnosis: 'e2e — partial clinical edit' },
      { headers: { Authorization: `Bearer ${staffToken}` } },
    );
    expect(patch.status).toBe(200);

    const afterPartial = await pool.query(
      `SELECT has_consent AS "hasConsent" FROM patients WHERE id = $1`,
      [leadId],
    );
    expect(afterPartial.rows[0].hasConsent).toBe(true);

    // Explicit false still writes false (clearing consent is an explicit act).
    const patchFalse = await api.patch(
      `/api/admin/patients/${leadId}/clinical`,
      { hasConsent: false },
      { headers: { Authorization: `Bearer ${staffToken}` } },
    );
    expect(patchFalse.status).toBe(200);

    const afterExplicit = await pool.query(
      `SELECT has_consent AS "hasConsent" FROM patients WHERE id = $1`,
      [leadId],
    );
    expect(afterExplicit.rows[0].hasConsent).toBe(false);
  });
});
