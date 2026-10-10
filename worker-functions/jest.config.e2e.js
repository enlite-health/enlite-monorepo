module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // R-16 (spec 050): guarda de rede do PROCESSO jest (o app que o e2e monta em processo e os clientes dos testes).
  // Controle: tests/e2e/rede-bloqueada.controle.test.ts. Os contêineres da API são bloqueados por extra_hosts (docker-compose.test.yml).
  setupFiles: ['<rootDir>/../scripts/rede-bloqueada-em-teste.cjs'],
  roots: ['<rootDir>/tests/e2e'],
  testMatch: ['**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/'],
  setupFilesAfterEnv: ['<rootDir>/tests/e2e/setup.ts'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
  ],
  coverageDirectory: 'coverage/e2e',
  verbose: true,
  testTimeout: 60000, // 60 segundos para testes E2E
  maxWorkers: 1, // Executar testes sequencialmente
  moduleNameMapper: {
    '^@shared/(.*)$': '<rootDir>/src/shared/$1',
    '^@shared$': '<rootDir>/src/shared/index',
    '^@modules/(.*)$': '<rootDir>/src/modules/$1',
  },
};
