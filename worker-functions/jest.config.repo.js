/**
 * Config de teste de REPOSITÓRIO — banco Postgres real (nunca mock), SEM a stack completa
 * (API/Firebase Emulator) que `jest.config.e2e.js` exige via `tests/e2e/setup.ts`.
 *
 * Uso (spec 019, protocolo "teste de repositório com banco real, nunca mock"): sobe um Postgres
 * isolado (`docker run postgis/postgis:16-3.4`, projeto/porta próprios — ver runbook de RAM do
 * ebrain), roda `node scripts/run-migrations-docker.js` contra ele, e só então:
 *
 *   DATABASE_URL=postgresql://enlite_admin:enlite_password@127.0.0.1:<porta>/enlite_e2e \
 *     npx jest --config jest.config.repo.js --runInBand
 */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests/repo'],
  testMatch: ['**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/'],
  testTimeout: 30000,
  maxWorkers: 1,
  moduleNameMapper: {
    '^@shared/(.*)$': '<rootDir>/src/shared/$1',
    '^@shared$': '<rootDir>/src/shared/index',
    '^@modules/(.*)$': '<rootDir>/src/modules/$1',
  },
};
