/**
 * patient-conversation-attachment-thumbnail-cors.integration.e2e.ts @integration — gate 21/09,
 * achado A1 (ALTO). Guarda PERMANENTE contra regressão: a miniatura de imagem NUNCA pode voltar a
 * depender de `fetch(signedUrl)→blob→createObjectURL`.
 *
 * Por quê existe: o e2e antigo (`patient-conversation-card-redesign.integration.e2e.ts`) roda
 * contra `fake-gcs-server`, que responde CORS por padrão — nunca teria pegado o defeito de
 * produção (o bucket `enlite-patient-documents` NÃO tem CORS, de propósito, `terraform/
 * environments/prd/storage.tf`).
 *
 * 🔒 Achado desta sessão — a 1ª versão deste arquivo tentava simular "bucket sem CORS" com
 * `page.route(...).fulfill({ headers })` removendo os headers `Access-Control-*` da resposta da
 * signed URL. Isso NUNCA funcionou: `playwright-core/lib/server/network.js`, método
 * `_maybeAddCorsHeaders` (comentário no próprio código: "See
 * https://github.com/microsoft/playwright/issues/12929"), injeta `access-control-allow-origin`
 * (+ `access-control-allow-credentials`, `vary: Origin`) em TODA resposta de `route.fulfill()`
 * cross-origin que não already tenha esse header — de propósito, pra fulfill "só funcionar" em
 * cenários cross-origin comuns. Ou seja: **`route.fulfill()` é estruturalmente incapaz de simular
 * "sem CORS"** — confirmado com `grep -n "access-control-allow-origin"` dentro de
 * `node_modules/.pnpm/playwright-core[at]<versão>/node_modules/playwright-core/lib/server/network.js`. O
 * teste antigo falhava (ou passava por acidente) independente do código do produto estar certo ou
 * errado — não discriminava nada.
 *
 * Conserto: em vez de `fulfill`, sobe um servidor HTTP REAL (`node:http`, porta efêmera,
 * `127.0.0.1`) que nunca passa pelo `route.fulfill` do Playwright — é uma origem de verdade, sem
 * NENHUM header `Access-Control-*` (porque nunca escrevemos nenhum). Só a resposta JSON da API de
 * "pegar signed URL" é interceptada (essa sim via `fulfill`, mas só pra TROCAR o campo `url` pelo
 * endereço do servidor local — não precisa simular ausência de CORS nessa chamada, que é uma API
 * JSON comum, não um subresource de imagem). A miniatura (`<img src>`) passa a apontar pro
 * servidor local sem CORS nenhum — condição real, não fingida.
 *
 * Prova pelo AVESSO, nos dois sentidos:
 *   GREEN — a miniatura da tela (`<img src={url}>`, o código ATUAL) carrega mesmo assim
 *          (`naturalWidth > 0`) — porque carga de subresource de `<img>` não passa pelo CORS.
 *   RED  — um `fetch()` de verdade contra essa MESMA URL (o que o código ANTIGO fazia) é REJEITADO
 *          pelo browser sob essa condição — prova que o ambiente aplica CORS de verdade (não é o
 *          Playwright fingindo).
 *
 * Sem PII/texto clínico: paciente "Paciente QA", staff "QA Staff Thumb", corpo "msg-1 sem cors",
 * arquivo `e2e/fixtures/sample.png` (sintético, já usado por `card-redesign`), servido também
 * pelo servidor HTTP local (mesmos bytes, lidos do disco).
 */
import { test, expect } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import http from 'http';
import type { AddressInfo } from 'net';
import { fileURLToPath } from 'url';
import {
  seedPatientQA, cleanupPatientQA, seedStaffInGroup, cleanupStaffAndGroup, grantCell, loginAs, tokenFor,
  type MockUser,
} from '../helpers/patient-conversation-helper';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RUN_ID = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
const AUTORA_UID = `e2e-conv-thumb-cors-${RUN_ID}`;
const AUTORA_EMAIL = `${AUTORA_UID}@e2e.test`;
const GRUPO = `E2E Conv Thumb CORS ${RUN_ID}`;
const PNG_FIXTURE = path.join(HERE, '..', 'fixtures', 'sample.png');
const PNG_BYTES = fs.readFileSync(PNG_FIXTURE);

/** `GET .../conversation/files/:fileId/url` — a chamada que devolve a signed URL da miniatura
 *  (contrato: `{ url, expiresInSeconds }`). É a ÚNICA coisa que interceptamos via `route.fulfill`
 *  — só pra trocar o campo `url`, nunca pra simular ausência de CORS (ver docblock do arquivo). */
function isAttachmentUrlEndpoint(url: string): boolean {
  return /\/conversation\/files\/[^/]+\/url(\?[^/]*)?$/.test(url);
}

let patientId = '';
let groupId = '';
let server: http.Server;
let noCorsImageUrl = '';

const AUTORA: MockUser = { uid: AUTORA_UID, email: AUTORA_EMAIL, role: 'recruiter', country: 'AR' };

test.describe('Chat interno — miniatura de imagem sobrevive a bucket SEM CORS (gate A1, guarda permanente) @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(120_000);

  test.beforeAll(async () => {
    patientId = seedPatientQA();
    const seeded = seedStaffInGroup({ uid: AUTORA_UID, email: AUTORA_EMAIL, groupName: GRUPO, country: 'AR' });
    groupId = seeded.groupId;
    grantCell(groupId, 'patient', 'read');
    grantCell(groupId, 'patient_conversation', 'read');
    grantCell(groupId, 'patient_conversation', 'create');

    // Servidor HTTP REAL (não passa por `route.fulfill` do Playwright — ver docblock do topo do
    // arquivo) — nenhum header `Access-Control-*` é escrito, de propósito: é a condição real do
    // bucket de prd sem CORS, não uma simulação via interceptação.
    server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': PNG_BYTES.length });
      res.end(PNG_BYTES);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    const { port } = server.address() as AddressInfo;
    noCorsImageUrl = `http://127.0.0.1:${port}/sample.png`;
  });

  test.afterAll(async () => {
    await new Promise<void>((resolve, reject) => {
      server.close((err) => (err ? reject(err) : resolve()));
    });
    cleanupStaffAndGroup(AUTORA_UID, groupId);
    cleanupPatientQA(patientId);
  });

  test('miniatura carrega via <img> mesmo sem Access-Control-Allow-Origin na resposta; um fetch() direto à mesma URL é bloqueado', async ({ page }) => {
    let interceptedAtLeastOnce = false;

    // 🔒 achado desta sessão (mesma classe do gate A7, `patient-conversation-loading-state...ts`):
    // `loginAs`/`installAuthInterceptors` registra `page.route('**/api/**', swapToken)`, e o
    // Playwright resolve rotas sobrepostas em ordem LIFO (a registrada por ÚLTIMO ganha, via
    // `route.continue()`, que não repassa pras mais antigas). Registrar este route ANTES do
    // `loginAs` fazia o `swapToken` (mais recente) interceptar a GET de `.../files/:fileId/url`
    // primeiro — `interceptedAtLeastOnce` ficava `false`, o `<img>` carregava a signed URL REAL do
    // fake-gcs (que tem CORS) em vez da do servidor local, e o teste não provava nada.
    await loginAs(page, AUTORA);

    // Troca só o campo `url` da resposta JSON pelo endereço do servidor local sem CORS — não
    // precisa (nem faz sentido) simular ausência de CORS NESTA chamada, que é uma API JSON comum
    // servida pela própria API admin (que já tem CORS_ALLOWED_ORIGINS configurado pro Vite).
    // Registrado DEPOIS do `loginAs` (mais recente, primeiro na ordem LIFO) — por isso replica a
    // troca do header `Authorization` do `swapToken` aqui dentro (`tokenFor`), senão a requisição
    // sairia com o id-token real do Firebase em vez do `mock_*` que a API espera.
    await page.route((url) => isAttachmentUrlEndpoint(url.toString()), async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      const response = await route.fetch({
        headers: { ...route.request().headers(), authorization: `Bearer ${tokenFor(AUTORA)}` },
      });
      // 🔒 achado desta sessão: a resposta vem no envelope `{ success, data: { url,
      // expiresInSeconds } }` (`requestJson` do client desembrulha `.data`) — trocar um `url` no
      // NÍVEL DE FORA do envelope (`{ ...body, url: ... }`) não muda nada que o app lê; o `<img>`
      // continuava carregando a signed URL real do fake-gcs. A troca tem que ser em `data.url`.
      const body = (await response.json()) as { success: boolean; data: { url: string; expiresInSeconds: number } };
      interceptedAtLeastOnce = true;
      await route.fulfill({
        response,
        contentType: 'application/json',
        body: JSON.stringify({ ...body, data: { ...body.data, url: noCorsImageUrl } }),
      });
    });

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

    // sanidade: a troca de URL de fato rodou (senão o teste inteiro provaria a URL do fake-gcs,
    // que TEM cors — contagem zero de interceptação seria "não testei nada").
    expect(interceptedAtLeastOnce).toBe(true);

    // ── GREEN: a miniatura de verdade carrega — `naturalWidth > 0` é a MESMA prova usada em
    // `card-redesign` (elemento de fato decodificado pelo browser, não um placeholder) — mesmo com
    // `src` apontando pro servidor local SEM NENHUM header de CORS ──
    const img = item.locator('img[data-testid^="message-attachment-image-"]');
    await expect(img).toBeVisible({ timeout: 10_000 });
    const src = await img.getAttribute('src');
    expect(src).toBe(noCorsImageUrl);
    await expect.poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth), {
      timeout: 10_000,
      message: 'miniatura deveria decodificar mesmo sem CORS na resposta (carga de <img>, não de fetch)',
    }).toBeGreaterThan(0);

    // ── RED: um `fetch()` direto contra a MESMA URL (o que o código ANTIGO fazia,
    // `fetch(signedUrl)→blob→objectURL`) é bloqueado pelo browser — desta vez CORS de verdade
    // (o servidor é real, a requisição nunca passa por `route.fulfill`) ──
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
