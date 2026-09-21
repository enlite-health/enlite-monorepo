/**
 * patient-conversation-no-cell.integration.e2e.ts @integration — spec 022, Bloco 2, T219.
 *
 * Alternativo 1: conta QA SEM `patient_conversation:*` não vê o handle na ficha, e a chamada
 * MANUAL à API dá 403. Cuidado do brief ("já mordeu 3 vezes nesta spec"): um 403 aqui pode ser
 * célula ausente (o que queremos provar) OU token sem `country` / catálogo não sincronizado /
 * rota não montada — indistinguíveis se só olharmos o lado negativo. Por isso o MESMO teste
 * também loga como a conta COM a célula (`grantCell`, `seedStaffInGroup` — molde de
 * `stack-e2e-abac-ligado`) e prova handle visível + 200 na mesma rota, no MESMO run.
 *
 * Stack: ver docblock de `patient-conversation-happy.integration.e2e.ts` (Postgres
 * `enlite-pg-022b2`:5442, API :8092, Vite :5173).
 */
import { test, expect } from '@playwright/test';
import {
  seedPatientQA, cleanupPatientQA,
  seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, tokenFor,
  ABAC_API_URL, type MockUser,
} from '../helpers/patient-conversation-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const SEM_CELULA_UID = `e2e-conv-semcelula-${RUN_ID}`;
const SEM_CELULA_EMAIL = `${SEM_CELULA_UID}@e2e.test`;
const COM_CELULA_UID = `e2e-conv-comcelula-${RUN_ID}`;
const COM_CELULA_EMAIL = `${COM_CELULA_UID}@e2e.test`;
const GRUPO_SEM = `E2E Conv SemCelula ${RUN_ID}`;
const GRUPO_COM = `E2E Conv ComCelula ${RUN_ID}`;

let patientId = '';
let groupSemId = '';
let groupComId = '';

const SEM_CELULA: MockUser = { uid: SEM_CELULA_UID, email: SEM_CELULA_EMAIL, role: 'recruiter', country: 'AR' };
const COM_CELULA: MockUser = { uid: COM_CELULA_UID, email: COM_CELULA_EMAIL, role: 'recruiter', country: 'AR' };

test.describe('Chat interno por paciente — sem célula (alternativo 1) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  test.beforeAll(() => {
    patientId = seedPatientQA();
    // A SEM_CELULA tem GRUPO (não é "0 grupos") com `patient:read` — carrega a FICHA normalmente
    // (`GET /patients/:id`, mesma família `admin.patients`) mas SEM nenhuma célula
    // `patient_conversation:*`. Isola o que este teste mede: o `ContainerGate` esconde o handle
    // por FALTA da célula específica (`missing_cell`), não porque a página inteira deu 403 (que
    // seria "0 grupos" → `no_group` — prova mais fraca, confunde "página bloqueada" com
    // "container bloqueado").
    const semSeeded = seedStaffInGroup({ uid: SEM_CELULA_UID, email: SEM_CELULA_EMAIL, groupName: GRUPO_SEM, country: 'AR' });
    groupSemId = semSeeded.groupId;
    grantCell(groupSemId, 'patient', 'read');

    const comSeeded = seedStaffInGroup({ uid: COM_CELULA_UID, email: COM_CELULA_EMAIL, groupName: GRUPO_COM, country: 'AR' });
    groupComId = comSeeded.groupId;
    grantCell(groupComId, 'patient', 'read');
    grantCell(groupComId, 'patient_conversation', 'read');
  });

  test.afterAll(() => {
    cleanupStaffAndGroup(SEM_CELULA_UID, groupSemId);
    cleanupStaffAndGroup(COM_CELULA_UID, groupComId);
    cleanupPatientQA(patientId);
  });

  test('1. sem célula de conversa (mas COM patient:read — página carrega): handle ausente na tela E 403 direto na API (missing_cell)', async ({ page, request }) => {
    await loginAs(page, SEM_CELULA);
    await page.goto(`/admin/patients/${patientId}`);

    // prova de que a página CARREGOU (não é o "Access denied" da ficha inteira mascarando o teste)
    await expect(page.getByRole('heading', { level: 3, name: 'Access denied' })).toHaveCount(0);
    await expect(page.getByTestId('patient-conversation-handle-btn')).toHaveCount(0);

    const res = await request.get(`${ABAC_API_URL}/api/admin/patients/${patientId}/conversation`, {
      headers: { Authorization: `Bearer ${tokenFor(SEM_CELULA)}` },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(403);
    const body = await res.json();
    expect(body.code).toBe('missing_cell');
  });

  test('2. CONTROLE, mesmo run: com célula, o handle aparece e a MESMA rota dá 200', async ({ page, request }) => {
    await loginAs(page, COM_CELULA);
    await page.goto(`/admin/patients/${patientId}`);

    await expect(page.getByTestId('patient-conversation-handle-btn')).toBeVisible({ timeout: 15_000 });

    const res = await request.get(`${ABAC_API_URL}/api/admin/patients/${patientId}/conversation`, {
      headers: { Authorization: `Bearer ${tokenFor(COM_CELULA)}` },
      failOnStatusCode: false,
    });
    expect(res.status()).toBe(200);
  });
});
