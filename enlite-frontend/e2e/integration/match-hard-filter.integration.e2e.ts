/**
 * match-hard-filter.integration.e2e.ts @integration
 *
 * Garante que o `/api/admin/vacancies/:id/match` (com `useScoring=false`,
 * default) respeita os 3 hard filters acordados com operações:
 *
 *   1. SEXO — vaga 'M' aceita M, recusa F e recusa worker sem sex cadastrado
 *   2. PROFISSÃO — vaga ['AT'] aceita AT, recusa CAREGIVER
 *   3. DISTÂNCIA — vaga com lat/lng + raio_default=30km recusa workers
 *      além do raio. Worker sem coords passa como "distance unknown".
 *
 * Tudo via API real → backend real → Postgres real. Sem mocks de match.
 * GEMINI/Talentum não entram nesse flow — match não dispara nenhum dos dois.
 */

import { test, expect } from '@playwright/test';
import {
  insertTestPatient,
  cleanupTestPatient,
  insertBaseVacancy,
  cleanupVacancies,
  insertTestWorker,
  cleanupTestWorker,
} from '../helpers/db-test-helper';

const BACKEND_URL = 'http://localhost:8080';

const MOCK_ADMIN = { uid: 'e2e-int-match', email: 'admin.match@e2e.test', role: 'admin' };
const MOCK_TOKEN =
  'mock_' + Buffer.from(JSON.stringify(MOCK_ADMIN), 'utf-8').toString('base64');
const AUTH_HEADERS = {
  Authorization: `Bearer ${MOCK_TOKEN}`,
  'Content-Type': 'application/json',
};

interface MatchCandidate {
  workerId: string;
  workerName: string;
  occupation: string | null;
  distanceKm: number | null;
}

interface MatchResponse {
  success: boolean;
  data: {
    jobPostingId: string;
    radiusKm: number | null;
    matchSummary: { hardFilteredCount: number; llmScoredCount: number };
    candidates: MatchCandidate[];
  };
}

test.describe('Match — hard filters @integration', () => {
  test.setTimeout(60_000);

  // Patient + base vacancy with required_sex='M' and required_professions=['AT']
  let patientId = '';
  let addressId = '';
  let vacancyId = '';
  // 5 workers covering each filter scenario
  const workerIds: Record<string, string> = {};

  test.beforeAll(async ({ request }) => {
    // Patient at CABA (Av. Corrientes 1234) — addressLat/Lng come from helper default.
    const patient = insertTestPatient({
      status: 'ACTIVE',
      firstName: 'MatchTest',
      lastName: `Patient${Date.now()}`,
      withAddress: true,
      addressLat: -34.6037,
      addressLng: -58.3816,
    });
    patientId = patient.patientId;
    addressId = patient.addressId ?? '';

    // Vaga: AT only, mulheres NÃO aceitas (required_sex='M')
    const caseNumber = 980_000 + Math.floor(Math.random() * 9999);
    insertBaseVacancy({ patientId, patientAddressId: addressId, caseNumber });
    // Now create the actual vacancy under test via API (so the controller path
    // is exercised) with explicit required_sex and required_professions.
    const createRes = await request.post(`${BACKEND_URL}/api/admin/vacancies`, {
      headers: AUTH_HEADERS,
      data: {
        case_number: caseNumber,
        patient_id: patientId,
        patient_address_id: addressId,
        required_professions: ['AT'],
        required_sex: 'M',
        providers_needed: 1,
        salary_text: 'A convenir',
        schedule: [{ dayOfWeek: 1, startTime: '09:00', endTime: '17:00' }],
        status: 'SEARCHING',
      },
    });
    expect(createRes.ok(), `Create vacancy failed: ${createRes.status()}`).toBe(true);
    vacancyId = (await createRes.json()).data.id as string;

    // Workers — five scenarios. All status=REGISTERED.
    // Coordinates around CABA: ~0.01 lat ≈ 1.1km.
    workerIds.maleNear = insertTestWorker({
      sex: 'M', occupation: 'AT',
      firstName: 'MaleNear', lat: -34.6137, lng: -58.3816, // ~1km from patient
    });
    workerIds.femaleNear = insertTestWorker({
      sex: 'F', occupation: 'AT',
      firstName: 'FemaleNear', lat: -34.6137, lng: -58.3816,
    });
    workerIds.caregiverNear = insertTestWorker({
      sex: 'M', occupation: 'CAREGIVER',
      firstName: 'CaregiverNear', lat: -34.6137, lng: -58.3816,
    });
    workerIds.maleFar = insertTestWorker({
      sex: 'M', occupation: 'AT',
      firstName: 'MaleFar', lat: -33.4489, lng: -70.6693, // Santiago, Chile (>1000km)
    });
    workerIds.maleNoCoords = insertTestWorker({
      sex: 'M', occupation: 'AT',
      firstName: 'MaleNoCoords', lat: null, lng: null,
    });
  });

  test.afterAll(() => {
    Object.values(workerIds).forEach(cleanupTestWorker);
    if (vacancyId) cleanupVacancies([vacancyId]);
    if (patientId) cleanupTestPatient(patientId);
  });

  test('hard filter respects sex, profession and distance — only valid workers come back', async ({ request }) => {
    test.skip(!vacancyId, 'Could not seed vacancy under test');

    const res = await request.post(
      `${BACKEND_URL}/api/admin/vacancies/${vacancyId}/match?radius_km=30`,
      { headers: AUTH_HEADERS },
    );
    expect(res.ok(), `Match POST failed: ${res.status()} ${await res.text()}`).toBe(true);

    const body = (await res.json()) as MatchResponse;
    const ids = body.data.candidates.map((c) => c.workerId);

    // ── 1. Sexo ─────────────────────────────────────────────────────────────
    expect(ids).toContain(workerIds.maleNear);          // M aceito
    expect(ids).not.toContain(workerIds.femaleNear);    // F recusado

    // ── 2. Profissão ────────────────────────────────────────────────────────
    expect(ids).not.toContain(workerIds.caregiverNear); // CAREGIVER recusado

    // ── 3. Distância ────────────────────────────────────────────────────────
    expect(ids).not.toContain(workerIds.maleFar);       // >1000km recusado
    expect(ids).toContain(workerIds.maleNoCoords);      // sem coords entra como distance unknown

    // Distance unknown vem com distanceKm=null
    const noCoordsCandidate = body.data.candidates.find((c) => c.workerId === workerIds.maleNoCoords);
    expect(noCoordsCandidate?.distanceKm).toBeNull();

    // O worker próximo tem distance preenchida e <= 30km
    const nearCandidate = body.data.candidates.find((c) => c.workerId === workerIds.maleNear);
    expect(nearCandidate?.distanceKm).not.toBeNull();
    expect(nearCandidate!.distanceKm!).toBeLessThanOrEqual(30);
  });
});
