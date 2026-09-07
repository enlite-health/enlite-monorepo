/**
 * Suíte de fronteira com TOKEN REAL (emulador do Firebase, API com USE_MOCK_AUTH=false).
 * Separada do `jest.config.e2e.js` de propósito: a suíte principal roda contra a API em
 * modo mock e sem emulador; esta exige o stack de `docker-compose.real-auth-ports.yml`
 * e FALHA (não pula) quando ele não está de pé — ver tests/e2e-real-auth/helpers/realAuth.ts.
 */
const base = require('./jest.config.e2e.js');

module.exports = {
  ...base,
  roots: ['<rootDir>/tests/e2e-real-auth'],
  testMatch: ['**/*.real.test.ts'],
  setupFilesAfterEnv: [],
};
