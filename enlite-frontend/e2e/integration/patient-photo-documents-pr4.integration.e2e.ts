/**
 * patient-photo-documents-pr4.integration.e2e.ts @integration
 *
 * Spec 018 PR-4 (foto/documentos/consentimento de imagem do paciente) contra o stack REAL
 * (frontend + API + Postgres, engine de permissão LIGADO), zero mock de API: click +
 * `setInputFiles` (upload real) + valor lido da TELA. Molde: `patient-header-pr3.integration.e2e.ts`
 * (`abac-stack-helper.ts` para grupo/célula real via ABAC).
 *
 * D335 (14/09/2026): consentimento/representante são OPCIONAIS — nenhum teste aqui espera 409
 * por falta de consentimento (essa trava foi removida pelo Gabriel).
 *
 * O que se prova:
 *   1. feliz — subir a foto (arquivo PNG real via `setInputFiles`) → aparece a `<img>`; remover
 *      (confirmar no modal) → volta ao placeholder.
 *   2. alternativo — ator SEM `patient_consent_documents:read`: a seção de documentos não mostra
 *      a lista (elemento ausente da árvore, não só invisível).
 *   2b. alternativo (achado 2, prova da stage 15/09) — o mesmo ator SEM a célula de leitura:
 *      mostra o aviso `patient-documents-no-permission`, sobe documento, vê "Documento enviado"
 *      e NUNCA dispara `GET .../documents` (0 request nessa rota do início ao fim do teste).
 *   3. alternativo — arquivo inválido (PDF como foto) é recusado com mensagem de erro na tela,
 *      sem crash.
 *   4. feliz (furo fechado 14/09) — enviar documento → `page.reload()` → o documento continua
 *      listado (prova que `GET .../documents` persiste, não é mais estado de sessão).
 *   5. feliz (furo fechado 14/09) — registrar um representante (`patient_responsibles`, feature
 *      pré-existente — `FamiliaresCard`/`PatientSupportNetworkEditDrawer`) → `page.reload()` →
 *      continua na tabela.
 *   6. alternativo (furo fechado 14/09) — consentimento registrado e depois revogado →
 *      `page.reload()` em cada passo mostra o estado real (vigente, depois SEM vigente).
 *   7. feliz (achado 1, prova da stage 15/09) — ator COM a célula abre um documento já enviado
 *      pelo botão "Abrir": interação humana real (`click`), abre aba nova por `blob:` (asserção do
 *      conserto — o clique aciona `fetch()`+blob, não navegação direta pra URL assinada).
 *
 * Stack local (ver docker-compose.018pr4-ports.yml + engine ligado):
 *   docker compose -p 018pr4c -f docker-compose.yml -f docker-compose.test.yml \
 *     -f docker-compose.018pr4-ports.yml -f /tmp/pr4-engine.yml up -d postgres fake-gcs api
 *   (bucket criado via POST http://localhost:54443/storage/v1/b antes de subir a API)
 *   psql ... -c "INSERT INTO iam.rollout_state ... VALUES ('permission_groups_migrated','done',...)"
 *   cd enlite-frontend && npx vite --port 5183 --strictPort
 *   PW_BASE_URL=http://localhost:5183 npx playwright test patient-photo-documents-pr4 --project=integration
 */
import { test, expect, type Page } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { seedStaffInGroup, grantCell, cleanupStaffAndGroup, loginAs, type MockUser } from '../helpers/abac-stack-helper';
import { runSQL, cleanupPatientDeep } from '../helpers/patient-detail-a-helper';
import { insertTestPatient } from '../helpers/db-test-helper';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// Conserto #8 da 2ª revisão do PR-4: era um caminho ABSOLUTO de macOS
// (`/Users/gabrielstein-dev/...`) — quebra em qualquer outra máquina/CI (Linux do runner).
// Relativo ao repo, dentro de `test-results/` (gitignored — CLAUDE.md do frontend já ignora
// `test-results`), criado on-demand pelo `mkdirSync` abaixo.
const EVID_DIR = path.join(HERE, '..', '..', 'test-results', 'evidencias', 'pr-4-local');
fs.mkdirSync(EVID_DIR, { recursive: true });
const PHOTO_FIXTURE = path.join(HERE, '..', 'fixtures', 'figma', '5764_49894.png');
const PDF_FIXTURE = path.join(HERE, '..', 'fixtures', 'sample.pdf');

test.use({ viewport: { width: 1600, height: 1000 } });

test.describe('spec 018 PR-4 — foto/documentos do paciente: HUMANO no stack real, engine LIGADO @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  const stamp = Date.now().toString().slice(-6);
  let patientId: string;
  const completa: MockUser = { uid: `pr4h-completa-${stamp}`, email: `pr4h-completa-${stamp}@e2e.local`, role: 'admin', country: 'AR' };
  const semDocRead: MockUser = { uid: `pr4h-sem-docread-${stamp}`, email: `pr4h-sem-docread-${stamp}@e2e.local`, role: 'admin', country: 'AR' };
  let grupoCompleta: string;
  let grupoSemDocRead: string;

  test.beforeAll(() => {
    const { patientId: pid } = insertTestPatient({ status: 'ACTIVE', firstName: 'FotoPR4', lastName: `Humano${stamp}` });
    patientId = pid;

    ({ groupId: grupoCompleta } = seedStaffInGroup({ uid: completa.uid, email: completa.email, groupName: `PR4H Completa ${stamp}`, country: 'AR' }));
    grantCell(grupoCompleta, 'patient', 'read');
    grantCell(grupoCompleta, 'patient_identity', 'read');
    grantCell(grupoCompleta, 'patient_identity', 'write');
    grantCell(grupoCompleta, 'patient_consent_documents', 'read');
    // Furo 2 (14/09): representante já é feature pré-existente (patient_responsibles,
    // adminPatientsRoutes.ts:320-327) — precisa da célula PRÓPRIA dela, nunca herdada de
    // patient_identity, pra registrar pelo `FamiliaresCard`/`PatientSupportNetworkEditDrawer`.
    grantCell(grupoCompleta, 'patient_family', 'write');
    grantCell(grupoCompleta, 'patient_family', 'read'); // sem ela `reads.family` fica falso e a ficha nunca decripta/devolve responsibles

    ({ groupId: grupoSemDocRead } = seedStaffInGroup({ uid: semDocRead.uid, email: semDocRead.email, groupName: `PR4H SemDocRead ${stamp}`, country: 'AR' }));
    grantCell(grupoSemDocRead, 'patient', 'read');
    grantCell(grupoSemDocRead, 'patient_identity', 'read');
    grantCell(grupoSemDocRead, 'patient_identity', 'write');
    // patient_consent_documents:read PROPOSITALMENTE ausente.
  });

  test.afterAll(() => {
    cleanupStaffAndGroup(completa.uid, grupoCompleta);
    cleanupStaffAndGroup(semDocRead.uid, grupoSemDocRead);
    // Ordem importa: `patient_image_consents` referencia `patient_documents` (FK composta
    // `pic_doc_fk`/`pic_revoke_doc_fk`) — apagar o documento primeiro derruba com 23503
    // (achado desta rodada: os testes novos 4-6 são os primeiros aqui a deixar as duas tabelas
    // povoadas ao mesmo tempo no fim do arquivo).
    runSQL(`DELETE FROM patient_photos WHERE patient_id = '${patientId}'`);
    runSQL(`DELETE FROM patient_image_consents WHERE patient_id = '${patientId}'`);
    runSQL(`DELETE FROM patient_documents WHERE patient_id = '${patientId}'`);
    cleanupPatientDeep(patientId);
  });

  async function abrirFicha(page: Page, u: MockUser): Promise<void> {
    // Só stack LOCAL: a URL v4 assinada (`PatientObjectStorageBase.getReadSignedUrl`) usa o HOST
    // do `apiEndpoint` configurado no cliente do `@google-cloud/storage` (`GCS_EMULATOR_HOST` —
    // comentário no topo daquele arquivo explica por que NÃO é `STORAGE_EMULATOR_HOST`), que
    // dentro do Docker é `fake-gcs:4443` — nome só resolvível DENTRO da rede do compose. O
    // navegador real do Playwright roda no HOST, sem esse DNS — sem isto, `fetch()` da URL
    // assinada dá `ERR_NAME_NOT_RESOLVED` (achado medido nesta mesma rodada, nada a ver com o
    // CORS do achado 1: aqui nem chega a fazer a requisição). Na stage/prod real isso não existe
    // (o host é `storage.googleapis.com`) — é puramente um artefato do fake-gcs-server local.
    await page.route('http://fake-gcs:4443/**', async (route) => {
      const url = new URL(route.request().url());
      url.protocol = 'http:';
      url.host = process.env.FAKE_GCS_PUBLIC_HOST ?? 'localhost:54443';
      await route.continue({ url: url.toString() });
    });
    await loginAs(page, u);
    await page.goto(`/admin/patients/${patientId}`);
    await expect(page.getByTestId('patient-identity-card')).toBeVisible({ timeout: 30_000 });
  }

  test('1. feliz: subir a foto (PNG real) → aparece a imagem; remover (confirmar) → volta ao placeholder', async ({ page }) => {
    await abrirFicha(page, completa);
    await expect(page.getByTestId('patient-photo-placeholder')).toBeVisible();

    await page.getByTestId('patient-photo-file-input').setInputFiles(PHOTO_FIXTURE);
    await expect(page.getByTestId('patient-photo-image')).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: path.join(EVID_DIR, '1-foto-subida.png'), fullPage: false });

    await page.getByTestId('patient-photo-remove-btn').click();
    await expect(page.getByTestId('patient-photo-remove-confirm')).toBeVisible();
    await page.getByTestId('patient-photo-remove-confirm-button').click();
    await expect(page.getByTestId('patient-photo-placeholder')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('patient-photo-remove-confirm')).toHaveCount(0);
    await page.screenshot({ path: path.join(EVID_DIR, '1b-foto-removida.png'), fullPage: false });
  });

  test('2. alternativo: ator SEM patient_consent_documents:read não vê a lista de documentos (elemento ausente, não só invisível)', async ({ page }) => {
    await abrirFicha(page, semDocRead);
    await expect(page.getByTestId('patient-documents-card')).toBeVisible();
    // Upload continua visível (tem patient_identity:write) — só a LISTA/leitura some.
    await expect(page.getByTestId('patient-document-upload-btn')).toBeVisible();
    await expect(page.getByTestId('patient-documents-list')).toHaveCount(0);
    // Achado 2 (prova da stage 15/09): no lugar da lista, um aviso — não fica em branco.
    await expect(page.getByTestId('patient-documents-no-permission')).toBeVisible();
    await page.screenshot({ path: path.join(EVID_DIR, '2-sem-patient-consent-documents-read.png'), fullPage: false });
  });

  test('2b. achado 2 (prova da stage 15/09): sem a célula de leitura — sobe documento, vê "Documento enviado", NUNCA chama GET .../documents', async ({ page }) => {
    const listDocsRequests: string[] = [];
    page.on('request', (req) => {
      if (req.method() === 'GET' && /\/api\/admin\/patients\/[^/]+\/documents$/.test(new URL(req.url()).pathname)) {
        listDocsRequests.push(req.url());
      }
    });

    await abrirFicha(page, semDocRead);
    await expect(page.getByTestId('patient-documents-no-permission')).toBeVisible();
    await expect(page.getByTestId('patient-document-upload-success')).toHaveCount(0);

    await page.getByTestId('patient-document-file-input').setInputFiles(PDF_FIXTURE);
    await expect(page.getByTestId('patient-document-upload-success')).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: path.join(EVID_DIR, '2b-documento-enviado-sem-permissao-leitura.png'), fullPage: false });

    // A prova central do achado 2: em NENHUM momento (mount, upload, reload da lista) o front
    // chamou GET .../documents sem a célula — 403 previsível nunca deveria ter sido tentado.
    expect(listDocsRequests).toEqual([]);

    // Limpeza: este teste sobe um documento REAL no paciente compartilhado (`mode: 'serial'`) —
    // sem apagar, o teste 4 (que espera lista VAZIA no mount) quebra por efeito colateral deste.
    runSQL(`DELETE FROM patient_documents WHERE patient_id = '${patientId}'`);
  });

  test('3. alternativo: arquivo inválido (PDF como foto) é recusado com mensagem de erro, sem crash', async ({ page }) => {
    await abrirFicha(page, completa);
    await page.getByTestId('patient-photo-file-input').setInputFiles(PDF_FIXTURE);
    await expect(page.getByTestId('patient-photo-error')).toBeVisible();
    await expect(page.getByTestId('patient-photo-placeholder')).toBeVisible();
    await expect(page.getByTestId('patient-identity-card')).toBeVisible(); // nada quebrou a tela
    await page.screenshot({ path: path.join(EVID_DIR, '3-arquivo-invalido.png'), fullPage: false });
  });

  test('4. feliz (furo fechado 14/09): enviar documento → page.reload() → documento continua listado', async ({ page }) => {
    await abrirFicha(page, completa);
    await expect(page.getByTestId('patient-documents-empty')).toBeVisible();

    await page.getByTestId('patient-document-upload-btn').click();
    await page.getByTestId('patient-document-file-input').setInputFiles(PDF_FIXTURE);
    await expect(page.getByTestId('patient-document-row')).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: path.join(EVID_DIR, '4-documento-enviado.png'), fullPage: false });

    await page.reload();
    await expect(page.getByTestId('patient-identity-card')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('patient-document-row')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('patient-documents-empty')).toHaveCount(0);
    await page.screenshot({ path: path.join(EVID_DIR, '4b-documento-apos-reload.png'), fullPage: false });
  });

  test('5. feliz (furo fechado 14/09): registrar representante → page.reload() → continua na tabela', async ({ page }) => {
    const nomeStamp = `Rep${stamp}`;
    await abrirFicha(page, completa);

    // Achado desta rodada (revisão gate): `FamiliaresCard`/`edit-support-btn` só montam sob a aba
    // "Rede de Apoio" (`PatientDetailPage.tsx` — `shownTab === 'supportNetwork'`, D286); o teste
    // nunca clicava na aba, então o botão nunca existia no DOM (timeout de 180s, não um 404/403).
    await page.getByText('Red de Apoyo').click();
    await page.getByTestId('edit-support-btn').click();
    await expect(page.getByTestId('patient-support-edit-drawer')).toBeVisible();
    await page.getByTestId('psn-add').click();
    await page.getByTestId('psn-firstName-0').click();
    await page.keyboard.type('Marta');
    await page.getByTestId('psn-lastName-0').click();
    await page.keyboard.type(nomeStamp);
    await page.getByTestId('psn-save').click();
    await expect(page.getByTestId('patient-support-edit-drawer')).toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByText(`Marta ${nomeStamp}`)).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: path.join(EVID_DIR, '5-representante-registrado.png'), fullPage: false });

    await page.reload();
    await expect(page.getByTestId('patient-identity-card')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByText(`Marta ${nomeStamp}`)).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: path.join(EVID_DIR, '5b-representante-apos-reload.png'), fullPage: false });
  });

  test('6. alternativo (furo fechado 14/09): consentimento registrado e depois revogado → page.reload() mostra o estado real em cada passo', async ({ page }) => {
    await abrirFicha(page, completa);
    await expect(page.getByTestId('patient-consent-register-btn')).toBeVisible();

    await page.getByTestId('patient-consent-register-btn').click();
    await expect(page.getByTestId('patient-consent-status')).toBeVisible({ timeout: 20_000 });

    // Recarregar ANTES de revogar: o vigente tem que sobreviver ao reload (não é mais sessão).
    await page.reload();
    await expect(page.getByTestId('patient-identity-card')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('patient-consent-status')).toBeVisible({ timeout: 20_000 });
    await page.screenshot({ path: path.join(EVID_DIR, '6-consentimento-vigente-apos-reload.png'), fullPage: false });

    await page.getByTestId('patient-consent-revoke-btn').click();
    await expect(page.getByTestId('patient-consent-register-btn')).toBeVisible({ timeout: 20_000 });

    // Recarregar DEPOIS de revogar: sem vigente — volta a mostrar "Registrar consentimento".
    await page.reload();
    await expect(page.getByTestId('patient-identity-card')).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId('patient-consent-register-btn')).toBeVisible({ timeout: 20_000 });
    await expect(page.getByTestId('patient-consent-status')).toHaveCount(0);
    await page.screenshot({ path: path.join(EVID_DIR, '6b-consentimento-revogado-apos-reload.png'), fullPage: false });
  });

  test('7. feliz (achado 1, prova da stage 15/09): ator COM a célula abre o documento pelo botão "Abrir" — interação humana, abre por blob:', async ({ page, context }) => {
    await abrirFicha(page, completa);
    // Documento já existe (enviado no teste 4, `mode: 'serial'` preserva estado do paciente).
    await expect(page.getByTestId('patient-document-row')).toBeVisible({ timeout: 20_000 });

    // Prova do conserto pelo LADO DA REDE: o `fetch()` (contrato — abre por `blob:`, nunca
    // navegação direta) precisa completar 200 na URL assinada antes do `window.open`. Não
    // inspecionamos `popup.url()`: o Chrome roteia `blob:` de PDF pro visualizador NATIVO, e o
    // CDP não expõe a URL desse alvo de forma estável (medido: fica em ":" os 20s inteiros, aba
    // correta aberta — mesma classe de quirk do `pdf-no-navegador-react-pdf`).
    let signedUrlStatus: number | undefined;
    page.on('response', (res) => {
      if (res.request().method() === 'GET' && res.url().includes('/patient-documents/')) {
        signedUrlStatus = res.status();
      }
    });

    const [popup] = await Promise.all([
      context.waitForEvent('page'), // window.open('_blank') — só dispara se o fetch+blob deu certo
      page.getByTestId('patient-document-open-btn').first().click(),
    ]);

    await expect.poll(() => signedUrlStatus, { timeout: 20_000 }).toBe(200);
    await expect(page.getByTestId('patient-documents-error')).toHaveCount(0);
    await page.screenshot({ path: path.join(EVID_DIR, '7-documento-aberto-blob.png'), fullPage: false });
    await popup.close();
  });
});
