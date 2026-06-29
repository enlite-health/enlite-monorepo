/**
 * postularse-journey.integration.e2e.ts @integration
 *
 * Real-stack, real-screens journey of a worker postulating to a public vacancy.
 * Frontend real + backend real (USE_MOCK_AUTH=true) + Postgres real. The worker
 * is NOT injected into the DB — it registers THROUGH the real UI (form fields,
 * MultiSelects, availability slots, document uploads), exactly like a human.
 *
 * Covers, end-to-end, for BOTH professions (AT and CAREGIVER/Cuidador):
 *   1. Anonymous → clicks Postularse → "Registro requerido" (login warning)
 *   2. Registers (login) → worker auto-provisioned in INCOMPLETE_REGISTER
 *   3. Postularse with empty profile → 403, blocking modal lists the
 *      profession-specific missing documents; WhatsApp is NOT opened
 *   4. Fills General tab only → Postularse → STILL 403, but personal fields
 *      no longer listed (partial progress reflected)
 *   5. Completes ONLY the mandatory remainder via the real screens
 *      (address + availability + required docs for the profession)
 *   6. Postularse → 200 (not 403) → window.open called with the EXACT
 *      talentum_whatsapp_url; backend worker status flips to REGISTERED
 *
 * Strong WhatsApp assertion (fixes the staging `status || /wa\.me/` gap):
 *   expect(openedUrls).toContain(WHATSAPP_URL) AND expect(track).not.toBe(403)
 *
 * Pré-condições:
 *   cd worker-functions && docker compose -f docker-compose.yml -f docker-compose.test.yml up -d postgres api
 *   cd enlite-frontend && pnpm dev
 * Run: pnpm test:e2e:integration
 */

import { test, expect, type Page } from '@playwright/test';
import {
  insertMinimalVacancy,
  cleanupMinimalVacancy,
  cleanupWorkerByAuthUid,
  getWorkerStatusByAuthUid,
} from '../helpers/eligibility-worker-helper';
import { loginNewWorker } from '../helpers/worker-realreg-auth-helper';
import { installGoogleMapsFake } from '../helpers/google-maps-fake';
import {
  fillGeneralInfo,
  fillServiceAddress,
  fillAvailability,
  uploadRequiredDocs,
  type Profession,
} from '../helpers/worker-registration-ui-helper';

const WHATSAPP_URL = 'https://wa.me/5491155550123';

test.describe('@integration Postularse journey — real screens (AT + Cuidador)', () => {
  let vacancyId: string;
  const authUids: string[] = [];

  test.beforeAll(() => {
    vacancyId = insertMinimalVacancy({ talentumWhatsappUrl: WHATSAPP_URL });
  });

  test.afterAll(() => {
    for (const uid of authUids) cleanupWorkerByAuthUid(uid);
    cleanupMinimalVacancy(vacancyId);
  });

  /** Installs window.open capture + tracks the last track-channel HTTP status. */
  function instrument(page: Page): { lastTrack: () => number | null } {
    let last: number | null = null;
    page.on('response', (r) => {
      if (r.url().includes('/api/worker-applications/track-channel')) last = r.status();
    });
    return { lastTrack: () => last };
  }

  async function openedUrls(page: Page): Promise<string[]> {
    return page.evaluate(() => (window as unknown as { __openedUrls?: string[] }).__openedUrls ?? []);
  }

  async function gotoVacancyAndPostularse(page: Page): Promise<void> {
    await page.goto(`/vacantes/${vacancyId}`, { waitUntil: 'networkidle', timeout: 30_000 });
    const btn = page.getByRole('button', { name: /Postularse/i });
    await expect(btn).toBeVisible({ timeout: 15_000 });
    await btn.click();
  }

  async function runJourney(page: Page, profession: Profession): Promise<void> {
    test.setTimeout(180_000);
    const slug = profession.toLowerCase();
    const authUid = `e2e-journey-${slug}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const email = `${authUid}@test.local`;
    authUids.push(authUid);

    // Capture window.open (the WhatsApp redirect) without opening real tabs.
    await page.addInitScript(() => {
      (window as unknown as { __openedUrls: string[] }).__openedUrls = [];
      window.open = ((u?: string | URL) => {
        (window as unknown as { __openedUrls: string[] }).__openedUrls.push(String(u));
        return null;
      }) as typeof window.open;
    });
    await installGoogleMapsFake(page);
    const { lastTrack } = instrument(page);

    // ── 1. Anonymous → login warning ─────────────────────────────────────────
    await gotoVacancyAndPostularse(page);
    await expect(page.locator('text=/Registro requerido/i').first()).toBeVisible({ timeout: 10_000 });
    await expect(page.getByRole('button', { name: /Registrarse/i })).toBeVisible({ timeout: 5_000 });
    expect(await openedUrls(page), 'no WhatsApp before registration').toHaveLength(0);

    // ── 2. Register (login) → worker provisioned INCOMPLETE_REGISTER ──────────
    await loginNewWorker(page, authUid, email);

    // ── 3. Empty profile → blocked, universal fields listed ───────────────────
    // profession is still NULL here (treated as AT by the gate), so the empty
    // modal lists personal fields + the universal docs. The profession-specific
    // difference is asserted at step 4, once the worker has chosen a profession.
    await gotoVacancyAndPostularse(page);
    const blockedModal = page.locator('.fixed.inset-0 > div').first();
    await expect(page.locator('text=/Registro incompleto/i').first()).toBeVisible({ timeout: 10_000 });
    expect(lastTrack(), 'track-channel must be 403 when empty').toBe(403);
    expect(await openedUrls(page), 'no WhatsApp while blocked').toHaveLength(0);
    await expect(blockedModal).toContainText('Datos personales y profesionales');
    await expect(blockedModal).toContainText('Nombre');
    await expect(blockedModal).toContainText('Documentos');
    await expect(blockedModal).toContainText('Documento de identidad');
    await expect(blockedModal).toContainText('Antecedentes penales');
    await expect(blockedModal).toHaveScreenshot(`journey-${slug}-blocked-empty.png`, { maxDiffPixels: 150 });

    // ── 4. Fill General only → still blocked; profession-specific docs + no personal ──
    await fillGeneralInfo(page, profession);
    await gotoVacancyAndPostularse(page);
    const partialModal = page.locator('.fixed.inset-0 > div').first();
    await expect(page.locator('text=/Registro incompleto/i').first()).toBeVisible({ timeout: 10_000 });
    expect(lastTrack(), 'still 403 after only General').toBe(403);
    await expect(partialModal).toContainText('Documentos');
    // Personal fields are now complete → "Nombre" must no longer be listed.
    await expect(partialModal).not.toContainText('Nombre');
    // Documents adapt to the chosen profession.
    await expect(partialModal).toContainText('Documento de identidad');
    await expect(partialModal).toContainText('Antecedentes penales');
    if (profession === 'AT') {
      await expect(partialModal).toContainText('Certificado de Acompañante Terapéutico');
      await expect(partialModal).toContainText('Currículum vitae');
    } else {
      await expect(partialModal).not.toContainText('Certificado de Acompañante Terapéutico');
    }
    await expect(partialModal).toHaveScreenshot(`journey-${slug}-blocked-partial.png`, { maxDiffPixels: 150 });

    // ── 5. Complete ONLY the mandatory remainder via the real screens ─────────
    await fillServiceAddress(page);
    await fillAvailability(page);
    await uploadRequiredDocs(page, profession);

    // ── 6. Postularse → WhatsApp (strong assertion) ───────────────────────────
    await gotoVacancyAndPostularse(page);
    await expect
      .poll(async () => (await openedUrls(page)).length, { timeout: 15_000 })
      .toBeGreaterThan(0);
    expect(lastTrack(), 'eligible → not 403').not.toBe(403);
    expect(await openedUrls(page), 'opens the exact vacancy WhatsApp URL').toContain(WHATSAPP_URL);
    await expect(page.locator('text=/Registro incompleto/i')).toHaveCount(0);
    expect(getWorkerStatusByAuthUid(authUid), 'worker promoted to REGISTERED').toBe('REGISTERED');
  }

  test('Cuidador (CAREGIVER): no-reg → login → bloqueio → completa → WhatsApp', async ({ page }) => {
    await runJourney(page, 'CAREGIVER');
  });

  test('Acompañante Terapéutico (AT): no-reg → login → bloqueio → completa → WhatsApp', async ({ page }) => {
    await runJourney(page, 'AT');
  });
});
