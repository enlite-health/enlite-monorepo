/**
 * patient-conversation-attachment-thumbnail-cors.integration.e2e.ts @integration — gate 21/09,
 * achado A1 (ALTO). Guarda PERMANENTE contra regressão: a miniatura de imagem NUNCA pode voltar a
 * depender de `fetch(signedUrl)→blob→createObjectURL`.
 *
 * Por quê existe: o e2e antigo (`patient-conversation-card-redesign.integration.e2e.ts`) roda
 * contra `fake-gcs-server`, que responde CORS por padrão — nunca teria pegado o defeito de
 * produção (o bucket `enlite-patient-documents` NÃO tem CORS, de propósito, `terraform/
 * environments/prd/storage.tf`). Este teste simula a condição de PRD de verdade: intercepta a
 * resposta da signed URL (identificada pelo parâmetro `X-Goog-Signature`, presente em toda URL
 * v4 assinada pelo `@google-cloud/storage`, local ou prd) e REMOVE os headers `Access-Control-*`
 * antes de entregar ao browser — os BYTES da imagem continuam reais (fake-gcs de verdade), só a
 * permissão de CORS que some.
 *
 * Prova pelo AVESSO, nos dois sentidos, na MESMA rota interceptada:
 *   RED  — um `fetch()` de verdade contra essa URL (o que o código ANTIGO fazia) é bloqueado pelo
 *          browser (rejeita) sob essas condições — prova que a simulação reproduz o defeito real.
 *   GREEN — a miniatura da tela (`<img src={signedUrl}>`, o código ATUAL) carrega mesmo assim
 *          (`naturalWidth > 0`) — porque carga de subresource de `<img>` não passa pelo CORS.
 *
 * Sem PII/texto clínico: paciente "Paciente QA", staff "QA Staff Thumb", corpo "msg-1 sem cors",
 * arquivo `e2e/fixtures/sample.png` (sintético, já usado por `card-redesign`).
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
const AUTORA_UID = `e2e-conv-thumb-cors-${RUN_ID}`;
const AUTORA_EMAIL = `${AUTORA_UID}@e2e.test`;
const GRUPO = `E2E Conv Thumb CORS ${RUN_ID}`;
const PNG_FIXTURE = path.join(HERE, '..', 'fixtures', 'sample.png');

/** Toda signed URL v4 do `@google-cloud/storage` (local fake-gcs OU prd de verdade) carrega este
 *  parâmetro de query — é como reconhecemos "isto é a requisição da miniatura", sem depender do
 *  host (varia por ambiente/porta do emulador). */
function isSignedStorageRequest(url: string): boolean {
  return url.includes('X-Goog-Signature');
}

let patientId = '';
let groupId = '';

const AUTORA: MockUser = { uid: AUTORA_UID, email: AUTORA_EMAIL, role: 'recruiter', country: 'AR' };

test.describe('Chat interno — miniatura de imagem sobrevive a bucket SEM CORS (gate A1, guarda permanente) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  test.beforeAll(() => {
    patientId = seedPatientQA();
    const seeded = seedStaffInGroup({ uid: AUTORA_UID, email: AUTORA_EMAIL, groupName: GRUPO, country: 'AR' });
    groupId = seeded.groupId;
    grantCell(groupId, 'patient', 'read');
    grantCell(groupId, 'patient_conversation', 'read');
    grantCell(groupId, 'patient_conversation', 'create');
  });

  test.afterAll(() => {
    cleanupStaffAndGroup(AUTORA_UID, groupId);
    cleanupPatientQA(patientId);
  });

  test('miniatura carrega via <img> mesmo sem Access-Control-Allow-Origin na resposta; um fetch() direto à mesma URL é bloqueado', async ({ page }) => {
    let interceptedAtLeastOnce = false;
    let observedResponseHadNoCorsHeader = false;

    // registrado ANTES de qualquer navegação — pega a miniatura desde o primeiro carregamento,
    // exatamente como o browser real veria contra o bucket de prd.
    await page.route((url) => isSignedStorageRequest(url.toString()), async (route) => {
      const response = await route.fetch();
      const original = response.headers();
      const headers = { ...original };
      delete headers['access-control-allow-origin'];
      delete headers['access-control-allow-methods'];
      delete headers['access-control-allow-headers'];
      delete headers['access-control-expose-headers'];
      delete headers['access-control-allow-credentials'];
      interceptedAtLeastOnce = true;
      observedResponseHadNoCorsHeader = !('access-control-allow-origin' in headers);
      await route.fulfill({ response, headers, body: await response.body() });
    });

    await loginAs(page, AUTORA);
    await page.goto(`/admin/patients/${patientId}`);

    await page.getByTestId('patient-conversation-handle-btn').click();
    const panel = page.getByTestId('patient-conversation-panel');
    await expect(panel).toBeVisible();

    await page.getByTestId('composer-attach-input').setInputFiles(PNG_FIXTURE);
    await expect(page.getByText('sample.png')).toBeVisible({ timeout: 10_000 });

    const editor = page.getByTestId('composer-editor');
    await editor.click();
    await page.keyboard.type('msg-1 sem cors');

    const posted = page.waitForResponse((r) => r.request().method() === 'POST' && /\/conversation\/messages$/.test(r.url()));
    await page.getByTestId('composer-send-btn').click();
    const postedBody = (await (await posted).json()) as { data: { id: string } };
    const messageId = postedBody.data.id;

    const item = page.getByTestId(`conversation-message-${messageId}`);
    await expect(item).toBeVisible();

    // ── GREEN: a miniatura de verdade carrega — `naturalWidth > 0` é a MESMA prova usada em
    // `card-redesign` (elemento de fato decodificado pelo browser, não um placeholder) ──
    const img = item.locator('img[data-testid^="message-attachment-image-"]');
    await expect(img).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth), {
      timeout: 10_000,
      message: 'miniatura deveria decodificar mesmo sem CORS na resposta (carga de <img>, não de fetch)',
    }).toBeGreaterThan(0);

    // sanidade: a interceptação de fato rodou e de fato removeu o header (senão o teste todo
    // provaria uma condição que não é a de prd — contagem zero de interceptação seria "não testei nada").
    expect(interceptedAtLeastOnce).toBe(true);
    expect(observedResponseHadNoCorsHeader).toBe(true);

    // ── RED: um `fetch()` direto contra a MESMA URL (o que o código ANTIGO fazia,
    // `fetch(signedUrl)→blob→objectURL`) é bloqueado pelo browser sob esta MESMA condição —
    // prova que a simulação reproduz de verdade o defeito de prd, não um cenário artificial. ──
    const src = await img.getAttribute('src');
    expect(src).toBeTruthy();
    const fetchOutcome = await page.evaluate(async (url) => {
      try {
        await fetch(url as string);
        return 'resolved';
      } catch (err) {
        return err instanceof Error ? err.message : String(err);
      }
    }, src);
    expect(fetchOutcome).not.toBe('resolved');
  });
});
