# Sprint: Refactor de Vagas + Endpoint Público

> **Status:** SPRINT CONCLUÍDO (2026-04-29) — todas as 10 fases entregues
> **Criado em:** 2026-04-27
> **Substitui:** `docs/ROADMAP_PUBLIC_JOBS_API.md` (mantido como referência histórica do escopo original menor)
> **Estimativa:** 1 sprint completa (10-15 dias úteis em 10 fases sequenciais)

---

## 1. Sumário Executivo

A entrega final é um endpoint público (`GET /api/public/v1/jobs`) consumido pelo WordPress (`jobs.enlite.health`) listando vagas ativas. Mas a auditoria revelou que o caminho até lá exige **refatorar a base de dados de vagas** primeiro — o estado atual produziria 78 falsos positivos (vagas fechadas no ClickUp aparecendo como abertas) de 132 vagas públicas se entrasse em produção hoje.

A causa-raiz é que **o schema de `job_postings` duplica dados que pertencem ao paciente** (state, city, service, pathology, dependency_level), e o sync ClickUp manual desatualizou esses campos sem atualizar a linha pai. A decisão arquitetural é explicitar no schema que **vaga é derivada de paciente** — `job_postings` aponta pra `patient_addresses` via FK, e os outros campos clínicos vêm via JOIN com `patients`.

Como consequência, o sprint cobre 10 fases na ordem `paciente → vaga`:
1. Patient mapper completo (cobre os 4 campos órfãos hoje)
2. Sync paciente em produção
3. Status normalization (`job_postings.status` + `patients.status`)
4. Sync vaga em produção (paridade com ClickUp)
5. Schema refactor (FK pra `patient_address`, deprecation das colunas duplicadas)
6. Backend `createVacancy` refatorado + use case de match address
7. Frontend novo upload PDF — UI bloqueante (Estratégia 2)
8. Backfill manual queue (vagas que não bateram no fuzzy match)
9. Drop columns (limpa schema)
10. Util Short.io + endpoint público + Cloud Scheduler

---

## 2. Contexto e Objetivo

### Estado anterior (antes do sprint)

- WordPress (`jobs.enlite.health/es/`) lista vagas via HTML estático populado por scraping do banco antigo — fluxo invertido em relação ao desejado.
- Worker-functions roda `JobScraperService` (Cheerio+Axios) lendo o WP a cada 5 min para alimentar o frontend administrativo `JobsEmbeddedSection`.
- Sync ClickUp → banco é script manual (`worker-functions/scripts/import-vacancies-from-clickup.ts`), executado sob demanda.
- Schema de `job_postings` evoluiu organicamente: status livre, colunas duplicando dados do paciente, sem CHECK constraint.

### Objetivo do sprint

1. WordPress passa a consumir `GET /api/public/v1/jobs` (worker-functions vira fonte da verdade).
2. Frontend `JobsEmbeddedSection` consome o mesmo endpoint (fonte única).
3. Schema de `job_postings` reflete o modelo conceitual: vaga é derivada de paciente (`patient_id` + `patient_address_id`), sem duplicação.
4. Sync ClickUp passa a popular máximo de campos (Cobertura, Número ID Afiliado, Zona/Barrio) sem perder dados.
5. Operação tem fluxo bloqueante de qualidade na criação de vaga: recrutadora confirma vínculo paciente↔endereço antes de salvar.

### Não-objetivos

- Webhook ClickUp em tempo real — fora de escopo (decisão registrada em memória `project_clickup_webhook_out_of_scope`).
- Migração de `worker-functions` para NestJS / `case-service` — fora de escopo (decisão na memória `project_data_layer_roadmap`).
- Notion como fonte de verdade documental — markdown em `docs/` é a escolha, indexado no local-rag.

---

## 3. Achados da Auditoria

Tudo abaixo foi medido em produção em 2026-04-27.

### 3.1. `job_postings.status` está desnormalizado

297 linhas não-deletadas, **18 strings distintas** para o mesmo conceito, sem CHECK constraint ativo (perdido em alguma migration pós-011). Distribuição:

| String | Count | Canônico final |
|---|---|---|
| `CLOSED` | 51 | `CLOSED` |
| `rta_rapida` | 46 | `RAPID_RESPONSE` |
| `ACTIVO` | 39 | `ACTIVE` |
| `REEMPLAZOS` | 25 | `SEARCHING_REPLACEMENT` |
| `ACTIVE` | 23 | `ACTIVE` |
| `BUSQUEDA` | 20 | `SEARCHING` |
| `replacement` | 20 | `SEARCHING_REPLACEMENT` |
| `paused` | 16 | `CLOSED` |
| _(null)_ | 12 | `CLOSED` |
| `searching` | 12 | `SEARCHING` |
| `EQUIPO RESPUESTA RAPIDA` | 11 | `RAPID_RESPONSE` |
| `SUSPENDIDO TEMPORALMENTE` | 8 | `SUSPENDED` |
| `SEARCHING_REPLACEMENT` | 5 | `SEARCHING_REPLACEMENT` |
| `EN ESPERA` | 3 | `PENDING_ACTIVATION` |
| `SEARCHING` | 2 | `SEARCHING` |
| `ACTIVACION PENDIENTE` | 2 | `PENDING_ACTIVATION` |
| `active` | 1 | `ACTIVE` |
| `PENDING_ACTIVATION` | 1 | `PENDING_ACTIVATION` |

### 3.2. Sync ClickUp manual desatualizou o banco

Script Python `worker-functions/scripts/compare-vacantes-clickup.py` cruzou as 297 vagas do banco com 1428 tasks do ClickUp:

| Métrica | Valor |
|---|---|
| Vagas com status PÚBLICO no banco (SEARCHING/SEARCHING_REPLACEMENT/RAPID_RESPONSE) | **132** |
| **Falsos positivos** (banco diz publica, ClickUp diz NÃO) | **78 (59%)** |
| Vagas DIVERGENTE (status diferente nos dois lados) | 125 |
| Vagas SO_BANCO (fantasma — só no banco, ClickUp não tem) | 5 |
| Vagas SO_CLICKUP (perda silenciosa) | 1 |
| Vagas no banco sem `case_number` | 8 |

Top 5 padrões de falso positivo:

| ClickUp | Banco | Quantos | Significado |
|---|---|---|---|
| `baja` (vaga fechada) | `rta_rapida` | 19 | Vaga fechada continuaria aparecendo no WP |
| `activo` (preenchida) | `rta_rapida` | 17 | Vaga preenchida continuaria captando reservas |
| `activo` (preenchida) | `REEMPLAZOS` | 9 | Vaga preenchida apareceria como urgência |
| `equipo respuesta rápida` (sem "de") | `EQUIPO RESPUESTA RAPIDA` | 7 | Mapping não cobre essa variação ClickUp |
| `activo` (preenchida) | `replacement` | 6 | Idem |

### 3.3. Vacancy mapper consome só 9 de 62 custom fields

Auditoria via `tmp/audit-clickup-mapper-coverage.py`:

- ClickUp tem **62 custom fields** distintos na lista "Estado de Pacientes" (901304883903)
- `ClickUpVacancyMapper.ts` consome **9** (`Caso Número`, `Días y Horarios`, `Perfil del Prestador Buscado`, `Período Autorizado`, `Inicio Búsqueda`, 3 slots de Domicilio + 3 de Domicilio Informado)
- **53 fields ignorados** pelo vacancy mapper

Top 6 fields ignorados que afetam o contrato público:

| Custom field ClickUp | Cobertura | Campo do contrato |
|---|---|---|
| `Servicio` (drop_down) | 98.6% | `service` |
| `Diagnóstico (si lo conoce)` | 90% | `pathologies` |
| `Provincia del Paciente` (location) | 88.3% | `provincia` |
| `Ciudad / Localidad del Paciente` (location) | 86.9% | `localidad` |
| `Horas Semanales` (number) | 83.4% | enriquece `daysAndHours` |
| `Dependencia` (drop_down) | 97.2% | `dependency_level` (interno) |

### 3.4. Patient mapper compensa quase tudo

`ClickUpPatientMapper.ts` (separado, lê a mesma lista do ClickUp) captura **a maioria** dos campos que o vacancy mapper ignora — mas joga em outras tabelas:

| ClickUp field | Tabela destino |
|---|---|
| Nombre/Apellido/Doc/Sexo/WhatsApp Paciente | `patients.*` |
| Diagnóstico (si lo conoce) | `patients.diagnosis` |
| Dependencia | `patients.dependency_level` |
| Servicio | `patients.service_type` |
| Provincia/Ciudad del Paciente | `patient_addresses[].addressFormatted` (não em `patients.province/city_locality`) |
| Segmentos Clínicos | `patients.clinical_specialty` |
| Posee CUD / Consentimiento / Amparo | `patients.*` flags |
| Comentarios Adicionales Paciente | `patients.additional_comments` |
| Responsibles (Nombre/Tel/Email/Doc/Relación) | `patient_responsibles[]` |
| Profesionales Tratantes 1/2/3 | `patient_professionals[]` |

### 3.5. Schema duplicado: vaga "deveria ser derivada de paciente"

Mesmo dado vive em duas tabelas, com fontes diferentes:

| Campo do contrato `PublicJobDto` | Tabela onde sync ClickUp escreve | Tabela onde endpoint leria hoje |
|---|---|---|
| `service` | `patients.service_type` (auto via patient mapper) | `job_postings.service_device_types` (manual via admin) |
| `pathologies` | `patients.diagnosis` (auto) | `job_postings.pathology_types` (manual) |
| `provincia` | `patient_addresses[].addressFormatted` (auto) | `job_postings.state` (manual) |
| `localidad` | idem | `job_postings.city` (manual) |
| `dependency_level` (interno) | `patients.dependency_level` (auto) | `job_postings.dependency_level` (manual) |

Cobertura no banco (DBA): 94-95% nos campos duplicados de `job_postings`. Mas **94-95% vem de input manual histórico** — não há garantia que ainda batem com o ClickUp.

### 3.6. Cobertura `social_short_links.site` em vagas públicas

Das 132 vagas com status canônico público:
- 105 (74%) têm `social_short_links.site` populado
- 27 (26%) não têm — perderiam `detailLink` no endpoint

### 3.7. Quatro campos órfãos (não capturados em lugar nenhum)

| Campo ClickUp | Cobertura | Onde deveria ir |
|---|---|---|
| `Cobertura Informada` | 47.6% | `patients.health_insurance_name` (futuro: tabela própria) |
| `Número ID Afiliado Paciente` | 50.7% | `patients.health_insurance_member_id` (futuro: tabela própria) |
| `Zona o Barrio Paciente` | 83.1% | `patients.neighborhood` |
| `Horas Semanales` | 83.4% | `job_postings.weekly_hours` (após refactor) |

---

## 4. Decisões Arquiteturais

### 4.1. Vaga é derivada de paciente

Modelo conceitual aceito pelo PO:

```
patients (1) ─── (N) patient_addresses
   │                      ▲
   │                      │ FK (NOVO)
   │ FK                   │ patient_address_id
   ▼                      │
job_postings ──────────────┘
```

Vaga **não tem dados próprios** que duplicam paciente. Ela só:
- Aponta pro paciente (`patient_id`)
- Aponta pra qual endereço do paciente serve (`patient_address_id`)
- Tem campos exclusivos de vaga (status, vacancy_number, case_number, schedule_days_hours, perfil_prestador_buscado, talentum_*, social_short_links, etc.)

### 4.2. Caminho C: refactor schema completo

Avaliados 3 caminhos:
- **A** Schema intacto, endpoint usa COALESCE — rejeitado: dívida arquitetural permanece
  > **Atualização 2026-05-23:** COALESCE será removido em F4-F6 de [features/worker-job-applications/](features/worker-job-applications/README.md).
- **B** Cirúrgico (FK + JOIN, sem dropar) — rejeitado: schema feio para sempre
- **C** Refactor completo (FK + JOIN + drop columns deprecadas) — **escolhido**

### 4.3. Estratégia 2: UI bloqueante para match address

Quando recrutadora faz upload de PDF:
1. Gemini parseia → extrai endereço como texto/coords
2. Frontend mostra o paciente identificado pelo `case_number` + lista de `patient_addresses` existentes (1-3 endereços)
3. **UI bloqueia** continuação até a recrutadora:
   - Selecionar um endereço existente do paciente, OU
   - Clicar "criar novo endereço pro paciente" (sistema cria nova `patient_addresses` row e usa)
4. Vaga recebe `patient_address_id` apontando pro escolhido

**Sem auto-match silencioso.** Sem dashboard de revisão posterior. Bloqueia na criação.

### 4.4. Source of truth = paciente; sobrescrita = consentimento

Quando Gemini extrai do PDF um valor (ex: `service: "DOMICILIARIO"`) e o paciente já tem outro (`patients.service_type: "ESCOLAR"`):
1. Frontend mostra os dois lado a lado: "PDF diz X, paciente tem Y"
2. Recrutadora escolhe:
   - "Manter paciente" → vaga usa `patients.service_type` atual
   - "Atualizar paciente com valor do PDF" → executa update em `patients.*` E vaga usa novo valor
3. **Nunca sobrescreve sem consentimento.** Memória registrada: `feedback_patient_overwrite_consent`.

### 4.5. ADMISSION é status de paciente, não de vaga

ClickUp tem o status `admisión` (com til). Decisão: **não é vaga ainda** — paciente está em admissão/onboarding. Mapeamento:
- `vacancyStatusMap.ts` → `'admisión'` retorna `{ patientStatus: 'ADMISSION', jobPostingStatus: null }`
- `ClickUpVacancyMapper.map()` → se `jobPostingStatus === null`, retorna `[]` (skip)
- `ClickUpPatientMapper` → cria/atualiza paciente com `status='ADMISSION'`
- Migration estende `patients.status` CHECK constraint com `ADMISSION` (5º valor: `ACTIVE | DISCONTINUED | SUSPENDED | DISCHARGED | ADMISSION`)

Memória: `project_admission_is_patient_status`.

### 4.6. Status canônicos finais

**`job_postings.status`** (7 valores):

| Canônico | Significado | Aparece no endpoint público? |
|---|---|---|
| `SEARCHING` | Vacante aberta / Búsqueda | ✅ |
| `SEARCHING_REPLACEMENT` | Reemplazo (prestador saiu) | ✅ |
| `RAPID_RESPONSE` | Equipe de resposta rápida (mantém captação para reservas) | ✅ |
| `PENDING_ACTIVATION` | Ativação pendente | ❌ |
| `ACTIVE` | Tem prestador, sem time de resposta rápida | ❌ |
| `SUSPENDED` | Suspendido temporariamente | ❌ |
| `CLOSED` | Baja / Alta / encerrada | ❌ |

> Nota: `FULLY_STAFFED` (do mapping atual) foi renomeado para `RAPID_RESPONSE` em 2026-04-27. `FULLY_STAFFED` em inglês passava a impressão de "vaga preenchida, não publica" — oposto da intenção operacional.

**`patients.status`** (5 valores):

| Canônico | Significado |
|---|---|
| `ADMISSION` | Em admissão (NOVO neste sprint) |
| `ACTIVE` | Ativo no sistema |
| `SUSPENDED` | Internação / viagem |
| `DISCHARGED` | Alta clínica |
| `DISCONTINUED` | Baja (desistência ou encerramento) |

### 4.7. Webhook ClickUp fora de escopo

Sync continua manual. Cloud Scheduler 10min agendando o script é a solução interim (Fase 10). Webhook só quando dor real surgir. Memória: `project_clickup_webhook_out_of_scope`.

### 4.8. Bloquear endpoint público até normalização completa

Decidido em 2026-04-27: o endpoint público **só entra em produção depois de a fila de revisão manual da Fase 8 zerar**. Não publica parcial. Justificativa: 78 falsos positivos seria destrutivo para a confiança do candidato no portal de vagas — o custo de esperar a fila zerar é menor que o custo reputacional.

---

## 5. Sprint — 10 Fases

Cada fase é um PR independente, com testes verdes (unit 100% + E2E + integration), lint + type-check, e commit no `main` (após review). Sequenciais — uma só começa quando a anterior estiver mergada e validada em homolog.

### Fase 1 — Patient mapper completo

**Objetivo:** Garantir que sync paciente captura o máximo do ClickUp, sem mudar schema de vagas ainda.

**Tasks:**

| # | Descrição | Files |
|---|---|---|
| 1.1 | Migration `136_patient_table_extensions.sql` adicionando `patients.health_insurance_name TEXT`, `patients.health_insurance_member_id TEXT`, `patients.neighborhood TEXT`, e `patients.province` / `patients.city_locality` (se já não existirem). Adicionar `ADMISSION` ao CHECK constraint de `patients.status`. | `worker-functions/migrations/136_patient_table_extensions.sql` (NOVO) |
| 1.2 | Verificar via DBA se ClickUp tem `Nombre de Responsable 2/3`, `Apellido de Responsable 2/3`, etc. Se sim, mapper passa a iterar slots. | — (DBA query first) |
| 1.3 | Estender `ClickUpPatientMapper.ts` para ler `Cobertura Informada`, `Número ID Afiliado Paciente`, `Zona o Barrio Paciente`, e popular `patients.province/city_locality` extraindo de `Provincia del Paciente` / `Ciudad / Localidad del Paciente` (location.formatted_address). Manter modular: extração de cada campo em helper isolado. | `worker-functions/src/modules/integration/infrastructure/clickup/ClickUpPatientMapper.ts` (EDIT) |
| 1.4 | Estender `PatientServiceUpsertInput` com novos campos. | `worker-functions/src/modules/case/...` (EDIT) |
| 1.5 | Estender `PatientService.upsertFromClickUp` (ou equivalente) para persistir os novos campos seguindo regra `fill-only` (sobrescrita só com flag explícita). | `worker-functions/src/modules/case/...` (EDIT) |
| 1.6 | Testes unitários do mapper com fixtures cobrindo: cada novo field presente, cada novo field ausente, valor inválido, location parseável vs raw. **100% coverage no mapper.** | `worker-functions/src/modules/integration/infrastructure/clickup/__tests__/ClickUpPatientMapper.test.ts` (EDIT) |
| 1.7 | Teste integration usando Postgres real validando que UPDATE não sobrescreve quando paciente já tem o campo populado. | tests/integration |
| 1.8 | Atualizar `vacancyStatusMap.ts` para incluir `'admisión'` → `{ patientStatus: 'ADMISSION', jobPostingStatus: null }` (e variantes case-insensitive). | `worker-functions/src/modules/integration/infrastructure/clickup/mappings/vacancyStatusMap.ts` (EDIT) |
| 1.9 | Atualizar `ClickUpVacancyMapper.map()` para retornar `[]` quando `jobPostingStatus === null`. | `worker-functions/src/modules/integration/infrastructure/clickup/ClickUpVacancyMapper.ts` (EDIT) |

**Critérios de aceite Fase 1:**
- [x] Migration aplicada em homolog sem erro (migration 147, 2026-04-28)
- [x] `patients.status` aceita `ADMISSION`
- [x] 100% coverage unitário do mapper estendido
- [x] Integration test verde (phase1-patient-extensions.e2e.test.ts — 11 testes)
- [x] `npm run type-check` + `npm run lint` verdes
- [x] E2E suite verde (52 suites, 955 passed, 0 failed)

**Riscos Fase 1:**
- Se ClickUp não tem campos `Responsable 2/3`, mapper continua com 1 — documentar como gap aberto, não bloqueante.
- Adicionar coluna a tabela `patients` (303 rows) é rápido — sem risco de lock significativo.

---

### Fase 2 — Sync paciente em produção

**Objetivo:** Trazer paridade ClickUp ↔ banco para pacientes antes de mexer em vagas.

**Tasks:**

| # | Descrição |
|---|---|
| 2.1 | Rodar `npx ts-node scripts/import-patients-from-clickup.ts --live` em produção |
| 2.2 | DBA query validando: % de pacientes com `health_insurance_name`, `neighborhood`, `province` populados — comparar antes/depois |
| 2.3 | Verificar quantos pacientes saíram de `status = NULL` para `ACTIVE`/`ADMISSION` |
| 2.4 | Documentar resultado em commit message + atualizar este doc com snapshot |

**Critérios de aceite Fase 2:**
- [ ] Sync rodou sem erro fatal
- [ ] Cobertura de `province`/`city_locality` em pacientes vinculados a vagas públicas: ≥ 85%
- [ ] Cobertura de `health_insurance_name`: ≥ ClickUp coverage de 47% (de 0% para 47% mínimo)
- [ ] Nenhum paciente perdeu dado (UPDATE só em campo NULL/vazio)

**Riscos Fase 2:**
- ClickUp pode ter dados inválidos (ex: phone com 5 dígitos). Mapper já trata via `cleanPhone` retornando null — mas vale auditar amostra de 20 pacientes pós-sync.

---

### Fase 3 — Status normalization (vaga + paciente)

**Objetivo:** Normalizar `job_postings.status` para os 7 canônicos. Reaplicar CHECK constraint. Atualizar TS para refletir.

**Tasks:**

| # | Descrição | Files |
|---|---|---|
| 3.1 | Migration `137_normalize_job_posting_status.sql` — atômica, em uma transação: backfill 18 strings → 7 canônicos + NULLs → `CLOSED` + reaplicar CHECK constraint | `worker-functions/migrations/137_normalize_job_posting_status.sql` (NOVO) |
| 3.2 | Atualizar `vacancyStatusMap.ts` — `FULLY_STAFFED` → `RAPID_RESPONSE` (linhas 29 e 31). Adicionar variantes que faltam (`equipo respuesta rápida` sem "de"). | EDIT |
| 3.3 | Atualizar entity `JobPosting.ts` — substituir `JobPostingStatus` union pelo correto (7 canônicos) | `worker-functions/src/domain/entities/JobPosting.ts` (EDIT) |
| 3.4 | Corrigir bombas-relógio: `VacancyCrudController.ts:87` (`'BUSQUEDA'` hardcoded → `'SEARCHING'`), `VacancyCrudController.ts:265` (`'closed'` → `'CLOSED'`) | EDIT |
| 3.5 | Atualizar `VacanciesController.ts` — 3 filtros `status IN (...)` com strings antigas → 7 canônicos. Atualizar `mapStatus()` se houver. | EDIT |
| 3.6 | Grep defensivo em `MatchmakingService.ts` por `'BUSQUEDA'`, `'paused'`, `'draft'`, `'filled'`, `'active'` (lowercase) — atualizar onde houver | EDIT (se houver) |
| 3.7 | Grep `worker-functions/tests/` por strings antigas — atualizar fixtures | EDIT |
| 3.8 | Testes E2E que cria, lista e atualiza vaga passam com novos status | tests/e2e |

**Critérios de aceite Fase 3:**
- [ ] Migration 137 aplicada local + homolog sem erro
- [ ] CHECK constraint impede inserção de string fora dos 7 canônicos
- [ ] Lint + type-check verdes
- [ ] E2E suite verde
- [ ] Painel admin lista vagas após backfill (regressão pega se faltar atualizar `VacanciesController`)

**Riscos Fase 3:**
- Migration + edits TS DESINCRONIZADOS quebram criação de vaga. Migration + código vão no MESMO deploy.
- Lock em `job_postings` durante UPDATE de 297 linhas é curto (~50ms estimado); rodar fora de horário de pico mesmo assim.

---

### Fase 4 — Sync vaga em produção

**Objetivo:** Trazer paridade ClickUp ↔ banco para vagas. Resolver os 78 falsos positivos.

**Tasks:**

| # | Descrição |
|---|---|
| 4.1 | Rodar `npx ts-node scripts/import-vacancies-from-clickup.ts --live` em produção |
| 4.2 | Re-rodar `worker-functions/scripts/compare-vacantes-clickup.py` com banco normalizado |
| 4.3 | Validar: falsos positivos próximos a 0 (esperado ≤ 5) |
| 4.4 | Listar vagas SO_BANCO restantes (vagas sem correspondência no ClickUp) — decisão caso a caso: marcar como `CLOSED` ou investigar manualmente |
| 4.5 | Documentar resultado em commit message |

**Critérios de aceite Fase 4:**
- [ ] Sync rodou sem erro fatal
- [ ] Falsos positivos ≤ 5 (de 78 anteriores)
- [ ] Vagas DIVERGENTE de status ≤ 10 (de 125 anteriores)
- [ ] Painel admin continua listando vagas corretamente

**Riscos Fase 4:**
- Sync pode trazer status `admisión` que agora vira `[]` (skip) — pacientes nesse estado entram via patient sync. Se houver vaga já criada para esse caso (do passado), o status fica como está (não vira CLOSED automaticamente).

---

### Fase 5 — Schema refactor (FK + deprecation)

**Objetivo:** Adicionar `patient_address_id FK`. Marcar colunas duplicadas como deprecated. Não dropa ainda.

**Tasks:**

| # | Descrição | Files |
|---|---|---|
| 5.1 | Migration `138_job_postings_patient_address_fk.sql` — adiciona `job_postings.patient_address_id UUID REFERENCES patient_addresses(id) ON DELETE RESTRICT NULL`. Adiciona índice. Comentários de deprecation em `state`, `city`, `service_address_formatted`, `service_address_raw`, `service_device_types`, `pathology_types`, `dependency_level` (via `COMMENT ON COLUMN`). | NOVO |
| 5.2 | Migration `139_backfill_patient_address_fk.sql` — UPDATE de auto-fuzzy match: para cada `job_posting`, encontra `patient_address` que bate por `patient_id` + (case-insensitive trim igualdade de `addressFormatted`). Loga matches em tabela auxiliar `_patient_address_match_audit` para review. | NOVO |
| 5.3 | Tabela `_patient_address_match_audit` (temp): `job_posting_id, patient_id, attempted_match, match_type ('EXACT', 'FUZZY', 'NONE'), confidence_score, matched_address_id`. Vagas com `match_type='NONE'` entram na fila de revisão da Fase 8. | NOVO |
| 5.4 | Atualizar `ClickUpVacancyMapper.ts` para parar de escrever `serviceAddressFormatted` / `serviceAddressRaw` direto em `job_postings`. Em vez disso, busca `patient_address` que bate e seta a FK. Se não bate, cria um novo `patient_addresses` row (vinculado ao paciente) e seta a FK. | EDIT |
| 5.5 | Repository `JobPostingARRepository.upsertFromClickUp` aceita `patientAddressId` em vez de `serviceAddressFormatted/Raw`. Repo NÃO escreve mais nas colunas deprecadas (mantém valores antigos pra rollback). | EDIT |
| 5.6 | Testes unitários do mapper cobrindo: match exato, match fuzzy, criação de novo address. | tests/unit |

**Critérios de aceite Fase 5:**
- [ ] Migration 138+139 aplicadas em homolog sem erro
- [ ] ≥ 80% das vagas têm `patient_address_id` populado pós-backfill (vagas restantes na fila de revisão)
- [ ] `ClickUpVacancyMapper.ts` populando FK em vez de campos livres
- [ ] Testes verdes

**Riscos Fase 5:**
- Auto-fuzzy match pode confundir endereços parecidos (Rua A 100 vs Rua A 1000). Mitigação: log detalhado em `_patient_address_match_audit` e fila de revisão da Fase 8.
- 27 vagas sem nenhum patient_address (paciente sem endereço cadastrado): essas DEVEM entrar na fila de revisão; criar `patient_addresses` retroativamente exige dados que podem não existir.

---

### Fase 6 — Backend `createVacancy` refatorado + match address

**Objetivo:** Fluxo de criação de vaga via PDF aceita `patient_address_id` e oferece match suggestion + clash resolution.

**Tasks:**

| # | Descrição | Files |
|---|---|---|
| 6.1 | Use case `MatchPdfAddressToPatientAddressUseCase` — recebe `caseNumber` (do PDF) + endereço extraído pelo Gemini. Retorna lista ordenada de candidatos: `[{ patient_address_id, addressFormatted, confidence: 0-1, matchType: 'EXACT'|'FUZZY'|'PROXIMITY' }]`. | NOVO |
| 6.2 | Use case `ResolvePatientFieldClashUseCase` — recebe `patientId` + payload Gemini com `service`, `pathology`, `dependency_level`. Compara com `patients.*`. Retorna `{ field, pdfValue, patientValue, action: 'IDENTICAL' \| 'CLASH' }[]`. | NOVO |
| 6.3 | Endpoint `POST /api/admin/vacancies/parse` (NOVO) recebe PDF base64, retorna `{ parsed: ParsedVacancyResult, addressMatches: AddressMatchResult[], fieldClashes: PatientFieldClash[] }` — sem persistir nada. Frontend usa pra montar UI bloqueante. | NOVO |
| 6.4 | Endpoint `POST /api/admin/vacancies` (EDIT) — agora aceita `{ ...vacancyFields, patient_address_id: UUID, fieldOverrides: { service, pathology, dependency }, updatePatient: { service?, pathology?, dependency? } }`. Valida que `patient_address_id` pertence ao paciente. Se `updatePatient` populado, atualiza `patients.*` (com auditoria). | EDIT `VacancyCrudController.ts` |
| 6.5 | Endpoint `POST /api/admin/patients/:patientId/addresses` (NOVO) — cria `patient_addresses` row (caso recrutadora escolha "criar novo endereço"). | NOVO |
| 6.6 | Auditoria: tabela `patient_field_overrides_audit` registra updates em `patients.*` feitos via vacancy creation flow. `{ patient_id, field_name, old_value, new_value, source: 'vacancy_create_pdf', actor_id, occurred_at }`. | NOVO migration |
| 6.7 | Testes unitários cobrindo cada use case. Integration test do fluxo completo: PDF → parse → match → resolve → create. **100% coverage.** | tests |

**Critérios de aceite Fase 6:**
- [ ] Endpoint `POST /api/admin/vacancies/parse` retorna estrutura correta
- [ ] Endpoint `POST /api/admin/vacancies` rejeita request sem `patient_address_id`
- [ ] Endpoint cria vaga + atualiza paciente atomicamente quando `updatePatient` é enviado
- [ ] Auditoria registra todos os updates em `patients`
- [ ] Cobertura testes ≥ 95% nos novos use cases

**Riscos Fase 6:**
- Race condition: dois admins criando vaga pro mesmo paciente simultaneamente. Mitigação: use case usa `SELECT ... FOR UPDATE` no paciente para serializar.

---

### Fase 7 — Frontend novo upload PDF (UI bloqueante)

**Objetivo:** UX de criação de vaga mostra paciente + endereços + clashes; bloqueia continuação até resolução.

**Tasks:**

| # | Descrição | Files |
|---|---|---|
| 7.1 | Refatorar `CreateVacancyPage.tsx`: novo wizard de 3 steps — `Step 1: Upload PDF`, `Step 2: Confirmar paciente + endereço`, `Step 3: Resolver clashes` | EDIT |
| 7.2 | Novo componente `PatientAddressSelector` — recebe `patientId` + `addressMatches` (do parse), mostra lista de endereços do paciente com indicador de match suggestion. Botão "criar novo endereço". | NOVO |
| 7.3 | Novo componente `PatientFieldClashResolver` — para cada clash mostra duas colunas (PDF / Paciente) com botões "Manter paciente" / "Atualizar paciente com PDF". Step 3 só desbloqueia quando todos os clashes estão resolvidos. | NOVO |
| 7.4 | Novo componente `CreatePatientAddressDialog` — modal usado quando "criar novo endereço" é clicado. Permite preencher addressFormatted + addressType + displayOrder. | NOVO |
| 7.5 | Hook `useCreateVacancyFlow` que orquestra o wizard, mantém estado entre steps, faz as chamadas pra `/parse`, `/addresses`, `/vacancies`. | NOVO |
| 7.6 | Tradução i18n (es-AR padrão) das mensagens novas | EDIT `locales/es.json`, `pt-BR.json` |
| 7.7 | Screenshot Playwright de cada step (regra `feedback_visual_tests_required`) | tests/e2e |
| 7.8 | E2E completo: PDF mockado → step 1 → step 2 (escolhe endereço existente) → step 3 → vaga criada com sucesso. Cenários: clash com manter paciente, clash com atualizar, criar novo endereço. | tests/e2e |

**Critérios de aceite Fase 7:**
- [ ] Recrutadora não consegue avançar do step 2 sem selecionar/criar endereço
- [ ] Recrutadora não consegue avançar do step 3 sem resolver todos os clashes
- [ ] Screenshots Playwright de cada cenário verdes
- [ ] E2E suite verde
- [ ] `pnpm validate:lines` e `pnpm validate:architecture` verdes

**Riscos Fase 7:**
- UX nova pode confundir recrutadoras acostumadas com fluxo antigo. Mitigação: comunicação prévia com PO + screencast curto demonstrando.

---

### Fase 8 — Backfill manual queue

**Objetivo:** Resolver as vagas sem `patient_address_id` (auto-fuzzy match falhou na Fase 5) via dashboard de revisão.

**Tasks:**

| # | Descrição | Files |
|---|---|---|
| 8.1 | Endpoint `GET /api/admin/vacancies/pending-address-review` retorna lista de vagas com `patient_address_id IS NULL` + dados auxiliares (case_number, paciente, address antigo de `service_address_formatted`) | NOVO |
| 8.2 | Endpoint `POST /api/admin/vacancies/:id/resolve-address-review` aceita `patient_address_id` (existente) ou `createAddress: { ... }` (cria novo) | NOVO |
| 8.3 | Frontend: nova rota `/admin/vacancies/pending-address-review` com tabela de vagas pendentes. Cada row tem botão "resolver" que abre o componente reaproveitado da Fase 7. | NOVO |
| 8.4 | Testes E2E cobrindo dashboard + resolução individual + bulk | tests/e2e |

**Critérios de aceite Fase 8:**
- [ ] Dashboard lista 100% das vagas com `patient_address_id IS NULL` e status público
- [ ] Operador consegue resolver caso por caso até zerar a fila
- [ ] **Endpoint público (Fase 10) só vai pra produção quando essa fila zerar.**

**Riscos Fase 8:**
- Volume da fila pode ser maior que esperado. Estimativa: 27 vagas (públicas sem `social_short_links.site` proxy) + n vagas que falharam fuzzy match. Operador resolve ~10 por hora.

---

### Fase 9 — Drop columns

**Objetivo:** Remover colunas deprecadas em `job_postings`. Schema enxuto.

**Tasks:**

| # | Descrição | Files |
|---|---|---|
| 9.1 | Migration `140_drop_deprecated_job_posting_columns.sql` — `ALTER TABLE job_postings DROP COLUMN state, city, service_address_formatted, service_address_raw, service_device_types, pathology_types, dependency_level`. NOT NULL em `patient_address_id` (constraint adicionada). | NOVO |
| 9.2 | Audit grep no projeto inteiro por essas colunas — atualizar qualquer query SQL ou referência TS restante. | EDIT múltiplos |
| 9.3 | `JobPosting.ts` entity: remover esses campos. | EDIT |
| 9.4 | Tipo `PublicJobDto` mantém os campos correspondentes (`provincia`, `localidad`, `service`, `pathologies`) — mapper continua resolvendo via JOIN. | EDIT |
| 9.5 | Atualizar `JobPostingARRepository.findActivePublic` SQL para JOIN com `patients` e `patient_addresses` | EDIT |
| 9.6 | Re-rodar suite completa de testes | tests |

**Critérios de aceite Fase 9:**
- [ ] Migration aplicada sem erro em homolog (rollback testado também)
- [ ] `npm run type-check` + `npm run lint` verdes em ambos projetos
- [ ] E2E suite verde
- [ ] Schema final: `\d job_postings` sem as colunas deprecadas

**Riscos Fase 9:**
- DROP COLUMN é irreversível. Mitigação: backup completo de `job_postings` antes da migration. Rollback = restore do backup + re-add das colunas.
- Algum lugar do código pode ainda referenciar essas colunas. Mitigação: grep agressivo + lint personalizado se necessário.

---

### Fase 10 — Util Short.io + endpoint público + Cloud Scheduler

**Objetivo:** Entregar o objetivo final — endpoint público funcionando + Cloud Scheduler agendando o sync.

**Tasks:**

| # | Descrição | Files |
|---|---|---|
| 10.1 | Util `ShortIoClient` — cliente HTTP puro do Short.io. Testável com mock. | `worker-functions/src/modules/matching/infrastructure/shortlinks/ShortIoClient.ts` (NOVO) |
| 10.2 | Util `ShortLinkService` — UTM + chamada Short.io + fallback canônico. **Não escreve no banco.** | NOVO |
| 10.3 | Use case `EnsureVacancyShortLinkUseCase` — orquestra: lê vaga, checa `social_short_links.site`, chama service, persiste via repo. | NOVO |
| 10.4 | Refactor `VacancySocialLinksController` para consumir `ShortLinkService` (não duplicar lógica) | EDIT |
| 10.5 | Backfill one-shot pras vagas restantes sem `social_short_links.site` (chama o use case 10.3) | NOVO script |
| 10.6 | `JobPostingARRepository.findActivePublic()` — query com filtro `status IN ('SEARCHING','SEARCHING_REPLACEMENT','RAPID_RESPONSE') AND deleted_at IS NULL AND social_short_links ? 'site'`. JOIN com `patients` e `patient_addresses` para resolver `service`, `pathologies`, `provincia`, `localidad`. | EDIT |
| 10.7 | DTO `PublicJobDto` (12 campos) + `PublicJobMapper`. Sanitiza `description` se for string genérica de import (`"Caso operacional importado do ClickUp..."`) — devolve string vazia. | NOVO |
| 10.8 | Use case `ListActivePublicJobsUseCase` — orquestrador puro. | NOVO |
| 10.9 | Controller `PublicJobsController` + rota `GET /api/public/v1/jobs`. Rate limit 60 rpm/IP. `Cache-Control: public, max-age=300, s-maxage=600`. ETag default. | NOVO |
| 10.10 | Cloud Scheduler config: `gcp/scheduler/sync-vacancies.yaml` ou equivalente Terraform agendando `import-vacancies-from-clickup.ts --live` a cada 10 min. Idem `import-patients`. | NOVO |
| 10.11 | Frontend `JobsEmbeddedSection`: trocar `fetch('/api/jobs')` → `fetch('/api/public/v1/jobs')` atrás de feature flag `VITE_USE_PUBLIC_JOBS_API=true`. Tipagem `Job` reduz para 12 campos. Screenshot Playwright. | EDIT |
| 10.12 | Observabilidade: log estruturado por request (`count`, `durationMs`, `ip`), métrica de erro 5xx, alerta "0 vagas por 30min" | EDIT |
| 10.13 | E2E `worker-functions/tests/e2e/public-jobs.test.ts` cobrindo cenários (SEARCHING / REPLACEMENT / RAPID_RESPONSE retornam, CLOSED não retorna, sem `site` link não retorna, shape JSON 12 campos). | NOVO |
| 10.14 | WordPress: time web atualiza template PHP consumindo o endpoint. Fora do monorepo. | — |

**Critérios de aceite Fase 10:**
- [ ] `GET /api/public/v1/jobs` responde 200 com 12 campos não-null
- [ ] Endpoint < 500ms em 100 vagas
- [ ] Rate limit 60 rpm devolve 429
- [ ] Cloud Scheduler rodando a cada 10 min, com logs visíveis no Cloud Logging
- [ ] Frontend migrado atrás de feature flag, screenshot Playwright atualizado
- [ ] WP consumindo em produção (validação com time web)
- [ ] E2E + lint + type-check verdes

**Riscos Fase 10:**
- Quebra SEO no WP ao mudar de HTML estático → fetch API. Mitigação: server-side com transient cache, HTML idêntico para crawlers.
- Endpoint vira alvo de scraping externo. Mitigação: rate limit + Cloud Armor se necessário.

---

## 6. Migrations Envolvidas

| # | Nome | Fase | Reversível? |
|---|---|---|---|
| 136 | `136_patient_table_extensions.sql` (cobertura, afiliado, zona, província, city_locality, ADMISSION) | 1 | sim (DROP COLUMN) |
| 137 | `137_normalize_job_posting_status.sql` (backfill 18→7 + CHECK constraint) | 3 | parcial (re-add DROP CONSTRAINT) |
| 138 | `138_job_postings_patient_address_fk.sql` (FK + deprecation comments) | 5 | sim (DROP COLUMN/CONSTRAINT) |
| 139 | `139_backfill_patient_address_fk.sql` (auto-fuzzy match + audit table) | 5 | sim (clear FK + drop audit table) |
| 140 | `140_audit_patient_field_overrides.sql` (auditoria de updates em patients via vacancy flow) | 6 | sim |
| 141-144 | reservadas para fixups durante o sprint | qualquer | — |
| 145 | `145_drop_deprecated_job_posting_columns.sql` (drop final) | 9 | **NÃO** (precisa restore de backup) |

---

## 7. Plano de Testes

Cada fase entrega:

1. **Testes unitários — 100% coverage** das classes/utils novos ou refatorados (Vitest no frontend, Jest/native no backend)
2. **Testes integration** — banco real (Postgres E2E Docker), mocks só pra serviços externos (Gemini, Short.io, ClickUp)
3. **Testes E2E** — `worker-functions/tests/e2e/` para fluxos backend; `enlite-frontend/e2e/` (Playwright) para fluxos frontend, com `toHaveScreenshot()` em cada step de UI

Comandos:
- `npm run test:run` (worker-functions, single run)
- `npm run test:e2e:docker` (worker-functions, Docker stack)
- `pnpm test:run` (enlite-frontend)
- `pnpm test:e2e` (enlite-frontend, Playwright)
- `pnpm validate:lines` + `pnpm validate:architecture` (frontend lint customizado)

**Gate de commit:** lint + type-check + unit + integration + E2E todos verdes (regra `feedback_all_tests_pass_before_commit` + `feedback_e2e_must_run_before_commit`).

---

## 8. Riscos Consolidados

| Risco | Fase afetada | Mitigação |
|---|---|---|
| Migration + edits TS desincronizados quebram criação/listagem de vaga | 3 | Migration + código no MESMO deploy. Rollback rápido via `DROP CONSTRAINT` |
| Auto-fuzzy match cria vínculos errados | 5 | Tabela de auditoria + fila de revisão manual (Fase 8) |
| Operador não resolve fila de revisão a tempo | 8 | Endpoint público fica bloqueado (decisão de PO) — sem trade-off |
| Sobrescrita silenciosa de `patients.*` | 6, 7 | UI bloqueante + auditoria explícita (memory `feedback_patient_overwrite_consent`) |
| Sync ClickUp escreve string fora do canônico | 3 em diante | CHECK constraint da Fase 3 bloqueia |
| Endpoint público vira alvo de scraping | 10 | Rate limit + Cache-Control + Cloud Armor se necessário |
| WP fica sem dado durante a sprint | qualquer | `/api/jobs` (scraper antigo) coexiste, sem deprecação até Task 9 |
| Quebra SEO no WP | 10 | Template PHP renderiza server-side, HTML idêntico |
| DROP COLUMN final é irreversível | 9 | Backup completo de `job_postings` antes da Fase 9 |
| Volume da fila Fase 8 maior que estimado | 8 | Operador resolve em paralelo; nada bloqueia além da Fase 10 |

---

## 9. Plano de Rollback

| Fase | Como reverter |
|---|---|
| 1 | `DROP COLUMN` das colunas novas em `patients`; reverter mapper edits via revert do PR |
| 2 | Sync paciente é fill-only — nenhum dado foi sobrescrito; rollback = nada a fazer |
| 3 | `ALTER TABLE job_postings DROP CONSTRAINT valid_job_status` + revert dos edits TS |
| 4 | Sync vaga já feito — rollback exige restore de backup pré-Fase 4 |
| 5 | `ALTER TABLE job_postings DROP COLUMN patient_address_id` + drop da audit table |
| 6 | Revert dos PRs do backend |
| 7 | Revert dos PRs do frontend + feature flag desabilitando o novo wizard |
| 8 | Dashboard de revisão fica como ferramenta — não há rollback necessário |
| 9 | **Necessário restore de backup completo de `job_postings`** — colunas dropadas |
| 10 | Feature flag `VITE_USE_PUBLIC_JOBS_API=false` no frontend; rota `/api/public/v1/jobs` retorna 410 Gone até retomar |

Backup obrigatório antes da Fase 4 (sync) e Fase 9 (drop columns).

---

## 10. Open Questions

Itens que precisam decisão durante a sprint:

| # | Pergunta | Decidir antes de qual fase | Responsável |
|---|---|---|---|
| OQ1 | ClickUp tem custom fields `Nombre de Responsable 2/3`, `Apellido de Responsable 2/3`, ou só 1? | Fase 1 (DBA query) | Verificável via auditoria |
| OQ2 | Quando recrutadora cria novo `patient_addresses` via Fase 7, o `addressType` default é `secondary` ou pergunta? | Fase 7 | PO |
| OQ3 | Auditoria de overrides em `patients.*` (Fase 6.6) — retenção indefinida ou TTL de 90 dias? | Fase 6 | PO + compliance |
| OQ4 | Fase 8 — operador resolve linha por linha ou tem ação bulk "marcar como CLOSED"? | Fase 8 | Definir conforme volume real |
| OQ5 | Cloud Scheduler — qual GCP service account roda? Cloud Run job dedicado ou cron sobre o serviço atual? | Fase 10 | DevOps |
| OQ6 | `description` genérica `"Caso operacional importado do ClickUp..."` — sanitizar pra string vazia ou filtrar a vaga inteira do endpoint? | Fase 10 | PO (recomenda string vazia) |
| OQ7 | Quando uma vaga já existe no banco e o ClickUp atualiza o status para `admisión`, o que acontece? Mapper retorna `[]` (skip) — vaga fica desatualizada? Ou marca como `CLOSED`? | Fase 1 | PO |

---

## 11. Glossário

| Termo | Significado |
|---|---|
| Vaga / Vacante / Job Posting | Linha em `job_postings` — solicitação ativa por um prestador (AT/Caregiver) |
| Caso / Case Number | Identificador clínico do paciente (não único, vagas podem compartilhar) |
| Vacancy Number | Identificador único de cada vaga (sequência) |
| Encuadre | Vocabulário operacional para uma candidatura worker↔vaga (WJA). Tabela `encuadres` é LEGADA — ver [features/worker-job-applications/02-vocabulario.md](features/worker-job-applications/02-vocabulario.md) |
| Recrutadora / Recruiter | Operador que cria a vaga via upload de PDF |
| Postularse | Ação do AT/candidato de se inscrever numa vaga (entidade `worker_job_applications`) |
| ClickUp `Estado de Pacientes` | Lista (901304883903) onde operações cadastra cada paciente — fonte de verdade |
| ClickUp `Encuadres` | Lista separada (901304882853 ou similar) onde matching é registrado |
| Talentum | Plataforma externa de prescreening que publica vagas e recebe candidatos |
| Short.io | Encurtador de URL com UTM tracking — gera link por canal social |

---

## 12. Referências

### Memórias relevantes (em `~/.claude/projects/.../memory/`)

- `feedback_patient_overwrite_consent.md` — sobrescrita de paciente sempre com consentimento
- `project_admission_is_patient_status.md` — `admisión` é status de paciente, não vaga
- `project_clickup_webhook_out_of_scope.md` — webhook fora de escopo
- `feedback_modularize_to_extreme.md` — utils nunca escrevem no DB
- `feedback_enum_values_english_uppercase.md` — canônicos em UPPERCASE inglês
- `project_status_clickup_vs_enlite.md` — tabela de tradução status
- `project_patient_vacancy_cardinality.md` — paciente tem N responsáveis/endereços
- `feedback_visual_tests_required.md` — Playwright screenshot obrigatório
- `feedback_e2e_must_run_before_commit.md` — E2E é pré-condição de commit
- `feedback_all_tests_pass_before_commit.md` — gate obrigatório
- `feedback_line_limit_when_touching_file.md` — limite 400 linhas

### Código de referência

- `worker-functions/src/modules/integration/infrastructure/clickup/ClickUpVacancyMapper.ts`
- `worker-functions/src/modules/integration/infrastructure/clickup/ClickUpPatientMapper.ts`
- `worker-functions/src/modules/integration/infrastructure/clickup/mappings/vacancyStatusMap.ts`
- `worker-functions/src/modules/integration/infrastructure/GeminiVacancyParserService.ts`
- `worker-functions/src/modules/matching/infrastructure/JobPostingARRepository.ts`
- `worker-functions/src/modules/matching/interfaces/controllers/VacancyCrudController.ts`
- `worker-functions/src/modules/matching/interfaces/controllers/VacanciesController.ts`
- `worker-functions/src/modules/matching/interfaces/controllers/VacancySocialLinksController.ts`
- `worker-functions/scripts/import-patients-from-clickup.ts`
- `worker-functions/scripts/import-vacancies-from-clickup.ts`
- `worker-functions/scripts/compare-vacantes-clickup.py`
- `enlite-frontend/src/presentation/pages/admin/CreateVacancyPage.tsx`
- `enlite-frontend/src/presentation/pages/public/PublicVacancyPage.tsx`
- `enlite-frontend/src/presentation/components/features/admin/VacancyDetail/VacancySocialLinksCard.tsx`

### Outros docs

- `docs/ROADMAP_PUBLIC_JOBS_API.md` — versão anterior, escopo menor (mantida como histórico)
- `worker-functions/CLAUDE.md` — guia do backend
- `enlite-frontend/CLAUDE.md` — guia do frontend
- `worker-functions/docs/ARCHITECTURE.md` — arquitetura do backend
- `worker-functions/docs/IMPLEMENTATION_RULES.md` — regras de implementação

---

## 13. Histórico de Decisões

| Data | Decisão | Justificativa |
|---|---|---|
| 2026-04-20 | Inverter fluxo: WP consome endpoint do worker-functions | WP hoje é fonte; queremos worker-functions como fonte da verdade |
| 2026-04-27 | Contrato 14 → 12 campos (sem `whatsappLink`) | WhatsApp redirect mora dentro do app via `usePostularseAction` |
| 2026-04-27 | `detailLink` aponta pra Short.io (canal `site`), não pro WP | Página de detalhe migrou pro app Enlite |
| 2026-04-27 | `FULLY_STAFFED` → `RAPID_RESPONSE` | Operação mantém captação mesmo com time formado |
| 2026-04-27 | NULLs em `job_postings.status` → `CLOSED` no backfill | Conservador; operadores reabrem se necessário |
| 2026-04-27 | Webhook ClickUp fora de escopo | Cloud Scheduler 10min cobre 95% da dor |
| 2026-04-27 | Util Short.io modularizado em camadas | Memória `feedback_modularize_to_extreme` |
| 2026-04-27 | Caminho C: refactor schema completo (drop columns) | Vaga é derivada de paciente; denormalização atual contraria modelo |
| 2026-04-27 | Estratégia 2: UI bloqueante para match address | Operação garante qualidade do vínculo paciente↔vaga |
| 2026-04-27 | Source of truth = paciente; sobrescrita = consentimento | Operadores responsáveis pelo dado clínico |
| 2026-04-27 | `admisión` é status de paciente, vaga não criada | Memória `project_admission_is_patient_status` |
| 2026-04-27 | Endpoint público bloqueado até fila de revisão (Fase 8) zerar | Custo reputacional de publicar dado errado é maior que esperar |
| 2026-04-27 | Markdown em `docs/` + local-rag — não Notion | Acesso direto via Read, indexação semântica, versionado com código |
