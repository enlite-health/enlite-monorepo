/**
 * conversation-names-from-server.integration.e2e.ts @integration — change
 * 022-ux-mencao-e-notificacao, item 5a (Fase 2, `fase-2.md`).
 *
 * Prova que `authorDisplayName`/`mentionDisplayNames` (JOIN no servidor, Fase 1) chegam à UI sem
 * depender de o LEITOR já ter buscado o uid no autocomplete de menção nesta sessão de navegador
 * (achado de prd, F19/F20 de `fatos-medidos.md`) — `staffNameCache` vira só fallback.
 *
 * Feliz: autor e menção aparecem com NOME, nunca uid cru, para quem os leu normalmente.
 * Alternativo: um SEGUNDO leitor, numa aba/contexto que NUNCA abriu o autocomplete de menção
 *   nesta sessão (cache de navegador vazio), ainda vê o nome correto — vindo do servidor, não do
 *   cache local.
 *
 * Stack: mesma família de `patient-conversation-happy.integration.e2e.ts`.
 * Sem PII/texto clínico: paciente "Paciente QA", staff "QA Staff Autora"/"QA Staff Mencionado".
 */
import { test, expect } from '@playwright/test';
import {
  seedPatientQA, cleanupPatientQA, seedPlainStaff, cleanupPlainStaff,
  seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, tokenFor, psql,
  ABAC_API_URL,
  type MockUser,
} from '../helpers/patient-conversation-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const AUTORA_UID = `e2e-names-autora-${RUN_ID}`;
const AUTORA_EMAIL = `${AUTORA_UID}@e2e.test`;
const MENCIONADO_UID = `e2e-names-mencionado-${RUN_ID}`;
const MENCIONADO_EMAIL = `${MENCIONADO_UID}@e2e.test`;
const LEITORA_UID = `e2e-names-leitora-${RUN_ID}`;
const LEITORA_EMAIL = `${LEITORA_UID}@e2e.test`;
const GRUPO_AUTORA = `E2E Names Autora ${RUN_ID}`;
const GRUPO_LEITORA = `E2E Names Leitora ${RUN_ID}`;

let patientId = '';
let groupIdAutora = '';
let groupIdLeitora = '';

const AUTORA: MockUser = { uid: AUTORA_UID, email: AUTORA_EMAIL, role: 'recruiter', country: 'AR' };
const LEITORA: MockUser = { uid: LEITORA_UID, email: LEITORA_EMAIL, role: 'recruiter', country: 'AR' };

test.describe('Nomes de autor/menção vêm do SERVIDOR — sem depender do cache do navegador (item 5a) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  test.beforeAll(() => {
    patientId = seedPatientQA();
    const seededAutora = seedStaffInGroup({ uid: AUTORA_UID, email: AUTORA_EMAIL, groupName: GRUPO_AUTORA, country: 'AR' });
    groupIdAutora = seededAutora.groupId;
    psql(`UPDATE users SET display_name = 'QA Staff Autora' WHERE firebase_uid = '${AUTORA_UID}'`);
    grantCell(groupIdAutora, 'patient', 'read');
    grantCell(groupIdAutora, 'patient_conversation', 'read');
    grantCell(groupIdAutora, 'patient_conversation', 'create');

    seedPlainStaff(MENCIONADO_UID, MENCIONADO_EMAIL, 'QA Staff Mencionado');

    const seededLeitora = seedStaffInGroup({ uid: LEITORA_UID, email: LEITORA_EMAIL, groupName: GRUPO_LEITORA, country: 'AR' });
    groupIdLeitora = seededLeitora.groupId;
    grantCell(groupIdLeitora, 'patient', 'read');
    grantCell(groupIdLeitora, 'patient_conversation', 'read');
    // SEM `staff_directory:read` de propósito — a leitora nunca poderia abrir o autocomplete
    // mesmo se tentasse, então o cache dela NUNCA pode ter sido populado por essa via.
  });

  test.afterAll(() => {
    cleanupStaffAndGroup(AUTORA_UID, groupIdAutora);
    cleanupPlainStaff(MENCIONADO_UID);
    cleanupStaffAndGroup(LEITORA_UID, groupIdLeitora);
    cleanupPatientQA(patientId);
  });

  test('feliz: autor e menção aparecem com nome, montado direto do servidor', async ({ page, request }) => {
    const res = await request.post(`${ABAC_API_URL}/api/admin/patients/${patientId}/conversation/messages`, {
      headers: { Authorization: `Bearer ${tokenFor(AUTORA)}` },
      data: { body: `msg-1 nomes <@${MENCIONADO_UID}>` },
    });
    expect(res.ok()).toBe(true);

    await loginAs(page, LEITORA);
    await page.goto(`/admin/patients/${patientId}`);
    await page.getByTestId('patient-conversation-handle-btn').click();

    const messageCard = page.locator('[data-testid^="conversation-message-"]').first();
    await expect(messageCard).toBeVisible({ timeout: 10_000 });
    await expect(messageCard.getByTestId('message-author')).toHaveText('QA Staff Autora');
    await expect(messageCard.getByTestId('mention-chip')).toHaveText('@QA Staff Mencionado');
    // nunca o uid cru em lugar nenhum do card.
    await expect(messageCard).not.toContainText(AUTORA_UID);
    await expect(messageCard).not.toContainText(MENCIONADO_UID);
  });

  test('alternativo — leitora NUNCA abriu o autocomplete nesta sessão (cache de navegador vazio): nome ainda vem certo, do servidor', async ({ browser }) => {
    // Contexto NOVO — zustand/staffNameCache é estado em memória do processo do navegador; um
    // contexto novo garante 0% de chance de reaproveitar cache de outro teste desta suíte.
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await loginAs(page, LEITORA);
      await page.goto(`/admin/patients/${patientId}`);
      await page.getByTestId('patient-conversation-handle-btn').click();

      // Confirma que o cache está mesmo vazio: NUNCA clicamos no editor nem digitamos "@" antes
      // desta asserção — só abrimos o painel e lemos.
      const messageCard = page.locator('[data-testid^="conversation-message-"]').first();
      await expect(messageCard).toBeVisible({ timeout: 10_000 });
      await expect(messageCard.getByTestId('message-author')).toHaveText('QA Staff Autora');
      await expect(messageCard.getByTestId('mention-chip')).toHaveText('@QA Staff Mencionado');
    } finally {
      await context.close();
    }
  });
});
