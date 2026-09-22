/**
 * presence-heartbeat-immediate.integration.e2e.ts @integration — Rodada 2 (22/09/2026), decisão B
 * do Gabriel: "sessão ativa em QUALQUER LUGAR do app manda heartbeat a cada ~60s", com disparo
 * IMEDIATO ao montar/logar (`immediate: true` em `usePresenceHeartbeat`, montado agora em
 * `AdminProtectedRoute` — não mais só dentro do `AdminLayout`).
 *
 * Este spec prova o `immediate`: abre uma página do painel que NÃO é a ficha do paciente (a lista
 * de pacientes) e espera o `POST /api/admin/me/presence` chegar bem ANTES do 1º intervalo de 60s
 * — sem mock, servidor real, Postgres real. Se `usePresenceHeartbeat` perder o `immediate: true`
 * (regressão para o comportamento antigo, "só depois do 1º intervalo"), este teste estoura o
 * timeout de espera e falha.
 *
 * Stack: mesma família de `mention-autocomplete-min-zero.integration.e2e.ts`/
 * `mention-popup-clickup.integration.e2e.ts` (ver docblock deles para portas/env desta sessão).
 *
 * Sem PII/texto clínico: staff "QA Staff Presence Immediate".
 */
import { test, expect } from '@playwright/test';
import {
  seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, ABAC_API_URL,
  type MockUser,
} from '../helpers/patient-conversation-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const UID = `e2e-presence-immediate-${RUN_ID}`;
const EMAIL = `${UID}@e2e.test`;
const GRUPO = `E2E Presence Immediate ${RUN_ID}`;

let groupId = '';
const STAFF: MockUser = { uid: UID, email: EMAIL, role: 'recruiter', country: 'AR' };

test.describe('Heartbeat de presença dispara IMEDIATAMENTE ao abrir QUALQUER página do painel (Rodada 2, decisão B) @integration', () => {
  test.setTimeout(60_000);

  test.beforeAll(() => {
    const seeded = seedStaffInGroup({ uid: UID, email: EMAIL, groupName: GRUPO, country: 'AR' });
    groupId = seeded.groupId;
    grantCell(groupId, 'own_presence', 'update');
  });

  test.afterAll(() => {
    cleanupStaffAndGroup(UID, groupId);
  });

  test('lista de pacientes (NÃO a ficha): POST /api/admin/me/presence chega em bem menos de 60s', async ({ page }) => {
    // A espera de rede começa ANTES do goto — o heartbeat imediato pode disparar assim que
    // `AdminProtectedRoute` monta, durante o próprio carregamento da página.
    const heartbeatReq = page.waitForRequest(
      (req) => req.url().includes('/api/admin/me/presence') && req.method() === 'POST',
      // 10s — MUITO abaixo dos 60s do intervalo normal. Se `immediate: true` regredir, o único
      // heartbeat da sessão só chegaria aos 60s e este `waitForRequest` estoura antes disso.
      { timeout: 10_000 },
    );

    await loginAs(page, STAFF);
    await page.goto('/admin/patients');

    const req = await heartbeatReq;
    expect(req.url()).toContain(`${new URL(ABAC_API_URL).host}`);

    const res = await req.response();
    expect(res?.status()).toBe(204);
  });
});
