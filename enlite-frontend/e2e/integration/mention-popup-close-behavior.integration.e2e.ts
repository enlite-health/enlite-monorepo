/**
 * mention-popup-close-behavior.integration.e2e.ts @integration — D1 (achado do Gabriel, 22/09):
 * com o popup de @ aberto, Esc não fechava e clicar fora não fechava.
 *
 * Causa medida (ver docblock de `createMentionSuggestion.ts`):
 *   1. Clicar fora não fechava — `render()` nunca chamava `props.mount()`, e o
 *      `dismissOnOutsideClick` (default `true` da lib `@tiptap/suggestion`) só existe DENTRO dele.
 *   2. Esc fechava o POPUP (o `Suggestion` plugin já despacha o `exit`), mas o `keydown` nativo
 *      nunca tinha `stopPropagation()` — só `preventDefault()` (do ProseMirror). O evento
 *      continuava borbulhando até `document`, onde o `SlideOverPanel` que embrulha este composer
 *      em produção (`PatientConversationHandle.tsx`) tem seu PRÓPRIO listener de Escape — com o
 *      rascunho não vazio (o `@` digitado conta), isso interceptava o fechamento em vez de só
 *      fechar o autocomplete.
 *
 * Este spec prova os DOIS, contra a stack real (Postgres + backend, sem mock) e o `SlideOverPanel`
 * DE VERDADE (não um listener simulado, como no unit test de `MessageComposer.test.tsx`) — é a
 * única camada que vê o vão entre "o popup fechou" e "o painel também fechou junto".
 *
 * Stack: mesma família de `patient-conversation-happy.integration.e2e.ts` (ver o docblock dele
 * para portas/env desta sessão).
 *
 * Sem PII/texto clínico: paciente "Paciente QA", staff "QA Staff Um", corpo "@qa".
 */
import { test, expect } from '@playwright/test';
import {
  seedPatientQA, cleanupPatientQA, seedMentionableStaff,
  seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs,
  type MockUser,
} from '../helpers/patient-conversation-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const AUTORA_UID = `e2e-d1-autora-${RUN_ID}`;
const AUTORA_EMAIL = `${AUTORA_UID}@e2e.test`;
const GRUPO = `E2E D1 Close ${RUN_ID}`;
const MENCIONAVEL_UID = `e2e-d1-mencionavel-${RUN_ID}`;
const MENCIONAVEL_EMAIL = `${MENCIONAVEL_UID}@e2e.test`;

let patientId = '';
let groupId = '';
let groupIdMencionavel = '';

const AUTORA: MockUser = { uid: AUTORA_UID, email: AUTORA_EMAIL, role: 'recruiter', country: 'AR' };

async function openComposer(page: import('@playwright/test').Page): Promise<import('@playwright/test').Locator> {
  await page.goto(`/admin/patients/${patientId}`);
  const handleBtn = page.getByTestId('patient-conversation-handle-btn');
  await expect(handleBtn).toBeVisible({ timeout: 15_000 });
  await handleBtn.click();
  const panel = page.getByTestId('patient-conversation-panel');
  await expect(panel).toHaveClass(/translate-x-0/);
  return panel;
}

test.describe('Popup de @ — Esc e clicar fora fecham só o popup, nunca o painel (D1) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  test.beforeAll(() => {
    patientId = seedPatientQA();
    const seeded = seedStaffInGroup({ uid: AUTORA_UID, email: AUTORA_EMAIL, groupName: GRUPO, country: 'AR' });
    groupId = seeded.groupId;
    grantCell(groupId, 'patient', 'read');
    grantCell(groupId, 'patient_conversation', 'read');
    grantCell(groupId, 'patient_conversation', 'create');
    grantCell(groupId, 'staff_directory', 'read');
    groupIdMencionavel = seedMentionableStaff(MENCIONAVEL_UID, MENCIONAVEL_EMAIL, 'QA Staff Um').groupId;
  });

  test.afterAll(() => {
    cleanupStaffAndGroup(AUTORA_UID, groupId);
    cleanupStaffAndGroup(MENCIONAVEL_UID, groupIdMencionavel);
    cleanupPatientQA(patientId);
  });

  test('Esc fecha o popup, mantém o texto digitado, e NÃO fecha o painel/drawer da conversa', async ({ page }) => {
    await loginAs(page, AUTORA);
    const panel = await openComposer(page);

    const editor = page.getByTestId('composer-editor');
    await editor.click();
    await page.keyboard.type('@qa');

    const list = page.getByTestId('composer-mention-list');
    await expect(list).toBeVisible({ timeout: 10_000 });

    await page.keyboard.press('Escape');

    // 1) o popup fecha
    await expect(list).not.toBeVisible();
    // 2) o texto digitado permanece — Esc não apaga o rascunho nem envia
    await expect(editor).toHaveText('@qa');
    // 3) o painel/drawer da conversa continua ABERTO — o mesmo Esc não deve borbulhar até o
    // `SlideOverPanel` e disparar o fechamento (ou a confirmação de descarte) dele.
    await expect(panel).toHaveClass(/translate-x-0/);
    await expect(page.getByTestId('composer-discard-confirm')).not.toBeVisible();

    // digitar mais uma letra na MESMA posição não deve reabrir a mesma sugestão (dismissedRange
    // nativo do `Suggestion` plugin do TipTap) — mas um `@` NOVO deve abrir de novo.
    await page.keyboard.type('x');
    await expect(list).not.toBeVisible();
    await page.keyboard.type(' @qa');
    await expect(list).toBeVisible({ timeout: 10_000 });
  });

  test('clicar fora do popup e do editor fecha o popup (sem apagar o rascunho); clicar num item continua selecionando', async ({ page }) => {
    await loginAs(page, AUTORA);
    await openComposer(page);

    const editor = page.getByTestId('composer-editor');
    await editor.click();
    await page.keyboard.type('@qa');

    const list = page.getByTestId('composer-mention-list');
    await expect(list).toBeVisible({ timeout: 10_000 });

    // "fora" real: o cabeçalho do painel (fora do popup E fora do editor).
    await page.getByTestId('conversation-panel-header').click();

    await expect(list).not.toBeVisible();
    await expect(editor).toHaveText('@qa');

    // reabre (um `@` NOVO — o anterior ficou fechado no texto) e prova que clicar NUM ITEM
    // continua selecionando — o outside-click novo (`mount()`) não pode regredir o clique de
    // seleção normal.
    await editor.click();
    await page.keyboard.type(' @qa');
    const mentionItem = page.getByTestId(`composer-mention-item-${MENCIONAVEL_UID}`);
    await expect(mentionItem).toBeVisible({ timeout: 10_000 });
    await mentionItem.click();
    await expect(page.getByTestId('composer-mention-chip')).toContainText('QA Staff Um');
  });
});
