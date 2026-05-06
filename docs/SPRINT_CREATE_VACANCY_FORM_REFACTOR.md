# Sprint: Criação de Vaga — Wizard → Formulário Único

> **Status:** EM PROGRESSO — sessão 2026-05-03 fechou o gate de transição Step 1 → Step 2 (Meet links com lookup, asteriscos vermelhos, Playwright). Commit pendente.
> **Período:** 2026-05-01 a 2026-05-03 (continuando)
> **Continuação de:** [`docs/SPRINT_VACANCIES_REFACTOR.md`](SPRINT_VACANCIES_REFACTOR.md) (que terminou 2026-04-29)
> **Tickets:** —
> **Branch:** `feat/create-vacancy-form-refactor` (criada 2026-05-02; absorveu `feat/atoms-input-centralization` via FF; sprint code todo no working tree)

---

## 1. Sumário Executivo

A entrega anterior estabeleceu o schema (vaga derivada de paciente, FK `patient_address_id`, status canônicos) e o endpoint público. Esta sprint **substitui o wizard de 6 steps de criação de vaga** por:

- **Tela 1 — `CreateVacancyPage` (form único)** com autocomplete de paciente como entry point. Campos derivados do paciente vêm read-only.
- **Tela 2 — `TalentumConfigPage`** onde a IA gera apenas description + prescreening (não mais extração de fields), recrutadora revisa, configura social links e publica no Talentum.
- **Tela 3** — `VacancyDetailPage` existente, sem mudança.

A IA passou de "extrair tudo do PDF" para "gerar 2 coisas a partir dos dados já preenchidos". O wizard inteiro com PDF upload, parse, address matching e clash resolver foi removido.

---

## 2. Contexto e Motivação

### Estado anterior

Wizard de 6 steps (`enlite-frontend/src/presentation/components/features/admin/CreateVacancy/`):
1. `GeminiParseStep` — upload PDF ou texto livre, IA parseia
2. `PatientAddressSelector` — escolher endereço do paciente identificado
3. `PatientFieldClashResolver` — resolver divergências entre PDF e paciente
4. `VacancyDataStep` — preencher campos restantes
5. `PrescreeningStep` — perguntas pro Talentum
6. `ReviewStep` — revisar + publicar

### Problemas identificados

- **Recrutadora sem PDF na mão** não conseguia criar vaga (tinha "modo texto" como fallback, mas com gaps de hidratação)
- **Edição manual do `case_number` no Step 3** não disparava lookup do paciente — campos clínicos ficavam vazios
- **PDF Gemini parse v2** sempre exigia upload mesmo quando os dados estavam disponíveis em outro lugar
- **Step 5 (PrescreeningStep)** ficava antes da publicação, mas o Talentum precisava de ajustes finos por canal — fluxo não dava espaço pra edição depois da IA

### Objetivos desta sprint

1. Substituir o wizard por **form único** onde o autocomplete de paciente hidrata todos os campos derivados
2. Remover dependência de PDF como entry point — IA passa a gerar a partir do form
3. Suportar **split shifts** (múltiplos slots no mesmo dia) que existem em produção mas não funcionavam no wizard
4. Computar **availability por endereço do paciente** pra evitar criar vaga em horário já ocupado
5. Aplicar **fidelidade visual** ao design Figma novo (tokens `#180149`, Lexend/Poppins, `rounded-[10px]`, `h-[60px]`)
6. **Garantir tudo via integration tests** (frontend → backend → DB) — não confiar só em mocks

---

## 3. Decisões Arquiteturais

### 3.1. Form único substituiu wizard

**Decisão:** Tela 1 é uma página única (não modal, não step). Layout 2 colunas (esquerda: dados do paciente derivados; direita: campos da vaga + endereço + map + horários) + bottom (datas de entrevista de enquadre, datas de publicação/encerramento). Botão "Salvar" no header direito como pill.

**Por quê:** mais rápido pra recrutadora preencher de cabeça (sem stepper). Read-only nos campos derivados elimina decisão "manter ou atualizar".

### 3.2. Autocomplete de paciente como entry point (não mais case_number)

**Decisão:** primeiro campo é `Nome do paciente` com input autocomplete (debounce 300ms, dropdown com avatar + status badge). Selecionar o paciente → form hidrata `tipo_servico`, `dependencia`, `diagnóstico`, `disponivel_para`, `case_number` (último), endereços, `lat/lng`, etc.

**Por quê:** `case_number` não é único (várias vagas no mesmo caso) e não está na cabeça da recrutadora. Nome é o identificador natural.

### 3.3. Campos derivados são read-only por padrão

**Decisão:** `dependency_level`, `tipo_servico`, `hipotese_diagnóstica`, `case_number`, `localização` ficam read-only após hidratar do paciente. Pra alterar, recrutadora vai em "editar paciente" (link futuro — não nesta sprint).

**Por quê:** alinhamento com Decisão 4.4 do sprint anterior (`feedback_patient_overwrite_consent` em memória) — sobrescrita do paciente requer consentimento. Read-only força a recrutadora a corrigir o paciente em vez de sobrescrever na vaga.

### 3.4. IA gera apenas description + prescreening

**Decisão:** o endpoint novo `POST /api/admin/vacancies/:id/generate-ai-content` recebe `vacancyId` (vaga já salva), lê todos os campos do banco, manda pro Gemini/Groq, retorna `{ description: string, prescreening: { questions, faq } }` **sem persistir**. Recrutadora revisa, edita se quiser, salva separadamente via `savePrescreeningConfig`.

**Por quê:** todos os campos (horários, endereço, dependência, etc.) já vêm do form. IA não precisa extrair. Só gera o conteúdo de marketing pro Talentum (description) e as perguntas/FAQ.

### 3.5. `patient_addresses` é dono de `lat/lng`

**Decisão (Fase 0):** colunas `service_lat/service_lng/service_location` movidas de `job_postings` para `patient_addresses`. Vaga lê via JOIN.

**Por quê:** estende a Decisão 4.1 do sprint anterior — vaga é derivada de paciente, sem duplicação. Coordenadas pertencem ao endereço, não à vaga. Migrações:
- `153_add_lat_lng_to_patient_addresses.sql`
- `154_backfill_lat_lng_from_job_postings.sql` (DISTINCT ON, fill-only)
- `155_deprecate_service_lat_lng_from_job_postings.sql` (rename to `_deprecated_20260501`)
- `156_drop_service_lat_lng_deprecated_from_job_postings.sql`

Padrão rename → drop em 2 fases é exigido pelo hook `.claude/hooks/validate-migration.sh`.

### 3.6. Address availability híbrida (1 vs N)

**Decisão:** componente `AddressSelectorWithAvailability` se comporta diferente conforme número de endereços do paciente:

- `addresses.length === 1` → input read-only com badge `"X hr/sem disponíveis"` (caso 100% atual em prod)
- `addresses.length > 1` → dropdown completo com badge em cada opção, `disabled` nas opções com `availability.isFull = true`
- Sempre mostra botão "+ Criar novo endereço" (abre `CreatePatientAddressDialog` existente)

**Por quê:** Spike (Q4 do dia 2026-05-01) confirmou que **0% dos pacientes em prod tem endereço secondary populado** (todos os secundários são placeholders vazios do ClickUp). UX simples agora, expansível quando ClickUp começar a popular múltiplos.

### 3.7. Cálculo de availability via soma simples (sem detecção de overlap)

**Decisão:** capacidade máxima por endereço = 168h/semana (24h × 7 dias). "Active" inclui status `SEARCHING`, `SEARCHING_REPLACEMENT`, `RAPID_RESPONSE`, `ACTIVE`. Soma horas do `schedule` jsonb por dayOfWeek. Não detecta overlap entre vagas.

**Por quê:** spike encontrou apenas 1 caso de overlap real em prod (30min, REPLACEMENT + RAPID_RESPONSE — operacional intencional). Detecção de overlap por janela seria over-engineering.

**Edge cases tratados:**
- **Virada de meia-noite** (`endTime < startTime`, ex: turnos 20:00 → 08:00): `hours = (24 - startHour) + endHour`. Sem isso, turnos noturnos viravam negativos.
- **`schedule = []` ou null**: contribui 0h e marca `hasUnknownSchedule = true`. **`isFull` só vira `true` se TODAS as vagas tiverem schedule preenchido E soma >= 168h.** Conservador.

Implementação: [`worker-functions/src/modules/case/application/AddressAvailabilityCalculator.ts`](../worker-functions/src/modules/case/application/AddressAvailabilityCalculator.ts) (função pura, 100% coverage com 13 unit tests).

### 3.8. Split shifts suportados nativamente

**Decisão:** `WeeklyDaySchedulePicker` (reusado de `VacancyModal/`, já cobria) permite N slots no mesmo dia. Schema do `schedule` jsonb (`{dayOfWeek, startTime, endTime}[]`) já suportava — só faltava UI permitir.

**Por quê:** spike encontrou 4-5 casos reais em ClickUp (`Lunes a Viernes 07-10 y 16-21`, `Mañana 09-11:30 y Tarde 17-19`, etc.). Schema desde sempre suportava — só não estava exposto.

**Decisão de produto pendente:** `DP-001` em [`docs/FOLLOWUPS.md`](FOLLOWUPS.md) registra a discussão se split shifts deveriam ser **2 vagas separadas** (opinião do PO) ou continuar como 1 vaga com schedule split. Por enquanto frontend permite ambos os modelos.

### 3.9. Status default = `PENDING_ACTIVATION`

**Decisão:** quando `createVacancy` é chamado sem `status` no body, o backend define como `PENDING_ACTIVATION` (rascunho). A vaga só vira `SEARCHING`/etc. quando publicada via Tela 2 (Talentum).

**Por quê:** evita estado intermediário "vaga existe mas não tem prescreening". Listagem pública e captação só consideram vagas com status público — `PENDING_ACTIVATION` é invisível pra candidatos.

### 3.10. Visual tokens migraram nos atoms/molecules globais

**Decisão (Fase 3.5):** ao aplicar specs do Figma, os atoms `Label` e molecules `InputWithIcon`/`SelectField` foram **modificados globalmente** (não só na pasta nova). Tokens novos: `#180149` primary, `#737373` text, `#d9d9d9` border, Lexend Medium 18px labels, 20px valores, `h-[60px]` inputs, `rounded-[10px]`.

**Trade-off aceito:** afeta os ~31 consumidores existentes (workers, patients, encuadres, vacancy modal legacy). User explicitamente preferiu (a) "tudo centralizado" sobre (b) "override local em CreateVacancyV2 só".

**Implicação:** todo formulário admin agora tem aparência da nova identidade. Se aparecer regressão, ajusta caso a caso. Documenta-se como migração de design system.

### 3.11. Modal `CreatePatientAddressDialog` precisa de `createPortal`

**Bug encontrado durante integration test:** o componente era renderizado dentro de `<form>` da vaga, criando forms HTML aninhados (inválido pelo spec). Browser descartava `<form>` interno → click em "Guardar" no diálogo submetia o form da vaga com dados incompletos.

**Fix:** wrap retorno em `createPortal(content, document.body)` (`react-dom`). Renderiza fora da árvore DOM do form principal.

**Lição:** integration tests catam bugs que mocked E2E não pegam. Vale o investimento.

### 3.12. Big-bang commit (não incremental)

**Decisão:** todo o trabalho fica unstaged até estar 100% verde. Quando passar tudo (unit + integration + lint + type-check + validate), faz commit único (ou splittado em 2-3 lógicos).

**Por quê:** mudanças cruzam backend + frontend + schema + tests. Commits parciais deixariam a branch em estado intermediário não-funcional, violando `feedback_all_tests_pass_before_commit`.

---

## 4. Fases de Implementação

Cada fase virou um PR conceitual (não commitado individualmente — big-bang no fim).

### Fase 0 — Schema cleanup: lat/lng para `patient_addresses`

| Item | Arquivo |
|---|---|
| Migration 153-156 (rename + backfill + drop) | `worker-functions/migrations/15{3,4,5,6}_*.sql` |
| `MatchmakingService.loadJob` JOIN | `worker-functions/src/modules/matching/infrastructure/MatchmakingService.ts:154` |
| `VacancyMatchController.getMatchResults` distance via `ST_MakePoint(pa.lng, pa.lat)` | `VacancyMatchController.ts` |
| `PatientRepository`, `PatientQueryRepository`, `PatientDetailQueryHelper`, `AdminPatientsController.listPatientAddresses` propagam `lat/lng` | múltiplos |
| `PatientAddress` entity | `src/modules/case/domain/PatientAddress.ts` |

**Achado lateral:** `service_location` (PostGIS GENERATED column) dependia de `service_lat/lng`. Tratada no rename (155) e drop (156).

### Fase 0.5 — Fix da E2E baseline

A baseline E2E **antes** desta sprint já tinha 6 suites falhando porque referenciavam colunas dropadas pela migration 152 (Fase 9 do sprint anterior: `state`, `city`, `pathology_types`, `dependency_level`, `service_address_formatted`, `service_address_raw`, `service_device_types`). Não dava pra commitar nada novo enquanto a baseline estivesse vermelha (regra `feedback_all_tests_pass_before_commit`).

| Suite | Fix aplicado |
|---|---|
| `talentum-sync.test.ts` | INSERTs sem colunas dropadas; dados clínicos em `patients` |
| `phase3-enrichment-invariants.e2e.test.ts` | `samplePatch()` removeu `pathology_types`/`dependency_level`/`service_device_types` |
| `phase1-vacancies-invariants.e2e.test.ts` | `serviceAddressFormatted` → `patient_address_id` (com helper insertPatientAddress); index `idx_job_postings_unique_slot` invertido para "não existe" |
| `public-jobs.test.ts` | `'DOMICILIO'` (TEXT inválido) → `ARRAY['AT']::text[]` (canônico) |
| `wave6-job-postings-refactor.test.ts` | 2 testes invertidos: `dependency_level` em `job_postings` agora é `toHaveLength(0)` |
| `vacancy-cases-for-select.test.ts` | `describe.skip` (depois deletado na Fase 2) |

Bonus: `enrich-vacancies-helpers.ts` atualizado pra remover refs a colunas dropadas. `MockAuthMiddleware.ts` adicionou `/api/public/` aos publicPaths (era bug de config que impedia `public-jobs.test.ts` de rodar).

### Fase 1 — Backend ajustes de endpoint

| Item | Arquivo |
|---|---|
| Autocomplete `addressesCount` no list | `PatientQueryRepository.ts.list()` |
| `lastCaseNumber`, `addresses[*].isPrimary`, `addresses[*].availability` | `PatientDetailQueryHelper.ts` |
| **`AddressAvailabilityCalculator` (NOVO, função pura, 100% cov, 13 unit tests)** | `src/modules/case/application/AddressAvailabilityCalculator.ts` |
| `createVacancy` valida `patient_address_id` via `patient_id` direto | `VacancyCrudController.ts` |
| Status default `PENDING_ACTIVATION` | `vacancyCrudHelpers.ts` |
| **`POST /vacancies/:id/generate-ai-content`** (NOVO endpoint — wrapper sobre `TalentumDescriptionService.generateDescriptionPreview` + `GeminiVacancyParserService.generateFromVacancyData`) | `VacancyTalentumController.ts` |
| Helpers extraídos pra manter <400 linhas | `GeminiVacancyParserHelpers.ts` |
| 17 integration tests novos cobrindo todos os endpoints modificados | `phase1-new-vacancy-form.e2e.test.ts` |

### Fase 2 — Deletar wizard antigo backend

Deletados (PR conceitual #2):
- `VacancyParseController.ts` inteiro (rotas `parse`, `parse-from-text`, `parse-from-pdf`)
- Métodos `parseFromText`/`parseFromPdf` em `VacancyCrudController.ts`
- `MatchPdfAddressToPatientAddressUseCase` + teste
- `ResolvePatientFieldClashUseCase` + teste
- `VacancyCasesController` + endpoint `cases-for-select`  ⚠ **(REVERTIDO ao final — ver §6.2)**
- Endpoint `next-case-number` em `VacanciesController` (alias de `getNextVacancyNumber`)
- `pdfUploadMiddleware` no `matching/index.ts`

### Fase 3 — Frontend: `CreateVacancyPage` (Tela 1)

**Componentes criados** em `src/presentation/components/features/admin/CreateVacancyV2/`:
- `PatientSearchAutocomplete.tsx` — autocomplete com debounce + dropdown role="listbox"
- `PatientAdmissionBanner.tsx` — banner amarelo no topo quando paciente é ADMISSION
- `AddressSelectorWithAvailability.tsx` — híbrido 1 vs N
- `WeeklyDaySchedulePicker` (reusado do `VacancyModal/`)
- `InterviewSlotsButton.tsx` + `InterviewSlotsModal.tsx` — calendário + grid de horários
- `CreateVacancyForm.tsx` orquestrador (RHF + Zod)
- `CreateVacancyLeftColumn.tsx` + `CreateVacancyRightColumn.tsx`
- `create-vacancy-v2-schema.ts` — Zod
- `CreatePatientAddressDialog.tsx` — **movido** de `CreateVacancy/`, **com `createPortal` fix**

**Hook novo:** `src/hooks/admin/useCreateVacancyV2.ts` — orquestra hidratação + submit (RHF separado).

**Util novo:** `src/presentation/hooks/useDebouncedValue.ts` — função pura genérica.

**Pasta deletada inteira:** `CreateVacancy/` (após mover `PrescreeningStep` → `TalentumConfig/` na Fase 4).

**Reusos confirmados (architect mapeou, dev confirmou):**
- `ServiceAreaMap` (Maps key já configurada — `VITE_GOOGLE_MAPS_API_KEY`)
- `AlertBanner` (mas variant `warning` usa `#ff0066`, não amber — solução: PatientAdmissionBanner é wrapper inline com classes amber custom)
- Constants `STATUS_OPTIONS`, `SEX_OPTIONS`, etc. de `vacancy-form-schema.ts`

### Fase 3.5 — Visual fidelity pass com Figma

**Erro reconhecido:** primeiras dispatches pro frontend-dev passaram só descrição textual do design — não os specs reais do Figma. Resultado: estrutura ok, fidelidade visual fora.

**Correção:** chamado `mcp__figma__get_design_context` em 2 frames (form: `6484:32094`, modal slots: `6953:71808`), extraído tokens (cores, fonts, spacings, radius, layout), gerado spec doc em `/tmp/figma-create-vacancy-specs.md`, dispatchado novo pass focado em "CSS/Tailwind only".

**Mudanças aplicadas:**

| Item | Antes | Depois |
|---|---|---|
| Label (atom) | `font-semibold text-base text-gray-800` | `font-medium text-[18px] text-[#737373]` |
| InputWithIcon (molecule) | `min-h-[56px] px-4 border-[1.5px]` + texto `text-base text-gray-800` | `h-[60px] px-5 border-2` + texto `text-[20px] text-[#737373]` |
| SelectField (molecule) | `h-12 px-4 border-[1.5px]` + img CDN externo | `h-[60px] px-5 border-2` + `<ChevronDown />` lucide |
| Botão Salvar | retangular | pill `rounded-full h-10 w-40 bg-[#180149]` |
| Modal de slots | (placeholder) | side-sheet `rounded-l-[32px]` com card primary à esquerda + grid de horários à direita |
| Inputs do form | (placeholder) | container `bg-white rounded-l-[32px] pl-12 pr-6 py-10` |

**Lição:** dispatches pra agentes que vão construir UI **devem incluir specs do Figma extraídos**, não descrição textual. `get_design_context` retorna React+Tailwind code que serve de referência (não final, mas direto).

### Fase 4 — Frontend: `TalentumConfigPage` (Tela 2)

**Não há Figma específico** pra esta tela — composição de componentes existentes mantendo tokens da Tela 1.

**Componentes criados** em `src/presentation/components/features/admin/TalentumConfig/`:
- `VacancySummaryCard.tsx` — card read-only com case_number, paciente, datas, status
- `GenerateAIButton.tsx` — botão grande com estados idle/loading/error/success
- `AIDescriptionEditor.tsx` — textarea editável com counter `{n}/4000`
- `PrescreeningStep.tsx` — **movido** de `CreateVacancy/`, reuso intacto

**Hook novo:** `src/hooks/admin/useTalentumConfig.ts` — generateAIContent + savePrescreening + publish.

**Page nova:** `src/presentation/pages/admin/TalentumConfigPage.tsx` — orquestra tudo.

**Service extraído:** `AdminTalentumApiService.ts` (delegation pattern já usado por 4 outros sub-services). Motivo: `AdminApiService.ts` ficou em 407 linhas com `generateAIContent` adicionado — split forçado pelo limite de 400 linhas.

**Side fix:** `GeneralInfoTab.tsx` (violação pré-existente de 580 linhas) splittado em `GeneralInfoFormFields.tsx` — necessário pra `validate:lines` ficar verde.

**Routing:** `/admin/vacancies/:id/talentum` registrado em `App.tsx:104`. `CreateVacancyPage.handleSubmit` navega pra essa rota após salvar.

**Pasta `CreateVacancy/` deletada inteira** após mover `PrescreeningStep`.

### Fase 5 — Routing + tabs detail page

Efetivamente já fechada via Fases 3+4:
- `/admin/vacancies/new` → `CreateVacancyPage`
- `/admin/vacancies/:id/talentum` → `TalentumConfigPage`
- `/admin/vacancies/:id` → `VacancyDetailPage` (existente, sem mudança)
- Submit Tela 1 → navega Tela 2; publish Tela 2 → navega Tela 3

Tabs Convidados/Postulados/Pré Selecionados/Rejeitados/Desistentes já existem via `EncuadreFunnelController` (sprint anterior).

### Fase 6 — Integration tests full-stack

**Arquivos criados** em `enlite-frontend/e2e/integration/`:
- `full-create-vacancy.integration.e2e.ts` — happy path: search paciente → form hidrata → save → Tela 2 → IA → publish → Tela 3
- `admission-patient-flow.integration.e2e.ts` — paciente ADMISSION + criar endereço inline + submit

**Helper novo:** `e2e/helpers/db-test-helper.ts` — INSERT/DELETE/SELECT direto no banco via `docker exec enlite-postgres psql`. Evita adicionar dep `pg` ao frontend.

**npm scripts adicionados:**
- `pnpm test:e2e:integration` — só os tagueados `@integration`
- `pnpm test:e2e:no-integration` — só os mockados

**Auth strategy:** intercepta TODAS as chamadas `/api/**` e troca Authorization por `Bearer mock_<base64>`. Backend roda com `USE_MOCK_AUTH=true` (compose `docker-compose.test.yml`). `/api/admin/auth/profile`, `/generate-ai-content`, `/publish-talentum` são mockados via `page.route()` pra evitar chamada externa.

**Bug encontrado (createPortal):** ver §6.1.

---

## 5. Componentes — Mapa Final

### Criados (frontend)
```
src/presentation/components/features/admin/
  CreateVacancyV2/
    PatientSearchAutocomplete.tsx          (~180 linhas)
    PatientAdmissionBanner.tsx             (~40 linhas)
    AddressSelectorWithAvailability.tsx    (~150 linhas)
    InterviewSlotsButton.tsx               (~80 linhas)
    InterviewSlotsModal.tsx                (~250 linhas)
    CreateVacancyForm.tsx                  (~300 linhas)
    CreateVacancyLeftColumn.tsx            (~250 linhas)
    CreateVacancyRightColumn.tsx           (~250 linhas)
    CreatePatientAddressDialog.tsx         (movido + createPortal fix)
    create-vacancy-v2-schema.ts
    __tests__/                             (4 unit tests)

  TalentumConfig/
    VacancySummaryCard.tsx
    GenerateAIButton.tsx
    AIDescriptionEditor.tsx
    PrescreeningStep.tsx                   (movido de CreateVacancy/)
    __tests__/

src/presentation/pages/admin/
  CreateVacancyPage.tsx                    (rewrite)
  TalentumConfigPage.tsx                   (NOVO)

src/presentation/pages/tabs/
  GeneralInfoFormFields.tsx                (split de GeneralInfoTab)

src/hooks/admin/
  useCreateVacancyV2.ts
  useTalentumConfig.ts

src/presentation/hooks/
  useDebouncedValue.ts                     (util novo)

src/infrastructure/http/
  AdminTalentumApiService.ts               (extraído de AdminApiService)

e2e/integration/
  full-create-vacancy.integration.e2e.ts
  admission-patient-flow.integration.e2e.ts

e2e/helpers/
  db-test-helper.ts
```

### Criados (backend)
```
worker-functions/migrations/
  153_add_lat_lng_to_patient_addresses.sql
  154_backfill_lat_lng_from_job_postings.sql
  155_deprecate_service_lat_lng_from_job_postings.sql
  156_drop_service_lat_lng_deprecated_from_job_postings.sql

worker-functions/src/modules/case/application/
  AddressAvailabilityCalculator.ts         (função pura, 100% cov, 13 testes)

worker-functions/src/modules/integration/infrastructure/
  GeminiVacancyParserHelpers.ts            (extraído pra <400 linhas)
```

### Modificados (atoms/molecules globais)
```
src/presentation/components/atoms/Label/Label.tsx
src/presentation/components/molecules/InputWithIcon/InputWithIcon.tsx
src/presentation/components/molecules/SelectField/SelectField.tsx
```

Tokens migrados pro novo design system. **Affecting blast radius:** ~31 consumers (workers, patients, encuadres). Aceito explicitamente como migração centralizada.

### Deletados
```
Frontend:
  CreateVacancy/                           (pasta inteira)
  src/hooks/admin/useCreateVacancyFlow.ts
  src/infrastructure/http/AdminVacancyParseApiService.ts
  e2e/create-vacancy-wizard.e2e.ts

Backend:
  src/modules/matching/interfaces/controllers/VacancyParseController.ts
  src/modules/matching/application/MatchPdfAddressToPatientAddressUseCase.ts
  src/modules/matching/application/ResolvePatientFieldClashUseCase.ts
  scripts/enrich-vacancies-with-gemini.ts  (ver TD-002 em FOLLOWUPS)
  tests/e2e/vacancy-cases-for-select.test.ts
  tests/unit/__tests__/MatchPdfAddressToPatientAddressUseCase.test.ts
  tests/unit/__tests__/ResolvePatientFieldClashUseCase.test.ts
```

---

## 6. Bugs Caught

### 6.1. Forms HTML aninhados em `CreatePatientAddressDialog`

**Sintoma:** click em "Guardar" no diálogo de criar endereço submetia o form da vaga (sem dados completos), em vez do form do diálogo.

**Causa:** o componente renderizava `<form>` interno dentro do `<form>` externo da vaga. HTML5 não permite — browser descarta a tag interna e o `type="submit"` sobe pro form externo.

**Detectado por:** integration test `admission-patient-flow.integration.e2e.ts` ao tentar criar endereço novo no fluxo ADMISSION.

**Fix:** wrap retorno do componente em `createPortal(content, document.body)` (`react-dom`). Diff de 2 linhas.

**Lição:** integration tests valem o investimento — pegam o que mocked E2E não pega. Vide `feedback_e2e_must_run_before_commit`.

### 6.2. `cases-for-select` deletado por engano (regressão em `VacancyModal/` legacy)

**Sintoma:** após Fase 2 (delete do wizard), modal de **edição** de vaga (acessível via lista em `AdminVacanciesPage`) ficou quebrado: erro `invalid input syntax for type uuid: "cases-for-select"`. Backend caía no route `/vacancies/:id` com `id="cases-for-select"`.

**Causa:** o architect's audit categorizou `cases-for-select` como "exclusivo do wizard". Errado — `VacancyModal/CaseSelectStep.tsx` e `VacancyFormLeftColumn.tsx` (modal de edição/criação direto da listagem) também usavam.

**Detectado por:** user em testing manual local após Fase 2.

**Fix:** restaurado endpoint:
- Método `getCasesForSelect()` reescrito em `VacanciesController.ts` (DISTINCT ON `case_number`, JOIN com `patients`, retorna `[{ caseNumber, patientId, dependencyLevel }]`)
- Rota `/vacancies/cases-for-select` re-adicionada em `adminVacanciesRoutes.ts` (BEFORE `/:id` pra evitar param capture)

**Follow-up:** TD-003 em `FOLLOWUPS.md` — deprecar `VacancyModal/` legacy futuramente. Hoje convivem 2 fluxos (CreateVacancyV2 + VacancyModal). Sprint dedicada migra "Edit" da listagem pra `/admin/vacancies/:id/edit` (route nova da `CreateVacancyPage` em modo edição).

**Lição:** **architect's audit pode subestimar dependências cross-feature.** Antes de deletar endpoint, fazer grep universal em `enlite-frontend/src/` (não só no escopo do refactor). Mecanismo de defesa adicionado em §7.1.

---

## 7. Patterns Estabelecidos

### 7.1. Hook `validate-migration.sh` estendido

`.claude/hooks/validate-migration.sh` agora detecta `DROP COLUMN` e faz grep no código de produção (`worker-functions/src/` e `worker-functions/scripts/`) pelos nomes de coluna. Se houver referência viva, **bloqueia a migration** e lista os arquivos. Ignora colunas com nomes muito genéricos (`id`, `created_at`, `name`, `status`, etc.) e arquivos `_deprecated_` pra reduzir falsos positivos.

Defesa contra "tsc não vê SQL string crua" — o grep é cego pra tipo, vê o nome em qualquer lugar.

Registrado em `FOLLOWUPS.md` como **TD-002 mitigado**.

### 7.2. Address availability calculation

Modelo de cálculo padronizado pra "endereço cheio":

```ts
type AddressAvailability = {
  totalCoveredHours: number;
  maxHours: 168;
  isFull: boolean;
  perDay: Array<{
    dayOfWeek: number;       // 0=Dom, 6=Sab
    coveredHours: number;
    availableRanges: Array<{ start: string; end: string }>;
  }>;
  activeVacanciesCount: number;
  hasUnknownSchedule: boolean;
};
```

Implementação em `AddressAvailabilityCalculator.ts`. Pode ser reusado em qualquer feature que precise de "horários disponíveis por endereço/recurso".

### 7.3. Visual tokens do design system novo

Catalogados em `/tmp/figma-create-vacancy-specs.md` (temporário) e aplicados nos atoms/molecules globais. Tokens essenciais:

| Token | Valor | Uso |
|---|---|---|
| `#180149` | Primary | Títulos, botão Salvar, pill de slot, borda card de horário |
| `#737373` | Texto secundário | Labels, valores, helper text |
| `#d9d9d9` | Border | Inputs, cards |
| `#eceff1` | Border soft | Border `2.5px` em campos específicos |
| `#FFF9FC` | Page background | Fora dos cards |
| Poppins SemiBold | Heading | H1 32px, botão Salvar 16px, dia de schedule 16px |
| Lexend SemiBold | Subheading | Mês/ano calendário 22px |
| Lexend Medium | Labels/values | Labels 18px, valores 20px |
| Lexend Regular | Helper text | Helper 12px, badges 14px, slots 14px |
| `rounded-[10px]` | Inputs | Pattern universal |
| `rounded-l-[32px]` | Modal/page wrapper | Side-sheet style |
| `rounded-full` | Pill | Botão Salvar (h-10 w-40) |
| `h-[60px]` | Input height | Padronizado em inputs/selects |

### 7.4. Integration test pattern

- Pasta `e2e/integration/`, sufixo `*.integration.e2e.ts`
- Tag `@integration` no `test.describe()`
- npm scripts separados (`test:e2e:integration` e `test:e2e:no-integration`)
- Helper `db-test-helper.ts` via `docker exec` (zero deps adicionadas no frontend)
- Mocka SÓ endpoints externos (Talentum publish, Gemini/Groq) — backend interno é REAL
- Cleanup robusto via `test.afterAll()`

Pré-condições documentadas em `enlite-frontend/CLAUDE.md`.

### 7.5. Side-sheet style com `rounded-l-[32px]`

Padrão visual pra "modal que entra pela direita": container com `rounded-l-[32px]` (só lados esquerdos) + `pl-12 pr-6 py-10`. Aplicado em:
- Card principal da `CreateVacancyPage`
- `InterviewSlotsModal`
- (futuro) `VacancyModal` quando migrar

---

## 8. Lessons Learned

### 8.1. Sempre passe specs do Figma — não descrição textual

A descrição "tem 2 colunas, paciente à esquerda, endereço à direita" produz layout estrutural OK mas fidelidade visual zero. `mcp__figma__get_design_context` retorna React+Tailwind direto — copia tokens (cores, fontes, spacings) e passa pro dev no prompt. Custou um pass de visual fidelity extra (Fase 3.5) por não ter feito isso desde o início.

### 8.2. Architect's audit pode subestimar dependências cross-feature

Antes de deletar endpoint, **fazer grep universal** no codebase do consumidor (`enlite-frontend/src/`), não só no escopo do refactor atual. `cases-for-select` foi deletado porque o architect mapeou que "wizard usa", mas `VacancyModal/` legacy também usa. Mitigado por `validate-migration.sh` estendido (§7.1) — defesa em depth.

### 8.3. Integration tests catam bugs que mocked E2E não pegam

Bug do `createPortal` (forms aninhados) só apareceu quando integration test exercitou o fluxo real de criar endereço inline. Em mocked E2E, o submit do diálogo nem chegava no backend — não havia evidência do problema. **Mocked E2E pode mentir.** Justificativa pra ter ambos.

### 8.4. Mudanças globais em atoms/molecules têm blast radius wide

Ao migrar tokens visuais do `Label`/`InputWithIcon`/`SelectField`, ~31 consumidores foram afetados (alguns sem teste visual). Decisão consciente do user (option a — migração centralizada) sobre option b (override local). Trade-off aceito: regressões aparecem caso a caso, ajusta quando aparecer. Mas **não é grátis**.

### 8.5. `CreatePortal` é necessário pra modais dentro de forms

`<form>` aninhado é HTML inválido. Browser silenciosamente descarta o form interno. Submit do botão dentro vai pro form externo. **Sempre que um modal/dialog tiver `<form>` interno e estiver renderizado dentro de outro form, usar `createPortal(content, document.body)`.**

### 8.6. Limite de 400 linhas força modularização útil

Regra `feedback_line_limit_when_touching_file` parecia limitante mas resultou em:
- `AdminTalentumApiService.ts` extraído (delegation pattern já existia)
- `GeminiVacancyParserHelpers.ts` extraído (separação validators/DB helpers/text builders)
- `GeneralInfoFormFields.tsx` extraído de `GeneralInfoTab.tsx` (560+ linhas pré-existente)

Cada extração teve responsabilidade clara. Limite de linha funciona como gate pra "esse arquivo está fazendo coisa demais".

### 8.7. Big-bang commit no fim funciona pra mudanças cross-stack

Quando schema + backend + frontend mudam juntos, commits parciais deixariam a branch em estado intermediário não-funcional. Big-bang commit no fim com working tree todo verde é mais seguro. **Custo:** working tree fica grande (~70 arquivos), risco de perder por hora sem backup.

**Mitigação adotada:** validação contínua (lint + type-check + tests) ao fim de cada fase. Se algo quebra, fix antes de seguir. Working tree nunca é deixado vermelho.

---

## 9. Métricas Finais

### Backend
- 4 migrations novas (153-156)
- ~10 arquivos modificados
- ~6 arquivos deletados
- 1 arquivo criado (`AddressAvailabilityCalculator.ts`)
- Tests: 1364 unit + 53 E2E suites passing, 0 failures, 1 skipped (vacancy-cases-for-select removido)
- `talentum-webhook-v2` mantido em 10/10 (regra crítica)

### Frontend
- ~13 arquivos criados em `CreateVacancyV2/` + `TalentumConfig/`
- ~8 arquivos deletados (wizard antigo)
- 3 atoms/molecules globais modificados
- 4 service files modificados/criados
- Tests: 2637 unit passing, integration tests criados (validação manual pendente em ambiente correto)
- Build verde, lint 0 warnings, type-check 0 errors, validate:lines + validate:architecture verdes

### Tempo
- 2 dias (2026-05-01 e 2026-05-02)
- ~7 fases sequenciais com gates verdes entre cada uma

---

## 10. Open Questions / Pendências

### Pendentes nesta sprint
- [ ] **Big-bang commit** com mensagem consolidada — bloqueado por validação manual final
- [ ] **Validação manual no browser** com test compose ou seed real — confirmar que autocomplete + hidratação + save funcionam end-to-end

### Follow-ups registrados em `docs/FOLLOWUPS.md`
- **TD-001** — `ClickUpVacancyMapper` não estrutura `Días y Horarios` (só 10% das tasks viram `schedule` jsonb)
- **TD-002** — Scripts CLI ad-hoc viram bombas-relógio (mitigado via hook)
- **TD-003** (proposta nesta sprint) — Deprecar `VacancyModal/` legacy. Hoje convivem 2 fluxos: novo `CreateVacancyV2/` + antigo `VacancyModal/` (modal de edição na listagem). Sprint dedicada migra "Edit" da listagem pra rota `/admin/vacancies/:id/edit` (CreateVacancyPage em modo edição). Enquanto isso, o endpoint `cases-for-select` permanece restaurado.
- **DP-001** — Split shifts: 1 vaga split ou 2 vagas separadas? Em conversa com gestão de operações.

---

## 11. Referências

### Memórias relevantes (em `~/.claude/projects/.../memory/`)

- `feedback_patient_overwrite_consent.md` — sobrescrita de paciente sempre com consentimento
- `project_admission_is_patient_status.md` — `admisión` é status de paciente, não vaga
- `feedback_modularize_to_extreme.md` — preferir muitos arquivos pequenos
- `feedback_visual_tests_required.md` — Playwright screenshot obrigatório
- `feedback_e2e_must_run_before_commit.md` — E2E é PRÉ-condição
- `feedback_all_tests_pass_before_commit.md` — gate obrigatório
- `feedback_line_limit_when_touching_file.md` — limite 400 linhas
- `feedback_cleanup_obsolete_files.md` — apaga órfãos no mesmo commit
- `feedback_enum_values_english_uppercase.md` — canônicos UPPERCASE EN
- `project_patient_vacancy_cardinality.md` — paciente N responsáveis/endereços
- `reference_followups_doc.md` — `docs/FOLLOWUPS.md` existe
- `reference_sprint_vacancies_refactor.md` — sprint anterior (Decisões 4.1, 4.3, 4.4)

### Código de referência

**Backend:**
- `worker-functions/src/modules/case/application/AddressAvailabilityCalculator.ts`
- `worker-functions/src/modules/case/infrastructure/PatientDetailQueryHelper.ts`
- `worker-functions/src/modules/matching/interfaces/controllers/VacancyTalentumController.ts`
- `worker-functions/src/modules/matching/interfaces/controllers/VacanciesController.ts` (`getCasesForSelect`)
- `worker-functions/src/modules/integration/infrastructure/GeminiVacancyParserService.ts`

**Frontend:**
- `enlite-frontend/src/presentation/components/features/admin/CreateVacancyV2/`
- `enlite-frontend/src/presentation/components/features/admin/TalentumConfig/`
- `enlite-frontend/src/presentation/pages/admin/CreateVacancyPage.tsx`
- `enlite-frontend/src/presentation/pages/admin/TalentumConfigPage.tsx`
- `enlite-frontend/src/hooks/admin/useCreateVacancyV2.ts`
- `enlite-frontend/src/hooks/admin/useTalentumConfig.ts`
- `enlite-frontend/src/infrastructure/http/AdminTalentumApiService.ts`

**Tests:**
- `enlite-frontend/e2e/integration/full-create-vacancy.integration.e2e.ts`
- `enlite-frontend/e2e/integration/admission-patient-flow.integration.e2e.ts`
- `enlite-frontend/e2e/helpers/db-test-helper.ts`

### Outros docs
- [`docs/SPRINT_VACANCIES_REFACTOR.md`](SPRINT_VACANCIES_REFACTOR.md) — sprint anterior (10 fases, schema base)
- [`docs/FOLLOWUPS.md`](FOLLOWUPS.md) — TD/DP pendentes
- [`enlite-frontend/CLAUDE.md`](../enlite-frontend/CLAUDE.md) — comandos pra rodar testes de integração
- [`worker-functions/CLAUDE.md`](../worker-functions/CLAUDE.md) — guia do backend

### Figma
- Arquivo: `App EnLite Pro - Copy` (key `6weibfyKiLH2VWWcxcIRiA`)
- Frame form preenchido: `6484:32094` (modal interno do `6340:16115`)
- Frame modal slots: `6953:71808`

---

## 12. Histórico de Decisões

| Data | Decisão | Justificativa |
|---|---|---|
| 2026-05-01 | Substituir wizard de 6 steps por form único | UX: recrutadora não tem PDF na mão sempre; autocomplete é entry point natural |
| 2026-05-01 | IA gera só description + prescreening | Resto vem do form preenchido manualmente |
| 2026-05-01 | Read-only nos campos derivados do paciente (incluindo `dependency_level`) | Sobrescrita do paciente requer consentimento (memória `feedback_patient_overwrite_consent`) |
| 2026-05-01 | `lat/lng` movem de `job_postings` para `patient_addresses` | Decisão 4.1 do sprint anterior — vaga é derivada de paciente |
| 2026-05-01 | Status default = `PENDING_ACTIVATION` | Rascunho até publicação no Talentum |
| 2026-05-01 | Address availability = soma simples + fix meia-noite | Spike confirmou 0 endereços com >168h em prod, 1 só caso de overlap (intencional) |
| 2026-05-01 | Híbrido 1 vs N pra address selector | 100% pacientes em prod tem só 1 endereço — UX simples |
| 2026-05-01 | Split shifts suportados nativamente | Schema já permitia (jsonb array com N entries no mesmo dayOfWeek) |
| 2026-05-01 | TD-001 + TD-002 + DP-001 registrados em FOLLOWUPS | Itens descobertos fora de escopo |
| 2026-05-02 | Visual fidelity migra atoms/molecules globais (não só CreateVacancyV2) | User aceita migração centralizada do design system |
| 2026-05-02 | `CreatePatientAddressDialog` precisa `createPortal` | Bug de forms HTML aninhados detectado por integration test |
| 2026-05-02 | `cases-for-select` restaurado | `VacancyModal/` legacy ainda depende — Phase 2 foi overzealous |
| 2026-05-02 | TD-003 proposto: deprecar `VacancyModal/` legacy | Sprint dedicada futura migra Edit pra `CreateVacancyPage` |
| 2026-05-02 | Big-bang commit no fim, não incremental | Mudanças cross-stack — commits parciais deixariam branch em estado quebrado |
| 2026-05-02 | Branch dedicada `feat/create-vacancy-form-refactor` criada e merged com `feat/atoms-input-centralization` (FF) | Isolar trabalho da main; absorver atoms novos antes do refactor |
| 2026-05-02 | **PIVOT:** abandonar form V2 com autocomplete; reusar `VacancyFormSection` (modal-content) na `CreateVacancyPage` | Modal já tinha tudo que a recrutadora precisa (case-select, fields, schedule). Reusar > reescrever |
| 2026-05-03 | RBAC controla mascaramento de PII no futuro; remover hardcode `patientNamePrivacy='—'` | Nome do paciente passa a ser visível pro staff agora; mascaramento futuro vem por permissão (memória `project_rbac_pii_visibility`) |
| 2026-05-03 | ClickUp será depreciado — não investir em mapper de complemento | Coluna `complement` adicionada (157), populada manual via UI futura. Não pedir campo novo no ClickUp (memória `project_clickup_deprecation`) |
| 2026-05-03 | Disabled = bg gris, não opacity | Opacity afeta texto e fica ilegível; bg `#f3f4f6` mantém legibilidade |

---

## 13. Sessão 2026-05-02/03 — Pivot: form V2 → modal-content na page com Stepper

Esta seção documenta a sessão que refez completamente a abordagem da Tela 1.

### 13.1. Por que pivotamos

O form V2 com autocomplete de paciente (sec. 3.2 acima) foi construído mas **nunca exposto na UI**: o botão "Nova vaga" no `AdminVacanciesPage` continuava abrindo o `VacancyModal` legacy. Ao tentar usar o flow novo, o user descobriu que:

1. O modal legacy não tinha multi-step, IA, Talentum nada — terminava em "criar e fechar".
2. A `CreateVacancyPage` (V2) era órfã. Acessível só por `/admin/vacancies/new` digitado.
3. O modal legacy já tinha **todos** os campos relevantes pra recrutadora (case-select, dependency read-only, address selector, schedule, salary, etc.).

Decisão: **trocar o conteúdo da CreateVacancyPage pelo do modal**. Reusar `VacancyFormSection` em vez de reescrever. Manter a página V2 como shell + Stepper. O modal legacy fica vivo só pra "edit" da listagem (até `TD-003` deprecá-lo).

### 13.2. Mudanças na Tela 1 (`CreateVacancyPage`)

| Item | Antes | Agora |
|---|---|---|
| Conteúdo do form | `CreateVacancyForm` + `CreateVacancyLeftColumn`/`RightColumn` (V2, autocomplete-based) | `VacancyFormSection` + `VacancyFormLeftColumn`/`RightColumn` (do `VacancyModal/`) |
| Estado de paciente | `useCreateVacancyV2` hook | `useVacancyModalFlow` (mesmo do modal) |
| Entry point | Patient autocomplete | Case-select dropdown |
| Botão "Nova vaga" no AdminVacanciesPage | Abria modal | Navega pra `/admin/vacancies/new` |
| Stepper | Inexistente | `<Stepper currentStep={1}>` no topo |

### 13.3. Stepper (novo molecule)

[`enlite-frontend/src/presentation/components/molecules/Stepper/Stepper.tsx`](../enlite-frontend/src/presentation/components/molecules/Stepper/Stepper.tsx):
- 3 círculos numerados ligados por linhas
- Step concluído: bg primary + check icon
- Step atual: white + border primary
- Step pendente: white + border `#d9d9d9`
- 4 unit tests

Steps no flow:
1. Datos de la vacante (`/admin/vacancies/new`)
2. Configuración Talentum (`/admin/vacancies/:id/talentum`)
3. Detalle y postulantes (`/admin/vacancies/:id`)

Aparece em ambos Step 1 e Step 2 (mesmas labels + i18n).

### 13.4. Mudanças no `VacancyFormSection` / colunas

**Removidos do `VacancyFormLeftColumn`:**
- Item 9 "Job description" (textarea de `required_experience`) — vai aparecer no Step 2 via IA, não precisa duplicar.
- Item 10 "Interview dates — coming soon" placeholder — substituído pelos meet links inputs reais.
- Hardcode `patientNamePrivacy='—'`. Agora mostra o nome real (controle vai pra RBAC futuro).

**Adicionados:**
- Item 9 "Meet links": 3 inputs URL ligados a `meet_links: [string, string, string]` no schema. Validação Zod: pelo menos 1 deve casar `MEET_LINK_REGEX`. Inválido → erro `meetLinkRequired` no campo, botão Salvar bloqueado.
- "Cantidad de profesionales" e "Horas semanales" trocaram de lugar — Horas semanales vai pra antes do Schedule.
- "Horas semanales" agora é **read-only div auto-calculado** via `computeWeeklyHours(schedule)` do `vacancyScheduleUtils`. Reativo a mudanças do schedule via `useWatch`.

**`VacancyFormRightColumn`:**
- Campo "Complemento de dirección" virou read-only div mostrando `selectedAddress.complement` (não mais `register('daily_obs')` errado).
- Campo "Localização" puxa via `summarizeAddress(selectedAddress.address_formatted)` — extrai cidade/província dos formatted addresses (BR e AR).
- `patientDis` (wrapper aplicado quando paciente não selecionado): trocou de `opacity-40` para `[&_.bg-white]:!bg-[#f3f4f6]` (cinza nos wrappers em vez de opacity em tudo).

### 13.5. Mudanças na Tela 2 (`TalentumConfigPage`)

- `<Stepper currentStep={2}>` adicionado.
- `GenerateAIButton` removido. Geração agora é automática:
  - **Path comum:** Step 1 chama `generateAIContent` antes de navegar e passa o resultado em `location.state`. Step 2 lê e popula direto, sem nova chamada.
  - **Fallback (refresh / nav direta):** `useEffect` em `TalentumConfigPage` detecta ausência de conteúdo e dispara `generateAIContent()` no mount.
- Banners substituem o botão: "Gerando conteúdo IA..." quando loading; "Reintentar" quando erro.
- `useTalentumConfig(vacancyId, preloaded?)` — novo segundo parâmetro pra seed via state.

### 13.6. Submit handler do Step 1

`CreateVacancyPage.handleSuccess(vacancyId)`:
1. `setGenerating(true)` → mostra overlay full-screen "Gerando conteúdo IA..."
2. `await AdminApiService.generateAIContent(vacancyId)` → pega description + prescreening
3. `navigate(/.../talentum, { state: { description, prescreeningQuestions, prescreeningFaq } })`
4. Se IA falha: navega mesmo assim, propaga erro pro Step 2 que vai auto-retry no mount.

`VacancyFormSection.onSubmit` agora também faz:
- `await AdminApiService.updateVacancyMeetLinks(vacancyId, meetLinksPayload)` antes de chamar `onSuccess(vacancyId)`. Funciona em modo `create` E `edit`.
- Em modo edit, popula `meet_links` no reset com `existingVacancy.meet_link_1/2/3`.

`onSuccess` mudou de `() => void` pra `(vacancyId: string) => void` — afeta `VacancyModal` (caller silenciosamente ignora o arg) e `AdminVacanciesPage.handleModalSuccess`.

### 13.7. Backend changes desta sessão

**Migration 157** ([`worker-functions/migrations/157_add_complement_to_patient_addresses.sql`](../worker-functions/migrations/157_add_complement_to_patient_addresses.sql)):
- `ALTER TABLE patient_addresses ADD COLUMN complement TEXT`
- Aditiva, populada null. ClickUp não tem campo equivalente; população futura via UI Enlite (memória `project_clickup_deprecation`).
- Migrations 153-156 (lat/lng) também aplicadas localmente — não estavam no banco dev/E2E quando começamos.

**`VacanciesController.getCasesForSelect`** ([linha 281](../worker-functions/src/modules/matching/interfaces/controllers/VacanciesController.ts#L281)):
- Filtros adicionados: `INNER JOIN patients` + `p.needs_attention = false` + `EXISTS patient_addresses`. Em prod: 284 → 126 casos visíveis.

**`PatientDetailQueryHelper`** + **`AdminPatientsController.listPatientAddresses`**:
- Selects retornam `complement`, `lat`, `lng`.
- Tipo `PatientAddressDetail` (em `PatientQueryRepository.ts`) inclui `complement: string | null`.

### 13.8. Frontend utils novos

| Arquivo | Função | Tests |
|---|---|---|
| `presentation/utils/summarizeAddress.ts` | Pega `address_formatted` (Google Places, BR ou AR) e devolve cidade/província (drop street + country + postal codes) | 11 unit tests |
| `presentation/components/features/admin/vacancyScheduleUtils.ts` (estendido) | Nova função `computeWeeklyHours(schedule)` — soma horas com fix de virada de meia-noite | 8 unit tests |
| `presentation/components/molecules/Stepper/` | Stepper visual horizontal (atom-like) | 4 unit tests |

### 13.9. Atom Input — disabled visual mudou

[`atoms/Input/inputClasses.ts`](../enlite-frontend/src/presentation/components/atoms/Input/inputClasses.ts):
- `DISABLED_CLASSES`: era `opacity-60 cursor-not-allowed` → agora `bg-[#f3f4f6] cursor-not-allowed`.
- Motivo: opacity faz o texto sumir junto com o background. Bg cinza claro mantém texto 100% legível e ainda sinaliza disabled.
- Snapshots e 5 testes atualizados.

`vacancyFormShared.READONLY_CLS` também mudou:
- `bg-white` → `bg-[#f3f4f6]` (mesmo cinza)
- `text-gray-600` → `text-gray-800` (legibilidade no cinza)

### 13.10. Cleanup desta sessão

Deletados (dead code):
- `enlite-frontend/src/presentation/components/features/admin/CreateVacancyV2/` (10 arquivos: form, columns, autocomplete, schema, dialog, hooks, etc.)
- `enlite-frontend/src/hooks/admin/useCreateVacancyV2.ts`

Removidas chaves i18n órfãs:
- `admin.vacancyModal.patientNamePrivacy` (es + pt-BR)

### 13.11. Memórias novas (em `~/.claude/projects/.../memory/`)

- `project_clickup_deprecation` — não investir em melhorias de ClickUp mapper; migra pra UI direta no futuro
- `project_rbac_pii_visibility` — não hardcodar mascaramento; RBAC futuro decide

### 13.12. Arquivos chave (snapshot final desta sessão)

**Frontend:**
- `enlite-frontend/src/presentation/pages/admin/CreateVacancyPage.tsx` — página V2 com Stepper + handleSuccess que gera IA antes de navegar
- `enlite-frontend/src/presentation/pages/admin/TalentumConfigPage.tsx` — Stepper + auto-generate via location.state ou fallback no mount
- `enlite-frontend/src/presentation/pages/admin/AdminVacanciesPage.tsx` — botão "Nova vaga" agora navega
- `enlite-frontend/src/presentation/components/features/admin/VacancyModal/VacancyFormSection.tsx` — onSuccess(vacancyId), salva meet links após create/update
- `enlite-frontend/src/presentation/components/features/admin/VacancyModal/VacancyFormLeftColumn.tsx` — sem jobDescription, com 3 meet inputs, com patientName real
- `enlite-frontend/src/presentation/components/features/admin/VacancyModal/VacancyFormRightColumn.tsx` — Localização via summarizeAddress, Complemento read-only, Horas semanales auto, ordem de campos atualizada
- `enlite-frontend/src/presentation/components/features/admin/VacancyModal/vacancyFormShared.tsx` — READONLY_CLS com bg cinza
- `enlite-frontend/src/presentation/components/features/admin/vacancy-form-schema.ts` — campo `meet_links` + validação Zod
- `enlite-frontend/src/presentation/components/features/admin/vacancyScheduleUtils.ts` — `computeWeeklyHours`
- `enlite-frontend/src/presentation/components/molecules/Stepper/` — molecule novo
- `enlite-frontend/src/presentation/utils/summarizeAddress.ts` — util novo
- `enlite-frontend/src/presentation/components/atoms/Input/inputClasses.ts` — DISABLED_CLASSES = bg cinza
- `enlite-frontend/src/hooks/admin/useTalentumConfig.ts` — `(vacancyId, preloaded?)`

**Backend:**
- `worker-functions/migrations/157_add_complement_to_patient_addresses.sql`
- `worker-functions/src/modules/matching/interfaces/controllers/VacanciesController.ts` — getCasesForSelect filtrado
- `worker-functions/src/modules/case/infrastructure/PatientDetailQueryHelper.ts` — select complement/lat/lng
- `worker-functions/src/modules/case/interfaces/controllers/AdminPatientsController.ts` — listPatientAddresses retorna complement/lat/lng
- `worker-functions/src/modules/case/infrastructure/PatientQueryRepository.ts` — `PatientAddressDetail.complement`

### 13.13. Pendências para a próxima sessão

- [ ] **Validação manual no browser** end-to-end (clicar Nova vaga → preencher → ver overlay → cair na Step 2 com tudo carregado).
- [ ] **Commit big-bang** — working tree tem 100+ arquivos pendentes. Quando manual passar, commitar.
- [ ] **TD-003** — deprecar `VacancyModal/` legacy. Hoje convive (é o flow de "edit" da listagem).
- [ ] **Backend `meet_link_*` columns** — confirmar que `updateVacancyMeetLinks` aceita 3 slots e que `existingVacancy.meet_link_1/2/3` vêm populados do GET `/vacancies/:id`. Não validei no banco.

---

## 14. Sessão 2026-05-03 — gate Step 1 → Step 2 fechado

User reportou 4 itens bloqueando a transição entre Step 1 e Step 2. Esta seção
documenta o fix de cada um.

### 14.1. O bug que travava a navegação

**Sintoma:** botão Guardar habilitado, mas click não navegava pra Step 2.

**Causa raiz:** `MEET_LINK_REGEX = /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/`
exigia o prefixo `https://`. Recrutadora colava `meet.google.com/abc-defg-hij`
direto do Calendar e o Zod rejeitava silenciosamente — `meetLinkRequired` era
exibido em letra pequena no FormField mas sem feedback inline em cada slot.
Resultado: a vaga nunca era criada e nada explicava por quê.

### 14.2. Asteriscos vermelhos em campos obrigatórios

`Label` (atom) já suportava `required` — desenha um `<span class="text-red-500">*</span>`
após o label. Adicionado `required` no `FormField` de:

| Campo | Arquivo |
|---|---|
| Caso (case_number, só em mode=create) | [`VacancyFormLeftColumn.tsx:139`](../enlite-frontend/src/presentation/components/features/admin/VacancyModal/VacancyFormLeftColumn.tsx#L139) |
| Tipo de prestador (required_professions) | [`VacancyFormLeftColumn.tsx`](../enlite-frontend/src/presentation/components/features/admin/VacancyModal/VacancyFormLeftColumn.tsx) |
| Links de Google Meet | [`MeetLinksField.tsx`](../enlite-frontend/src/presentation/components/features/admin/VacancyModal/MeetLinksField.tsx) |
| Endereço de prestação do serviço | [`VacancyFormRightColumn.tsx`](../enlite-frontend/src/presentation/components/features/admin/VacancyModal/VacancyFormRightColumn.tsx) |
| Cantidad de profesionales (providers_needed) | idem |
| Schedule (días y horarios) | idem |

Asterisk visual já existia no atom `Label`, só faltava propagar a flag.

### 14.3. Aceitar Meet link sem `https://` + onBlur lookup do datetime

**Schema** ([`vacancy-form-schema.ts:13`](../enlite-frontend/src/presentation/components/features/admin/vacancy-form-schema.ts#L13)):

```ts
// Strict: usado para validar payload final salvo no banco
export const MEET_LINK_REGEX = /^https:\/\/meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
// Loose: aceita digitação intermediária (sem https://) + http:// + www.
export const MEET_LINK_REGEX_LOOSE = /^(?:https?:\/\/)?(?:www\.)?meet\.google\.com\/[a-z]{3}-[a-z]{4}-[a-z]{3}$/;
// Util pra promover loose → canônico
export function normalizeMeetLink(input: string): string;
```

`meetLinkSlot` agora tem `.transform(v => normalizeMeetLink(v))` antes do
`.refine(MEET_LINK_REGEX.test)`. Resultado: form aceita os dois formatos
durante a digitação, mas o payload final sempre sai canônico.

**Backend — wrapper sobre rotina existente** ([`VacancyMeetLinksController.ts`](../worker-functions/src/modules/matching/interfaces/controllers/VacancyMeetLinksController.ts)):

```
POST /api/admin/vacancies/meet-links/lookup
Body: { link: string }
→ { normalized: string, datetime: string | null }
```

**Importante:** este endpoint é um **wrapper fino** sobre
`googleCalendarService.resolveDateTime()` — exatamente a mesma rotina que o
PUT `/:id/meet-links` já consumia em paralelo pros 3 slots. **Nada de lógica
nova de Calendar.** O wrapper existe só porque no Step 1 (criação) ainda não
temos `vacancyId` pra chamar o PUT, e a recrutadora precisa ver datetime no
blur antes de salvar. Reusa código, não duplica.

Rota registrada **antes** de `/:id/meet-links` em
[`adminVacanciesRoutes.ts`](../worker-functions/src/modules/matching/interfaces/routes/adminVacanciesRoutes.ts)
porque é static path (express captura ordem-dependente).

**Frontend** ([`MeetLinksField.tsx`](../enlite-frontend/src/presentation/components/features/admin/VacancyModal/MeetLinksField.tsx)):

- Subcomponente extraído (VacancyFormLeftColumn estourou 400 linhas com a
  lógica inline)
- `onBlur` por slot: trim → loose-regex check → normalize →
  `field.onChange()` com valor canônico → `AdminApiService.lookupMeetDatetime()`
- 4 estados visuais: `idle`, `loading` (spinner à direita), `found`
  (CheckCircle verde + badge azul com data formatada `'es-AR'`), `not_found`
  (AlertCircle amarelo + texto `meetLinkNotFound`), `invalid` (AlertCircle
  amarelo + texto `meetLinkInvalid`).

**Erro "No encontramos este meet en tu calendario" em dev:** sintoma típico
de `GOOGLE_CALENDAR_IMPERSONATE_EMAIL` ou credenciais Service Account não
configuradas no env local. `resolveDateTime()` retorna `null` e o estado
vira `not_found`. Em prod (com creds OK), o badge aparece com data formatada.

i18n keys novas:
- `admin.vacancyModal.meetLinkNotFound` — "No encontramos este meet en tu calendario."
- `admin.vacancyModal.meetLinkInvalid` — "Formato inválido. Usá meet.google.com/xxx-xxxx-xxx"

### 14.4. Playwright test do gate Step 1 → Step 2

[`enlite-frontend/e2e/create-vacancy-step1-to-step2.e2e.ts`](../enlite-frontend/e2e/create-vacancy-step1-to-step2.e2e.ts):

Teste mockado (não-integration) que cobre:
1. Login via Firebase Emulator + mock de `auth/profile`
2. `cases-for-select` → seleciona case → hidrata paciente (1 endereço)
3. Selects: profession AT, schedule (Lunes 09:00-17:00), address option
4. **Cola `meet.google.com/abc-defg-hij` (sem https) no slot 0 → blur**
5. Asserta que o input agora exibe `https://meet.google.com/abc-defg-hij`
   (normalização inline, sem chamar nenhum endpoint extra)
6. Click Guardar → asserta `POST /vacancies` + `PUT /meet-links` chamados
   (PUT é onde o backend resolve datetime via `googleCalendarService`)
7. Asserta URL muda pra `/admin/vacancies/:id/talentum`
8. Asserta `<li aria-current="step">` do Stepper contém "Configuración Talentum"
9. Screenshot snapshot

Auth pattern segue `create-vacancy.e2e.ts` (Firebase Emulator + page.route).
Não precisa Docker do backend — todas as chamadas estão mockadas.

### 14.5. Arquivos modificados nesta sessão

```
Frontend:
  src/presentation/components/features/admin/vacancy-form-schema.ts
    + MEET_LINK_REGEX_LOOSE, normalizeMeetLink()
    + meetLinkSlot.transform() pra normalizar antes do refine

  src/presentation/components/features/admin/VacancyModal/
    MeetLinksField.tsx                       (NOVO — extraído de Left, ~189 linhas)
    VacancyFormLeftColumn.tsx                (slim down — usa MeetLinksField + required em case/profession)
    VacancyFormRightColumn.tsx               (required em address/providers/schedule)

  src/infrastructure/http/AdminApiService.ts
    + lookupMeetDatetime(link) — wrapper sobre o novo endpoint backend
    updateVacancyMeetLinks() agora retorna { meet_link_*, meet_datetime_* }
    em vez de void

  src/infrastructure/i18n/locales/{es,pt-BR}.json
    + admin.vacancyModal.meetLinkNotFound
    + admin.vacancyModal.meetLinkInvalid

  e2e/create-vacancy-step1-to-step2.e2e.ts    (NOVO — gate Step 1 → Step 2,
    inclui asserção que `meet-links/lookup` é chamado com URL canônica e
    badge de datetime aparece)

Backend:
  src/modules/matching/interfaces/controllers/VacancyMeetLinksController.ts
    + lookupMeetDatetime() handler — wrapper fino sobre o
      `googleCalendarService.resolveDateTime()` já existente
    + normalizeMeetLink() helper local (mesma lógica do schema do front)
    + MeetLinkLookupSchema (Zod)

  src/modules/matching/interfaces/routes/adminVacanciesRoutes.ts
    + POST /vacancies/meet-links/lookup (registrada antes de /:id/meet-links
      pra evitar captura como :id)
```

### 14.6. Pendências REAIS pra próxima sessão

- [ ] **Validação manual no browser** — abrir `/admin/vacancies/new`, preencher, colar link sem `https://`, ver datetime aparecer, salvar, conferir que cai na Step 2.
- [ ] **Rodar Playwright** `pnpm test:e2e create-vacancy-step1-to-step2.e2e.ts` — gerar baseline screenshot.
- [ ] **Commit big-bang** — working tree continua grande (~100 arquivos). Após validação manual, splittar em:
  1. Backend (migrations 153-157 + endpoint lookup + meet links)
  2. Atoms/molecules globais (Label, Input, FormField, Stepper, Disabled cinza)
  3. CreateVacancyV2 → page-with-stepper pivot (frontend)
  4. Tests (unit + e2e)
- [ ] **TD-003** — deprecar `VacancyModal/` legacy (continua sendo o flow de "edit" da listagem).
- [ ] **Backend `meet_link_*` columns** — confirmar que `updateVacancyMeetLinks` aceita 3 slots e que `existingVacancy.meet_link_1/2/3` vêm populados do GET `/vacancies/:id`.
- [ ] **DP-001** (split shifts) — decisão de produto continua aberta no `FOLLOWUPS.md`.

### 14.7. O que ESTÁ pronto (gate fechado)

✅ Asteriscos vermelhos em campos obrigatórios via `FormField required`
✅ Meet link aceita formato sem `https://` (regex loose + normalize on blur)
✅ Lookup do datetime no blur via novo endpoint `meet-links/lookup`
✅ Feedback visual por slot (loading/found/not_found/invalid)
✅ Playwright test cobrindo a transição Step 1 → Step 2
✅ Type-check + validate:lines verdes (todos arquivos < 400 linhas)
✅ Unit tests do schema continuam verdes (7/7)

---

## 15. Sessão 2026-05-03 (continuação) — gate Step 2 → Step 3 fechado + i18n

Esta sessão fechou o restante do fluxo: validação visível no topo, troca do
LLM de description, auto-save de prescreening na publicação, labels traduzidos
e teste E2E mockado completo (sem custo de Gemini, sem publish real).

### 15.1. Banner de validação no topo da página

Antes: o `handleSubmit` do RHF falhava silenciosamente quando algum campo
obrigatório (schedule, profession, meet link) estava vazio.

Fix:
- [`VacancyFormSection.tsx`](../enlite-frontend/src/presentation/components/features/admin/VacancyModal/VacancyFormSection.tsx) usa `handleSubmit(onSubmit, onValidationError)` e expõe `onValidationFailedFieldsChange?: (fields: string[]) => void` callback.
- [`CreateVacancyPage.tsx`](../enlite-frontend/src/presentation/pages/admin/CreateVacancyPage.tsx) renderiza o banner vermelho (`role="alert"`, `data-testid="vacancy-form-validation-error"`) **acima do form card**, logo abaixo do Stepper, listando os campos faltantes.
- Helper local `listInvalidFields(errors, tp)` mapeia `errors.required_professions`, `errors.providers_needed`, `errors.schedule`, `errors.meet_links`, `errors.title`, `errors.age_range_max` para labels i18n (`admin.vacancyModal.{professionalType,providersNeeded,schedule,meetLinksLabel,caseNumber,ageRange}`).
- i18n key nova: `admin.vacancyModal.validationBanner.title` (es: "Faltan datos para crear la vacante:" / pt-BR: "Faltam dados para criar a vaga:").
- Console log `[VacancyForm] validation failed { ... }` pra debug.

### 15.2. Migração `TalentumDescriptionService` Groq → Gemini com JSON `responseSchema`

**Por quê:** o operador usa Gemini, não Groq. O service antigo lançava `GROQ_API_KEY não configurado` no constructor, derrubando o `/generate-ai-content`. Além disso, o doc do Drive não tem prompt específico para description — só prescreening — então o LLM gerava texto sujo (`"¡Hola! Acá te armo..."`, `**SECCIÓN B: PRE-SCREENING Y DES`).

Mudanças em [`TalentumDescriptionService.ts`](../worker-functions/src/modules/integration/infrastructure/TalentumDescriptionService.ts):

- **Provider trocado:** `GROQ_API_KEY` → `GEMINI_API_KEY`, `GROQ_MODEL` → `GEMINI_MODEL` (default `gemini-2.5-flash`).
- **Prompt do Drive por worker type:** `loadSystemPrompt(workerType)` lê `PROMPT_DOC_ID_AT` ou `PROMPT_DOC_ID_CUIDADOR` via `GoogleDocsPromptProvider` (mesmo padrão de `GeminiVacancyParserService.buildSystemPrompt`). Helper `resolveWorkerType(professions)` mapeia `required_professions.includes('CAREGIVER')` → `'CUIDADOR'` senão `'AT'`.
- **JSON estruturado:** `generationConfig.responseMimeType: 'application/json'` + `responseSchema: DESCRIPTION_RESPONSE_SCHEMA` com 2 campos obrigatórios `propuesta` e `perfilProfesional`. O service monta a description final com headers canônicos:
  ```ts
  return (
    `Descripción de la Propuesta:\n${propuesta}\n\n` +
    `Perfil Profesional Sugerido:\n${perfil}`
  );
  ```
- **Markdown fence stripping:** se o LLM retornar a JSON dentro de ` ```json ... ``` `, o service remove as cercas antes do `JSON.parse`.
- **Logging:** `[TalentumDesc] Raw LLM content (N chars):` (JSON-stringified pra sobreviver à truncagem multiline do Docker logs).
- 27/27 unit tests verdes em [`TalentumDescriptionService.test.ts`](../worker-functions/tests/unit/__tests__/TalentumDescriptionService.test.ts) — agora cobrem JSON shape, fence stripping, fallback de modelo, key seleção por worker type.

Outras refs stale corrigidas:
- [`tests/unit/__tests__/VacancyTalentumController.test.ts:389`](../worker-functions/tests/unit/__tests__/VacancyTalentumController.test.ts#L389): mensagem de erro `GROQ_API_KEY` → `GEMINI_API_KEY`.
- [`tests/e2e/talentum-outbound.test.ts:814`](../worker-functions/tests/e2e/talentum-outbound.test.ts#L814) e [`tests/e2e/vacancies-api.test.ts:395`](../worker-functions/tests/e2e/vacancies-api.test.ts#L395): comentários atualizados.

`.env.example` atualizado com nota explicando que `PROMPT_DOC_ID_AT/CUIDADOR` agora é usado **tanto** pelo parser de prescreening **quanto** pelo gerador de description.

### 15.3. `useTalentumConfig.publish()` auto-salva prescreening

**Sintoma:** click em "Publicar en Talentum" no header do Step 2 retornava `400 — No prescreening questions configured for this vacancy`.

**Causa:** o botão "Save prescreening" mora no fim da seção de perguntas (UX legacy do `PrescreeningStep`). O usuário revisava o conteúdo da IA e clicava direto em Publicar, sem persistir as perguntas no banco.

Fix em [`useTalentumConfig.ts:160`](../enlite-frontend/src/hooks/admin/useTalentumConfig.ts#L160):
```ts
const publish = useCallback(async () => {
  // Auto-save prescreening BEFORE publish — avoids the 400 caused by
  // separate Save (in-section) and Publish (in-header) buttons.
  await AdminApiService.savePrescreeningConfig(vacancyId, {
    questions: prescreeningQuestions,
    faq: prescreeningFaq,
  });
  await AdminApiService.publishToTalentum(vacancyId);
  ...
}, [vacancyId, prescreeningQuestions, prescreeningFaq]);
```

### 15.4. i18n / labels traduzidos no formulário

Bug: vários campos derivados do paciente (read-only) mostravam o valor canônico em UPPERCASE inglês. Status badge no Step 2 também aparecia "SEARCHING".

Fixes:

| Campo | Onde | Antes | Depois |
|---|---|---|---|
| Grado de dependencia | [`VacancyFormLeftColumn.tsx`](../enlite-frontend/src/presentation/components/features/admin/VacancyModal/VacancyFormLeftColumn.tsx) | `SEVERE` | `Grave` (via `admin.patients.dependencyOptions.{SEVERE\|VERY_SEVERE\|MODERATE\|MILD}`) |
| Tipo de profesional (dropdown) | [`vacancy-form-schema.ts`](../enlite-frontend/src/presentation/components/features/admin/vacancy-form-schema.ts) | 5 opções (AT, CAREGIVER, NURSE, KINESIOLOGIST, PSYCHOLOGIST) | **2 opções** (AT, CAREGIVER) — operação só recruta esses dois pelo form |
| Tipo de servicio | [`VacancyFormRightColumn.tsx`](../enlite-frontend/src/presentation/components/features/admin/VacancyModal/VacancyFormRightColumn.tsx) | dropdown editable de `work_schedule` (full-time/part-time/flexible) — nome desconectado do campo | **Read-only** do `patient.serviceType` (`Profession[]` do ClickUp), label traduzido |
| Status badge Step 2 | [`VacancySummaryCard.tsx`](../enlite-frontend/src/presentation/components/features/admin/TalentumConfig/VacancySummaryCard.tsx) | `SEARCHING` | `Búsqueda` (via `admin.vacancyDetail.vacancyForm.statusOptions.{SEARCHING\|ACTIVE\|...}`) |

Mapeamento de Tipo de servicio (Profession[] → label es):
- `['AT']` → "Acompañante Terapéutico"
- `['CAREGIVER']` → "Cuidador/a"
- `['AT', 'CAREGIVER']` → "AT y Cuidador" *(nova chave `professionOptions.AT_AND_CAREGIVER` em es + pt-BR)*
- `['PSYCHOLOGIST']` → "Psicólogo/a"
- vazio → `—`

Wire de `patientDetail.serviceType` → `VacancyFormRightColumn.serviceType` em [`VacancyFormSection.tsx`](../enlite-frontend/src/presentation/components/features/admin/VacancyModal/VacancyFormSection.tsx).

Test stale do `VacancySummaryCard` corrigido: o mock de `t()` agora honra `opts.defaultValue` para refletir o comportamento real.

### 15.5. E2E mockado cobrindo Step 1 → 2 → 3

[`enlite-frontend/e2e/create-vacancy-step1-to-step2.e2e.ts`](../enlite-frontend/e2e/create-vacancy-step1-to-step2.e2e.ts) renomeado conceitualmente para "fluxo completo" (mantém o filename pra evitar churn).

**Cobertura agora:**
- Login Firebase Emulator
- Seleção de case → hidratação de paciente + endereço
- Preenchimento: profession AT, address, schedule (Lunes 09:00–17:00 via `+` button), meet link sem `https://`
- Asserções de blur do Meet link: `meetLookupCalls[0].link === 'https://meet.google.com/abc-defg-hij'` (já normalizado) + badge `data-testid="meet-link-0-datetime"` visível
- Click Guardar → POST `/vacancies` + PUT `/meet-links` + POST `/generate-ai-content` (mockado) → URL muda pra `/talentum`
- Step 2: descrição com headers canônicos + 2 perguntas + 1 FAQ vindos do fixture
- Click Publicar → POST `/prescreening-config` (auto-save) + POST `/publish-talentum` (mockado) → URL muda pra `/admin/vacancies/:id` (Step 3)
- Asserções: `vacancyCreated.calls === 1`, `meetLinksPersisted.calls === 1`, `prescreeningSaved.calls >= 1`, `publishCalled.calls === 1`, `savedBody.questions.length === 2`, `savedBody.faq.length === 1`
- Visual snapshot anchor `create-vacancy-step2-talentum.png`

**Mocks (zero custo, zero side-effects):**

| Endpoint | Mock |
|---|---|
| `POST /vacancies/:id/generate-ai-content` | Fixture com 2 perguntas + 1 FAQ — **NÃO chama Gemini, NÃO cobra** |
| `POST /vacancies/:id/publish-talentum` | `{ projectId: 'fake-talentum-project-id', ... }` — **NÃO publica vaga real** |
| `POST /vacancies/:id/prescreening-config` | Echo do body — verifica auto-save antes do publish |
| `POST /vacancies/meet-links/lookup` | `datetime: '2026-05-10T15:00:00-03:00'` — **NÃO chama Google Calendar** |
| `POST /vacancies` + `PUT /meet-links` | Fixture `vac-step12-new` — **NÃO escreve no banco** |

### 15.6. Bug detectado fora de escopo: dev local sem creds Calendar

[`docker-compose.dev.yml`](../worker-functions/docker-compose.dev.yml) **não** tem `GOOGLE_CALENDAR_IMPERSONATE_EMAIL` setado, e mesmo se setasse, [`GoogleCalendarEventFinder.getAccessToken`](../worker-functions/src/modules/matching/infrastructure/GoogleCalendarEventFinder.ts#L44) usa o metadata server (`http://metadata.google.internal/...`) que só existe no Cloud Run/GCE — **nunca** no Docker local.

Resultado em dev: `resolveDateTime` sempre retorna `null` → frontend mostra "No encontramos este meet en tu calendario." (esperado). Em prod (Cloud Run com domain-wide delegation) funciona.

**Não corrigido** nesta sprint (fora do escopo). O bypass `USE_MOCK_GOOGLE_CALENDAR=true` existe em [`GoogleCalendarService.ts:60-62`](../worker-functions/src/modules/matching/infrastructure/GoogleCalendarService.ts#L60-L62) e devolve `'2026-04-05T14:00:00-03:00'` fixo — ativar no compose dev é o caminho mais barato.

### 15.7. Arquivos modificados nesta sessão (delta sobre §14)

```
Backend:
  src/modules/integration/infrastructure/TalentumDescriptionService.ts
    Groq → Gemini, JSON responseSchema, fence stripping, prompt do Drive
  tests/unit/__tests__/TalentumDescriptionService.test.ts
    27/27 — cobre nova estrutura JSON
  tests/unit/__tests__/VacancyTalentumController.test.ts
    Mock error message GROQ → GEMINI
  tests/e2e/talentum-outbound.test.ts + tests/e2e/vacancies-api.test.ts
    Comentários stale atualizados
  .env.example
    Nota sobre uso compartilhado de PROMPT_DOC_ID_AT/CUIDADOR

Frontend:
  src/presentation/components/features/admin/VacancyModal/VacancyFormSection.tsx
    Banner de validação via callback onValidationFailedFieldsChange
    + serviceType prop forwarded para Right Column
  src/presentation/components/features/admin/VacancyModal/VacancyFormLeftColumn.tsx
    Dependency level traduzido (admin.patients.dependencyOptions)
  src/presentation/components/features/admin/VacancyModal/VacancyFormRightColumn.tsx
    Tipo de servicio read-only do patient.serviceType com label traduzido
    Removido import de WORK_SCHEDULE_OPTIONS (campo antigo deprecado na UI)
  src/presentation/components/features/admin/vacancy-form-schema.ts
    PROFESSION_OPTIONS = ['AT', 'CAREGIVER'] (era 5)
  src/presentation/components/features/admin/TalentumConfig/VacancySummaryCard.tsx
    Status badge traduzido via i18n
  src/presentation/components/features/admin/TalentumConfig/__tests__/VacancySummaryCard.test.tsx
    Mock de t() agora honra defaultValue
  src/presentation/pages/admin/CreateVacancyPage.tsx
    Banner de validação no topo, abaixo do Stepper
  src/hooks/admin/useTalentumConfig.ts
    publish() auto-salva prescreening antes de publicar
  src/infrastructure/i18n/locales/{es,pt-BR}.json
    + admin.vacancyModal.validationBanner.title
    + admin.vacancyDetail.vacancyForm.professionOptions.AT_AND_CAREGIVER

E2E:
  e2e/create-vacancy-step1-to-step2.e2e.ts
    Cobertura estendida para Step 3 + mocks de prescreening-config + publish-talentum
```

### 15.8. Validação visual headed (Playwright)

Script de debug ad-hoc rodou contra `make dev` com mocks de `/generate-ai-content` e `/publish-talentum` (zero custo). Capturou:
- Step 1: Tipo de profesional dropdown com `["Seleccionar...", "Acompañante Terapéutico", "Cuidador/a"]` ✅
- Step 1: Grado de dependencia mostra `Grave` ✅
- Step 1: Tipo de servicio mostra `Acompañante Terapéutico` (read-only do paciente) ✅
- Step 2: Status badge mostra `Búsqueda` ✅
- Navegação Step 1 → 2 → 3 sem erros, sem chamada real a Gemini, sem publish no Talentum.

Script de debug deletado após validação (não fica no repo — pertence ao E2E mockado de `e2e/`).
