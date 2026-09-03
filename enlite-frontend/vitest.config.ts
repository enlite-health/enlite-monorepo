import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      exclude: ['node_modules/', 'src/test/', '**/*.d.ts', '**/*.config.*'],

      /**
       * PISO DE COBERTURA — o que existia aqui era inerte (30/08/2026).
       *
       * Havia um `thresholds` global de 80 nos quatro eixos, mas o CI rodava
       * `pnpm test:run` (sem `--coverage`): sem coletar cobertura o vitest não
       * avalia threshold nenhum, então o piso nunca foi lido. Quando finalmente
       * foi medido, a base dava lines 41,28 — o global de 80 reprovaria TODO PR
       * no primeiro dia. Piso que reprova tudo é removido na primeira urgência;
       * por isso ele desce para o nível real e vira catraca.
       *
       * ⚠️ Os números globais abaixo são CATRACA ANTI-REGRESSÃO, não meta. Eles
       * dizem "não pode piorar a partir daqui" — não dizem que 38% é aceitável.
       * A meta continua sendo a régua da casa: 100% no ARQUIVO tocado (D200),
       * que é o que os globs per-file abaixo cobram de verdade.
       *
       * ⚠️ Medidos DEPOIS da subtração dos globs, que é como o vitest calcula:
       * arquivo casado por um glob SAI do bolo global (`resolveThresholds` em
       * vitest/dist/coverage.js). Como os globs abaixo são justamente os
       * arquivos em 100%, o global cai ao tirá-los — medido na suíte inteira
       * (253 arquivos / 4317 testes): lines/statements 41,28 → 39,69 ·
       * functions 58,6 → 56,52 · branches 83,09 → 81,26. A catraca fica um
       * ponto abaixo do medido, para não reprovar por ruído de arredondamento.
       * Ao subir a cobertura, SUBA a catraca junto — senão ela para de morder.
       */
      thresholds: {
        lines: 38,
        functions: 55,
        branches: 80,
        statements: 38,

        /**
         * PER-FILE 100 — a régua da casa, cobrada pelo CI e não a olho.
         *
         * A lista é a INTERSEÇÃO de (a) arquivo de produção tocado por esta
         * release (`git diff --name-only 04e6fee6..HEAD -- 'enlite-frontend/src/**'`,
         * sem teste) com (b) 100/100/100/100 medido na suíte INTEIRA. Deu 23
         * arquivos. Os 11 tocados que ficaram FORA ficaram por medição:
         * `App.tsx` (34% st), `AdminApiService` (20,6% fn), `VacancyDetailPage`
         * (9% fn), `AdminWorkersPage` (28,6% fn), `JobsEmbeddedSection` (0% fn),
         * e os que passam raspando em branches (`KanbanBoard` 98,9;
         * `VacancyMeetLinksCard` 97,5; `PatientClinicalEditDrawer` 93,1;
         * `VacancyMeetLinksRow` 90,47; `PublicApiService` 94,11).
         * Entram aqui quando forem saneados — um de cada vez, medindo antes.
         *
         * ⚠️ O prefixo `**` + barra do começo NÃO é enfeite (escrito assim
         * porque a sequência literal fecharia este comentário): o vitest casa
         * cada chave contra o
         * caminho ABSOLUTO do arquivo (`mm.isMatch(file, glob)` sobre
         * `coverageMap.files()`). Um glob escrito `src/...` casa com ZERO
         * arquivos — e glob que não casa nada passa CALADO, com 100% de um
         * conjunto vazio. É o modo de falha a vigiar aqui: piso morto parece
         * piso vivo. Ao acrescentar linha, confirme que ela reprova sabotando
         * um arquivo do grupo.
         *
         * ⚠️ Quem executa isto é o CI, com cobertura: `_frontend-quality.yml`
         * roda `pnpm test:ci` (= `vitest run --coverage`). `pnpm test:run --
         * --coverage` NÃO repassa a flag — medido — daí o script dedicado.
         *
         * Listas nominais e não glob de pasta porque quase toda pasta tem
         * vizinho com dívida antiga. Arquivo NOVO nessas pastas nasce FORA do
         * piso: quem criar, acrescenta aqui.
         */
        // Hooks de admin e os clientes HTTP que eles consomem.
        '**/src/hooks/admin/{useMapPoints,usePresentationInviteLast,useWJAFunnel}.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        '**/src/infrastructure/http/{AdminFunnelStageMessagesApiService,AdminMapApiService,AdminPresentationInviteApiService}.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        // Kanban: os cards e o formatador. `KanbanBoard.tsx` NÃO entra (98,9%
        // de branches) — é vizinho de pasta, e por isso a lista é nominal.
        '**/src/presentation/components/features/admin/Kanban/{KanbanCard.tsx,KanbanCardPresentationInvite.tsx,KanbanCardResend.tsx,KanbanCardStageMessage.tsx,kanbanCardFormat.ts}': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        // Detalhe do paciente: exibição e edição de texto clínico. Regra dura do
        // CLAUDE.md — texto clínico não vaza — mora parcialmente aqui.
        // Acrescentados em 31/08 (feature do contato do lead). O próprio
        // comentário acima manda: quem criar arquivo em 100%, acrescenta aqui —
        // senão o 100% conquistado cai para 70 no próximo PR, em silêncio. Foi
        // achado do gate `revisao-pr` (aviso 2), não meu.
        '**/src/presentation/components/features/admin/PatientDetail/kanban/{PatientKanbanCard.tsx,PatientKanbanBoard.tsx}': {
          lines: 100, statements: 100, functions: 100, branches: 100,
        },
        '**/src/presentation/components/features/admin/PatientDetail/{ClinicalLongText,DiagnosticoCard}.tsx': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        /**
         * Tabela de pacientes e a página que a alimenta — os dois em 100/100/100
         * medidos na suíte INTEIRA (03/09/2026), junto com o util de locale que
         * nasceu da unificação das três cópias do mapa de idioma. Entram aqui
         * pelo motivo escrito no cabeçalho: 100% conquistado e não cobrado cai
         * para o nível do próximo PR, em silêncio.
         *
         * ⚠️ `AdminPatientsPage.tsx` estava em 0% até hoje — o único teste com
         * "AdminPatients" no nome lê os JSON de tradução e nunca renderiza a
         * página. Zero não era "nada errado": era "ninguém olhou".
         */
        '**/src/presentation/components/features/admin/PatientsTable.tsx': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        '**/src/presentation/pages/admin/AdminPatientsPage.tsx': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        '**/src/presentation/utils/dateLocale.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        // Spec 011 bloco A (03/09): contrato da ficha, os 3 cards que passaram a
        // ler o contrato real e os 2 drawers que reenviam o que a tabela tem.
        // Nasceram/ficaram em 100% medidos na suíte inteira — entram no mesmo PR.
        '**/src/domain/entities/patientDetailContract.ts': {
          statements: 100, branches: 100, functions: 100, lines: 100,
        },
        '**/src/presentation/components/features/admin/PatientDetail/{EquipeTratanteCard,LocalizacoesCard,PatientIdentityCard}.tsx': {
          statements: 100, branches: 100, functions: 100, lines: 100,
        },
        '**/src/presentation/components/features/admin/PatientDetail/edit/{PatientGeneralEditDrawer,PatientSupportNetworkEditDrawer}.tsx': {
          statements: 100, branches: 100, functions: 100, lines: 100,
        },
        // Spec 012 bloco B (03/09): estado v2 (controle + Historial), cobertura por catálogo,
        // domicílio na ficha, dispositivo/parentesco por enum, Kanban por admission_status.
        // Nascem/ficam em 100% medidos na suíte inteira — entram no mesmo PR.
        '**/src/domain/entities/patientEnums.ts': {
          statements: 100, branches: 100, functions: 100, lines: 100,
        },
        '**/src/hooks/admin/usePatientKanban.ts': {
          statements: 100, branches: 100, functions: 100, lines: 100,
        },
        '**/src/presentation/components/features/admin/PatientDetail/{PatientStatusControl,PatientStatusHistoryCard,CoberturaMedicaCard,FamiliaresCard,PatientGeneralInfoCard}.tsx': {
          statements: 100, branches: 100, functions: 100, lines: 100,
        },
        '**/src/presentation/components/features/admin/PatientDetail/edit/{PatientCoverageEditDrawer,PatientAddressDrawer,PatientClinicalEditDrawer}.tsx': {
          statements: 100, branches: 100, functions: 100, lines: 100,
        },
        '**/src/presentation/components/features/admin/PatientCreateModal/PatientCreateModal.tsx': {
          statements: 100, branches: 100, functions: 100, lines: 100,
        },
        // Mediram 100 nos quatro eixos na suíte inteira (03/09, modo CI) ao serem tocados pelo bloco B.
        '**/src/infrastructure/http/AdminPatientsApiService.ts': {
          statements: 100, branches: 100, functions: 100, lines: 100,
        },
        '**/src/presentation/pages/admin/PatientDetailPage.tsx': {
          statements: 100, branches: 100, functions: 100, lines: 100,
        },
        '**/src/presentation/components/features/admin/PatientDetail/edit/ClinicalTextareaField.tsx': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        // Detalhe da vaga: funil e recorrência de Meet.
        '**/src/presentation/components/features/admin/VacancyDetail/Funnel/VacancyFunnelKanban.tsx': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        '**/src/presentation/components/features/admin/VacancyDetail/meetRecurringUtils.ts': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        '**/src/presentation/components/features/admin/WorkersTable.tsx': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        '**/src/presentation/components/molecules/PointsMap/PointsMap.tsx': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        // Navegação de admin: quem some daqui some da tela de alguém.
        '**/src/presentation/config/adminNavigation.tsx': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        // Páginas de admin nascidas nesta release.
        '**/src/presentation/pages/admin/AdminMapPage/{AdminMapPage.tsx,mapPageConfig.ts}': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        '**/src/presentation/pages/admin/{FunnelStageMessagesPage,PresentationInvitePage}.tsx': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
        // A modal de escolha da mensagem por etapa e a regra de texto dela.
        // Nascem em 100% (medido na suíte inteira) e entram no piso no MESMO PR
        // que as cria — foi um achado do gate que a regra acima existe.
        '**/src/presentation/pages/admin/{StageMessagePickerModal.tsx,stageMessagePreview.ts}': {
          statements: 100,
          branches: 100,
          functions: 100,
          lines: 100,
        },
      },
    },
  },
  resolve: {
    alias: {
      '@domain': path.resolve(__dirname, './src/domain'),
      '@application': path.resolve(__dirname, './src/application'),
      '@infrastructure': path.resolve(__dirname, './src/infrastructure'),
      '@presentation': path.resolve(__dirname, './src/presentation'),
      '@hooks': path.resolve(__dirname, './src/hooks'),
    },
  },
});
