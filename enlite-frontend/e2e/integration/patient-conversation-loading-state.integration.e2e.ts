/**
 * patient-conversation-loading-state.integration.e2e.ts @integration — achado A7 do gate 21/09.
 *
 * O item 6 dos ajustes de UI (rodada 3) cobriu o estado de carregamento com teste de COMPONENTE
 * (`ConversationPanel.test.tsx`, promise controlada manualmente) e com PRINT
 * (`ui-ajustes-06-carregando.png`, `window.fetch` interceptado via `page.addInitScript` porque
 * `page.route()` com string literal não bateu de forma confiável no fetch do Vite dev server,
 * medido naquela sessão) — mas nunca virou e2e COMMITADO. Este arquivo fecha essa lacuna: atrasa
 * a resposta REAL da listagem (`GET .../conversation`) com `page.route` (predicado de função,
 * MESMO padrão de `patient-conversation-attachment-thumbnail-cors.integration.e2e.ts`, que já
 * provou bater nesta stack) e afirma spinner + texto "Cargando mensajes…" ANTES da resposta,
 * depois o conteúdo (estado vazio) depois dela.
 *
 * Sem PII/texto clínico: paciente "Paciente QA", staff "QA Staff Loading".
 */
import { test, expect } from '@playwright/test';
import {
  seedPatientQA, cleanupPatientQA, seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs,
  type MockUser,
} from '../helpers/patient-conversation-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const AUTORA_UID = `e2e-conv-loading-${RUN_ID}`;
const AUTORA_EMAIL = `${AUTORA_UID}@e2e.test`;
const GRUPO = `E2E Conv Loading ${RUN_ID}`;

/** `GET .../patients/:id/conversation[?...]` — nunca `.../conversation/messages/:id/replies`
 *  (essa rota tem sufixo depois de `conversation`, o `$`/`?` no fim barra o match). */
function isConversationListingRequest(url: string): boolean {
  return /\/conversation(\?[^/]*)?$/.test(url);
}

let patientId = '';
let groupId = '';

const AUTORA: MockUser = { uid: AUTORA_UID, email: AUTORA_EMAIL, role: 'recruiter', country: 'AR' };

test.describe('Chat interno — estado de carregamento sobrevive com resposta real atrasada (gate A7) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  test.beforeAll(() => {
    patientId = seedPatientQA();
    const seeded = seedStaffInGroup({ uid: AUTORA_UID, email: AUTORA_EMAIL, groupName: GRUPO, country: 'AR' });
    groupId = seeded.groupId;
    grantCell(groupId, 'patient', 'read');
    grantCell(groupId, 'patient_conversation', 'read');
  });

  test.afterAll(() => {
    cleanupStaffAndGroup(AUTORA_UID, groupId);
    cleanupPatientQA(patientId);
  });

  test('spinner + "Cargando mensajes…" aparecem ANTES da resposta real da listagem; conteúdo (vazio) aparece DEPOIS', async ({ page }) => {
    let interceptedAtLeastOnce = false;

    // Atrasa a resposta REAL (não um mock de UI solto) — `route.fetch()` busca a resposta de
    // verdade do backend e só a entrega ao browser depois do delay: os BYTES continuam reais,
    // só o TIMING muda, exatamente como uma rede lenta faria.
    await page.route((url) => isConversationListingRequest(url.toString()), async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      interceptedAtLeastOnce = true;
      const response = await route.fetch();
      await new Promise((resolve) => setTimeout(resolve, 800));
      await route.fulfill({ response });
    });

    await loginAs(page, AUTORA);
    await page.goto(`/admin/patients/${patientId}`);

    const handleBtn = page.getByTestId('patient-conversation-handle-btn');
    await expect(handleBtn).toBeVisible({ timeout: 15_000 });
    await handleBtn.click();

    const panel = page.getByTestId('patient-conversation-panel');
    await expect(panel).toBeVisible();

    // ── ANTES da resposta atrasada resolver: spinner visível, texto exato, role=status ──
    const loading = page.getByTestId('conversation-panel-loading');
    await expect(loading).toBeVisible();
    await expect(loading).toHaveAttribute('role', 'status');
    await expect(loading).toContainText('Cargando mensajes…');

    // ── DEPOIS: a resposta real chega (800ms), o spinner some e o conteúdo aparece (paciente
    // sem mensagem nenhuma → estado vazio, nunca um painel em branco) ──
    const empty = page.getByTestId('conversation-panel-empty');
    await expect(empty).toBeVisible({ timeout: 10_000 });
    await expect(loading).not.toBeVisible();

    expect(interceptedAtLeastOnce).toBe(true);
  });
});
