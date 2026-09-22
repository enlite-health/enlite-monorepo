/**
 * mention-popup-patient-access.integration.e2e.ts @integration — change 022-ux-mencao-e-notificacao,
 * Rodada 3/R3-F (item 1 + item 2).
 *
 * Contrato novo do backend (R3-1, `docs/.../tasks.md` "Rodada 3"): `GET
 * /api/admin/staff-directory?patientId=<uuid>` filtra a lista a quem tem acesso à conversa
 * DAQUELE paciente (célula `patient_conversation:read` + país do grupo). Este spec prova, contra a
 * stack real (Postgres + engine ABAC ligado, sem mock), que o POPUP DE @ do chat manda esse
 * `patientId` — não só que o endpoint filtra (isso já é provado pelo e2e de API do backend,
 * `adminStaffDirectoryPatientAccess.e2e.test.ts`, 9 casos).
 *
 * Feliz: staff com a célula `patient_conversation:read` (mesmo país do paciente) aparece no popup.
 * Alternativo 1: staff SEM nenhuma célula aparece no diretório SEM `patientId` (prova por chamada
 *   direta à API, mesmo token) mas NUNCA no popup do chat (que sempre manda `patientId`) — a prova
 *   de que o filtro está de fato chegando ao servidor, não só existindo nele.
 * Alternativo 2: ninguém além da autora é elegível (candidato com acesso tem a célula revogada na
 *   hora) — o popup mostra a linha de estado vazio (item 2), nunca a lista nem o erro.
 *
 * Stack: mesma família de `mention-autocomplete-min-zero.integration.e2e.ts` (ver o docblock dele
 * para portas/env desta sessão).
 *
 * Sem PII/texto clínico: paciente "Paciente QA", staff "QA Staff <N>".
 */
import { test, expect } from '@playwright/test';
import {
  seedPatientQA, cleanupPatientQA, seedPlainStaff, cleanupPlainStaff,
  seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, tokenFor,
  type MockUser,
} from '../helpers/patient-conversation-helper';
import { ABAC_API_URL, revokeCell } from '../helpers/abac-stack-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const AUTORA_UID = `e2e-r3f-autora-${RUN_ID}`;
const AUTORA_EMAIL = `${AUTORA_UID}@e2e.test`;
const GRUPO_AUTORA = `E2E R3F Autora ${RUN_ID}`;
const COM_ACESSO_UID = `e2e-r3f-com-acesso-${RUN_ID}`;
const COM_ACESSO_EMAIL = `${COM_ACESSO_UID}@e2e.test`;
const GRUPO_COM_ACESSO = `E2E R3F Com Acesso ${RUN_ID}`;
const SEM_CELULA_UID = `e2e-r3f-sem-celula-${RUN_ID}`;
const SEM_CELULA_EMAIL = `${SEM_CELULA_UID}@e2e.test`;

let patientId = '';
let groupIdAutora = '';
let groupIdComAcesso = '';

const AUTORA: MockUser = { uid: AUTORA_UID, email: AUTORA_EMAIL, role: 'recruiter', country: 'AR' };

async function openComposer(page: import('@playwright/test').Page): Promise<void> {
  await page.goto(`/admin/patients/${patientId}`);
  const handleBtn = page.getByTestId('patient-conversation-handle-btn');
  await expect(handleBtn).toBeVisible({ timeout: 15_000 });
  await handleBtn.click();
  const panel = page.getByTestId('patient-conversation-panel');
  await expect(panel).toHaveClass(/translate-x-0/);
}

test.describe('Popup de @ filtrado por patientId (Rodada 3/R3-F, item 1) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  test.beforeAll(() => {
    patientId = seedPatientQA(); // país AR, hardcoded no helper
    const seededAutora = seedStaffInGroup({ uid: AUTORA_UID, email: AUTORA_EMAIL, groupName: GRUPO_AUTORA, country: 'AR' });
    groupIdAutora = seededAutora.groupId;
    grantCell(groupIdAutora, 'patient', 'read');
    grantCell(groupIdAutora, 'patient_conversation', 'read');
    grantCell(groupIdAutora, 'patient_conversation', 'create');
    grantCell(groupIdAutora, 'staff_directory', 'read');

    const seededComAcesso = seedStaffInGroup({ uid: COM_ACESSO_UID, email: COM_ACESSO_EMAIL, groupName: GRUPO_COM_ACESSO, country: 'AR' });
    groupIdComAcesso = seededComAcesso.groupId;
    grantCell(groupIdComAcesso, 'patient_conversation', 'read');

    // Staff ATIVO, sem grupo — aparece no diretório de staff em geral (base query não filtra por
    // célula nenhuma), mas não tem `patient_conversation:read` nenhuma: candidato exato para provar
    // que o `patientId` exclui quem SEM a célula, mesmo que digitável no diretório cru.
    seedPlainStaff(SEM_CELULA_UID, SEM_CELULA_EMAIL, 'QA Staff Sem Acesso');
  });

  test.afterAll(() => {
    cleanupStaffAndGroup(AUTORA_UID, groupIdAutora);
    cleanupStaffAndGroup(COM_ACESSO_UID, groupIdComAcesso);
    cleanupPlainStaff(SEM_CELULA_UID);
    cleanupPatientQA(patientId);
  });

  test('feliz: staff com patient_conversation:read (mesmo país) aparece no popup de @', async ({ page }) => {
    await loginAs(page, AUTORA);
    await openComposer(page);

    const editor = page.getByTestId('composer-editor');
    await editor.click();
    await page.keyboard.type('@');

    const list = page.getByTestId('composer-mention-list');
    await expect(list).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId(`composer-mention-item-${COM_ACESSO_UID}`)).toBeVisible();

    await page.screenshot({
      path: '/Users/gabrielstein-dev/projects/enlite/ebrain/openspec/changes/022-ux-mencao-e-notificacao/evidencias/r3-popup-filtrado-por-paciente.png',
    });
  });

  test('alt 1: staff sem NENHUMA célula aparece no diretório cru (sem patientId), mas NUNCA no popup do chat (que sempre manda patientId)', async ({ page, request }) => {
    // Prova por API direta (mesmo token da autora): SEM patientId, o candidato "sem célula"
    // aparece — é exatamente o comportamento de ANTES da Rodada 3, preservado de propósito
    // (`patientId` ausente = comportamento atual, R3-1). Isto isola a causa: se o popup também
    // não o mostrasse aqui, a ausência dele na tela não provaria NADA sobre o `patientId`.
    const semFiltro = await request.get(`${ABAC_API_URL}/api/admin/staff-directory`, {
      headers: { Authorization: `Bearer ${tokenFor(AUTORA)}` },
    });
    expect(semFiltro.status()).toBe(200);
    const semFiltroBody = (await semFiltro.json()).data as Array<{ uid: string }>;
    expect(semFiltroBody.some((e) => e.uid === SEM_CELULA_UID)).toBe(true);

    // Com patientId (mesmo endpoint, chamada direta): o candidato some — prova o filtro no
    // servidor, isolada do front.
    const comFiltro = await request.get(`${ABAC_API_URL}/api/admin/staff-directory?patientId=${patientId}`, {
      headers: { Authorization: `Bearer ${tokenFor(AUTORA)}` },
    });
    expect(comFiltro.status()).toBe(200);
    const comFiltroBody = (await comFiltro.json()).data as Array<{ uid: string }>;
    expect(comFiltroBody.some((e) => e.uid === SEM_CELULA_UID)).toBe(false);

    // E agora a prova de PONTA A PONTA: o popup do chat REAL (que só sabe fazer a chamada COM
    // patientId, wiring desta rodada) nunca revela o candidato sem célula.
    await loginAs(page, AUTORA);
    await openComposer(page);

    const editor = page.getByTestId('composer-editor');
    await editor.click();
    await page.keyboard.type('@');

    const list = page.getByTestId('composer-mention-list');
    await expect(list).toBeVisible({ timeout: 10_000 });
    await expect(page.getByTestId(`composer-mention-item-${COM_ACESSO_UID}`)).toBeVisible();
    await expect(page.getByTestId(`composer-mention-item-${SEM_CELULA_UID}`)).not.toBeVisible();
  });

  test('alt 2: ninguém elegível (célula do único candidato revogada na hora) — popup mostra o estado vazio, nunca a lista nem o erro', async ({ page }) => {
    revokeCell(groupIdComAcesso, 'patient_conversation', 'read');
    try {
      await loginAs(page, AUTORA);
      await openComposer(page);

      const editor = page.getByTestId('composer-editor');
      await editor.click();
      await page.keyboard.type('@');

      const empty = page.getByTestId('composer-mention-empty');
      await expect(empty).toBeVisible({ timeout: 10_000 });
      await expect(empty).toHaveText(/Nadie más tiene acceso a esta conversación|Ninguém mais tem acesso a esta conversa/);
      await expect(page.getByTestId('composer-mention-list')).not.toBeVisible();
      await expect(page.getByTestId('composer-mention-error')).not.toBeVisible();

      await page.screenshot({
        path: '/Users/gabrielstein-dev/projects/enlite/ebrain/openspec/changes/022-ux-mencao-e-notificacao/evidencias/r3-popup-estado-vazio.png',
      });
    } finally {
      grantCell(groupIdComAcesso, 'patient_conversation', 'read');
    }
  });
});
