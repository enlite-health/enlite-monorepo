import { execSync } from 'child_process';

/**
 * Global setup for E2E tests
 * Verifies Docker containers are running before starting tests
 */
export default async function globalSetup() {
  console.log('[E2E Setup] Checking Docker containers...');
  
  const baseUrl = process.env.PW_BASE_URL ?? 'http://localhost:5173';
  try {
    // Check if frontend is responding (use 127.0.0.1 to avoid IPv6 resolution issues)
    execSync(`curl -sf ${baseUrl}/health || curl -sf ${baseUrl}`, {
      timeout: 5000,
      stdio: 'pipe'
    });
    console.log(`[E2E Setup] Frontend is running on ${baseUrl}`);
  } catch {
    console.error(`[E2E Setup] ERROR: Frontend not found on ${baseUrl}`);
    console.error('[E2E Setup] Run: docker-compose up -d');
    process.exit(1);
  }
  
  try {
    // Check if API is responding (use 127.0.0.1 to avoid IPv6 resolution issues)
    execSync('curl -sf http://127.0.0.1:8080/health || curl -sf http://localhost:8080/health', {
      timeout: 5000,
      stdio: 'pipe'
    });
    console.log('[E2E Setup] API is running on port 8080');
  } catch {
    // API offline is acceptable for tests that mock all API calls (e.g. admin-workers).
    // Tests that need a real backend will fail with a network error.
    console.warn('[E2E Setup] WARNING: API not found on port 8080 — tests with page.route() mocks will still run.');
  }
  
  console.log('[E2E Setup] All Docker containers ready!');
}
