/**
 * mention-autocomplete-min-zero.integration.e2e.ts @integration — change
 * 022-ux-mencao-e-notificacao, item 1 (Fase 2, `fase-2.md`).
 *
 * Prova, contra a stack real (sem mock de rede): `MENTION_MIN_QUERY_LENGTH = 0` (revoga D-06) +
 * popup ancorado por `props.clientRect` (`mentionPopupPosition.ts`) + estado de erro do diretório
 * distinto de "sem resultado" (F5).
 *
 * Feliz: digitar só `@` já mostra a lista, sem exigir nenhum caractere; continuar digitando filtra.
 * Alternativo 1: diretório sem célula (`staff_directory:read` revogada) devolve 403 — o popup
 *   mostra o estado de erro (`composer-mention-error`), NUNCA a lista vazia.
 * Alternativo 2: o popup nasce dentro do viewport — a prova usa a posição REAL do compositor
 *   (`SlideOverPanel` é `fixed top-0 right-0`, o compositor fica no rodapé do painel — ou seja, o
 *   cursor já está perto do canto inferior direito da tela por DESIGN, sem precisar forçar um
 *   viewport artificial).
 *
 * Stack: mesma família de `patient-conversation-happy.integration.e2e.ts` (ver o docblock dele
 * para portas/env desta sessão).
 *
 * Sem PII/texto clínico: paciente "Paciente QA", staff "QA Staff Um"/"QA Staff Dois".
 */
import { test, expect } from '@playwright/test';
import {
  seedPatientQA, cleanupPatientQA, seedPlainStaff, cleanupPlainStaff,
  seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs,
  type MockUser,
} from '../helpers/patient-conversation-helper';
import { revokeCell } from '../helpers/abac-stack-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const AUTORA_UID = `e2e-ux-mention-${RUN_ID}`;
const AUTORA_EMAIL = `${AUTORA_UID}@e2e.test`;
const MENCIONADO_UID = `e2e-ux-mention-alvo-${RUN_ID}`;
const MENCIONADO_EMAIL = `${MENCIONADO_UID}@e2e.test`;
const GRUPO = `E2E UX Mention ${RUN_ID}`;

let patientId = '';
let groupId = '';

const AUTORA: MockUser = { uid: AUTORA_UID, email: AUTORA_EMAIL, role: 'recruiter', country: 'AR' };

async function openComposer(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(`/admin/patients/${patientId}`);
  const handleBtn = page.getByTestId('patient-conversation-handle-btn');
  await expect(handleBtn).toBeVisible({ timeout: 15_000 });
  await handleBtn.click();
  const panel = page.getByTestId('patient-conversation-panel');
  await expect(panel).toHaveClass(/translate-x-0/);
}

test.describe('Autocomplete de @ — min 0, popup ancorado, erro do diretório (item 1) @integration', () => {
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
    seedPlainStaff(MENCIONADO_UID, MENCIONADO_EMAIL, 'QA Staff Dois');
  });

  test.afterAll(() => {
    cleanupStaffAndGroup(AUTORA_UID, groupId);
    cleanupPlainStaff(MENCIONADO_UID);
    cleanupPatientQA(patientId);
  });

  test('feliz: digitar só @ (0 caracteres) já mostra a lista; continuar digitando filtra', async ({ page }) => {
    await loginAs(page, AUTORA);
    await openComposer(page);

    const editor = page.getByTestId('composer-editor');
    await editor.click();
    await page.keyboard.type('@');

    // min 0: a lista aparece SEM nenhum caractere depois do @.
    const list = page.getByTestId('composer-mention-list');
    await expect(list).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId(`composer-mention-item-${MENCIONADO_UID}`)).toBeVisible();

    // Evidência (brief): popup do @ ancorado no cursor, min 0 caracteres.
    await page.screenshot({
      path: '/Users/gabrielstein-dev/projects/enlite/ebrain/openspec/changes/022-ux-mencao-e-notificacao/evidencias/item1-popup-mencao-min-zero.png',
    });

    // continuar digitando FILTRA — só "QA Staff Dois" deve sobrar.
    await page.keyboard.type('Dois');
    await expect(page.getByTestId(`composer-mention-item-${MENCIONADO_UID}`)).toBeVisible({ timeout: 10_000 });
    await expect(list.locator('li')).toHaveCount(1);
  });

  test('alternativo 1 — diretório sem célula (403) mostra estado de erro, NUNCA lista vazia', async ({ page }) => {
    revokeCell(groupId, 'staff_directory', 'read');
    try {
      await loginAs(page, AUTORA);
      await openComposer(page);

      const editor = page.getByTestId('composer-editor');
      await editor.click();
      await page.keyboard.type('@');

      await expect(page.getByTestId('composer-mention-error')).toBeVisible({ timeout: 10_000 });
      await expect(page.getByTestId('composer-mention-list')).not.toBeVisible();
    } finally {
      grantCell(groupId, 'staff_directory', 'read');
    }
  });

  test('alternativo 2 — popup nasce DENTRO do viewport (compositor fica no rodapé direito da tela, por design do SlideOverPanel)', async ({ page }) => {
    await loginAs(page, AUTORA);
    await openComposer(page);

    const editor = page.getByTestId('composer-editor');
    await editor.click();
    await page.keyboard.type('@');

    const list = page.getByTestId('composer-mention-list');
    await expect(list).toBeVisible({ timeout: 10_000 });

    const box = await list.boundingBox();
    const viewport = page.viewportSize();
    expect(box).not.toBeNull();
    expect(viewport).not.toBeNull();
    // Nunca nasce fora da tela em NENHUM dos 4 lados — a prova real do clamp (F4/design.md §1).
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(viewport!.width + 1);
    expect(box!.y + box!.height).toBeLessThanOrEqual(viewport!.height + 1);
  });
});
