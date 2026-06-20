# Task: Sincronização ESPELHO de prestadores com Ana Care (Enlite → Ana Care)

**ClickUp:** https://app.clickup.com/t/86aj3yvdx · **Status:** Open→Refinada · **Board:** APP Recrutamento

> Refinamento PO+Architect. **DESBLOQUEADA E TRAVADA (2026-06-19, Gabriel).** Temos (a) a spec oficial da API da Ana Care (`docs/features/anacare/agencies-integration-api-v2.md`), (b) o pedido formal do cliente (e-mail do Javier, Ana Care) e (c) todas as decisões de produto/arquitetura travadas (§10). A direção do sync está **confirmada: OUTBOUND — Enlite → Ana Care**.
>
> **MUDANÇA DE MODELO (2026-06-19, Gabriel): de "alta única no REGISTERED" para SINCRONIZAÇÃO ESPELHO CONTÍNUA.** Ana Care (e HubSpot, task #6) são **espelho** da nossa base de prestadores. Não é um evento pontual no `REGISTERED`; é um espelho vivo que reflete **alta + toda atualização relevante + baixa** ao longo da vida do prestador. Executável sem novas perguntas.

---

## 1. Contexto

### Pedido do cliente (e-mail do Javier, Ana Care — resumo)
Após reunião para avançar na integração via API, a Ana Care quer aprofundar os requisitos técnicos da **primeira etapa de sincronização de prestadores ativos**. Objetivo prioritário: **automatizar o ALTA de profissionais** para posterior vinculação com pacientes na instância da Ana Care. Pontos levantados:

1. **Sincronização e Atualização de Dados:** confirmar se a API permite atualizações (PUT ou PATCH) dos campos de contato. Se um prestador muda telefone ou email, a mudança deve refletir automaticamente na Ana Care.
2. **Processamento em Lote (Bulk Update):** confirmar se há capacidade de requisições para `n` prestadores simultaneamente (coleção de objetos numa única transação).
3. Aguardam os **data points** e a **estrutura do JSON** que esperamos receber, para configurar a saída de dados.

> **Refinamento Enlite sobre o pedido:** o Javier pediu update **de contato**. A decisão de produto Enlite vai além: o espelho propaga **qualquer mudança relevante de perfil** (não só contato) — ver §10.2. O pedido do cliente é um subconjunto do que vamos entregar.

### O que a spec responde (evidência: `docs/features/anacare/agencies-integration-api-v2.md`)
- **Alta (POST):** `POST {BASE}/api/v2/agencies/nurses/` (`agencies-integration-api-v2.md:58`).
- **Atualização parcial:** a API usa **PATCH**, não PUT. `PATCH {BASE}/api/v2/agencies/nurses/<id>/` (`:60`). Responde diretamente o ponto 1 do Javier → **suportado via PATCH** (e cobre qualquer campo do recurso, não só contato — `:115`).
- **Bulk transacional:** `PATCH {BASE}/api/v2/agencies/nurses/bulk/` com `{ "items": [...] }`, **atômico** (falha total se algo não validar) (`:61`, `:104-117`). Responde o ponto 2 → **suportado, com `id` obrigatório em cada item** (`:115`).
- **Baja / desativação:** ⚠️ **NÃO HÁ endpoint de baja na spec.** A tabela de endpoints (`:53-61`) só expõe `GET`/`POST`/`PATCH` (individual + bulk); **não há `DELETE`**. O resumo de operações confirma: "Listar, crear, leer y actualizar parcialmente (`PATCH`)" (`:15`) — sem operação de exclusão. O recurso "enfermera" (`:65-92`) **não lista campo de status/activo/baja** algum. → **GAP DURO** documentado em §6.4 e §9; baja precisa ser confirmada com a Ana (campo de status via PATCH, ou DELETE não documentado, ou contrato de "baja" próprio). Bloqueia a propagação de baixa, não o desenho do espelho.
- **Data points / JSON esperado:** §4 da spec lista todos os campos do recurso "enfermera" (mapeados na §6 deste doc).

> ⚠️ **Disambiguação (mantida do refinamento anterior):** "Ana Care" (plataforma externa de RH/operacional de prestadores, em ES-AR) **não é** a linha de produto **"Care"/"Clinic"** da Enlite. São coisas distintas; esta task **não** pertence ao roadmap de microserviços clínicos / `provider-service` / Healthcare API.

> **Direção:** a integração histórica era Ana Care → Enlite (batch planilha, que populou `ana_care_status`, `ana_care_id`, etc.). Esta task é o **caminho inverso confirmado pelo PO**: Enlite empurra o espelho dos prestadores para a Ana Care. Não confundir com o import legado.

---

## 2. Objetivo

Implementar um canal **outbound Enlite → Ana Care** que mantenha a base de prestadores da Ana Care como **ESPELHO CONTÍNUO** da base de prestadores da Enlite. Três operações ao longo da vida do prestador:

1. **ENTRADA (alta / POST):** assim que o worker tiver os **campos mínimos obrigatórios da Ana Care** (`nombre` + `apellidos` + `genero` + `email` — `agencies-integration-api-v2.md:71-74`), faz o **ALTA** (POST `…/nurses/`) e guarda o `id` retornado em `workers.ana_care_id` (`014:32`). Esse é o **piso técnico**: antes desses 4 campos não dá alta (a API rejeita). **Não** espera `REGISTERED` — o espelho começa assim que é tecnicamente possível.
2. **ATUALIZAÇÃO (PATCH):** a **CADA mudança relevante do perfil** depois da alta (não só contato) — qualquer write elegível no worker reflete na Ana Care via `PATCH …/nurses/<ana_care_id>/` com os campos alterados. É **espelho contínuo**, não um one-shot.
3. **BAIXA (baja) — via WORKAROUND PATCH (decisão 2026-06-19):** quando o prestador deixa de ser elegível, propaga a **baja** na Ana Care **via um `PATCH …/nurses/<id>/` que marca o prestador como inativo num campo combinado com a Ana Care** (não há `DELETE` nem campo `status`/`activo` no recurso — §6.4). Gatilhos:
   - **Desativação (#3):** worker vira `status='DISABLED'` (`Worker.ts:50`) → evento de baja → PATCH-workaround na Ana Care.
   - **Merge (#5):** ao deduplicar, o **duplicado** (`merged_into_id IS NOT NULL` — `020:18`) recebe baja na Ana Care; o **sobrevivente** permanece.
   - ⚠️ **A spec não expõe campo de baja óbvio (§6.4).** A baixa é **desenhada como PATCH** num campo a definir, mas **CONDICIONADA à confirmação do Javier** sobre QUAL campo/convenção usar. Até lá, o handler de baja é **no-op logado**, mas o **evento de baja JÁ é capturado no `domain_events` (outbox)** — replay quando o campo for definido. Ver §9 (risco de vazamento) e §10.5/§11.

Tudo de forma **idempotente** via `workers.ana_care_id` (`014:32`): a presença/ausência do `ana_care_id` decide **POST vs PATCH**; o `ana_care_synced_at` (coluna nova, §7) registra o último espelhamento bem-sucedido. Reusa o padrão de integração outbound plugável já consolidado para o Talentum (`*ApiClient` + Port no domínio + Secret Manager).

> **Mudança vs. refinamento anterior:** o critério ATIVO **deixou de ser** `status='REGISTERED'`. Espelho começa nos **mínimos da Ana Care** (4 campos), independe de `REGISTERED`, e segue propagando update **a cada** mudança e baja na saída. `REGISTERED` continua sendo um marco do cadastro Enlite, mas **não** é mais o gatilho do espelho.

---

## 3. Escopo

### Dentro
- **ENTRADA / ALTA (POST):** ALTA de prestador na Ana Care (`POST …/nurses/`) assim que satisfaz o **predicado de elegibilidade** (§6.4): mínimos da Ana (`nombre`+`apellidos`+`genero`+`email`) preenchidos + não-merged + não-conta-de-teste. Persiste `ana_care_id` + `ana_care_synced_at` em transação.
- **ATUALIZAÇÃO / PATCH (espelho contínuo):** a **cada mudança relevante de perfil** após a alta (não só `phone`/`email`), `PATCH …/nurses/<ana_care_id>/` apenas com os campos alterados. Gatilho via **outbox transacional** a cada write elegível do worker (§5).
- **BAIXA / baja (espelho completo):** desativação (`status='DISABLED'`) e merge (`merged_into_id IS NOT NULL`) propagam baja na Ana Care para o `ana_care_id` correspondente. **Desenho condicionado** ao endpoint de baja (GAP §6.4).
- **Bulk (PATCH `…/nurses/bulk/`)** transacional/atômico para `n` prestadores, com **tratamento de erro/retry POR ITEM** — para lotes de atualização (ex.: drain do outbox, backfill incremental).
- **Catálogos:** GET `nurse-types` / `hiring-types` para resolver `tipo_enfermera` / `tipo_contratacion` por id ou nome (`agencies-integration-api-v2.md:55-56,82-92`).
- Provider plugável `IAnaCareApiClient` (domínio) + `AnaCareApiClient` (infra) + use cases de push (single + bulk) + mapper `Worker → Nurse(ES)` (resolve todos os GAPs de mapeamento — §6.3/§10).
- Carga da **API key estática** via Secret Manager (secret `ana-care-api-key`, nome idêntico prd/stg), nos moldes de `TalentumApiClient.fromSecretManager()`.
- Migration **aditiva mínima** para idempotência: índice único parcial em `ana_care_id` + coluna `ana_care_synced_at` (a coluna `ana_care_id` **já existe** — `014:32`; ver §4/§7).
- **BACKFILL (carga inicial):** roda **DEPOIS da dedup (#5)**, limitado por: `created_at >= '2026-04-01'` (`001:24`) **AND** `merged_into_id IS NULL` (`020:18`) **AND** não-conta-de-teste **AND** elegível (mínimos da Ana). Throttle + paginação. Predicado completo em §6.4.

### Fora
- **Vinculação prestador ↔ paciente:** acontece **do lado da Ana Care** (o próprio Javier diz "para posterior vinculação com pacientes na instância da Ana Care"). Não é responsabilidade da Enlite.
- **Inbound** (Ana Care → Enlite): import legado por planilha permanece como está; não é desta task.
- Sincronizar PHI / dado clínico de paciente (escopo é cadastro do **prestador**).
- Extrair a integração para microservice próprio (`provider-service` é roadmap; política multi-repo / TD-034 — não extrair agora).
- Edição de worker pela UI (decisão de produto: não há edição de worker hoje, é proposital — memória `project_no_worker_edit_intentional`). O espelho reflete mudanças vindas dos write-paths existentes (cadastro, MCP/Luz, import), não de uma UI de edição nova.

---

## 4. Estado atual do código — EVIDÊNCIA

### 4.1 Idempotência: id externo da Ana Care **já existe** no schema
- `workers.ana_care_id VARCHAR(20)` — `worker-functions/migrations/014_enlite_ar_operational_schema.sql:32`. É exatamente o ID do worker na plataforma Ana Care. **Hoje é nullable, sem índice único, sem constraint.** É o candidato natural para guardar o id retornado pela Ana Care no ALTA e para decidir **POST (null) vs PATCH (preenchido)**.
- `workers.cuit VARCHAR(30)` — `014:33` (plaintext, identificador fiscal AR; mantido para dedup).
- **GAP:** não há `ana_care_synced_at` / `last_synced_at` em `workers` (só `created_at`/`updated_at` genéricos — `001_create_workers_schema.sql:24-25`). O único `synced_at` do repo é de outra entidade (`job_postings_clickup_sync`, migration 081). → criar em §7.

### 4.2 Cutoff temporal e marcador de merge — EVIDÊNCIA (verificado nesta rodada)
- **`workers.created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()`** — `001_create_workers_schema.sql:24`. **Existe** e serve de cutoff do backfill (`>= '2026-04-01'`). Auxiliar: `updated_at` (`001:25`, auto-atualizado pelo trigger `update_workers_updated_at` em `001:118`).
- **`workers.merged_into_id UUID REFERENCES workers(id)`** — `020_analytics_and_dedup.sql:18` (ALTER TABLE; índice parcial em `020:22`). FK self-referencial: aponta para o worker canônico quando o registro é um duplicado mergeado. **É o marcador do espelho:** `merged_into_id IS NULL` = sobrevivente/canônico (elegível); `IS NOT NULL` = duplicado (baja). (`data_sources TEXT[]` foi adicionada no mesmo ALTER — `020:19` — usada pela dedup cross-source.)

### 4.3 Marcador de "conta de teste" — **NÃO ENCONTRADO** (decisão/risco)
Verificado nesta rodada (grep + leitura): **NÃO existe** marcador de conta de teste para workers no código de produção.
- **Sem coluna booleana** `is_test`/`test_account`/etc. na tabela `workers` (nenhum `ADD COLUMN ... test` nas migrations).
- O único `isTest` do código é flag de **ambiente de webhook de parceiro**, sem relação com worker: `PartnerAuthMiddleware.ts:41,78`, `WebhookPartner.ts:22`, `TalentumWebhookController.ts:39`.
- Emails/telefones `@test`/`@example`/fixtures só existem em `tests/`, `__tests__/` e `scripts/generate-test-fixtures.js` — **nunca** em path de produção. `gabriel.g.stein@gmail.com` não aparece em nenhum lugar do `worker-functions/`.
- Os filtros `NOT LIKE` de produção são **anti-IMPORT**, não anti-teste: `w.email NOT LIKE '%@enlite.import'` (`BulkDispatchTalentumIncompleteUseCase.ts:61`, `BulkDispatchIncompleteWorkersUseCase.ts:57`) e exclusão de `auth_uid LIKE 'anacareimport_%' / 'candidatoimport_%' / 'pretalnimport_%' / 'talentum_%'` (`backfill-worker-names-from-encuadres.ts:201-204`). Semântica de **origem de dado importado**, não de conta de teste.

**Decisão anti-lixo (atualizada 2026-06-19, Gabriel — §10.7):** o gate primário do espelho passa a ser a coluna **`workers.is_test = false`** (`BOOLEAN NOT NULL DEFAULT false`, **aditiva, criada na #5 — migration 221**). O predicado de elegibilidade inclui `AND is_test = false`. A heurística de email vira **rede de segurança** pra registros **históricos ainda não marcados** com `is_test` (não substitui o gate, complementa):
```sql
AND is_test = false                              -- gate primário (migration 221, criada na #5)
AND email NOT LIKE '%@enlite.import'             -- rede de segurança
AND email NOT IN ( /* TEST_EMAILS: gabriel.g.stein@gmail.com e aliases +testN */ )
AND email NOT LIKE '%+test%@%'                    -- rede de segurança
```
**Risco residual:** registros históricos com `is_test` ainda `false` por default mas que SÃO de teste dependem da rede de segurança por email (manual); um email de teste novo fora da lista e com `is_test=false` pode vazar. Mitigar: backfill de `is_test=true` nos conhecidos + revisão antes da carga inicial. A coluna `is_test` deixa de ser follow-up — é **dependência da #5** (§11).

### 4.4 ⚠️ PII está CRIPTOGRAFADA (KMS) — não dá pra ler do SQL
A migration `023_encrypt_all_pii.sql:46-55` **dropou** as colunas plaintext. Hoje nome/sobrenome/sexo/nascimento/documento existem só em colunas `*_encrypted` (Cloud KMS), descriptografadas na camada de aplicação:
- `first_name_encrypted` — `002_add_kms_encrypted_columns.sql:8`
- `last_name_encrypted` — `002:9`
- `sex_encrypted` / `gender_encrypted` — `002:13` / `:14`
- `birth_date_encrypted` — `002:12`
- `document_number_encrypted` — `002:22` (+ `document_type` plaintext — `002:21`)

Mantidos em **plaintext** propositalmente (necessários para lookup/dedup SQL): `email`, `phone`, `document_type`, `cuit`. → **O push para a Ana Care precisa descriptografar via mapper/repo da aplicação antes de enviar; nunca ler do SQL direto.** Schema se declara "HIPAA Compliant: No PII in logs" (`001` header).

> ⚠️ **Consequência para o predicado de elegibilidade:** os mínimos da Ana incluem `nombre`/`apellidos`/`genero`, que estão **sob KMS**. "Tem os mínimos preenchidos" **não** é checável só em SQL plaintext (só `email` é plaintext entre os 4). A elegibilidade tem duas camadas: (a) filtro SQL barato (`email NOT NULL` + cutoff + merged + anti-teste) seleciona candidatos; (b) o use case descriptografa e confirma `nombre`/`apellidos`/`genero` não-vazios antes do POST. Documentado em §6.4.

### 4.5 Write-paths do worker — onde plugar o gatilho do espelho (EVIDÊNCIA, verificado nesta rodada)
Métodos de escrita do worker (`src/modules/worker/infrastructure/WorkerRepository.ts` + sub-repos + use cases):

| Write-path | file:line | O que faz | Relevante p/ espelho |
|---|---|---|---|
| `create` | `WorkerRepository.ts:33` | `INSERT INTO workers` (status INCOMPLETE_REGISTER) | candidato a ALTA quando atinge mínimos |
| `updatePersonalInfo` | `WorkerRepository.ts:129` (→ `WorkerPersonalInfoRepository.ts:15`, UPDATE @ `:57`) | wizard de cadastro | **sim** (muda nome/sexo/etc.) |
| `updateAuthUid` | `WorkerRepository.ts:158` (→ `WorkerAuthRepository.ts:117`) | vincula auth + phone + consent | parcial (phone) |
| `updateFromImport` / `updateImportedWorkerData` | `WorkerRepository.ts:199,236` (→ `WorkerImportRepository.ts:53`, `WorkerAuthRepository.ts:173`) | path de import | **sim** (mas pode burlar revisão — §9) |
| `addDataSource` | `WorkerRepository.ts:206` | UPDATE data_sources array | marginal |
| `updateStatus` / `recalculateStatus` | `WorkerRepository.ts:214,232` | muda `status` (dispara `trg_worker_status_history`) | **sim — gatilho de baja** quando vira `DISABLED` |
| `UpdateWorkerProfileFieldsUseCase.execute` | `UpdateWorkerProfileFieldsUseCase.ts:73` (UPDATE workers @ `:205`, UPDATE worker_service_areas @ `:263`) | **choke point único** das mudanças de perfil (confirm da Luz + MCP) | **PONTO CENTRAL do gatilho** |
| `InitWorkerUseCase.execute` | `InitWorkerUseCase.ts:39` (create @ `:144` / updateAuthUid @ `:68`; já chama `eventDispatcher.notifyWorkerCreated` @ `:159`) | criação/reconciliação | candidato a ALTA |

### 4.6 Outbox transacional a reusar — EVIDÊNCIA (verificado nesta rodada)
Existem **dois** outboxes no repo; o correto para o gatilho do espelho é o **genérico de domain events**, não o de mensageria:

- **`domain_events` (outbox transacional genérico — USAR ESTE):** tabela em `099_event_driven_infrastructure.sql:8` (colunas `id, event(text), payload(jsonb), status('pending'|'processed'|'failed'), created_at, processed_at`; `trace_id` adicionado depois). Processada por `src/shared/events/DomainEventProcessor.ts:13` com `registerHandler(eventName, handler)`. **Enqueue é um `INSERT INTO domain_events (event, payload[, trace_id])`** na MESMA transação do write — exemplos reais em `ProcessTalentumPrescreening.ts:264` e `VacancyCrudController.ts:154`.
- **`messaging_outbox` (mensageria WhatsApp — NÃO é este):** `OutboxProcessor.ts:32` (`MAX_ATTEMPTS=3` `:8`, `BATCH_SIZE=50` `:9`, `MAX_PENDING_AGE_DAYS=7` `:10`), tabela em `060_talent_search_outbox_trigger.sql:6`. É molde de **bulk/retry** (BATCH_SIZE/MAX_ATTEMPTS) que o `BulkSyncWorkersToAnaCare` pode imitar, mas o enqueue do espelho vai no `domain_events`.

### 4.7 Tabelas de auditoria de perfil — EVIDÊNCIA (verificado nesta rodada)
Citadas na #5; **existem, mas são append-only sem trigger** — não servem como gatilho direto, servem como contexto/log:
- `worker_profile_changes_audit` — `202_worker_profile_changes_audit.sql:9`. **Sem trigger.** Populada só via código por `ProfileChangeAuditRepository.recordBatch` (`ProfileChangeAuditRepository.ts:48`), chamado por `ConfirmWorkerProfileUpdateUseCase.ts:71`. Escopo: fluxo propose/confirm da Luz (`changed_by='luz'`, valores redigidos). Log append-only, não dispara nada.
- `worker_pending_profile_changes` — `201_worker_pending_profile_changes.sql:12`. Staging do propose/confirm da Luz (payload KMS, TTL). Escrita via `PendingProfileChangeRepository` (`:37`, markConsumed `:105`). Sem trigger.

> **Conclusão do gatilho:** o módulo `src/modules/worker/` **NÃO emite domain events hoje** (`DOMAIN_EVENTS_NO_WORKER: NÃO ENCONTRADO`). O único sinal é o `EventDispatcher.ts:14` (webhook HTTP **síncrono** pra n8n via axios — `notifyWorkerCreated` `:68`, `notifyWorkerUpdated` `:91` existe mas **não é chamado** em write-path). O caminho limpo do espelho é **emitir um `domain_events` (INSERT na mesma transação) a partir de `UpdateWorkerProfileFieldsUseCase.execute` (choke point) e dos demais write-paths elegíveis**, registrar um handler que chama o `PushWorkerToAnaCareUseCase`. Sem trigger SQL na tabela `workers` (mantém a lógica de elegibilidade no app, onde o KMS é descriptografável).

### 4.8 Padrão outbound a reusar — Talentum (EVIDÊNCIA)
Molde maduro a copiar (sem acoplar o core a "Ana Care" — ADR-004). Módulo `worker-functions/src/modules/integration/`:

| Camada | Arquivo:line | Papel |
|---|---|---|
| Port (domain) | `src/modules/integration/domain/ITalentumApiClient.ts:88-103` | Interface + DTOs co-localizados (ex.: `createPrescreening` L90) |
| Adapter (infra) | `src/modules/integration/infrastructure/TalentumApiClient.ts:55` | `implements ITalentumApiClient`; HTTP via `fetch` nativo (`request<T>` L223-256) |
| Factory secret | `TalentumApiClient.ts:86-114` | `fromSecretManager()`: `require('@google-cloud/secret-manager')`, `GCP_PROJECT_ID ?? 'enlite-prd'` (L97), `accessSecretVersion` em `versions/latest` (L99-104) |
| Factory env | `TalentumApiClient.ts:71-80` | `fromEnv()` lê `process.env`; `create()` (L120-125) escolhe env→secret |
| Use case (app) | `src/modules/integration/application/PublishVacancyToTalentumUseCase.ts:38` | Outbound; instancia `TalentumApiClient.create()` (L127), chama API, persiste refs em txn |
| Barrel | `src/modules/integration/index.ts` | **Imports externos só por aqui**; todo símbolo público re-exportado |

- **Padrão de secret duplicado 3×** no repo (sem helper central): `TalentumApiClient.fromSecretManager()`, `BlindIndexService.loadKey()` (`src/shared/security/BlindIndexService.ts:116-154`), `ServicePrincipalSecretManagerRepo` (`src/modules/mcp/infrastructure/ServicePrincipalSecretManagerRepo.ts`). Copiar o bloco do Talentum e trocar o nome do secret.
- **Molde de scheduler bulk** (para drain/backfill): `BulkDispatchTalentumScheduler.ts` (stateless `run()` chamado por Cloud Scheduler via `POST /api/internal/...`) + `OutboxProcessor.ts` em `notification/`.

---

## 5. Arquitetura proposta

**TRAVADO:** reusar o padrão **outbound Talentum** em `worker-functions/src/modules/integration/`. `AnaCareApiClient` com **API key estática** no **Secret Manager** (secret `ana-care-api-key`, nome **idêntico em prd e stg** — memória `feedback_naming_prd_stg`). Provider **plugável** (ADR-004): vendor "Ana Care" não vaza pro core do domínio. **Não** extrair MS agora (TD-034 não atendido; `provider-service` fica como follow-up, não bloqueia v1).

### 5.1 Port + Adapter plugável (ADR-004)
- **Port (domain):** `src/modules/integration/domain/IAnaCareApiClient.ts` com métodos:
  - `createNurse(input: AnaCareNurseInput): Promise<{ id: number }>` (POST `…/nurses/`) — **ALTA**
  - `updateNurse(id: number, patch: Partial<AnaCareNurseInput>): Promise<void>` (PATCH `…/nurses/<id>/`) — **espelho de update**
  - `bulkUpdateNurses(items: AnaCareBulkItem[]): Promise<void>` (PATCH `…/nurses/bulk/`) — lote
  - `deactivateNurse(id: number): Promise<void>` — **baja via PATCH-workaround**; ⚠️ implementação faz `PATCH …/nurses/<id>/` setando o campo/convenção de inativo combinado com a Ana (GAP §6.4); enquanto o Javier não confirma QUAL campo, é **no-op logado** (evento já capturado no outbox p/ replay)
  - `listNurseTypes()` / `listHiringTypes()` (GET catálogos, paginado)
  - DTOs `AnaCareNurseInput` / `AnaCareBulkItem` co-localizados (espelham §6).
- **Adapter (infra):** `src/modules/integration/infrastructure/AnaCareApiClient.ts implements IAnaCareApiClient`. `BASE_URL` como constante no topo; `fetch` nativo; header de auth `X-Agency-Key: ana_care.<…>` **ou** `Authorization: Api-Key ana_care.<…>` (`agencies-integration-api-v2.md:31-39`). Auth é **mais simples que Talentum** — só uma API key estática, sem login RSA/cookies.
- **Factory:** `AnaCareApiClient.create()` → `fromEnv()` (`ANA_CARE_API_KEY`) senão `fromSecretManager()` (secret `ana-care-api-key`, idêntico em prd e stg).

### 5.2 Predicado de elegibilidade (espelho)
Quem entra/permanece no espelho. Duas camadas (a PII de `nombre`/`apellidos`/`genero` está sob KMS — §4.4):
- **Camada SQL (seleção barata de candidatos):** `email IS NOT NULL` (`001:16` já é NOT NULL) **AND** `created_at >= '2026-04-01'` (`001:24`, **só no backfill**; realtime não filtra por data) **AND** `merged_into_id IS NULL` (`020:18`) **AND** `is_test = false` (coluna nova criada na #5, migration 221 — gate primário anti-lixo) **AND** anti-teste por email como rede de segurança p/ registros históricos ainda não marcados (§4.3).
- **Camada app (confirmação dos mínimos KMS):** descriptografa e confirma `nombre`, `apellidos`, `genero` não-vazios; `genero` mapeável para `M`/`H` (§6.3). Só então POST.
- **Inelegível / baja:** `status='DISABLED'` (`Worker.ts:50`) **OU** `merged_into_id IS NOT NULL` (`020:18`) → se já tem `ana_care_id`, propaga baja; senão, não faz nada.

### 5.3 Gatilho via OUTBOX a cada write elegível — TRAVADO (§10.1)
**Nunca** no path síncrono HTTP do cadastro. O espelho é dirigido por **eventos no outbox transacional `domain_events`** (`099:8`, processado por `DomainEventProcessor.ts:13`):
1. Em cada **write-path elegível** do worker (§4.5) — sobretudo o choke point `UpdateWorkerProfileFieldsUseCase.execute` (`:73`), mas também `create`/`updatePersonalInfo`/`updateFromImport`/`updateStatus` — fazer `INSERT INTO domain_events (event, payload)` na **mesma transação** do UPDATE (padrão `ProcessTalentumPrescreening.ts:264`). Eventos: `worker.profile.changed`, `worker.disabled`, `worker.merged`.
2. Registrar handlers no `DomainEventProcessor`:
   - `worker.profile.changed` → `PushWorkerToAnaCareUseCase` (POST se `ana_care_id` null e elegível; senão PATCH dos campos alterados).
   - `worker.disabled` / `worker.merged` → baja (se tem `ana_care_id`).
3. O processamento é **assíncrono** (consome o outbox fora da transação do request) → não acopla latência do cadastro ao HTTP da Ana Care, e dá retry/idempotência de graça.

> **Por que outbox e não trigger SQL:** elegibilidade depende de PII KMS (descriptografável só no app — §4.4), e o `EventDispatcher` atual é síncrono via axios (`EventDispatcher.ts:14`), inadequado pra espelho resiliente. O `domain_events` já existe e é transacional.

### 5.4 Mapper `Worker → Nurse(ES)`
`WorkerToAnaCareNurseMapper` (domain) traduz a entidade `Worker` (descriptografada) → DTO em **espanhol** da §6. Inclui:
- mapeamento de **sexo PT→`M`/`H`** (valores plaintext originais eram `'Masculino'/'Feminino'/'Outro'` — `002_add_fullmap_fields.sql:149`) — normalizar na borda com comentário `// Ana Care: "M"|"H"`.
- resolução de `tipo_enfermera` / `tipo_contratacion` via catálogo (id ou nome exato).

### 5.5 Use cases
- `PushWorkerToAnaCareUseCase` (single): se `worker.ana_care_id` é null **e** elegível (§5.2) → `createNurse` → persiste `ana_care_id` + `ana_care_synced_at`; senão → `updateNurse(ana_care_id, patch)` com os campos alterados + atualiza `ana_care_synced_at`.
- `DeactivateWorkerInAnaCareUseCase` (baja via PATCH-workaround): se `worker.ana_care_id` não-null e (DISABLED ou merged) → `deactivateNurse(ana_care_id)` que faz `PATCH …/nurses/<id>/` no campo de inativo combinado com a Ana (§6.4). Disparado pelos eventos `worker.disabled`/`worker.merged` do outbox. Enquanto o Javier não confirma o campo, é **no-op logado** — mas o evento de baja **já está persistido em `domain_events`** (`099:8`), permitindo **replay** quando a convenção for definida.
- `BulkSyncWorkersToAnaCareUseCase` (lote, drain/backfill): monta `items[]` (cada um com `id = ana_care_id` obrigatório — `agencies-integration-api-v2.md:115`) e chama `bulkUpdateNurses`. **Só** prestadores que já têm `ana_care_id` entram no bulk (bulk é PATCH, exige id existente). ALTA em massa = loop de POST (não há bulk-create na spec). **Erro/retry POR ITEM:** o bulk é atômico (`:115`) — validar/normalizar cada item antes; em falha de lote, isolar o item ruim e cair pra PATCH individual nos demais; só marcar `ana_care_synced_at` dos itens aceitos. Molde: `BulkDispatchTalentumScheduler` + `OutboxProcessor` (BATCH_SIZE/MAX_ATTEMPTS).

### 5.6 Fluxo de BACKFILL — pós-dedup
Carga inicial **roda DEPOIS da dedup (#5)** (senão espelha duplicados que viram lixo). Stateless `AnaCareBackfillScheduler.run()` (molde `BulkDispatchTalentumScheduler`) com paginação + throttle, sobre o predicado de elegibilidade do backfill (§6.4: mínimos + cutoff abril + `merged_into_id IS NULL` + anti-teste). Para cada candidato: POST (ALTA) → persiste `ana_care_id`. Depois disso, o realtime (§5.3) mantém o espelho.

> **Ordem TRAVADA:** dedup (#5) → backfill (ALTA inicial) → realtime (update/baja contínuos). Inverter dedup↔backfill = lixo no espelho (§9).

---

## 6. Contrato da API Ana Care — EVIDÊNCIA + mapeamento

### 6.1 Endpoints (`agencies-integration-api-v2.md:53-61`)
| Método | Rota | Uso na task |
|---|---|---|
| `GET` | `{BASE}/api/v2/agencies/nurse-types/` | resolver `tipo_enfermera` |
| `GET` | `{BASE}/api/v2/agencies/hiring-types/` | resolver `tipo_contratacion` |
| `POST` | `{BASE}/api/v2/agencies/nurses/` | **ENTRADA / ALTA** de prestador |
| `PATCH` | `{BASE}/api/v2/agencies/nurses/<id>/` | **ATUALIZAÇÃO** (espelho contínuo) individual |
| `PATCH` | `{BASE}/api/v2/agencies/nurses/bulk/` | **bulk** transacional (`items[]`, cada item com `id`) |
| `GET` | `{BASE}/api/v2/agencies/nurses/` , `…/<id>/` | leitura/reconciliação |
| `DELETE` | — | ⚠️ **NÃO EXISTE na spec** (`:53-61`) — sem endpoint de baja, ver §6.4 |

- **Base URL:** prefixo `https://admin.ana.care/api/v2/agencies/` (`:5`); host final a confirmar com Ana (`{BASE}` placeholder — `:51`). Produção: **HTTPS only** (`:43`).
- **Auth:** API key por agência, formato `ana_care.<public_id_hex_16>.<secreto>` (`:23-27`), via header `X-Agency-Key` ou `Authorization: Api-Key <clave>` (`:31-39`). Guardar em secret manager; rotação coordenada com Ana (`:45`). Confirmado: **uma única API key estática por agência**, sem fluxo de login.
- **Paginação (listas):** objeto `{ count, next, previous, results }`, `?page=` e opcional `?page_size=` (`:121-123`).
- **HTTP:** `200/201` ok; `400` validação (incl. duplicado de email/telefone, tipo inexistente/ambíguo); `401` key ausente/incorreta/agência inativa; `403` sem auth válida; `404` enfermeira inexistente/de outra agência ou `id` inválido no bulk (`:127-137`).
- **Bulk:** **atômico** — falha total se qualquer item não validar (`:115`). Confirmado que **PATCH bulk cobre atualização em lote** com "los mismos campos que en el alta" por item (`:115`). Limite máx. de itens por petição: **a confirmar com Ana** (`:117`).

### 6.2 Payload por prestador (recurso "enfermera", `agencies-integration-api-v2.md:65-92`) ⇄ coluna `workers`

| Campo Ana Care | Obrig. (alta) | Coluna Enlite | Tabela | Migration:line | Notas / GAP |
|---|---|---|---|---|---|
| `nombre` | **Sim** | `first_name_encrypted` | workers | `002_add_kms_encrypted_columns.sql:8` | KMS — descriptografar no mapper. **Mínimo obrigatório do espelho** |
| `apellidos` | **Sim** | `last_name_encrypted` | workers | `002:9` | KMS. **Mínimo obrigatório do espelho** |
| `genero` (`"M"`/`"H"`) | **Sim** | `sex_encrypted` | workers | `002:13` | KMS. Valores originais PT `Masculino/Feminino/Outro` (`002_add_fullmap_fields.sql:149`) → mapear PT→`M`/`H` na borda. `"Outro"` **sem destino** em M/H → tratar (§9). **Mínimo obrigatório do espelho** |
| `email` | **Sim** | `email` (UNIQUE NOT NULL) | workers | `001_create_workers_schema.sql:16` | plaintext. Único na Ana Care também. **Mínimo obrigatório do espelho** (único plaintext entre os 4) |
| `telefono` | Não (único se enviado) | `phone` VARCHAR(20) | workers | `001:17` | plaintext. Campo-alvo do ponto 1 do Javier |
| `calle` (rua) | Não | **GAP — sem coluna dedicada** | — | — | Só `address_line` (rua+número juntos) em `worker_service_areas` (`001:43`); import legado usava string única. Sem `street` puro |
| `estado` (UF) | Não | `state` VARCHAR(50) | worker_service_areas | `001:45` | tabela 1:N, sem flag de endereço principal |
| `ciudad` | Não | `city` VARCHAR(100) | worker_service_areas | `001:44` | idem |
| `colonia` (bairro) | Não | `neighborhood` VARCHAR(150) | worker_service_areas | `110_add_neighborhood_to_worker_service_areas.sql:6` | preenchido via geocoding/manual; esparso |
| `codigo_postal` | Não | `postal_code` VARCHAR(20) | worker_service_areas | `001:46` | idem |
| `fecha_nacimiento` (YYYY-MM-DD) | Não | `birth_date_encrypted` | workers | `002:12` | KMS |
| `cedula_ciudadania` (CURP/doc) | Não | `cuit` (plaintext) **ou** `document_number_encrypted`+`document_type` | workers | `cuit`: `014:33`; doc: `002:22`+`002:21` | AR usa CUIT (plaintext, melhor pra dedup); doc genérico é KMS |
| `tipo_enfermera` | Não | `occupation` (sync Ana Care) **e/ou** `profession` (autodeclarado) | workers | `occupation`: `014:36` (`CHECK IN ('AT','CUIDADOR','AMBOS')`); `profession`: `002_add_fullmap_fields.sql:28` | ⚠️ enum local `AT/CUIDADOR/AMBOS` **não** bate 1:1 com catálogo da Ana (`nurse-types`). Resolver via GET catálogo → id/nome exato. Pode divergir de `profession` |
| `tipo_contratacion` | Não | `employment_type` | worker_employment_history (1:N) | `027_add_branch_and_employment_history.sql:30` | enum `ana_care/enlite/temporary/contractor/other`; "vínculo atual" = linha com `terminated_at IS NULL`. Mapear via catálogo `hiring-types` |
| `id` (no PATCH/bulk) | — (PATCH/bulk) | `ana_care_id` | workers | `014_enlite_ar_operational_schema.sql:32` | id retornado no ALTA; chave de idempotência (POST vs PATCH) |

### 6.3 GAPs de mapeamento
1. **`calle` (rua):** GAP — não há coluna `street`/`calle` dedicada; só `address_line` (rua+número concatenados) em `worker_service_areas`. Decidir: enviar `address_line` em `calle`, ou deixar `calle` vazio (é opcional).
2. **`genero = "Outro"`:** a Ana Care só aceita `"M"`/`"H"` (`:73`). Workers com sexo `Outro` não têm destino limpo — decidir fallback (§10.8).
3. **`ana_care_synced_at`:** GAP de coluna de timestamp de sync (§7).
4. **Endereço 1:N sem "principal":** `worker_service_areas` pode ter N linhas sem flag de endereço primário — desambiguar qual vai pros campos de endereço.
5. **`tipo_enfermera`/`tipo_contratacion`:** enums locais não batem com catálogo da Ana → resolução obrigatória via GET `nurse-types`/`hiring-types` (id ou nome exato; nome ambíguo é rejeitado, usar id — `:91`).

### 6.4 GAP — baja via WORKAROUND PATCH (não há DELETE nem campo status)
**A spec NÃO expõe operação de baja nem campo de status.** Evidência:
- Tabela de endpoints `agencies-integration-api-v2.md:53-61`: só `GET`/`POST`/`PATCH` (individual + bulk). **Sem `DELETE`.**
- Resumo de operações `:15`: "Listar, crear, leer y actualizar parcialmente (`PATCH`)" — não há "eliminar"/"dar de baja"/"desactivar".
- Recurso "enfermera" `:65-92`: **não lista** campo `activo`/`estado`/`status`/`baja`. Não há flag de estado dedicada para alternar via PATCH.

**Decisão (2026-06-19, Gabriel):** implementar a baja como um **`PATCH …/nurses/<id>/` que marca o prestador como inativo via um campo combinado com a Ana Care**. Como NÃO há campo óbvio, isto fica **CONDICIONADO à confirmação do Javier** sobre QUAL campo/convenção usar.

**Candidatos REAIS PATCH-able da spec** (campos do recurso "enfermera", todos atualizáveis via PATCH — `agencies-integration-api-v2.md:60,115`) que poderiam carregar uma convenção de "inativo":

| Candidato | file:line | Por que poderia servir | Ressalva |
|---|---|---|---|
| `tipo_contratacion` | `agencies-integration-api-v2.md:80` | Catálogo `hiring-types` da agência (`:56,89`): a Ana poderia criar um tipo dedicado tipo `"Baja"`/`"Inactivo"` no catálogo e nós setaríamos por id/nome | Exige a Ana adicionar valor ao catálogo; semântica desviada (é "tipo de contratación", não estado) |
| `tipo_enfermera` | `agencies-integration-api-v2.md:79` | Idem `tipo_contratacion`, via catálogo `nurse-types` (`:55,89`); um tipo dedicado marcaria inativo | Mesma ressalva: desvia a semântica do catálogo |
| `cedula_ciudadania` | `agencies-integration-api-v2.md:78` | Campo texto livre ("Identificador, ej. CURP"); poderia carregar uma marca-convenção (ex.: prefixo/sufixo `BAJA-`) | Polui um identificador legal; **NÃO recomendado** (corrompe dado real) |
| `calle`/`colonia` (texto livre de endereço) | `agencies-integration-api-v2.md:76` | Campos de endereço opcionais e texto livre; poderiam carregar uma marca | Polui endereço; **NÃO recomendado** |
| `email` (anonimização) | `agencies-integration-api-v2.md:74` | PATCH do email para um sentinela tipo `baja+<id>@enlite.invalid` "esconde" o registro de buscas reais | Destrói contato real; quebra reversibilidade; **NÃO recomendado** |

→ **Nenhum candidato é um campo de estado limpo.** O caminho semanticamente menos ruim é **`tipo_contratacion`/`tipo_enfermera` com um valor de catálogo dedicado criado pela Ana** — mas SÓ o Javier pode confirmar a convenção. Os demais (texto livre / email) corrompem dado real e ficam como último recurso.

→ **Implementação travada:** o handler `deactivateNurse` (disparado pelos eventos `worker.disabled`/`worker.merged` do outbox — §5.3) fica como **no-op logado**, mas o **evento de baja JÁ É capturado em `domain_events`** (`099:8`) na transação do write. Quando o Javier confirmar o campo/convenção, o handler ativa o PATCH-workaround e **dá replay** dos eventos pendentes. O **risco de vazamento por baja não-propagada** (worker DISABLED/merged seguir visível na Ana Care) é registrado em §9. **Bloqueia a propagação da baixa, não o resto do espelho.** Pergunta formal ao Javier em §11.

### 6.5 `predicado de elegibilidade` (espelho) — SQL completo
Seleção SQL barata (candidatos a ALTA/permanência); a confirmação dos mínimos KMS (`nombre`/`apellidos`/`genero`) é no app (§4.4/§5.2):

```sql
-- ELEGÍVEL (entra/permanece no espelho)
SELECT id
FROM workers w
WHERE w.email IS NOT NULL                       -- 001:16 (já NOT NULL; mínimo plaintext)
  AND w.merged_into_id IS NULL                  -- 020:18 (não é duplicado mergeado)
  AND w.status <> 'DISABLED'                    -- Worker.ts:50 (não desativado)
  AND w.is_test = false                         -- coluna nova (migration 221, criada na #5) — gate primário anti-lixo
  AND w.email NOT LIKE '%@enlite.import'        -- rede de segurança: anti-import (BulkDispatch...:61)
  AND w.email NOT LIKE '%+test%@%'              -- rede de segurança: anti-teste p/ históricos não marcados (§4.3)
  AND w.email NOT IN ( /* TEST_EMAILS allowlist (config) — rede de segurança */ )
  -- BACKFILL apenas: cutoff temporal
  AND w.created_at >= '2026-04-01'              -- 001:24 (só na carga inicial)
;
-- + confirmação no app (KMS): nombre, apellidos não-vazios; genero ∈ {Masculino,Feminino} mapeável p/ M/H
```

```sql
-- BAJA (propagar desativação no espelho), só se já tem ana_care_id
SELECT id, ana_care_id
FROM workers w
WHERE w.ana_care_id IS NOT NULL                 -- 014:32 (já existe na Ana)
  AND ( w.status = 'DISABLED'                   -- Worker.ts:50 (desativação #3)
        OR w.merged_into_id IS NOT NULL )       -- 020:18 (duplicado mergeado #5)
;
```

> O cutoff `created_at >= '2026-04-01'` é **só do backfill** (carga inicial). No realtime, qualquer worker novo elegível entra no espelho independentemente da data de criação.

---

## 7. Schema / migrations

Migração **aditiva** (regra do projeto: nunca dropar sem deprecação), prefixo sequencial em `worker-functions/migrations/`. Itens:

1. **`ana_care_id` já existe** (`014:32`, VARCHAR(20), nullable, sem índice). → adicionar **índice único parcial** `WHERE ana_care_id IS NOT NULL` para garantir 1:1 e dedupe (segue padrão do índice parcial de phone em `014:48`). É o que torna POST vs PATCH seguro.
2. **Nova coluna** `workers.ana_care_synced_at TIMESTAMPTZ NULL` — timestamp do último push bem-sucedido (controla "modificou desde o último sync", habilita reconciliação e o diff do realtime). `COMMENT` documentando.
3. **TRAVADO — não criar tabela nova na v1:** o **mínimo viável desta task é (1)+(2)**. O enqueue do espelho reusa a tabela `domain_events` existente (`099:8`); o retry/erro por item do bulk (§5.5) é resolvido **em memória no use case**, sem tabela de log dedicada. Tabela `ana_care_sync_log` fica como follow-up **se** observabilidade exigir. **Nota:** a coluna `workers.is_test` (gate anti-lixo do predicado) **não** é criada por esta task — é **migration 221, criada na #5** (§4.3/§10.7), e é dependência (§11).

> Migração aditiva mínima: **(1) índice único parcial em `ana_care_id` + (2) coluna `ana_care_synced_at`**. Nada além disso na v1.

---

## 8. Critérios de aceite

1. Existe Port `IAnaCareApiClient` (domain) + adapter `AnaCareApiClient` (infra); a string "Ana Care"/vendor não aparece em `domain/` além do nome do arquivo/DTOs ES esperados (grep como evidência; ADR-004).
2. **ENTRADA / ALTA (POST):** worker elegível (§6.5: mínimos confirmados + não-merged + não-teste) sem `ana_care_id` é criado na Ana Care assim que atinge os 4 mínimos; o `id` retornado é persistido em `workers.ana_care_id` + `ana_care_synced_at` numa transação. Teste cobre que a alta dispara nos mínimos, **não** espera `REGISTERED`.
3. **ATUALIZAÇÃO (PATCH) — espelho contínuo:** **qualquer** mudança relevante de perfil (não só `phone`/`email`) num worker já com `ana_care_id` dispara `PATCH …/nurses/<ana_care_id>/` só com os campos alterados, via evento no outbox. Teste cobre mudança de um campo não-contato (ex.: `occupation`) propagando.
4. **Gatilho via outbox:** o write elegível enfileira evento em `domain_events` na mesma transação (`099:8`); o handler registrado no `DomainEventProcessor` chama o push. Teste cobre que o evento é enfileirado no `UpdateWorkerProfileFieldsUseCase`.
5. **BAIXA / baja:** worker que vira `status='DISABLED'` **ou** ganha `merged_into_id` e que tem `ana_care_id` dispara `deactivateNurse`. ⚠️ Enquanto o endpoint de baja for GAP (§6.4), o aceite é: chamada logada/no-op + risco registrado; quando a Ana confirmar, ativar a propagação real.
6. **Bulk:** `PATCH …/nurses/bulk/` envia `items[]` com `id` em cada um; só entram prestadores com `ana_care_id`; trata resposta atômica (falha total → nenhum `synced_at` atualizado; isola item ruim → PATCH individual).
7. **Backfill pós-dedup:** o backfill só roda **depois** da dedup; predicado inclui cutoff `created_at >= '2026-04-01'` + `merged_into_id IS NULL` + anti-teste + mínimos. Teste cobre que worker criado antes de abril, mergeado, ou de teste **não** entra.
8. **Idempotência:** rodar o sync 2× para o mesmo worker não cria enfermeira duplicada (segundo run vira PATCH, não POST); índice único parcial em `ana_care_id` garante.
9. **PII via KMS:** nome/sobrenome/sexo/nascimento/documento são **descriptografados na aplicação** antes do envio; nenhum log expõe PII; secret da API key não commitado (grep limpo + `.env.example` atualizado).
10. **Auth + secret:** API key lida via Secret Manager em prd (`fromSecretManager`) e env em local; secret `ana-care-api-key` existe em `enlite-prd` **e** `enlite-stg` com nome idêntico.
11. **Mapeamento ES:** `genero` em `M`/`H`; `tipo_enfermera`/`tipo_contratacion` resolvidos via catálogo (id ou nome exato); valores com comentário `// Ana Care: "..."`.
12. **Anti-teste:** worker na allowlist de teste (ou `+test`, `@enlite.import`) **nunca** é espelhado (teste de não-vazamento).
13. **Teste E2E** mocka o HTTP da Ana Care (nunca chama a API real em CI), cobrindo ALTA + PATCH (campo não-contato) + bulk atômico + worker inelegível + baja + reprocessamento idempotente.

---

## 9. Riscos & armadilhas

- **PII saindo para serviço externo (CRÍTICO):** nome/sexo/nascimento/documento estão sob KMS e o schema se declara "No PII in logs". O **espelho contínuo amplifica** isso: não é uma alta pontual, é um fluxo vivo empurrando PII a cada mudança. Decisão de privacidade (LGPD/consentimento — worker tem `lgpdConsentAt`/`privacyAcceptedAt`). Sem guarda automática de PII (memória `project_pii_scrub_relies_on_human_review`): backfill em massa burla revisão humana. Exige aval explícito sobre quais campos PII saem e em qual cadência.
- **Lixo no espelho (CRÍTICO):** se o predicado de elegibilidade falhar (conta de teste; duplicado não-mergeado; worker incompleto), o espelho enche de registros inválidos na base do cliente. O gate primário agora é `is_test = false` (coluna nova da #5, migration 221 — §4.3/§10.7); a heurística de email é **rede de segurança** pra históricos não marcados, e é **manual** → revisar antes do backfill. **Risco residual:** registro de teste histórico com `is_test=false` por default e email fora da lista pode vazar. Mitigar: backfill de `is_test=true` nos conhecidos + dry-run do predicado contando candidatos antes de empurrar.
- **Ordem dedup → backfill (CRÍTICO):** se o backfill rodar **antes** da dedup (#5), espelha duplicados que depois viram baja — lixo + churn na Ana Care. **Ordem travada:** dedup → backfill → realtime (§5.6).
- **Baja não-propagada = VAZAMENTO (CRÍTICO):** a spec **não tem endpoint de baja nem campo de status** (§6.4). A baixa será um **PATCH-workaround** num campo a definir com o Javier; até essa confirmação, `deactivateNurse` é **no-op logado**, então um worker `DISABLED`/mergeado segue visível e vinculável a pacientes do lado Ana Care = prestador inválido em operação no cliente. **Mitigação parcial:** o evento de baja **JÁ é capturado em `domain_events`** (`099:8`) — quando o campo for confirmado, dá-se **replay** e a baixa propaga retroativamente. O risco persiste **só na janela** entre a baixa e a confirmação do campo. Candidatos de campo PATCH-able em §6.4; pergunta formal em §11.
- **Volume / rate limit:** espelho contínuo + backfill geram muitas chamadas. Spec não fixa rate limit, e o **máximo de itens por bulk é "a confirmar com Ana"** (`:117`). Backfill precisa paginação/throttle; realtime precisa do outbox (assíncrono, com retry) pra absorver picos sem derrubar o cadastro.
- **Bulk é transacional/atômico:** um único item inválido (email/telefone duplicado, tipo inexistente) faz **todo** o lote falhar (`:115`). Validar/normalizar antes; isolar item ruim → PATCH individual; não marcar `synced_at` de lote que falhou.
- **`genero` só aceita M/H:** workers com sexo `Outro` não têm destino limpo (`:73`) — fallback no mapper (§10.8).
- **`telefono`/`email` únicos na Ana Care (`:74-75`):** workers duplicados em prod (146 grupos por phone — memória `project_workers_duplication_state`) colidem no ALTA com `400`. `merged_into_id IS NULL` no predicado + dedupe na borda antes de enviar.
- **`tipo_enfermera`/`tipo_contratacion` divergentes:** enum local (`AT/CUIDADOR/AMBOS`, `occupation NULL` em ~68% — memória `project_worker_profession_null_bug`) não bate com catálogo da Ana; nome ambíguo é rejeitado (`:91`). Resolver via GET catálogo e tolerar campo vazio (opcionais).
- **"O que conta como mudança relevante":** sem `ana_care_synced_at` + diff, o realtime vira "envia tudo sempre". A coluna nova (§7) + comparação no use case + escopo de campos no evento `worker.profile.changed` definem o gatilho. Cuidado com write-paths de **import** (`updateFromImport`) que podem disparar PATCH em massa sem mudança real.
- **Naming prd↔stg:** esquecer o secret no stg quebra staging silenciosamente.
- **Multi-repo:** não criar MS especulativo agora (TD-034); se crescer, `enlite-health/provider-service` — follow-up, não bloqueia v1.

---

## 10. Decisões TRAVADAS (2026-06-19, Gabriel) — MODELO ESPELHO

Todas fechadas. A task é executável sem novas perguntas. Pendências residuais (host final, valor do limite de bulk, **contrato de baja**) são dados a obter da Ana Care — ver §11. O **contrato de baja** é a única que limita uma sub-operação (a baixa), não o desenho do espelho.

1. **Gatilho via OUTBOX a cada write elegível — TRAVADO:** o espelho é dirigido por **eventos no outbox transacional `domain_events`** (`099:8`, `DomainEventProcessor.ts:13`), enfileirados na mesma transação dos write-paths do worker — sobretudo o choke point `UpdateWorkerProfileFieldsUseCase.execute` (`UpdateWorkerProfileFieldsUseCase.ts:73`). **Nunca** no path síncrono HTTP. Não usar `EventDispatcher` (síncrono axios — `EventDispatcher.ts:14`). Backfill/bulk via scheduler (molde `BulkDispatchTalentumScheduler`). (§5.3)
2. **Modelo = ESPELHO CONTÍNUO — TRAVADO:** Ana Care (e HubSpot #6) são espelho da base de prestadores. Três operações: **(entrada) ALTA** nos mínimos da Ana; **(atualização) PATCH a CADA mudança relevante de perfil** (não só contato); **(baixa) baja** na desativação/merge. Substitui o modelo anterior de "alta única no `REGISTERED`".
3. **ENTRADA / piso técnico de alta — TRAVADO:** dispara o ALTA assim que o worker tiver os **4 mínimos da Ana Care**: `nombre` + `apellidos` + `genero` + `email` (`agencies-integration-api-v2.md:71-74`). Antes disso a API rejeita → não dá alta. **NÃO** espera `REGISTERED`. `email` já é NOT NULL (`001:16`); os outros 3 são KMS e confirmados no app (§4.4).
4. **ATUALIZAÇÃO — TRAVADO:** **PATCH** (não PUT) a **cada mudança relevante de perfil** após a alta, só com os campos alterados. É espelho contínuo, não one-shot de contato. O pedido do Javier (contato) é subconjunto. (`:60`, `:115`)
5. **BAIXA / baja — TRAVADO (desenho = PATCH-workaround) / CONDICIONADA (execução ao Javier):** `status='DISABLED'` (#3, `Worker.ts:50`) → baja; merge (#5, `merged_into_id IS NOT NULL`, `020:18`) → baja do duplicado, mantém o sobrevivente. A baixa é implementada como **`PATCH …/nurses/<id>/` marcando o prestador inativo via um campo combinado com a Ana Care** — NÃO há `DELETE` nem campo `status` na spec (§6.4). O evento de baja (`worker.disabled`/`worker.merged`) é gerado pelo disable (#3) e pelo merge do duplicado (#5) e **dispara esse PATCH-workaround**. ⚠️ **Como não há campo óbvio, fica CONDICIONADO à confirmação do Javier sobre QUAL campo/convenção usar** (dependência externa + pergunta formal §11). Até lá, o handler de baja **loga no-op MAS o evento JÁ é capturado no `domain_events`** (`099:8`) — **replay** quando o campo for definido. Candidatos PATCH-able reais em §6.4; risco de vazamento na janela em §9.
6. **BACKFILL pós-dedup — TRAVADO:** carga inicial roda **DEPOIS da dedup (#5)**, limitada a `created_at >= '2026-04-01'` (`001:24`) **AND** `merged_into_id IS NULL` (`020:18`) **AND** não-conta-de-teste **AND** elegível (mínimos). Throttle + paginação. Ordem: dedup → backfill → realtime. (§5.6/§6.5)
7. **Anti-lixo via `is_test` — TRAVADO (nova decisão 2026-06-19, Gabriel):** o gate primário do espelho passa a ser **`workers.is_test = false`** — coluna **aditiva `BOOLEAN NOT NULL DEFAULT false`, criada na #5 (migration 221)**. O predicado de elegibilidade inclui `AND is_test = false` (§5.2/§6.5). A heurística de email (`@enlite.import`, `+test`, allowlist `TEST_EMAILS`) é mantida como **rede de segurança** pra registros **históricos ainda não marcados**, não como gate principal. **Dependência:** `is_test` é criada pela #5 (§11). **Risco residual:** histórico com `is_test=false` por default + email fora da lista pode vazar; mitigar com backfill de `is_test=true` nos conhecidos + revisão antes do backfill (§9).
8. **GAPs de mapeamento — TRAVADO (resolver no MAPPER):**
   - **`calle`:** sem coluna `street`; usar **`address_line`** de `worker_service_areas` (`001:43`).
   - **`genero='Outro'`:** Ana só aceita `M`/`H` (`:73`) — **fallback** no mapper (não excluir o worker; documentar o default).
   - **Endereço 1:N sem flag de principal:** escolher **1 `service_area`** determinístico (documentar a regra).
   - **`tipo_enfermera`/`tipo_contratacion`:** mapear via GET `nurse-types`/`hiring-types` (id ou nome exato; ambíguo → id — `:91`).
9. **Idempotência — TRAVADO:** `workers.ana_care_id` (`014:32`) decide **POST (null) vs PATCH (preenchido)**; migration aditiva adiciona **índice único parcial** em `ana_care_id` + coluna **`ana_care_synced_at`** (diff do realtime + reconciliação). (§7)
10. **PII — TRAVADO:** campos do espelho (mínimos + contato + demais mapeados §6.2) descriptografados na aplicação (KMS — §4.4); nenhum log expõe PII; espelho contínuo amplifica exposição → aval explícito de privacidade (§9).
11. **Arquitetura — TRAVADO:** reusar padrão outbound Talentum em `worker-functions/src/modules/integration/`; `AnaCareApiClient` com API key estática no Secret Manager (`ana-care-api-key`, nome idêntico prd/stg); provider plugável (ADR-004). Sem extração de MS agora (TD-034). (§5)

> **Dados a obter da Ana Care (limitam só sub-operações, não o desenho):** host `{BASE}` final (`:51`); a API key (`ana_care.*`) para o secret; **campo/convenção de baja para o PATCH-workaround** (§6.4 — pergunta formal ao Javier em §11; limita a baixa); limite numérico de itens por bulk (`:117`).

---

## 11. Estimativa & dependências

**Estimativa (espelho: ALTA + PATCH contínuo + baja + bulk + gatilho outbox, sem backfill):** ~5-7 dias de dev backend.
- Port `IAnaCareApiClient` + adapter `AnaCareApiClient` + factory env/secret (auth por API key): ~1d.
- Mapper `Worker→Nurse(ES)` (descriptografar KMS, sexo PT→M/H, resolução de catálogo): ~1-1.5d.
- Gatilho via outbox (`domain_events`) nos write-paths + handlers no `DomainEventProcessor`: ~1.5d.
- Use cases `PushWorkerToAnaCare` + `DeactivateWorkerInAnaCare` + `BulkSyncWorkersToAnaCare`: ~1.5d.
- Migration (índice único `ana_care_id` + `ana_care_synced_at`) + idempotência: ~0.5d.
- Testes (unit + E2E mockado: ALTA/PATCH não-contato/bulk/inelegível/baja/idempotência/anti-teste) + lint/type-check: ~1-1.5d.
- +2-3d se backfill pós-dedup entrar no escopo (throttle + revisão de PII + paginação + dry-run do predicado).

**Dependências (bloqueantes):**
- **API key da Ana Care + host `{BASE}` final** → provisionar secret `ana-care-api-key` em `enlite-prd` **e** `enlite-stg` (nome idêntico) + recurso no Terraform (`automatic_secrets` em ambos `secrets.tf`). **Bloqueante de runtime.**
- **Dedup (#5) concluída** antes do backfill. **Bloqueante de ordem.**
- **Coluna `workers.is_test` (migration 221, criada na #5)** — gate primário anti-lixo do predicado (§4.3/§5.2/§6.5/§10.7). Sem ela, o espelho fica só com a rede de segurança por email. **Bloqueante do predicado v1.**

**Dependências parciais (limitam uma sub-operação, não o desenho):**
- **Campo/convenção de baja para o PATCH-workaround** (§6.4) — **dependência externa (Javier / Ana Care)**. Sem ela a **baixa não propaga** (handler no-op logado; evento já no outbox p/ replay); resto do espelho roda. Pergunta formal abaixo.
- **Limite numérico de itens por bulk** (`:117`) — dimensiona paginação do backfill/drain; default conservador até confirmar.

**Pergunta formal pro Javier (Ana Care) — baja via PATCH-workaround:**
> A spec v2 não expõe `DELETE` nem um campo de estado (`activo`/`status`) no recurso enfermera. Para a Enlite propagar a **baja** de um prestador (quando ele é desativado ou deduplicado do nosso lado), qual é a convenção que vocês querem que a gente use via `PATCH …/nurses/<id>/`? Opções que vemos: (a) vocês criam um valor dedicado no catálogo `hiring-types` (ou `nurse-types`) — ex.: `"Baja"`/`"Inactivo"` — e nós setamos `tipo_contratacion`/`tipo_enfermera` para esse id; (b) vocês expõem um campo de estado (`activo: false`) no PATCH; (c) a baja é processo manual do lado de vocês e a Enlite só pára de atualizar o registro. Qual prefere? Há limite de itens por requisição no `bulk`?

**Não-dependências (fora de escopo):** Cloud Healthcare API, `provider-service`, extração multi-repo, vinculação prestador↔paciente (lado Ana Care).

**Reuso confirmado:** módulo `integration` (Port+Adapter Talentum como molde), `fromSecretManager` (`TalentumApiClient.ts:86-114`), outbox transacional `domain_events` (`099:8` + `DomainEventProcessor.ts:13`), scheduler bulk (`BulkDispatchTalentumScheduler` + `OutboxProcessor` em `notification/`), coluna `ana_care_id` (`014:32`), `created_at` (`001:24`) e `merged_into_id` (`020:18`) para o predicado, choke point `UpdateWorkerProfileFieldsUseCase` (`:73`) para o gatilho.
```
