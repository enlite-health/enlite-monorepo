/**
 * patient-photo-pr4.integration.e2e.ts @integration
 *
 * Spec 018 PR-4 (foto do paciente) contra o stack REAL (frontend + API + Postgres, engine de
 * permissão LIGADO), zero mock de API: click + `setInputFiles` (upload real) + valor lido da
 * TELA. Molde: `patient-header-pr3.integration.e2e.ts` (`abac-stack-helper.ts` para grupo/célula
 * real via ABAC).
 *
 * Documentos y consentimiento de imagen (que vivia neste mesmo arquivo, antes chamado
 * `patient-photo-documents-pr4.integration.e2e.ts`) foi REMOVIDO por completo
 * (fix/018-remover-documentos-consentimento) — só a foto fica.
 *
 * O que se prova:
 *   1. feliz — subir a foto (arquivo PNG real via `setInputFiles`) → aparece a `<img>`; remover
 *      (confirmar no modal) → volta ao placeholder.
 *   2. alternativo — arquivo inválido (PDF como foto) é recusado com mensagem de erro na tela,
 *      sem crash.
 *
 * Stack local (ver docker-compose.018pr4-ports.yml + engine ligado):
 *   docker compose -p 018pr4c -f docker-compose.yml -f docker-compose.test.yml \
 *     -f docker-compose.018pr4-ports.yml -f /tmp/pr4-engine.yml up -d postgres fake-gcs api
 *   (bucket criado via POST http://localhost:54443/storage/v1/b antes de subir a API)
 *   psql ... -c "INSERT INTO iam.rollout_state ... VALUES ('permission_groups_migrated','done',...)"
 *   cd enlite-frontend && npx vite --port 5183 --strictPort
 *   PW_BASE_URL=http://localhost:5183 npx playwright test patient-photo-pr4 --project=integration
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

test.describe('spec 018 PR-4 — foto do paciente: HUMANO no stack real, engine LIGADO @integration', () => {
  test.describe.configure({ mode: 'serial' });
  test.setTimeout(180_000);

  const stamp = Date.now().toString().slice(-6);
  let patientId: string;
  const completa: MockUser = { uid: `pr4h-completa-${stamp}`, email: `pr4h-completa-${stamp}@e2e.local`, role: 'admin', country: 'AR' };
  let grupoCompleta: string;

  test.beforeAll(() => {
    const { patientId: pid } = insertTestPatient({ status: 'ACTIVE', firstName: 'FotoPR4', lastName: `Humano${stamp}` });
    patientId = pid;

    ({ groupId: grupoCompleta } = seedStaffInGroup({ uid: completa.uid, email: completa.email, groupName: `PR4H Completa ${stamp}`, country: 'AR' }));
    grantCell(grupoCompleta, 'patient', 'read');
    grantCell(grupoCompleta, 'patient_identity', 'read');
    grantCell(grupoCompleta, 'patient_identity', 'write');
  });

  test.afterAll(() => {
    cleanupStaffAndGroup(completa.uid, grupoCompleta);
    runSQL(`DELETE FROM patient_photos WHERE patient_id = '${patientId}'`);
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

  test('2. alternativo: arquivo inválido (PDF como foto) é recusado com mensagem de erro, sem crash', async ({ page }) => {
    await abrirFicha(page, completa);
    await page.getByTestId('patient-photo-file-input').setInputFiles(PDF_FIXTURE);
    await expect(page.getByTestId('patient-photo-error')).toBeVisible();
    await expect(page.getByTestId('patient-photo-placeholder')).toBeVisible();
    await expect(page.getByTestId('patient-identity-card')).toBeVisible(); // nada quebrou a tela
    await page.screenshot({ path: path.join(EVID_DIR, '2-arquivo-invalido.png'), fullPage: false });
  });
});
