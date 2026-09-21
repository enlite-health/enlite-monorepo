/**
 * patient-conversation-viewport-layout.integration.e2e.ts @integration — ajustes de UI B5, item 7
 * (achado do print do Gabriel: o rodapé do painel — compositor + "Adjuntar" + "Enviar" — ficava
 * CORTADO embaixo). Prova que o compositor fica SEMPRE inteiro visível, em 3 viewports comuns de
 * notebook (1280x720, 1366x768, 1440x900), com uma lista de mensagens REAL o bastante para
 * estressar o layout (não uma lista vazia, que nunca acusaria o bug).
 *
 * Conserto real: `SlideOverPanel` usava `h-screen` (`100vh`) — no mobile isso conta a altura da
 * JANELA inteira, incluindo a área que a barra de endereço ainda pode cobrir, e o painel virava
 * MAIOR que o espaço visível de verdade. Trocado por `h-dvh` (Tailwind >= 3.4, dynamic viewport
 * height). Some com isso, a causa raiz de verdade era `flex-1` sem `min-h-0` na lista rolável
 * (gotcha clássico de flexbox: sem isso, o item não encolhe, e o excesso empurra o rodapé pra fora
 * da área visível do painel) — `min-h-0` na lista + `flex-shrink-0` no cabeçalho/compositor.
 */
import { test, expect } from '@playwright/test';
import {
  seedPatientQA, cleanupPatientQA, seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs,
  tokenFor, type MockUser,
} from '../helpers/patient-conversation-helper';

const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const AUTORA_UID = `e2e-conv-viewport-${RUN_ID}`;
const AUTORA_EMAIL = `${AUTORA_UID}@e2e.test`;
const GRUPO = `E2E Conv Viewport ${RUN_ID}`;
const API_URL = process.env.ABAC_API_URL ?? 'http://localhost:8080';

let patientId = '';
let groupId = '';
const AUTORA: MockUser = { uid: AUTORA_UID, email: AUTORA_EMAIL, role: 'recruiter', country: 'AR' };

const VIEWPORTS = [
  { width: 1280, height: 720, label: '1280x720' },
  { width: 1366, height: 768, label: '1366x768' },
  { width: 1440, height: 900, label: '1440x900' },
];

test.describe('Compositor SEMPRE visível — 3 viewports (ajustes de UI B5, item 7) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  test.beforeAll(async ({ request }) => {
    patientId = seedPatientQA();
    const seeded = seedStaffInGroup({ uid: AUTORA_UID, email: AUTORA_EMAIL, groupName: GRUPO, country: 'AR' });
    groupId = seeded.groupId;
    grantCell(groupId, 'patient', 'read');
    grantCell(groupId, 'patient_conversation', 'read');
    grantCell(groupId, 'patient_conversation', 'create');
    grantCell(groupId, 'staff_directory', 'read');

    // 12 mensagens de topo, o bastante pra a lista estressar o layout (nunca uma lista vazia,
    // que nunca acusaria o corte no rodapé).
    const base = `${API_URL}/api/admin/patients/${patientId}/conversation`;
    for (let i = 1; i <= 12; i += 1) {
      await request.post(`${base}/messages`, {
        headers: { Authorization: `Bearer ${tokenFor(AUTORA)}` },
        data: { body: `mensagem de teste de layout número ${i}` },
      });
    }
  });

  test.afterAll(() => {
    cleanupStaffAndGroup(AUTORA_UID, groupId);
    cleanupPatientQA(patientId);
  });

  for (const vp of VIEWPORTS) {
    test(`viewport ${vp.label}: "Enviar" e "Adjuntar" com boundingBox TOTALMENTE dentro da tela`, async ({ page }) => {
      await page.setViewportSize({ width: vp.width, height: vp.height });
      await loginAs(page, AUTORA);
      await page.goto(`/admin/patients/${patientId}`);
      await page.getByTestId('patient-conversation-handle-btn').click();

      const panel = page.getByTestId('patient-conversation-panel');
      await expect(panel).toBeVisible();
      await expect(page.getByTestId('conversation-panel-list')).toContainText('mensagem de teste de layout número 12');
      // 🔒 achado desta sessão: `SlideOverPanel` desliza com `transition-transform duration-300`
      // (`translate-x-full` → `translate-x-0`). `toBeVisible()` já passa a meio da animação (o
      // elemento não é `display:none` desde o primeiro frame) — medir `boundingBox()` ANTES da
      // transição assentar pega uma posição INTERMEDIÁRIA (o painel ainda deslizando), dando um
      // "corte na direita" FALSO que não existe no estado final. Espera a transição (300ms) + folga.
      await page.waitForTimeout(400);

      const sendBtn = page.getByTestId('composer-send-btn');
      const attachBtn = page.getByTestId('composer-attach-btn');
      await expect(sendBtn).toBeVisible();
      await expect(attachBtn).toBeVisible();

      const sendBox = await sendBtn.boundingBox();
      const attachBox = await attachBtn.boundingBox();
      expect(sendBox, `"Enviar" sem boundingBox em ${vp.label}`).not.toBeNull();
      expect(attachBox, `"Adjuntar" sem boundingBox em ${vp.label}`).not.toBeNull();

      for (const [name, box] of [['Enviar', sendBox], ['Adjuntar', attachBox]] as const) {
        expect(box!.y, `${name} corta em CIMA (${vp.label})`).toBeGreaterThanOrEqual(0);
        expect(box!.x, `${name} corta na ESQUERDA (${vp.label})`).toBeGreaterThanOrEqual(0);
        expect(box!.y + box!.height, `${name} corta EMBAIXO (${vp.label})`).toBeLessThanOrEqual(vp.height);
        expect(box!.x + box!.width, `${name} corta na DIREITA (${vp.label})`).toBeLessThanOrEqual(vp.width);
      }
    });
  }
});
