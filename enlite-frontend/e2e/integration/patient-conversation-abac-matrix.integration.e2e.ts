/**
 * patient-conversation-abac-matrix.integration.e2e.ts @integration — spec 022, Bloco 2, T222.
 *
 * Matriz de ABAC de TELA (D-24): 3 contas QA em GRUPOS DISTINTOS, no MESMO run, contra a MESMA
 * ficha de paciente — cada uma prova um estado diferente do handle/painel:
 *   1. SEM_CELULA   — 0 células `patient_conversation:*` (mas COM `patient:read`, a ficha carrega
 *      normal) → o handle NÃO EXISTE na tela (ausência, não botão desabilitado).
 *   2. SOMENTE_LEITURA — só `patient_conversation:read` → handle aparece, painel abre e LISTA
 *      (mensagem semeada por uma 3ª conta, via API, ANTES do teste — prova que a leitura é real,
 *      não lista vazia disfarçando o estado), mas o COMPOSITOR não é oferecido (conserto do
 *      `b2-gate-pr.md`: `panel.readOnly` em vez do campo).
 *   3. COMPLETO — `read+create+update+delete` → fluxo completo: escreve, envia, responde na thread.
 *
 * ⚠️ Os 3 estados correm no MESMO arquivo/run (`test.describe.configure({ mode: 'serial' })`) —
 * se os 3 dessem ausência/403, a stack estaria quebrada e a matriz não provaria nada (aviso do
 * brief). O estado 3 sozinho já é a prova positiva de que a stack está viva.
 *
 * Stack: mesma família de `patient-conversation-happy.integration.e2e.ts` — ver o docblock dele
 * para as portas exatas desta sessão (Postgres/API/Vite variam por execução, sempre via env).
 *
 * Sem PII/texto clínico: paciente "Paciente QA", corpo "msg-1 ...", contas sintéticas `e2e-conv-*`.
 */
import { test, expect } from '@playwright/test';
import {
  seedPatientQA, cleanupPatientQA,
  seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, tokenFor,
  ABAC_API_URL, type MockUser,
} from '../helpers/patient-conversation-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;

const SEM_UID = `e2e-conv-abac-sem-${RUN_ID}`;
const LEITURA_UID = `e2e-conv-abac-leitura-${RUN_ID}`;
const COMPLETO_UID = `e2e-conv-abac-completo-${RUN_ID}`;
const GRUPO_SEM = `E2E Conv ABAC Sem ${RUN_ID}`;
const GRUPO_LEITURA = `E2E Conv ABAC Leitura ${RUN_ID}`;
const GRUPO_COMPLETO = `E2E Conv ABAC Completo ${RUN_ID}`;

const SEM_CELULA: MockUser = { uid: SEM_UID, email: `${SEM_UID}@e2e.test`, role: 'recruiter', country: 'AR' };
const SOMENTE_LEITURA: MockUser = { uid: LEITURA_UID, email: `${LEITURA_UID}@e2e.test`, role: 'recruiter', country: 'AR' };
const COMPLETO: MockUser = { uid: COMPLETO_UID, email: `${COMPLETO_UID}@e2e.test`, role: 'recruiter', country: 'AR' };

let patientId = '';
let groupSemId = '';
let groupLeituraId = '';
let groupCompletoId = '';
/** Mensagem semeada via API (conta COMPLETO) ANTES do teste do estado 2 — prova que a lista da
 * conta SOMENTE_LEITURA mostra dado REAL, não lista vazia mascarando "não pude ler". */
let seededMessageId = '';

test.describe('Chat interno por paciente — matriz de ABAC de TELA (D-24, T222) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  test.beforeAll(async ({ request }) => {
    patientId = seedPatientQA();

    const semSeeded = seedStaffInGroup({ uid: SEM_UID, email: SEM_CELULA.email, groupName: GRUPO_SEM, country: 'AR' });
    groupSemId = semSeeded.groupId;
    grantCell(groupSemId, 'patient', 'read'); // ficha carrega — isola "sem célula de conversa" de "sem grupo nenhum"

    const leituraSeeded = seedStaffInGroup({ uid: LEITURA_UID, email: SOMENTE_LEITURA.email, groupName: GRUPO_LEITURA, country: 'AR' });
    groupLeituraId = leituraSeeded.groupId;
    grantCell(groupLeituraId, 'patient', 'read');
    grantCell(groupLeituraId, 'patient_conversation', 'read');

    const completoSeeded = seedStaffInGroup({ uid: COMPLETO_UID, email: COMPLETO.email, groupName: GRUPO_COMPLETO, country: 'AR' });
    groupCompletoId = completoSeeded.groupId;
    grantCell(groupCompletoId, 'patient', 'read');
    grantCell(groupCompletoId, 'patient_conversation', 'read');
    grantCell(groupCompletoId, 'patient_conversation', 'create');
    grantCell(groupCompletoId, 'patient_conversation', 'update');
    grantCell(groupCompletoId, 'patient_conversation', 'delete');

    // Semeia a mensagem do estado 2 direto na API (conta COMPLETO já tem `create`) — nunca pela UI
    // da conta SOMENTE_LEITURA, que não pode escrever.
    const seedRes = await request.post(`${ABAC_API_URL}/api/admin/patients/${patientId}/conversation/messages`, {
      headers: { Authorization: `Bearer ${tokenFor(COMPLETO)}` },
      data: { body: 'msg-1 matriz-abac semente' },
    });
    if (!seedRes.ok()) throw new Error(`seed da mensagem falhou: ${seedRes.status()} ${await seedRes.text()}`);
    const seedBody = (await seedRes.json()) as { success: boolean; data?: { id: string } };
    if (!seedBody.success || !seedBody.data?.id) throw new Error(`seed sem id: ${JSON.stringify(seedBody)}`);
    seededMessageId = seedBody.data.id;
  });

  test.afterAll(() => {
    cleanupStaffAndGroup(SEM_UID, groupSemId);
    cleanupStaffAndGroup(LEITURA_UID, groupLeituraId);
    cleanupStaffAndGroup(COMPLETO_UID, groupCompletoId);
    cleanupPatientQA(patientId);
  });

  test('estado 1 — sem célula nenhuma: o handle NÃO EXISTE na tela (ausência, não desabilitado)', async ({ page }) => {
    await loginAs(page, SEM_CELULA);
    await page.goto(`/admin/patients/${patientId}`);

    // prova de que a página CARREGOU (não é "Access denied" da ficha inteira mascarando o teste —
    // a conta TEM `patient:read`, só não tem `patient_conversation:*`)
    await expect(page.getByRole('heading', { level: 3, name: 'Access denied' })).toHaveCount(0);
    await expect(page.getByTestId('patient-conversation-handle-btn')).toHaveCount(0);
    await expect(page.getByTestId('patient-conversation-panel')).toHaveCount(0);

    // Screenshot é evidência SECUNDÁRIA aqui (o aviso do brief sobre tolerância de ~2% do
    // `toHaveScreenshot` vale mais ainda numa asserção de AUSÊNCIA) — a prova primária é o
    // `toHaveCount(0)` acima. Clip determinístico na região onde o handle apareceria (fixed
        // right-0 top-1/2), viewport padrão do projeto Desktop Chrome (1280×720).
    await expect(page).toHaveScreenshot('abac-matrix-estado1-sem-celula.png', {
      clip: { x: 1180, y: 300, width: 100, height: 120 },
      maxDiffPixelRatio: 0.02,
    });
  });

  test('estado 2 — só patient_conversation:read: painel abre e LISTA, mas SEM compositor (panel.readOnly)', async ({ page }) => {
    await loginAs(page, SOMENTE_LEITURA);
    await page.goto(`/admin/patients/${patientId}`);

    const handleBtn = page.getByTestId('patient-conversation-handle-btn');
    await expect(handleBtn).toBeVisible({ timeout: 15_000 });
    await handleBtn.click();

    const panel = page.getByTestId('patient-conversation-panel');
    await expect(panel).toBeVisible();

    // LISTA real: a mensagem semeada pela conta COMPLETO aparece para quem só tem `:read`.
    const seededItem = page.getByTestId(`conversation-message-${seededMessageId}`);
    await expect(seededItem).toBeVisible({ timeout: 10_000 });
    await expect(seededItem.getByTestId('message-body')).toContainText('msg-1 matriz-abac semente');

    // SEM compositor: nem o campo de edição, nem o botão de enviar — só o aviso read-only.
    await expect(page.getByTestId('composer-editor')).toHaveCount(0);
    await expect(page.getByTestId('composer-send-btn')).toHaveCount(0);
    await expect(page.getByTestId('conversation-panel-read-only')).toBeVisible();

    await expect(panel).toHaveScreenshot('abac-matrix-estado2-somente-leitura.png', {
      mask: [page.locator('[data-testid="message-author"], [data-testid="message-time"]')],
      maxDiffPixelRatio: 0.02,
    });
  });

  test('estado 3 — read+create+update+delete: fluxo completo (escreve, envia, responde na thread)', async ({ page }) => {
    await loginAs(page, COMPLETO);
    await page.goto(`/admin/patients/${patientId}`);

    const handleBtn = page.getByTestId('patient-conversation-handle-btn');
    await expect(handleBtn).toBeVisible({ timeout: 15_000 });
    await handleBtn.click();

    const panel = page.getByTestId('patient-conversation-panel');
    await expect(panel).toBeVisible();

    // ESCREVE + ENVIA (click + keyboard.type, nunca fill) — mensagem de topo nova, distinta da
    // semente do estado 2 (prova que esta conta, e não a de leitura, é quem pode escrever).
    const editor = page.getByTestId('composer-editor');
    await editor.click();
    await expect(editor).toBeFocused();
    await page.keyboard.type('msg-1 matriz-abac completo');

    const posted = page.waitForResponse((r) => r.request().method() === 'POST' && /\/conversation\/messages$/.test(r.url()));
    await page.getByTestId('composer-send-btn').click();
    const postedBody = (await (await posted).json()) as { data: { id: string } };
    expect(postedBody.data.id).toBeTruthy();
    const novaMsgId = postedBody.data.id;

    const novoItem = page.getByTestId(`conversation-message-${novaMsgId}`);
    await expect(novoItem).toBeVisible();
    await expect(novoItem.getByTestId('message-body')).toContainText('msg-1 matriz-abac completo');

    // RESPONDE NA THREAD.
    await novoItem.getByRole('button').click(); // "N respostas"
    const thread = page.getByTestId('thread-view');
    await expect(thread).toBeVisible();
    await expect(page.getByTestId('thread-root-message')).toContainText('msg-1 matriz-abac completo');

    const replyEditor = page.getByTestId('composer-editor');
    await replyEditor.click();
    await expect(replyEditor).toBeFocused();
    await page.keyboard.type('msg-1 matriz-abac resposta');
    await page.getByTestId('composer-send-btn').click();
    await expect(page.getByTestId('thread-replies-list')).toContainText('msg-1 matriz-abac resposta', { timeout: 10_000 });

    await page.getByTestId('thread-back-btn').click();
    await expect(page.getByTestId('conversation-panel-list')).toBeVisible();
    await expect(page.getByTestId(`conversation-message-${novaMsgId}`)).toContainText('1 respuesta');

    await expect(panel).toHaveScreenshot('abac-matrix-estado3-completo.png', {
      mask: [page.locator('[data-testid="message-author"], [data-testid="message-time"]')],
      maxDiffPixelRatio: 0.02,
    });
  });
});
