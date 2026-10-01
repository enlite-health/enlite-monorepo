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
 * 🔒 2º teste (gate r2, achado da sonda): o teste acima faz `loginAs` e NAVEGA para a 1ª página —
 * `AdminProtectedRoute` monta pela 1ª vez já com o próprio fluxo de login "aquecendo" o
 * `adminAuthStore`, e NÃO reproduz o caminho real do defeito. O caminho real é RELOAD (F5) de uma
 * rota `/admin/*` JÁ autenticada: nesse boot a frio, `usePolling`'s efeito de MONTE (que dispara o
 * `immediate`) roda ANTES do `adminAuthStore` resolver `isAuthenticated`/`adminProfile` (Firebase
 * restaura a sessão de forma assíncrona) — `enabled=false` fica congelado no closure daquele
 * efeito (deps `[ms, pauseWhenHidden, immediate]` não incluem `enabled`) e, sem o conserto em
 * `usePresenceHeartbeat` (efeito próprio que observa a transição `false→true`), o próximo
 * heartbeat só sairia aos 60s. PROVADO empiricamente (22/09): o 1º teste deste arquivo PASSA
 * mesmo servindo a versão SEM o conserto — só este 2º teste, com F5 de verdade, é RED sem o
 * conserto e GREEN com ele.
 *
 * Stack: mesma família de `mention-autocomplete-min-zero.integration.e2e.ts`/
 * `mention-popup-clickup.integration.e2e.ts` (ver docblock deles para portas/env desta sessão).
 *
 * Sem PII/texto clínico: staff "QA Staff Presence Immediate"/"QA Staff Presence Reload".
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

const RELOAD_UID = `e2e-presence-reload-${RUN_ID}`;
const RELOAD_EMAIL = `${RELOAD_UID}@e2e.test`;
const RELOAD_GRUPO = `E2E Presence Reload ${RUN_ID}`;
let reloadGroupId = '';
const RELOAD_STAFF: MockUser = { uid: RELOAD_UID, email: RELOAD_EMAIL, role: 'recruiter', country: 'AR' };

test.describe('Heartbeat de presença — RELOAD (F5) de rota já autenticada (gate r2, caminho REAL do defeito) @integration', () => {
  test.setTimeout(60_000);

  test.beforeAll(() => {
    const seeded = seedStaffInGroup({ uid: RELOAD_UID, email: RELOAD_EMAIL, groupName: RELOAD_GRUPO, country: 'AR' });
    reloadGroupId = seeded.groupId;
    grantCell(reloadGroupId, 'own_presence', 'update');
  });

  test.afterAll(() => {
    cleanupStaffAndGroup(RELOAD_UID, reloadGroupId);
  });

  test('🔒 F5 numa rota /admin/* já logada: novo heartbeat chega em poucos segundos, sem esperar os 60s', async ({ page }) => {
    // 1. Login humano + navega para uma página do painel — sessão fica "quente" (adminAuthStore
    //    já resolvido, cookies/IndexedDB do Firebase persistidos). Não é este passo que o defeito
    //    mede (o teste-irmão acima já prova o `immediate` no 1º mount).
    await loginAs(page, RELOAD_STAFF);
    await page.goto('/admin/patients');
    await expect(page.getByTestId('admin-authz-loading')).toHaveCount(0, { timeout: 15_000 });

    // 2. RELOAD de verdade (F5): o JS do app reinicia do zero NESTA aba — `adminAuthStore` nasce
    //    de novo com `adminProfile: null`/`isLoading: true` (ver `adminAuthStore.ts`, estado
    //    inicial do `create()`) até o Firebase restaurar a sessão de forma assíncrona. É este
    //    boot a frio, em cima de uma rota já autenticada, que reproduz o achado da sonda do gate
    //    (0 chamadas 2s depois de `enabled` virar `true`; 1 aos 61s).
    const heartbeatAfterReload = page.waitForRequest(
      (req) => req.url().includes('/api/admin/me/presence') && req.method() === 'POST',
      // Bem abaixo dos 60s do intervalo normal — é exatamente essa distância que a sonda mediu.
      { timeout: 15_000 },
    );
    const reloadStartedAt = Date.now();
    await page.reload();

    const req = await heartbeatAfterReload;
    const elapsedMs = Date.now() - reloadStartedAt;
    // Medido pela própria requisição de rede (sem mock), não por presunção de tempo: bem abaixo
    // do intervalo de 60s do polling normal — se o conserto regredir, este `waitForRequest`
    // estoura o timeout de 15s bem antes de qualquer heartbeat chegar.
    expect(elapsedMs).toBeLessThan(15_000);

    const res = await req.response();
    expect(res?.status()).toBe(204);
  });
});
