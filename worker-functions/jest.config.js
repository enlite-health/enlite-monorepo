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
   * ⚠️ QUEM EXECUTA ISTO É O CI, com a SUÍTE INTEIRA:
   * `.github/workflows/_backend-quality.yml` roda `npm test -- --coverage`.
   * Sem `--coverage` o jest nem avalia o piso (medido: mesma suíte sai 0 sem a
   * flag e 1 com ela). E `npx jest <um diretório> --coverage` reclama de
   * "Coverage data ... was not found" para os globs que aquele subconjunto não
   * exercita: é esperado, não é regressão — conferir cobertura é sempre
   * `npx jest --coverage` inteiro e ler o per-file.
   *
   * Como ampliar: `npx jest --coverage --silent`, ler o per-file do arquivo
   * candidato, confirmar 100 nos quatro eixos e só então acrescentar aqui.
   *
   * Por que quatro listas NOMINAIS e um glob de módulo: `permissions/**` está
   * 100% inteiro, então protege por diretório e **cresce sozinho** com cada
   * arquivo novo. Os outros diretórios têm vizinho com dívida antiga
   * (`AuthMiddleware.ts` em 84,7% de branches; `authTelemetryRoutes.ts` em 0% de funcs), e um
   * glob de diretório ali quebraria o CI sem ninguém ter regredido nada. A
   * consequência a saber: arquivo NOVO nessas pastas nasce fora do piso — quem
   * criar, acrescenta na lista.
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
    'src/modules/identity/interfaces/routes/permissionRoutesInventoryRoute.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    // ROUTERS DE FAMÍLIA já virados para decisão por célula (task 3.5), em um
    // bloco só e em ordem de virada. Família nova entra AQUI no mesmo PR em que
    // declara — senão a trava do piso não alcança o arquivo e a família nasce
    // fora da rede. Moram em módulos diferentes, daí a lista explícita.
    'src/modules/identity/interfaces/routes/adminUsersRoutes.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    'src/modules/case/interfaces/routes/adminPatientsRoutes.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    // A4: as famílias de mensageria, integração e fixtures. `messagingRoutes.ts`
    // entrou aqui em 20/08, quando a `createPublicBulkDispatchRoute` — fábrica
    // de rota "pública temporária" que disparava WhatsApp em massa SEM auth e
    // que nunca era chamada — foi apagada. Enquanto ela existia, o arquivo
    // ficava em 82% e a saída honesta era ficar de fora, não testar código
    // morto para inflar o número.
    'src/modules/notification/interfaces/routes/messagingRoutes.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    'src/modules/integration/interfaces/routes/adminIntegrationsRoutes.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    'src/interfaces/routes/testFixturesRoutes.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    // `admin.workers` (3ª) é a primeira família ESPALHADA: 31 rotas em quatro
    // arquivos, dois deles fora do módulo `worker`. Os quatro entram, senão a
    // família fica coberta pela metade — que é o mesmo que não estar coberta.
    'src/modules/worker/interfaces/routes/{adminWorkerRoutes,adminWorkerDocumentsRoutes,workerDocumentsRoutes}.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    'src/modules/matching/interfaces/routes/{workerContextRoutes,adminVacanciesRoutes,analyticsRoutes,recruitmentRoutes}.ts': {
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
    // Peças pequenas e muito reusadas, cada uma nascida de um bug que chegou
    // em produção: `parseEnvList` (#222, vírgula em env de PRD),
    // `mergeCustomClaims` (#220, `role` apagava `country`), `EmailService`
    // (guard de envio, 17/08). São exatamente as que não podem regredir calado.
    'src/shared/utils/{envFlag,envList}.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    // O aviso do vínculo de contas: o que ele DEIXA REGISTRADO quando não
    // consegue avisar é a única pista de que alguém não foi avisado.
    'src/modules/account-link/accountLinkNotice.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    'src/modules/identity/infrastructure/{mergeCustomClaims,EmailService}.ts': {
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
