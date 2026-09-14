/**
 * Config de teste SÓ para os 2 helpers deste contrato (staffAuth.ts,
 * permissionFamilyHarness.ts) — herda de `jest.config.e2e.js` mas SEM o
 * `setupFilesAfterEnv` (tests/e2e/setup.ts exige API + Postgres de pé via
 * docker, proibido nesta sessão pela regra de memória). `tokenMock` e o ramo
 * mock de `staffAuth` são funções puras/sem I/O real — não precisam do stack.
 */
const base = require('./jest.config.e2e.js');

module.exports = {
  ...base,
  roots: ['<rootDir>/tests/e2e/helpers/__tests__'],
  setupFilesAfterEnv: [],
  collectCoverageFrom: [
    'tests/e2e/helpers/staffAuth.ts',
    'tests/e2e/helpers/permissionFamilyHarness.ts',
  ],
  coverageDirectory: 'coverage/staffauth-helpers',
};
