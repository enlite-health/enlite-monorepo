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
    // Ingestor CID-11 (spec 016 F1): a lógica PURA do crawler (reescrita de host — o achado
    // caro da F0, 401 da OMS real — classificação de kind e o diff-engine) entra no piso pelo
    // mesmo motivo do sync-message-templates acima. O orquestrador HTTP+DB
    // (`ingest-icd11-catalog.ts`) fica fora, como todo outro script CLI da pasta.
    // F1-CORREÇÃO D10: `cli-guards.ts` entrou na F1-correção (parsePromoteFlag,
    // assertReleaseMatchesApiBase) — mesma régua, mesmo motivo.
    'scripts/icd11-ingest/{rewrite-host,classify-entity,diff-engine,cli-guards}.ts',
    // Backfill do diagnóstico (spec 016 F4, Parte 2): a lógica PURA (casamento em memória e
    // parsing de flags) entra pelo MESMO motivo do ingestor CID-11 acima. O orquestrador
    // (`backfill-patient-diagnosis-catalog.ts`, HTTP/DB via TerminologyPort + duas conexões)
    // fica fora — provado pelo dry-run real contra a réplica (evidências da F4), não por mock.
    'scripts/backfill-diagnosis-catalog/{matching,cli-guards}.ts',
    // Carga pontual manual do ClickUp (decisão 11/09/2026 — remoção do sync automático): o
    // parser PURO de flags (`--apply` é a única combinação que grava; dry-run é o default)
    // entra pela MESMA régua acima. O orquestrador (`import-patients-from-clickup.ts`,
    // paginação HTTP + Postgres) fica fora, como todo outro script CLI da pasta.
    'scripts/import-patients-from-clickup-flags.ts',
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
    // D286: o ponto único de decisão por CONTAINER da ficha (identidade, clínica, familiares,
    // chat, cobertura, endereço, serviços, equipe) — mesma classe do `patientClinicalAccess`.
    'src/modules/case/application/patientContainerAccess.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    'src/modules/worker/application/workerContainerAccess.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    'src/modules/matching/application/patientInVacancyProjection.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    'src/modules/matching/application/dashboardContainerAccess.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    // Paciente como fonte da verdade: leitura clínica, repositórios e o guarda
    // de acesso ao texto clínico. `patientClinicalAccess` é o que decide quem
    // vê texto clínico — regra dura do CLAUDE.md, não pode regredir calado.
    // Contrato publicado do perfil do prestador: é ele que declara os DOIS ramos
    // do 200 e que `missingFields` não tem terceiro estado. O teste que o
    // exercita já nasceu porque a 1ª versão dele era cega ao próprio defeito.
    'src/shared/openapi/registrations/worker.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    // Completude do cadastro do prestador (D302). É a fonte ÚNICA da resposta
    // "o que falta para se postular", e o defeito que ela conserta foi
    // exatamente uma segunda definição divergir da do banco. A distinção
    // `null` ("não apurei") x `[]` ("nada falta") mora aqui: se ela regredir, a
    // tela volta a dizer "completo" para quem o portão recusa.
    'src/modules/worker/infrastructure/WorkerCompletenessRepository.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    // Escrita confirmada do perfil: `readFreshProgress` é o que impede a rota de
    // responder "salvo" sem dizer o que o banco ficou, e o ramo degradado tem de
    // devolver `missingFields: null`, nunca `[]`.
    'src/modules/worker/interfaces/controllers/WorkerControllerV2Helpers.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
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
    // Cross-product serviço×endereço da ativação (spec 013 bloco C) — cada vaga carrega o
    // contracted_service_id/providers_needed do serviço CERTO; regressão aqui embaralha vagas
    // entre serviços diferentes calada (QA-caça #2, achado real). Spec 015 (US-A6.2) estendeu
    // este mesmo arquivo com a franja etária (age_range_min/max) — segue medindo 100.
    // Spec 015 (A6): entidade do serviço contratado — `provider_age_band` entra no INSERT/UPDATE/decorate;
    // QA-caça A6 #2 achou o arquivo TOCADO fora do piso (88 % de branches desde o bloco C). Travado em 100.
    'src/modules/case/infrastructure/PatientContractedServiceRepository.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    'src/modules/case/application/ActivatePatientUseCase.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    // Correções C1-C9 do relatório F5 (gate `revisao-pr`). Os 6 arquivos abaixo foram TOCADOS por
    // aquelas correções e entram no piso medindo 100 nos quatro eixos — não por otimismo: o
    // per-file de `npx jest --coverage` inteiro foi lido antes de cada entrada.
    //
    //  - `PatientService`: `moveStatus` deixou de gravar `on_hold_note` incondicionalmente (C1) e
    //    passou a validar a SAÍDA de estado clínico (C5). Regressão aqui apaga texto clínico sem
    //    segunda cópia em lugar nenhum.
    //  - `PatientRelatedWriter`: o Path 2 copia `logistics_corridor`/`access_notes` da linha
    //    arquivada (C2). Estava a 5,66 % — o único INSERT do arquivo não tinha teste unitário
    //    NENHUM, e é ele que apagava os dois campos a cada sync.
    //  - `contractedServiceHourlyValueAccess`: ponto único de quem lê E de quem escreve
    //    `hourly_value` (C4) — mesmo papel de `patientClinicalAccess`, que já está no piso.
    //  - `InsuranceProviderRepository`: o 23505 passou a ser lido pela CONSTRAINT (C6); regredir
    //    para "todo 23505 é código duplicado" volta a mentir sobre um código que não existe.
    //  - Os dois controllers: as guardas de 403/404/409 que estas correções instalaram.
    // ── Quebra pelo teto de 400 linhas do CLAUDE.md (05/09/2026) ─────────────────────────
    // `PatientService` (841 linhas) foi cortado por RESPONSABILIDADE, e os pedaços entram no
    // piso NO MESMO commit que os cria — senão nasceriam fora da régua, que é exatamente o
    // defeito que o gate da F5 apontou ("passaram porque nasceram fora"). Os cinco medem 100
    // nos quatro eixos na suíte inteira (lido no per-file, não estimado): são o MESMO código
    // que já estava coberto dentro do `PatientService`, só que agora endereçável.
    //  - `PatientStatusWriter`: a transição de estado (+ os dois erros que o controller mapeia);
    //  - `PatientSectionWriter`: a edição por seção (os drawers do painel);
    //  - `PatientNativeCreator`: o caminho do paciente nascido na Enlite;
    //  - `PatientRelatedUpsert`: as coleções auxiliares, compartilhadas pelos dois caminhos;
    //  - `patientCaseNumberConflict`: a leitura do 23505 PELA CONSTRAINT, agora com dois donos.
    'src/modules/case/application/{PatientService,PatientRelatedWriter,contractedServiceHourlyValueAccess,PatientStatusWriter,PatientSectionWriter,PatientNativeCreator,PatientRelatedUpsert,patientCaseNumberConflict}.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    'src/modules/case/infrastructure/InsuranceProviderRepository.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    'src/modules/case/interfaces/controllers/{AdminPatientsController,AdminPatientContractedServicesController,AdminInsuranceProvidersController}.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    // Spec 015 (US-A6.2, D254 item 6): fonte ÚNICA do mapa franja→vaga — regressão aqui muda o
    // que TODA vaga nascida de serviço recebe de age_range_min/max, calado.
    'src/modules/case/domain/ProviderAgeBandMapping.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    // Spec 015 (US-A6.1): schema de validação do serviço contratado, estendido com
    // providerAgeBand — medido 100 nos 4 eixos na suíte inteira do módulo `case`.
    'src/modules/case/interfaces/validators/contractedServiceSchemas.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    // Spec 014 (bloco D, US-D1/lex D1.1/D1.2): critério ÚNICO de "pronto para ativar",
    // lido tanto pelo checklist da ficha quanto pelo gate de POST /activate — regressão
    // aqui faz os dois divergirem em silêncio.
    'src/modules/case/domain/PatientCompleteness.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    // Decisão do Gabriel 07/09 (D298): carrega os contadores do checklist DENTRO da transação que
    // já segurou a linha do paciente — é o insumo da guarda que recusa a mudança de status. Nasceu
    // fora deste piso e o gate `revisao-pr` reprovou (85,71% stmts, 0% branches: o ramo
    // "paciente não existe" vinha só de carona dos testes do `PatientStatusWriter`).
    'src/modules/case/infrastructure/PatientCompletenessLoader.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    // Spec 014 (US-D3, lex D3.1, MEDIDO 03/09 em PRODUÇÃO: 5/37 pacientes com telefone tinham o
    // do responsável no campo próprio) — decide se a ficha mostra o aviso de re-atribuição.
    'src/modules/case/domain/PhoneMatch.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    // Mesma quebra pelo teto de 400: `PatientQueryRepository` (612), `PatientDetailQueryHelper`
    // (408) e o SQL de endereço que estava DENTRO do `AdminPatientsController` (874) viraram
    // arquivos próprios — todos medindo 100 nos quatro eixos, todos entrando no piso aqui.
    //  - `ContractedServiceDetailMapper`: a subárvore de serviços contratados da ficha;
    //  - `PatientLeadContactAttacher`: a 2ª passada da listagem — é o ÚNICO ponto da listagem
    //    que toca o KMS, e a máscara do lex C1 mora lá;
    //  - `PatientAddressQueryHelper`: o INSERT/SELECT de endereço do painel (molde dos
    //    `*QueryHelper` que este módulo já usa).
    'src/modules/case/infrastructure/{PatientClinicalRepository,PatientDetailQueryHelper,PatientQueryRepository,ContractedServiceDetailMapper,PatientLeadContactAttacher,PatientAddressQueryHelper}.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    // A projeção pública da lista e da ficha saiu do `AdminPatientsController` para cá (mesmo
    // papel de `DiagnosisPublicView`): um lugar só decide o formato que a API publica, e é onde
    // as duas redações (texto clínico D211.2, `hourlyValue` lex C-c.4) são aplicadas. 100 nos
    // quatro eixos — o controller já estava no piso e o código é o mesmo.
    'src/modules/case/interfaces/AdminPatientView.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    // `PatientSourceLabelRepository` (963 linhas, 2,4× o teto) foi quebrado em quatro. Ele
    // NUNCA esteve no piso (mediu 91,66/73,49/84,37/91,46 antes da quebra), então os pedaços só
    // entram aqui se medirem 100 sozinhos — e estes DOIS medem. Os outros dois ficam de fora
    // POR MEDIÇÃO, não por esquecimento: `PatientSourceLabelClassifier` 92,1/85/100/94,28 e
    // `PatientSourceLabelRejectionRecorder` 96,87/73,52/83,33/96,49 — a dívida é a mesma que já
    // existia no arquivo grande, agora visível por responsabilidade.
    'src/modules/case/infrastructure/{PatientSourceLabelCeiling,PatientSourceLabelRead,PatientSourceLabelLock}.ts': {
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
    // Rota de transporte público do /admin/mapa. Entram no piso no MESMO PR:
    // `GoogleTransitDirections` é a FRONTEIRA EXTERNA — é dali que saem duas
    // coordenadas de domicílio. Regressão silenciosa nesse arquivo não é bug de
    // tela, é vazamento; e o interruptor (`enabled`, sem chave não chama nada)
    // precisa continuar coberto.
    'src/modules/matching/domain/transitRoute.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    'src/modules/matching/infrastructure/GoogleTransitDirections.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    'src/modules/matching/application/GetTransitCorridorUseCase.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    'src/modules/matching/interfaces/controllers/TransitCorridorController.ts': {
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
    // Spec 016 F1 (CID-11): a PORTA e seus dois consumidores de teste. `TerminologyPort.ts` é só
    // tipos (0 statements — entra pelo mesmo motivo dos outros arquivos de contrato: qualquer
    // método novo na interface nasce sob o piso). `IcdCode` é o Value Object que responde ao
    // defeito medido na F0 (código truncado na tela, 6A02.Z → 02.Z); `UnavailableTerminology` é
    // o Null Object que cumpre a US-4 (falha VISÍVEL). Regressão aqui é sempre calada — código
    // clínico errado na tela ou busca "vazia" indistinguível de "catálogo fora do ar".
    'src/modules/terminology/domain/{TerminologyPort,IcdCode,UnavailableTerminology}.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    // F5-CORREÇÃO T2 (QA-caça, 05/09/2026): `conceptKey` é o espelho TS da função SQL
    // `terminology.concept_key` (migration 328) — a identidade de conceito ESTÁVEL entre
    // releases. É a peça que faz o mapa do ClickUp continuar resolvendo depois de promover um
    // release novo; regressão aqui é sempre calada (o espelho fica mudo, webhook 200, nenhuma
    // linha de rejeição). Arquivo NOVO, nasce em 100% nos quatro eixos — medido antes de entrar.
    'src/modules/terminology/infrastructure/conceptKey.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    // O adaptador real (Postgres) e o fake que prova a LSP da porta (mesma bateria de teste nos
    // dois — tests/e2e/terminology-port-contract.e2e.test.ts) + o Strategy que escolhe entre
    // eles por configuração.
    'src/modules/terminology/infrastructure/{IcdCatalogTerminology,InMemoryTerminology,TerminologyPortFactory}.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    // F1-CORREÇÃO D9: o ingestor CID-11 já estava em `collectCoverageFrom` (linha ~25) desde a
    // F1 original, mas SEM entrada aqui — o que faz o arquivo só APARECER no relatório, nunca
    // reprovar o build. Medido: comentar o teste de `classKind='extension'` derrubava
    // `classify-entity.ts` para 50% de branch e `npm test -- --coverage` continuava saindo com
    // RC=0 (evidencias/f1fix-D9-red.txt) — a lógica pura do crawler (incluindo `toLocalUri`, o
    // achado caro da F0) podia cair a 0% sem o CI piscar. `cli-guards.ts` (D10) entra pela mesma
    // régua: nasceu nesta correção, mesmo motivo dos outros três.
    'scripts/icd11-ingest/{rewrite-host,classify-entity,diff-engine,cli-guards}.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    // Spec 016 F4, Parte 2 (backfill do diagnóstico): a lógica PURA que decide "alta confiança"
    // (nunca inventa, D260) e o parsing de `--dry-run`/`--write` (dry-run é DEFAULT). Mesma
    // régua do D9 acima — sem entrada aqui, uma regressão no casamento cairia sem o CI piscar.
    'scripts/backfill-diagnosis-catalog/{matching,cli-guards}.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    // Spec 016 F4: o espelho do ClickUp ("Tipo de Patología" → CID-11). `ClickUpDiagnosisMapper`
    // é o Adapter que NUNCA decide por `if (source === 'CLICKUP')` (o escopo vem do repositório
    // injetado); `ClickUpDiagnosisLabelRepository`/`ClickUpDiagnosisRejectionRepository` são as
    // duas metades do ConceptMap (migration 326) e da recusa durável (migration 304, ampliada).
    'src/modules/diagnosis/infrastructure/clickup/{ClickUpDiagnosisMapper,ClickUpDiagnosisLabelRepository,ClickUpDiagnosisRejectionRepository}.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    // Spec 016 F2 (D263): diagnóstico estruturado do paciente. `DiagnosisSource` carrega a
    // ordem de precedência (REGRA-03, Diego) — regredir aqui troca qual origem vence em
    // silêncio. `PatientDiagnosis` espelha os CHECKs da migration 325 (defesa em profundidade).
    // `PrimaryDiagnosisPolicy` é o Strategy que decide qual principal aparece na tela.
    // `PatientDiagnosisRepositoryPort` é só tipos (0 statements, mesmo motivo de TerminologyPort).
    'src/modules/diagnosis/domain/{DiagnosisSource,PatientDiagnosis,PrimaryDiagnosisPolicy,PatientDiagnosisRepositoryPort}.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    // Os 3 casos de uso + a Facade (porta de entrada única — controller e webhook chamam só
    // ela). `RecordPatientDiagnosis` é onde mora a integridade sem FK (valida na escrita via
    // TerminologyPort); `SetPrimaryDiagnosis` é a reconciliação (índice parcial não DEFERRABLE).
    'src/modules/diagnosis/application/{RecordPatientDiagnosis,SetPrimaryDiagnosis,DeactivatePatientDiagnosis,PatientDiagnosisService}.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    // O fake (prova o contrato da porta em memória, mesmo espírito de InMemoryTerminology) e o
    // adaptador real, escopados por CONSTRUTOR (D263) — regressão no escopo é a classe de bug
    // que esta fase existe para tornar impossível ("o escritor do ClickUp fica FISICAMENTE
    // incapaz de tocar linha PANEL").
    'src/modules/diagnosis/infrastructure/{InMemoryPatientDiagnosisRepository,PostgresPatientDiagnosisRepository}.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    // A fronteira REQ-21 (código NUNCA no navegador) + o controller HTTP + os schemas de
    // entrada. Regressão em `DiagnosisPublicView` é o defeito medido na F0 de novo (código
    // vazando pela API desta vez, não pela tela).
    'src/modules/diagnosis/interfaces/DiagnosisPublicView.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    'src/modules/diagnosis/interfaces/controllers/AdminPatientDiagnosesController.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    'src/modules/diagnosis/interfaces/validators/diagnosisSchemas.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    // Busca de terminologia (ISP: a tela de admissão só enxerga `search`, nunca `ancestorsOf`).
    'src/modules/terminology/interfaces/controllers/AdminTerminologySearchController.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    'src/modules/terminology/interfaces/validators/terminologySearchSchema.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    // ── Correções I1-I4 do relatório F5 (espelho do ClickUp) ─────────────────────────────
    // Os quatro defeitos moravam exatamente nos dois arquivos abaixo + nos dois repositórios,
    // e os quatro tinham em comum a MESMA causa: a régua não media ali.
    //
    //  - `SyncPatientFromClickUpTaskUseCase`: o `return` de CASE_NUMBER_CONFLICT estava ACIMA
    //    das 4 gravações (cru, cobertura, dispositivo, diagnóstico) — para toda tarefa com
    //    número de caso duplicado, essas 4 tabelas NUNCA eram escritas, em silêncio, enquanto
    //    os escalares eram. Estava a 93,91 %/78,68 %: nenhum `catch` best-effort tinha teste.
    //  - `ClickUpPatientMapper`: 4 campos (`Dependencia`, `Sexo`, `Tipo de Documento Paciente`,
    //    `Servicio`) liam `resolveDropdown` CRU, e a opção que deixava de resolver virava um
    //    `null` gravado como APAGAMENTO (348/185/349 linhas de exposição medida); e
    //    `Equipo Tratante Multidisciplinario`, que é `drop_down`, era lido como checkbox.
    //  - `PatientIdentityRepository`: estava a **25 %/0 % de branches** — o `ON CONFLICT DO
    //    UPDATE` inteiro sem um teste unitário, e é ele quem decide se `sex`/`document_type`
    //    do paciente são sobrescritos pelo espelho. Agora 100 nos quatro eixos.
    //  - `PatientClinicalRepository` e `PatientService` já estavam no piso, acima; as
    //    bandeiras `dependencyLevelReadable`/`serviceTypeReadable` entraram medindo 100.
    'src/modules/case/infrastructure/PatientIdentityRepository.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    'src/modules/integration/application/SyncPatientFromClickUpTaskUseCase.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    // Este arquivo parava em 99,36/99,24 por uma guarda PROVADAMENTE MORTA em
    // `parseNameFromTitle`: depois de `.filter(Boolean)` e do `if (parts.length < 2) return null`,
    // `parts[0]` e o `join(' ')` de pelo menos um elemento não-vazio são SEMPRE truthy, então o
    // `if (!lastName || !firstName) return null` era inalcançável. Autorizado pelo Gabriel na F5,
    // a guarda foi apagada e o piso subiu para 100 nos quatro eixos — medido com as 19 suítes que
    // cobrem o arquivo (300 testes). 🔒 Piso de 100 % sobre ramo morto é régua que não mede nada:
    // o número só vale depois de o ramo inalcançável sair.
    'src/modules/integration/infrastructure/clickup/ClickUpPatientMapper.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    // ── Entradas vindas da `stage` (trem ABAC), unidas no sync main→stage 06/09/2026 ──
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
    // Peças da F2 (células de prestador). Entram aqui no mesmo PR que as cria —
    // o gate `revisao-pr` pegou as quatro nascendo FORA do piso, que é
    // exatamente o que a nota acima avisa. Medidas em 100/100/100/100.
    'src/modules/worker/application/export/workerExportCells.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    'src/modules/worker/domain/transicaoDeBaixa.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    'src/shared/audit/{contactAccessLog,contactAccessFromRequest}.ts': {
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
    // `admin.permissions` (F3) — a leitura do painel. Entra junto com a
    // declaração de `permission_management:read`, como a nota acima manda.
    // F4 — a escrita do painel. Entra junto com o arquivo, como a nota acima
    // manda: arquivo novo nesta pasta nasce FORA do piso.
    'src/modules/identity/interfaces/routes/permissionPanelWriteRoutes.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    'src/modules/identity/interfaces/routes/permissionPanelRoutes.ts': {
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
    'src/interfaces/routes/{testFixturesRoutes,dedupRoutes}.ts': {
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
    'src/modules/matching/interfaces/routes/{workerContextRoutes,adminVacanciesRoutes,analyticsRoutes,recruitmentRoutes,workerEncuadreRoutes}.ts': {
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
    // D293/D294 (07/09/2026): a fronteira staff × prestador e o que sobrou do papel.
    // `AccountType` é o ponto único da fronteira; `FirebaseAuthStrategy` é de onde o
    // tipo sai (claim → coluna → ponte); os use cases de usuário admin deixaram de
    // expor `role`. Todos medidos 100 no PR — o piso existe para não voltar atrás.
    'src/modules/identity/domain/AccountType.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    'src/modules/identity/infrastructure/FirebaseAuthStrategy.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    'src/modules/identity/application/{CreateAdminUserUseCase,GetAdminProfileUseCase,ListAdminUsersUseCase,adminUserDto}.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    'src/modules/identity/interfaces/controllers/AdminController.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    'src/modules/case/interfaces/AdminPatientView.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    'src/infrastructure/triggers/onUserCreate.ts': {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
    // Carga pontual manual do ClickUp (decisão 11/09/2026 — remoção do sync automático,
    // webhook + reconciliador + resync-one-clickup-task.ts): `--apply` é a ÚNICA combinação
    // que sai do dry-run, mesma disciplina do D10 do ingestor CID-11 e do backfill de
    // diagnóstico acima. Nasce em 100% nos quatro eixos — medido antes de entrar.
    'scripts/import-patients-from-clickup-flags.ts': {
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
