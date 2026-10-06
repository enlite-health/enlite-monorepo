/**
 * cid-na-vaga-publica.integration.e2e.ts @integration — spec 042 (D473, 05/10/2026).
 *
 * `/vacantes/:id` (página pública, sem auth) contra backend + Postgres REAIS, sem `page.route`
 * nem qualquer interceptação da API. Prova que a seção "Patología" mostra SÓ o NOME de catálogo
 * do CID principal (sem código) e que, sem rótulo, a seção NÃO existe — nem o texto livre do
 * paciente aparece.
 *
 *   E1 feliz: 1 CID principal → título sintético + heading "Patología" visíveis; sem o código.
 *   E2: paciente só com texto livre (0 CID) → sem heading "Patología" e sem o texto livre.
 *   E3: 2+ CID ativos sem principal → sem heading "Patología".
 *
 * `describe.serial`: E2/E3 só valem como prova de AUSÊNCIA se o E1 achou o rótulo (contagem zero
 * é falha). Serial faz E2/E3 serem PULADOS se o E1 falhar; além disso cada um confirma que a
 * página renderizou ("Características:" visível) antes de afirmar a ausência.
 *
 * Dado sintético: título `Diagnóstico sintético QA`, código `ZZ99.Z`, texto livre
 * `texto livre sintético QA`. Seed por `docker exec psql` (mesmo padrão de
 * `vacancy-de-baja-pagina-publica.integration.e2e.ts`); `patient_diagnoses` sai por
 * ON DELETE CASCADE com o paciente.
 *
 * Pré-condições: docker (postgres + api desta worktree) + pnpm dev.
 * Run: PW_BASE_URL=<url> E2E_PG_CONTAINER=<container> pnpm test:e2e:integration --grep "cid-na-vaga-publica"
 */

import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import { insertTestPatient, cleanupTestPatient, insertBaseVacancy } from '../helpers/db-test-helper';

const CONTAINER = process.env.E2E_PG_CONTAINER || 'enlite-postgres';
const DB_USER = 'enlite_admin';
const DB_NAME = 'enlite_e2e';

const TITULO = 'Diagnóstico sintético QA';
const TITULO_B = 'Diagnóstico sintético QA B';
const CODIGO = 'ZZ99.Z';
const TEXTO_LIVRE = 'texto livre sintético QA';

function runSQL(sql: string): string {
  const escaped = sql.replace(/'/g, "'\\''");
  try {
    return execSync(`docker exec ${CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} -c '${escaped}'`, { stdio: 'pipe' }).toString();
  } catch (err: unknown) {
    const error = err as { stderr?: Buffer; message?: string };
    throw new Error(`DB error: ${error.stderr?.toString() ?? error.message}`);
  }
}

function insertDiagnosis(patientId: string, titulo: string, codigo: string, uriSufixo: string, principal: boolean): void {
  runSQL(`INSERT INTO patient_diagnoses (
            patient_id, terminology_system, concept_uri, concept_code, concept_title,
            concept_language, concept_group, catalog_release, source, is_primary, active,
            created_by, updated_by
          ) VALUES (
            '${patientId}', 'ICD-11', 'http://e2e.local/cidvaga/${uriSufixo}', '${codigo}',
            '${titulo}', 'es', '06', '2026-01', 'PANEL', ${principal}, true, 'e2e', 'e2e'
          )`);
}

function semearVaga(): { patientId: string; vacancyId: string } {
  const { patientId, addressId } = insertTestPatient({ withAddress: true, diagnosis: TEXTO_LIVRE });
  const caseNumber = Math.floor(Math.random() * 90000) + 10000;
  const vacancyId = insertBaseVacancy({
    patientId,
    patientAddressId: addressId!,
    caseNumber,
    status: 'SEARCHING',
    isDraft: false,
  });
  return { patientId, vacancyId };
}

test.describe.serial('@integration Página pública da vaga — nome do CID principal (spec 042)', () => {
  test.setTimeout(60_000);

  const patientIds: string[] = [];

  test.afterAll(() => {
    for (const id of patientIds) cleanupTestPatient(id);
    for (const id of patientIds) {
      const sobra = runSQL(`SELECT count(*) FROM patient_diagnoses WHERE patient_id = '${id}'`);
      if (!/\b0\b/.test(sobra)) throw new Error(`patient_diagnoses não saiu por cascade para ${id}`);
    }
  });

  test('E1 feliz: CID principal → título sintético + heading "Patología" visíveis, sem o código', async ({ page }) => {
    const { patientId, vacancyId } = semearVaga();
    patientIds.push(patientId);
    insertDiagnosis(patientId, TITULO, CODIGO, 'a', true);

    await page.goto(`/vacantes/${vacancyId}`, { waitUntil: 'networkidle', timeout: 30_000 });

    await expect(page.getByRole('heading', { name: 'Patología' })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(TITULO, { exact: true })).toBeVisible();
    // Código e texto livre nunca saem — nem no texto visível nem no HTML inteiro.
    const visivel = await page.locator('body').innerText();
    const html = await page.content();
    for (const proibido of [CODIGO, 'ZZ99', TEXTO_LIVRE]) {
      expect(visivel).not.toContain(proibido);
      expect(html).not.toContain(proibido);
    }
  });

  test('E2 só texto livre (0 CID): sem heading "Patología" e sem o texto livre', async ({ page }) => {
    const { patientId, vacancyId } = semearVaga();
    patientIds.push(patientId);

    await page.goto(`/vacantes/${vacancyId}`, { waitUntil: 'networkidle', timeout: 30_000 });

    // A página renderizou (senão a ausência abaixo seria vácuo).
    await expect(page.getByText('Características:')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Patología' })).toHaveCount(0);
    expect(await page.locator('body').innerText()).not.toContain(TEXTO_LIVRE);
    expect(await page.content()).not.toContain(TEXTO_LIVRE);
  });

  test('E3 2+ CID ativos sem principal: nenhum heading "Patología", nenhum dos títulos', async ({ page }) => {
    const { patientId, vacancyId } = semearVaga();
    patientIds.push(patientId);
    insertDiagnosis(patientId, TITULO, CODIGO, 'a', false);
    insertDiagnosis(patientId, TITULO_B, 'ZZ99.Y', 'b', false);

    await page.goto(`/vacantes/${vacancyId}`, { waitUntil: 'networkidle', timeout: 30_000 });

    await expect(page.getByText('Características:')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('heading', { name: 'Patología' })).toHaveCount(0);
    const visivel = await page.locator('body').innerText();
    expect(visivel).not.toContain(TITULO);
    expect(visivel).not.toContain(TEXTO_LIVRE);
  });
});
