module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/src', '<rootDir>/tests'],
  testMatch: ['**/__tests__/**/*.test.ts', '!**/e2e/**'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/index.ts',
  ],
  coverageDirectory: 'coverage',

  /**
   * PISO DE COBERTURA — a trava que faltava (17/08/2026).
   *
   * A regra "100% per-file nos arquivos tocados" existia só na skill `revisao-pr`,
   * conferida a olho pelo revisor: nada falhava sozinho se a cobertura caísse.
   * Isto passa a falhar.
   *
   * ⚠️ NÃO é piso global: a base tem dívida antiga e exigir 100% de tudo hoje
   * quebraria o CI sem ninguém ter regredido nada. O piso vale só onde JÁ está
   * em 100% (medido, não estimado), e a lista CRESCE conforme cada área é
   * saneada — é anti-regressão, não meta.
   *
   * O barrel (`index.ts`) fica de fora de propósito: re-export conta como
   * "função não coberta" e derrubaria o número por artefato de instrumentação,
   * não por falta de teste (o módulo de permissões marca 86% de funcs COM o
   * barrel e 100% sem ele).
   *
   * Como ampliar: rodar
   * `npx jest <suites> --coverage --collectCoverageFrom='<glob>' --silent`,
   * confirmar 100 nos quatro eixos e só então acrescentar a entrada aqui.
   */
  coverageThreshold: {
    // Módulo extraível de permissões (D115) — 100% desde o grupo 2.
    'src/modules/identity/permissions/**/!(index).ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    // Peças do enforcement (grupo 3) — 100% nos quatro eixos, medido.
    'src/modules/identity/interfaces/middleware/{PermissionMiddleware,denyUndeclaredRoutes,undeclaredRouteLists,countryScopeGuard}.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    'src/modules/identity/interfaces/routes/{adminUsersRoutes,permissionRoutesInventoryRoute}.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    'src/modules/identity/infrastructure/{GroupPermissionEngine,CerbosAuthorizationAdapter}.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    // Boot: caminho crítico do processo INTEIRO, não só do painel.
    'src/bootstrap/{wirePermissionsModule,startServer}.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    'src/shared/utils/envFlag.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
  },
  verbose: true,
  testTimeout: 10000,
  passWithNoTests: true,
  moduleNameMapper: {
    '^@shared/(.*)$': '<rootDir>/src/shared/$1',
    '^@shared$': '<rootDir>/src/shared/index',
    '^@modules/(.*)$': '<rootDir>/src/modules/$1',
  },
};
