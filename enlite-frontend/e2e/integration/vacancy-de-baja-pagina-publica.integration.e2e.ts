/**
 * vacancy-de-baja-pagina-publica.integration.e2e.ts @integration
 *
 * Lacuna do PR #553 (change baja-vacante-por-servico): a implementação só tinha
 * `PublicVacancyPage.deBaja.test.tsx` (unit — mocka `PublicApiService.getVacancy`,
 * não sobe a app real). Este arquivo é o e2e de TELA que faltava — `/vacantes/:id`
 * (página pública, sem auth) contra backend + Postgres reais, sem `page.route`
 * forjando o payload da vaga.
 *
 * Três casos:
 *   a) vaga DE_BAJA (serviço contratado ligado deu baixa) → a página ABRE com
 *      200 (não 404), mostra o badge "Dada de baja" e NÃO oferece candidatura —
 *      mesmo com `talentum_whatsapp_url` preenchido de propósito (prova que o
 *      botão some pelo `is_disabled`, não por falta de link).
 *   b) vaga em status publicável (SEARCHING) → abre normal e OFERECE
 *      candidatura — prova que o teste DISTINGUE o caso (a), não que toda vaga
 *      esconde o botão.
 *   c) vaga inexistente → continua caindo no "não encontrada" — prova que a
 *      allow-list nova (`STATUS_DETALHE_PUBLICO`) não abriu a rota geral.
 *
 * Frontend real + backend real (PublicVacancyController, sem auth) + Postgres
 * real. DB helpers reaproveitados de `db-test-helper.ts` (insertTestPatient/
 * insertBaseVacancy/cleanupTestPatient) e `eligibility-worker-helper.ts`
 * (insertMinimalVacancy/cleanupMinimalVacancy) — nenhum dos dois cobre "vaga
 * DE_BAJA com link preenchido", então o UPDATE pontual usa o MESMO padrão
 * `docker exec ... psql` já usado em `admin-vacancies-edit-routing.integration.e2e.ts`
 * (runSQL local, sem tocar nos helpers compartilhados).
 *
 * Pré-condições: docker (postgres + api desta worktree) + pnpm dev.
 * Run: PW_BASE_URL=<url> E2E_PG_CONTAINER=<container> pnpm test:e2e:integration
 *      --grep "vaga DE_BAJA"
 */

import { test, expect } from '@playwright/test';
import { execSync } from 'child_process';
import { insertTestPatient, cleanupTestPatient, insertBaseVacancy } from '../helpers/db-test-helper';
import { insertMinimalVacancy, cleanupMinimalVacancy } from '../helpers/eligibility-worker-helper';

// ── DB: UPDATE pontual (mesmo padrão de admin-vacancies-edit-routing.integration.e2e.ts) ──

const CONTAINER = process.env.E2E_PG_CONTAINER || 'enlite-postgres';
const DB_USER = 'enlite_admin';
const DB_NAME = 'enlite_e2e';

function runSQL(sql: string): string {
  const escaped = sql.replace(/'/g, "'\\''");
  try {
    return execSync(
      `docker exec ${CONTAINER} psql -U ${DB_USER} -d ${DB_NAME} -c '${escaped}'`,
      { stdio: 'pipe' },
    ).toString();
  } catch (err: unknown) {
    const error = err as { stderr?: Buffer; message?: string };
    throw new Error(`DB error: ${error.stderr?.toString() ?? error.message}`);
  }
}

/** Preenche o link do WhatsApp de propósito — o botão precisa sumir pelo `is_disabled`. */
function setVacancyTalentumWhatsappUrl(vacancyId: string, url: string): void {
  runSQL(`UPDATE job_postings SET talentum_whatsapp_url = '${url}' WHERE id = '${vacancyId}'`);
}

test.describe('@integration Página pública da vaga — DE_BAJA continua servindo (change baja-vacante-por-servico)', () => {
  test.setTimeout(60_000);

  const patientIds: string[] = [];
  const minimalVacancyIds: string[] = [];

  test.afterAll(() => {
    for (const id of patientIds) cleanupTestPatient(id);
    for (const id of minimalVacancyIds) cleanupMinimalVacancy(id);
  });

  test('a) vaga DE_BAJA abre (não 404), mostra o estado desativado e NÃO oferece candidatura', async ({ page }) => {
    const { patientId, addressId } = insertTestPatient({ withAddress: true });
    patientIds.push(patientId);
    const caseNumber = Math.floor(Math.random() * 90000) + 10000; // >= 1000 → formatCaseNumber prefixa "EN"
    const vacancyId = insertBaseVacancy({
      patientId,
      patientAddressId: addressId!,
      caseNumber,
      status: 'DE_BAJA',
      isDraft: false,
    });
    setVacancyTalentumWhatsappUrl(vacancyId, 'https://wa.me/5491100000900');

    await page.goto(`/vacantes/${vacancyId}`, { waitUntil: 'networkidle', timeout: 30_000 });

    await expect(page.getByText(new RegExp(`CASO EN${caseNumber}-\\d+`))).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('Dada de baja', { exact: true })).toBeVisible();
    await expect(page.getByText('Esta vacante fue dada de baja y ya no acepta postulaciones.')).toBeVisible();
    // O botão não é só invisível — não existe no DOM (o JSX condiciona a render inteira a `!is_disabled`).
    await expect(page.getByRole('button', { name: 'Postularse' })).toHaveCount(0);
    await expect(page.getByText('Vacante no encontrada')).not.toBeVisible();
  });

  test('b) vaga em status publicável (SEARCHING) abre normal e OFERECE candidatura', async ({ page }) => {
    const vacancyId = insertMinimalVacancy({ talentumWhatsappUrl: 'https://wa.me/5491100000901' });
    minimalVacancyIds.push(vacancyId);

    await page.goto(`/vacantes/${vacancyId}`, { waitUntil: 'networkidle', timeout: 30_000 });

    const postularseBtn = page.getByRole('button', { name: 'Postularse' });
    await expect(postularseBtn).toBeVisible({ timeout: 15_000 });
    await expect(postularseBtn).toBeEnabled();
    await expect(page.getByText('Esta vacante fue dada de baja y ya no acepta postulaciones.')).not.toBeVisible();
    await expect(page.getByText('Vacante no encontrada')).not.toBeVisible();
  });

  test('c) vaga inexistente continua caindo no "não encontrada" (404 legítimo preservado)', async ({ page }) => {
    const nonExistentId = '00000000-0000-4000-8000-000000000000';

    // `networkidle` não é alcançado de forma confiável aqui (medido) — o "não encontrada"
    // já renderiza a tempo; a espera fica por conta do `expect(...).toBeVisible` abaixo.
    await page.goto(`/vacantes/${nonExistentId}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });

    await expect(page.getByText('Vacante no encontrada')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText('La vacante que busca no existe o ya no está disponible.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Postularse' })).toHaveCount(0);
  });
});
