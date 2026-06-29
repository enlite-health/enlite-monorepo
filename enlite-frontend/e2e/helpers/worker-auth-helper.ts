/**
 * worker-auth-helper.ts
 *
 * Playwright auth helpers for worker sessions on public pages.
 * Used by postularse-incomplete-modal.integration.e2e.ts and similar specs.
 *
 * Strategy: USE_MOCK_AUTH=true on the Docker backend.
 * - Firebase Identity Toolkit is intercepted to inject a fake id_token.
 * - /api/admin/auth/profile returns 401 (not admin → no admin redirect).
 * - /api/workers/* stubs provide minimal worker data.
 * - All other /api/** calls pass through with Authorization: Bearer mock_<base64>
 *   so the real backend resolves the worker by auth_uid.
 */

import { type Page, type Route } from '@playwright/test';

/** Build the mock_<base64> token the backend accepts (USE_MOCK_AUTH=true). */
export function buildMockToken(authUid: string, email: string): string {
  return (
    'mock_' +
    Buffer.from(
      JSON.stringify({ uid: authUid, email, role: 'worker' }),
      'utf-8',
    ).toString('base64')
  );
}

/** Fake Firebase id_token — never validated server-side when USE_MOCK_AUTH=true. */
export function buildFakeIdToken(authUid: string, email: string): string {
  return (
    'eyJhbGciOiJub25lIiwidHlwIjoiSldUIn0.' +
    Buffer.from(
      JSON.stringify({
        sub: authUid, uid: authUid, email,
        iss: 'https://securetoken.google.com/enlite-prd',
        aud: 'enlite-prd',
        iat: Math.floor(Date.now() / 1000),
        exp: Math.floor(Date.now() / 1000) + 3600,
      }),
    ).toString('base64url') +
    '.'
  );
}

/**
 * Installs request interceptors for a worker session on the public page.
 *
 * Intercepted:
 * - Firebase Identity Toolkit → fake id_token
 * - /api/admin/auth/profile → 401 (prevents admin redirect)
 * - /api/workers/init → 200 stub
 * - /api/workers/me/availability → 200 []
 * - /api/workers/me/documents → 200 null
 * - /api/workers/me (GET) → 200 minimal worker
 * - All other /api/** → pass-through with mock_* token
 */
/**
 * Injects a stable mock auth entry into localStorage so that
 * FirebaseAuthService.onAuthStateChanged always finds it — even after
 * the Firebase SDK tries to invalidate the fake token.
 *
 * The key e2e_mock_auth is read by FirebaseAuthService as a fallback
 * that the real Firebase SDK never removes.
 */
/**
 * Uses page.addInitScript to inject mock auth into localStorage on every
 * page load/navigation. The 'enlite_e2e_mock_auth' key is stable — the
 * Firebase SDK never removes it (it only manages 'firebase:*' keys).
 *
 * FirebaseAuthService.readMockAuth() checks this key first, so the user
 * stays authenticated even if the Firebase SDK invalidates the fake token.
 */
async function injectMockAuthIntoLocalStorage(
  page: Page,
  authUid: string,
  email: string,
  fakeIdToken: string,
): Promise<void> {
  const mockAuthPayload = JSON.stringify({
    uid: authUid,
    email,
    stsTokenManager: {
      accessToken: fakeIdToken,
      expirationTime: Date.now() + 3600_000,
    },
  });

  // addInitScript runs on every page load/navigation, before the React app mounts.
  await page.addInitScript((payload: string) => {
    // E2E-dedicated key: Firebase SDK never clears this namespace.
    localStorage.setItem('enlite_e2e_mock_auth', payload);
  }, mockAuthPayload);

  // Also inject immediately into the current page context (in case the page is already loaded).
  // This covers the case where installWorkerInterceptors is called after page.goto().
  try {
    await page.evaluate((payload: string) => {
      localStorage.setItem('enlite_e2e_mock_auth', payload);
    }, mockAuthPayload);
  } catch {
    // Ignore if no page context yet (e.g., first call before any navigation)
  }
}

export async function installWorkerInterceptors(
  page: Page,
  authUid: string,
  email: string,
): Promise<void> {
  const fakeIdToken = buildFakeIdToken(authUid, email);
  const mockToken = buildMockToken(authUid, email);

  // Inject mock auth into localStorage on every page load so that
  // FirebaseAuthService can always find it, even if the Firebase SDK clears its own keys.
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

  await page.route('**/api/**', async (route: Route) => {
    const url = route.request().url();

    if (url.includes('/api/admin/auth/profile')) {
      await route.fulfill({
        status: 401, contentType: 'application/json',
        body: JSON.stringify({ success: false, error: 'Unauthorized' }),
      });
      return;
    }
    if (url.includes('/api/workers/init')) {
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ success: true, data: { status: 'ok', worker: { id: authUid } } }),
      });
      return;
    }
    if (url.includes('/api/workers/me/availability')) {
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      });
      return;
    }
    if (url.includes('/api/workers/me/additional-documents')) {
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ success: true, data: [] }),
      });
      return;
    }
    if (url.includes('/api/workers/me/documents')) {
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({ success: true, data: null }),
      });
      return;
    }
    if (url.includes('/api/workers/me') && route.request().method() === 'GET') {
      await route.fulfill({
        status: 200, contentType: 'application/json',
        body: JSON.stringify({
          success: true,
          data: {
            id: authUid, authUid, email,
            status: 'INCOMPLETE_REGISTER', country: 'AR',
            timezone: 'America/Argentina/Buenos_Aires',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        }),
      });
      return;
    }

    // All other API calls (including track-channel): replace token with mock_*
    const headers = { ...route.request().headers(), authorization: `Bearer ${mockToken}` };
    await route.continue({ headers });
  });
}

/**
 * Logs in as a worker via /login using fake Firebase auth.
 * After this, the page context is authenticated and any /api/** call
 * will carry the mock_* token that the real backend resolves.
 */
export async function loginAsWorker(
  page: Page,
  authUid: string,
  email: string,
): Promise<void> {
  await installWorkerInterceptors(page, authUid, email);
  await page.goto('/login');
  await page.locator('input[type="email"]').fill(email);
  await page.locator('input[type="password"]').fill('TestWorker123!');
  await page.locator('button[type="submit"]').click();
  const { expect } = await import('@playwright/test');
  await expect(page).not.toHaveURL(/.*\/login/, { timeout: 20_000 });
}
