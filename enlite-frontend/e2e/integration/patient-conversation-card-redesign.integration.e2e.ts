/**
 * patient-conversation-card-redesign.integration.e2e.ts @integration — ajustes de UI B5
 * (redesenho pedido pelo Gabriel, molde ClickUp).
 *
 * Provas específicas do redesenho (pedidas explicitamente, além dos e2e já existentes que este
 * bloco também ajustou): card mostra iniciais + nome do autor; imagem anexada aparece como
 * MINIATURA de verdade (elemento `<img>` carregado, `naturalWidth > 0` — não só um placeholder);
 * "Responder" abre a thread e a resposta enviada aparece nela; contraste do nome/hora medido via
 * `getComputedStyle` (cálculo real de contraste, não só a classe — isso é papel deste e2e, o
 * unit só trava a classe como regressão barata).
 *
 * Molde: `patient-conversation-attachment-happy.integration.e2e.ts` (mesmos helpers de seed/login).
 * Sem PII/texto clínico: paciente "Paciente QA", staff "QA Staff Um", corpo "msg-1 com foto",
 * arquivo `e2e/fixtures/sample.png` (gerado sinteticamente nesta sessão, 300x200, sem dado real).
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import {
  seedPatientQA, cleanupPatientQA, seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs,
  type MockUser,
} from '../helpers/patient-conversation-helper';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const AUTORA_UID = `e2e-conv-card-${RUN_ID}`;
const AUTORA_EMAIL = `${AUTORA_UID}@e2e.test`;
const GRUPO = `E2E Conv Card ${RUN_ID}`;
const PNG_FIXTURE = path.join(HERE, '..', 'fixtures', 'sample.png');

let patientId = '';
let groupId = '';

const AUTORA: MockUser = { uid: AUTORA_UID, email: AUTORA_EMAIL, role: 'recruiter', country: 'AR' };

/**
 * Contraste real (WCAG), a partir de `getComputedStyle` — luminância relativa W3C. Independe de
 * qual classe Tailwind está por trás (o unit trava a CLASSE; isto trava o NÚMERO de verdade,
 * lido do DOM renderizado no browser).
 */
function relativeLuminance(rgb: [number, number, number]): number {
  const [r, g, b] = rgb.map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function parseRgb(value: string): [number, number, number] {
  const match = value.match(/(\d+),\s*(\d+),\s*(\d+)/);
  if (!match) throw new Error(`cor não reconhecida: ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function contrastRatio(fg: [number, number, number], bg: [number, number, number]): number {
  const L1 = relativeLuminance(fg);
  const L2 = relativeLuminance(bg);
  const [lighter, darker] = L1 > L2 ? [L1, L2] : [L2, L1];
  return (lighter + 0.05) / (darker + 0.05);
}

test.describe('Chat interno — card redesenhado (ajustes de UI B5) @integration', () => {
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
  });

  test.afterAll(() => {
    cleanupStaffAndGroup(AUTORA_UID, groupId);
    cleanupPatientQA(patientId);
  });

  test('card mostra avatar (iniciais) + nome; imagem anexada carrega como <img> de verdade; Responder abre a thread e a reply aparece nela; contraste do nome/hora >= 4.5:1', async ({ page }) => {
    await loginAs(page, AUTORA);
    await page.goto(`/admin/patients/${patientId}`);

    await page.getByTestId('patient-conversation-handle-btn').click();
    const panel = page.getByTestId('patient-conversation-panel');
    await expect(panel).toBeVisible();

    // ── anexa a imagem sintética + envia ──
    await page.getByTestId('composer-attach-input').setInputFiles(PNG_FIXTURE);
    await expect(page.getByText('sample.png')).toBeVisible({ timeout: 10_000 });

    const editor = page.getByTestId('composer-editor');
    await editor.click();
    await page.keyboard.type('msg-1 com foto');

    const posted = page.waitForResponse((r) => r.request().method() === 'POST' && /\/conversation\/messages$/.test(r.url()));
    await page.getByTestId('composer-send-btn').click();
    const postedBody = (await (await posted).json()) as { data: { id: string } };
    const topMessageId = postedBody.data.id;

    const item = page.getByTestId(`conversation-message-${topMessageId}`);
    await expect(item).toBeVisible();
    // O CARD de verdade (`bg-white`, borda) é `message-card-<id>`, DENTRO do wrapper de item da
    // lista (`conversation-message-<id>`, sem background próprio — transparente). Medir contraste
    // contra o wrapper daria fundo (0,0,0,0) e um número FALSO (achado medido nesta sessão: 4.43
    // em vez do 4.74 real, por ler o elemento errado).
    const card = item.getByTestId(`message-card-${topMessageId}`);
    await expect(card).toBeVisible();

    // ── avatar: iniciais visíveis (staff sem nome cadastrado no diretório-de-busca cai no uid,
    // mas o AVATAR sempre existe e mostra ALGUMA letra — nunca vazio) ──
    const avatar = card.getByTestId('message-avatar');
    await expect(avatar).toBeVisible();
    await expect(avatar).not.toHaveText('');

    // ── imagem: miniatura de verdade (fetch->blob->objectURL), não um placeholder de texto ──
    const img = card.locator('img[data-testid^="message-attachment-image-"]');
    await expect(img).toBeVisible({ timeout: 10_000 });
    const naturalWidth = await img.evaluate((el: HTMLImageElement) => el.naturalWidth);
    expect(naturalWidth).toBeGreaterThan(0);
    const src = await img.getAttribute('src');
    expect(src).toMatch(/^blob:/); // nunca a signed URL crua no DOM

    // ── contraste real do nome e da hora (getComputedStyle, cálculo W3C) ──
    const authorRgb = await card.getByTestId('message-author').evaluate((el) => getComputedStyle(el).color);
    const timeRgb = await card.getByTestId('message-time').evaluate((el) => getComputedStyle(el).color);
    const bgRgb = await card.evaluate((el) => getComputedStyle(el).backgroundColor);
    const bg = parseRgb(bgRgb);
    const authorRatio = contrastRatio(parseRgb(authorRgb), bg);
    const timeRatio = contrastRatio(parseRgb(timeRgb), bg);
    // Medido nesta sessão: author/time = rgb(115,115,115) (#737373, `text-gray-800`) sobre
    // rgb(255,255,255) (`bg-white` do card) → 4.74:1, acima do piso AA (4.5:1) checado abaixo.
    expect(authorRatio).toBeGreaterThanOrEqual(4.5);
    expect(timeRatio).toBeGreaterThanOrEqual(4.5);

    // ── "Responder" abre a thread (mesmo sem nenhuma reply ainda — replyCount 0, sem "0 respuestas") ──
    await expect(card.getByTestId('conversation-message-replies')).not.toBeVisible();
    await card.getByTestId('conversation-message-reply-btn').click();
    const thread = page.getByTestId('thread-view');
    await expect(thread).toBeVisible();
    await expect(page.getByTestId('thread-root-message')).toContainText('msg-1 com foto');

    // responde na thread — a reply aparece nela
    const replyEditor = page.getByTestId('composer-editor');
    await replyEditor.click();
    await page.keyboard.type('resposta na thread');
    await page.getByTestId('composer-send-btn').click();
    await expect(page.getByTestId('thread-replies-list')).toContainText('resposta na thread', { timeout: 10_000 });
  });
});
