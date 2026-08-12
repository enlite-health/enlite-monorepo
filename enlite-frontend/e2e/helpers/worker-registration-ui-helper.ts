/**
 * worker-registration-ui-helper.ts
 *
 * Drives the REAL worker registration UI (/worker/profile) the way a human
 * would: typing into fields, picking selects, opening MultiSelect dropdowns,
 * adding availability slots and uploading documents via the file input.
 *
 * Used by postularse-journey.integration.e2e.ts against the Docker backend.
 * No DB injection — every save hits the real PUT /api/workers/me/* endpoints,
 * which call recalculateStatus() and flip the worker to REGISTERED once the
 * fn_worker_missing_fields gate is satisfied.
 *
 * Selectors verified against:
 *   GeneralInfoFormFields.tsx, MultiSelect.tsx, ServiceAddressTab.tsx,
 *   GooglePlacesAutocomplete.tsx, DayScheduleEditor.tsx, DocumentsGrid.tsx,
 *   DocumentUploadCard.tsx.
 */

import { fileURLToPath } from 'url';
import { type Page, expect } from '@playwright/test';

export type Profession = 'AT' | 'CAREGIVER';

const FIXTURE_PDF = fileURLToPath(new URL('../fixtures/sample.pdf', import.meta.url));

/** Documents the fn_worker_missing_fields gate requires per profession (mig 212). */
export function requiredDocsFor(profession: Profession): string[] {
  const base = ['identity_document', 'criminal_record'];
  return profession === 'AT' ? [...base, 'resume_cv', 'at_certificate'] : base;
}

async function gotoProfileTab(page: Page, tab: 'general' | 'address' | 'availability' | 'documents'): Promise<void> {
  await page.goto(`/worker/profile?tab=${tab}`, { waitUntil: 'networkidle', timeout: 30_000 });
  await expect(page.locator(`[data-testid="tab-btn-${tab}"]`)).toBeVisible({ timeout: 20_000 });
  await page.locator(`[data-testid="tab-btn-${tab}"]`).click();
  // Let the tab's own getProgress()/reset() settle before interacting.
  await page.waitForTimeout(1_500);
}

/** Opens a MultiSelect by testId, picks the first option, closes the dropdown. */
async function selectFirstMultiSelectOption(page: Page, testId: string): Promise<void> {
  const trigger = page.locator(`[data-testid="${testId}-trigger"]`);
  if (!(await trigger.isVisible({ timeout: 5_000 }).catch(() => false))) return;
  await trigger.click();
  const dropdown = page.locator(`[data-testid="${testId}-dropdown"]`);
  if (!(await dropdown.isVisible({ timeout: 3_000 }).catch(() => false))) return;
  await dropdown.locator('div').first().click().catch(() => undefined);
  await page.mouse.click(10, 10); // close (component closes on outside mousedown)
  await page.waitForTimeout(200);
}

/**
 * Fills EVERY personal/professional field the gate requires and saves.
 * Asserts the PUT /api/workers/me/general-info returned 2xx.
 */
export async function fillGeneralInfo(page: Page, profession: Profession): Promise<void> {
  await gotoProfileTab(page, 'general');

  // Phone and document have backend uniqueness — generate unique values so
  // parallel AT/CAREGIVER journeys don't collide (409 PHONE_NOT_AVAILABLE).
  const rand8 = (): string => String(Math.floor(Math.random() * 1e8)).padStart(8, '0');
  const uniquePhone = `11${rand8()}`; // 10 digits, AR national
  const uniqueCuil = `20-${rand8()}-9`; // 13 chars, passes maskCuilCuit

  await page.locator('input#fullName').fill('Worker');
  await page.locator('input#lastName').fill('JourneyE2E');

  const phone = page.locator('input[type="tel"]').first();
  if (await phone.isVisible({ timeout: 5_000 }).catch(() => false)) {
    await phone.fill(uniquePhone);
  }
  await page.locator('input#birthDate').fill('01/01/1990');
  await page.locator('input#cpf').fill(uniqueCuil);
  await page.locator('select#sex').selectOption('male');
  await page.locator('select#gender').selectOption('male');
  await page.locator('select#profession').selectOption(profession);
  await page.locator('select#knowledgeLevel').selectOption('TERTIARY');
  await page.locator('input#professionalLicense').fill('Cert-Journey-E2E');
  await page.locator('select#yearsExperience').selectOption('0_2');

  await selectFirstMultiSelectOption(page, 'languages');
  await selectFirstMultiSelectOption(page, 'experience-types');
  await selectFirstMultiSelectOption(page, 'preferred-types');
  await selectFirstMultiSelectOption(page, 'preferred-age-range');

  const saved = page.waitForResponse(
    (r) => r.url().includes('/api/workers/me/general-info') && r.request().method() === 'PUT',
    { timeout: 15_000 },
  );
  // Não há mais botão Guardar — o formulário salva sozinho no blur (autosave).
  // Tirar o foco de um campo dispara o PUT /general-info.
  await page.locator('input#fullName').click();
  await page.locator('input#fullName').blur();
  const resp = await saved;
  expect(resp.status(), 'PUT general-info should succeed').toBeLessThan(400);
}

/**
 * Selects an address via the faked Google autocomplete and saves.
 * Asserts the PUT /api/workers/me/service-area returned 2xx.
 */
export async function fillServiceAddress(page: Page): Promise<void> {
  await gotoProfileTab(page, 'address');

  const saved = page.waitForResponse(
    (r) => r.url().includes('/api/workers/me/service-area') && r.request().method() === 'PUT',
    { timeout: 15_000 },
  );
  // Typing >3 chars triggers the faked place_changed → onPlaceSelected → autosave.
  await page.locator('[data-testid="address-autocomplete-input"]').fill('Av. Corrientes 1234');
  await page.waitForTimeout(1_000);
  const resp = await saved;
  expect(resp.status(), 'PUT service-area should succeed').toBeLessThan(400);
}

/**
 * Adds one availability slot (Monday, default 09:00–17:00) and saves.
 * Asserts the PUT /api/workers/me/availability returned 2xx.
 */
export async function fillAvailability(page: Page): Promise<void> {
  await gotoProfileTab(page, 'availability');
  await expect(page.locator('[data-testid="day-schedule-editor"]')).toBeVisible({ timeout: 10_000 });

  const saved = page.waitForResponse(
    (r) => r.url().includes('/api/workers/me/availability') && r.request().method() === 'PUT',
    { timeout: 15_000 },
  );
  await page.locator('[data-testid="day-schedule-add-monday"]').click();
  await page.waitForTimeout(800);
  const resp = await saved;
  expect(resp.status(), 'PUT availability should succeed').toBeLessThan(400);
}

/**
 * Uploads each required document via the real file input. The 3-step flow
 * (upload-url → mock-gcs PUT → documents/save) runs against the real backend;
 * only the opaque GCS PUT is intercepted (see worker-realreg-auth-helper).
 * Asserts the documents/save POST returned 2xx and the slot shows uploaded.
 */
export async function uploadRequiredDocs(page: Page, profession: Profession): Promise<void> {
  await gotoProfileTab(page, 'documents');

  for (const docType of requiredDocsFor(profession)) {
    const slot = page.locator(`[data-testid="doc-slot-${docType}"]`);
    await expect(slot, `doc slot ${docType} should be visible`).toBeVisible({ timeout: 10_000 });

    const saved = page.waitForResponse(
      (r) => r.url().includes('/api/workers/me/documents/save') && r.request().method() === 'POST',
      { timeout: 20_000 },
    );
    await slot.locator('input[type="file"]').setInputFiles(FIXTURE_PDF);
    const resp = await saved;
    expect(resp.status(), `documents/save for ${docType} should succeed`).toBeLessThan(400);

    await expect(
      slot.locator('[data-state="uploaded"]'),
      `slot ${docType} should render uploaded`,
    ).toBeVisible({ timeout: 10_000 });
  }
}
