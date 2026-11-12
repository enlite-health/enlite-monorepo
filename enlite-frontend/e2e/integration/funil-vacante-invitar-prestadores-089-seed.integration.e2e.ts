/**
 * funil-vacante-invitar-prestadores-089-seed.integration.e2e.ts @integration
 *
 * Smoke da SEED da T042 (spec 089), SEM tela: prova pela API real (Postgres real) que o seed do canvas
 * (`invitar-prestadores-089-helper.ts`) produz o que a tela da T043 espera, e que o envio vai ao stub 9911.
 * Base da T043 (mesmo seed, mesmo stub, mesmo usuário).
 *
 *  (a) GET match-results?limit=0 da vacante A → `service` com lat/lng e `pendingInVacancyCount`;
 *  (b) POST match (50 km, top_n 500) + GET → 35 candidatos do canvas nas bandas do canvas;
 *  (c) POST vacancy-match para 1 worker → o stub recebe 1 `POST …/message/send` e `messaged_at` grava.
 *
 * Nenhum canal real: prestadores com `messaging_channel='periskope'` → `PERISKOPE_BASE_URL` (stack de teste) = stub 9911.
 */
import { test, expect } from '@playwright/test';
import { tokenFor, type MockUser } from '../helpers/abac-stack-helper';
import { seedMockStaff, cleanupMockStaff } from '../helpers/vacancy-notes-e2e-helper';
import {
  seedInvitar089,
  startPeriskopeStub,
  inviteViaApi,
  countMessagedAt,
  readMessagedAt,
  stubSendCount,
  stubRecipients,
  chatIdOfWorker,
  bandOf,
  BANDS,
  type Invitar089Seed,
  type PeriskopeStub,
} from '../helpers/invitar-prestadores-089-helper';

const BACKEND_URL = process.env.E2E_BACKEND_URL ?? 'http://localhost:8080';

const MOCK_STAFF: MockUser = {
  uid: 'e2e-int-staff-invitar-089',
  email: 'staff.invitar.089@e2e.test',
  role: 'admin',
  country: 'AR',
};

interface MatchResultsBody {
  data: {
    totalCandidates: number;
    invitedCount: number;
    pendingInVacancyCount: number;
    operationDate: string;
    service: { lat: number | null; lng: number | null; addressLabel: string | null };
    candidates: Array<{ workerId: string; workerName: string; distanceKm: number | null; lat: number | null; lng: number | null; documentStatus: string | null; messagedAt: string | null; source: string }>;
  };
}

test.describe('seed do canvas — Invitar prestadores (089 T042) @integration', () => {
  test.setTimeout(120_000);
  test.describe.configure({ mode: 'serial' });

  let stub: PeriskopeStub;
  let seed: Invitar089Seed;
  const headers = { Authorization: `Bearer ${tokenFor(MOCK_STAFF)}` };

  test.beforeAll(() => {
    seedMockStaff(MOCK_STAFF, 'E2E Invitar 089');
    stub = startPeriskopeStub();
    seed = seedInvitar089();
  });

  test.afterAll(() => {
    stub.server.close();
    seed.cleanup();
    cleanupMockStaff(MOCK_STAFF);
  });

  test('(a) GET limit=0: service com lat/lng e pendentes', async ({ request }) => {
    const res = await request.get(`${BACKEND_URL}/api/admin/vacancies/${seed.vacancyA.vacancyId}/match-results?limit=0`, { headers });
    expect(res.status()).toBe(200);
    const { data } = (await res.json()) as MatchResultsBody;
    console.log('[089 smoke a]', JSON.stringify({ service: data.service, pendingInVacancyCount: data.pendingInVacancyCount, invitedCount: data.invitedCount, totalCandidates: data.totalCandidates, operationDate: data.operationDate }));
    expect(data.service.lat).toBeCloseTo(seed.vacancyA.serviceLat, 4);
    expect(data.service.lng).toBeCloseTo(seed.vacancyA.serviceLng, 4);
    expect(data.service.addressLabel).toBe('Av. Santa Fe 3200, Palermo');
    expect(data.pendingInVacancyCount).toBe(seed.pending.length);
    expect(data.invitedCount).toBe(seed.preInvited.length);
  });

  test('(b) POST match 50 km + GET: 35 do canvas nas bandas certas', async ({ request }) => {
    const id = seed.vacancyA.vacancyId;
    const post = await request.post(`${BACKEND_URL}/api/admin/vacancies/${id}/match?radius_km=50&top_n=500`, { headers });
    expect(post.status()).toBe(200);
    const get = await request.get(`${BACKEND_URL}/api/admin/vacancies/${id}/match-results?limit=500`, { headers });
    expect(get.status()).toBe(200);
    const { data } = (await get.json()) as MatchResultsBody;

    const ours = new Map(seed.candidates.map((c) => [c.workerId, c]));
    const mine = data.candidates.filter((c) => ours.has(c.workerId));
    const perBand = [0, 0, 0, 0];
    for (const c of mine) {
      expect(c.distanceKm, `${c.workerName} sem distância`).not.toBeNull();
      const b = bandOf(c.distanceKm as number);
      expect(b, `${c.workerName} ${c.distanceKm} km fora das bandas`).toBeGreaterThanOrEqual(0);
      expect(b, `${c.workerName}: banda do servidor × do canvas`).toBe(ours.get(c.workerId)!.band);
      perBand[b] += 1;
      expect(c.lat).not.toBeNull();
      expect(c.lng).not.toBeNull();
    }
    const docsOk = mine.filter((c) => ours.get(c.workerId)!.docsComplete).length;
    console.log('[089 smoke b]', JSON.stringify({ total: data.totalCandidates, nossos: mine.length, bandas: Object.fromEntries(BANDS.map((b, i) => [`${b.min}-${b.max}`, perBand[i]])), docsCompletos: docsOk, invitedCount: data.invitedCount, pending: data.pendingInVacancyCount }));
    expect(mine.length).toBe(35);
    expect(perBand).toEqual([6, 9, 11, 9]);
    // Os 3 "ya en la vacante" continuam pendentes (match não os promove) e os 3 de 03/11 continuam "convidados".
    expect(data.pendingInVacancyCount).toBe(3);
    expect(data.invitedCount).toBe(3);
  });

  test('(c) convite de 1 worker: 1 POST no stub e messaged_at gravado', async ({ request }) => {
    const target = seed.candidates[0];
    const id = seed.vacancyA.vacancyId;
    const callsBefore = stub.calls.length;
    const messagedBefore = countMessagedAt(id);
    expect(readMessagedAt(target.workerId, id)).toBeNull();

    const res = await inviteViaApi(request, MOCK_STAFF, target.workerId, id);
    console.log('[089 smoke c] api', res.status, JSON.stringify(res.body).slice(0, 120));
    expect(res.status).toBe(200);

    expect(stubSendCount(stub, callsBefore)).toBe(1);
    expect(stub.calls[callsBefore].path).toMatch(/\/message\/send$/);
    expect(stubRecipients(stub, callsBefore)).toEqual([chatIdOfWorker(target.workerId)]);
    expect(readMessagedAt(target.workerId, id)).not.toBeNull();
    const messagedAfter = countMessagedAt(id);
    console.log('[089 smoke c]', JSON.stringify({ stubPosts: stubSendCount(stub, callsBefore), messagedAtAntes: messagedBefore, messagedAtDepois: messagedAfter, path: stub.calls[callsBefore].path }));
    expect(messagedAfter).toBe(messagedBefore + 1);
  });
});
