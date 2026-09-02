module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // `scripts` entra aqui porque script que escreve em produção (o sync de
  // templates) precisa de teste como qualquer código — a pasta inteira estava
  // fora do alcance do runner, e por isso a 0%.
  roots: ['<rootDir>/src', '<rootDir>/tests', '<rootDir>/scripts'],
  testMatch: ['**/__tests__/**/*.test.ts', '!**/e2e/**'],
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/**/*.d.ts',
    '!src/index.ts',
    // O sync de templates ESCREVE em `message_templates` em produção. Ficava
    // fora do relatório inteiro — não por decisão, mas porque `scripts/` estava
    // fora dos `roots`: cobertura ali era 0% "por natureza", e piso nenhum
    // mordia. Entram os dois arquivos que decidem o que vai para qual coluna.
    'scripts/sync-message-templates/{diff-engine,db}.ts',
  ],
  coverageDirectory: 'coverage',

  /**
   * PISO DE COBERTURA — a trava que faltava nesta release (30/08/2026).
   *
   * O `_backend-quality.yml` já rodava `npm test -- --coverage` e já trazia um
   * comentário explicando que a flag é o que faz o `coverageThreshold` morder.
   * Só que não havia `coverageThreshold` nenhum para morder: o comentário
   * descrevia um mecanismo inexistente, e a régua "100% per-file no arquivo
   * tocado" (memória `definicao-de-pronto-frontend`, D200) seguia conferida a
   * olho. Isto passa a falhar sozinho.
   *
   * ⚠️ NÃO é piso global: a base tem dívida antiga e exigir 100% de tudo hoje
   * quebraria o CI sem ninguém ter regredido nada. O piso vale só onde JÁ está
   * em 100% (medido, não estimado), e a lista CRESCE conforme cada área é
   * saneada — é anti-regressão, não meta.
   *
   * COMO ESTA LISTA FOI MONTADA (não é memória nem otimismo): interseção de
   * (a) arquivo de produção tocado por esta release — `git diff --name-only
   * 04e6fee6..HEAD -- 'worker-functions/src/**'`, sem teste — com
   * (b) 100/100/100/100 nos quatro eixos na SUÍTE INTEIRA
   * (`jest --coverage`, 330 suites / 4838 testes). Deu 34 arquivos.
   * Os 15 tocados que ficaram FORA ficaram por medição, não por esquecimento:
   * `DomainEventProcessor` (44% br), `ReminderScheduler` (69% br),
   * `TwilioMessagingService` (89% br), `AdminWorkersListHelpers` (88% br),
   * `JobPostingARRepository` (0% br), e os que passam raspando em branches
   * (`PatientService` 98,46; `WJAFunnelController` 99,13; `KanbanBoard` etc.).
   * Entram aqui quando forem saneados — um de cada vez, medindo antes.
   *
   * ⚠️ QUEM EXECUTA ISTO É O CI, com a SUÍTE INTEIRA:
   * `.github/workflows/_backend-quality.yml` roda `npm test -- --coverage`.
   * Sem `--coverage` o jest nem avalia o piso. E `npx jest <um diretório>
   * --coverage` reclama de "Coverage data ... was not found" para os globs que
   * aquele subconjunto não exercita: é esperado, não é regressão — conferir
   * cobertura é sempre `npx jest --coverage` inteiro e ler o per-file.
   *
   * Como ampliar: `npx jest --coverage --silent`, ler o per-file do arquivo
   * candidato, confirmar 100 nos quatro eixos e só então acrescentar aqui.
   *
   * Por que listas NOMINAIS por diretório e não glob de pasta: quase toda pasta
   * aqui tem vizinho com dívida antiga, e `dir/**` quebraria o CI sem ninguém
   * ter regredido nada. A consequência a saber: arquivo NOVO nessas pastas
   * nasce FORA do piso — quem criar, acrescenta na lista.
   *
   * Os barris (`index.ts`) ficam de fora de propósito — re-export conta como
   * "função não coberta" e derruba o número por artefato de instrumentação
   * (`case/index.ts` marca 3,7% de funcs, `shared/index.ts` 0%). A exceção é
   * `worker/index.ts`, que MEDIU 100 nos quatro eixos e por isso entra.
   */
  coverageThreshold: {
    // Paciente como fonte da verdade: leitura clínica, repositórios e o guarda
    // de acesso ao texto clínico. `patientClinicalAccess` é o que decide quem
    // vê texto clínico — regra dura do CLAUDE.md, não pode regredir calado.
    'src/modules/case/application/patientClinicalAccess.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    // O único caminho do sistema que APAGA paciente — e desde a D248 apaga de
    // verdade. A trava (`is_test`) e a guarda de candidatura real (lex C3) são o
    // que separa faxina de perda de dado: regressão aqui não pode passar calada.
    'src/modules/case/application/PatientTestFixtureService.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    'src/modules/case/infrastructure/{PatientClinicalRepository,PatientDetailQueryHelper,PatientQueryRepository}.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    'src/modules/case/interfaces/controllers/AdminPatientsMapController.ts': {
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
    'src/modules/case/interfaces/validators/patientSectionSchemas.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    // Funil e vagas públicas: emissor de evento de etapa, resolução de slot de
    // entrevista e o filtro/mapper do que sai para o portal público. O mapper e
    // o query builder são a fronteira do que vira PII no ar.
    'src/modules/matching/application/{FunnelStageEventEmitter,ListInterviewSlotsForVacancyUseCase}.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    'src/modules/matching/domain/{PublicJobsFilters,interviewSlotResolver}.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    'src/modules/matching/infrastructure/{PublicJobMapper,PublicJobsQueryBuilder,scheduleNormalizer}.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    'src/modules/matching/interfaces/controllers/{FunnelStageMessagesController,PublicJobsController,PublicVacancyController,VacancyMeetLinksController}.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    'src/modules/matching/interfaces/routes/funnelStageMessagesRoutes.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    // Mensageria de convite/agendamento. `StageTemplateEligibility` decide se um
    // template PODE ser disparado: quando ela regride, alguém recebe mensagem
    // que não devia — o modo de falha do incidente de opt-out.
    'src/modules/notification/application/{BookSlotFromWhatsAppUseCase,InvitePresentationMeetingUseCase,StageTemplateEligibility}.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    // O texto aprovado do template: `twilioContentBody` é a regra ÚNICA de
    // extração (duas regras divergentes já puseram um sentinela na tela como se
    // fosse a mensagem da cuidadora) e o provider é quem a persiste. Entram no
    // piso no mesmo PR que as cria.
    'src/modules/notification/infrastructure/{twilioContentBody,TwilioContentBodyProvider}.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    // A fiação do sync: `diff-engine` decide QUAL texto vai para QUAL coluna e
    // `db` é o último elo antes do INSERT/UPDATE em produção. O piso aqui é o
    // que impede o sentinela de voltar a `body_twilio` por uma troca de $4 por $3.
    'scripts/sync-message-templates/{diff-engine,db}.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    'src/modules/notification/interfaces/controllers/PresentationInviteController.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    'src/modules/notification/interfaces/routes/presentationInviteRoutes.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    // Prestador: mapa e rotas de admin. `worker/index.ts` é barril, mas mediu
    // 100 nos quatro eixos (ver nota acima sobre barris).
    'src/modules/worker/index.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    'src/modules/worker/interfaces/controllers/AdminWorkersMapController.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    'src/modules/worker/interfaces/routes/adminWorkerRoutes.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    // Peças pequenas e MUITO reusadas — as que não podem regredir caladas.
    // `messagingOptOutFilter` é o filtro que impede disparo para quem pediu
    // baixa; os handlers de evento são o caminho por onde a etapa vira mensagem.
    'src/shared/database/messagingOptOutFilter.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    'src/shared/events/handlers/{QualifiedInterviewHandler,StageMessageHandler}.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    'src/shared/http/mapQueryCommon.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    'src/shared/openapi/registrations/{adminEncuadres,publicJobs}.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    // `geohash5` nasce em 100% (arquivo novo desta condição do lex): é a peça
    // que decide QUANTA localização vai para o log — regressão silenciosa aqui
    // é vazamento de precisão, não perda de teste.
    'src/shared/utils/geohash.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    'src/shared/utils/dateFormatters.ts': {
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
