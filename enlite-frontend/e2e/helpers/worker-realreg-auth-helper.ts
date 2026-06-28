/**
 * worker-realreg-auth-helper.ts
 *
 * Auth helper for the REAL registration journey (postularse-journey.integration.e2e.ts).
 *
 * Difference from worker-auth-helper.ts:
 *   worker-auth-helper STUBS /api/workers/me, /api/workers/init,
 *   /api/workers/me/availability and /api/workers/me/documents — perfect for
 *   testing the modal against a DB-injected worker, but useless when we want
 *   the worker to register THROUGH the real UI.
 *
 * This helper passes ALL /api/** calls through to the real Docker backend
 * (USE_MOCK_AUTH=true) so the worker is provisioned via POST /api/workers/init
 * and completed via the real PUT /api/workers/me/* + documents endpoints.
 *
 * Only two things are faked, because they are external/opaque dependencies
 * (never the system under test):
 *   - Firebase Identity Toolkit / secure token  → fake id_token (never validated)
 *   - GCS signed-upload PUT (mock-gcs-upload)    → 200 (backend still persists
 *     the filePath via documents/save and recalculates the worker status)
 */

import { type Page, type Route, expect } from '@playwright/test';
import { buildMockToken, buildFakeIdToken } from './worker-auth-helper';

async function injectMockAuthIntoLocalStorage(
  page: Page,
  authUid: string,
  email: string,
  fakeIdToken: string,
): Promise<void> {
  const payload = JSON.stringify({
    uid: authUid,
    email,
    stsTokenManager: { accessToken: fakeIdToken, expirationTime: Date.now() + 3600_000 },
  });
  await page.addInitScript((p: string) => {
    localStorage.setItem('enlite_e2e_mock_auth', p);
  }, payload);
  try {
    await page.evaluate((p: string) => localStorage.setItem('enlite_e2e_mock_auth', p), payload);
  } catch {
    // no page context yet — addInitScript covers the next navigation
  }
}

/**
 * Installs interceptors for a real-registration worker session:
 * - Firebase endpoints → fake token
 * - mock-gcs-upload PUT → 200 (opaque storage)
 * - /api/admin/auth/profile → 401 (no admin redirect)
 * - every other /api/** → pass-through with Authorization: Bearer mock_<base64>
 */
export async function installRealRegInterceptors(
  page: Page,
  authUid: string,
  email: string,
): Promise<void> {
  const fakeIdToken = buildFakeIdToken(authUid, email);
  const mockToken = buildMockToken(authUid, email);

  await injectMockAuthIntoLocalStorage(page, authUid, email, fakeIdToken);

  await page.route('**/identitytoolkit.googleapis.com/**', async (route: Route) => {
    const url = route.request().url();
    if (url.includes('signInWithPassword') || url.includes('signUp')) {
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          localId: authUid, email, idToken: fakeIdToken,
          refreshToken: 'fake-refresh', expiresIn: '3600', registered: true,
        }),
      });
      return;
    }
    if (url.includes('token') || url.includes('securetoken')) {
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          id_token: fakeIdToken, access_token: fakeIdToken,
          expires_in: '3600', token_type: 'Bearer', refresh_token: 'fake-refresh',
        }),
      });
      return;
    }
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ users: [{ localId: authUid, email, emailVerified: true }] }),
    });
  });

  await page.route('**/securetoken.googleapis.com/**', async (route: Route) => {
    await route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({
        id_token: fakeIdToken, expires_in: '3600',
        token_type: 'Bearer', refresh_token: 'fake-refresh',
      }),
    });
  });

  // Opaque storage PUT — backend (mock GCS mode) returns this localhost URL,
  // which has no real route. Fulfilling 200 lets the documents/save POST
  // (which DOES hit the real backend) persist the filePath.
  await page.route('**/mock-gcs-upload**', async (route: Route) => {
    await route.fulfill({ status: 200, contentType: 'text/plain', body: 'ok' });
  });

  await page.route('**/api/**', async (route: Route) => {
    const url = route.request().url();
    if (url.includes('/api/admin/auth/profile')) {
      await route.fulfill({
        status: 401, contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'Unauthorized' }),
      });
      return;
    }
    // Pass everything else through to the real backend with the mock_* token.
    const headers = { ...route.request().headers(), authorization: `Bearer ${mockToken}` };
    await route.continue({ headers });
  });
}

/**
 * Logs in as a brand-new worker. The backend auto-provisions a worker in
 * INCOMPLETE_REGISTER via POST /api/workers/init on login (authStore).
 */
export async function loginNewWorker(
  page: Page,
  authUid: string,
  email: string,
): Promise<void> {
  await installRealRegInterceptors(page, authUid, email);
  await page.goto('/login');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill('TestWorker123!');
  await page.locator('button[type="submit"]').click();
  await expect(page).not.toHaveURL(/.*\/login/, { timeout: 20_000 });
}
