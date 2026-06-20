# Task: Integração de cadastros de prestadores com HubSpot (espelho contínuo)

**ClickUp:** https://app.clickup.com/t/86aj3yvcd · **Status:** Open→Refinada · **Board:** APP Recrutamento

> Ticket sem descrição. Escopo **RE-TRAVADO por Gabriel em 2026-06-19** (ver §9), substituindo o modelo anterior ("push único no `REGISTERED`"). **Novo modelo: SINCRONIZAÇÃO ESPELHO** — o HubSpot é um **espelho contínuo** da nossa base de prestadores, não um destino de push pontual. **ENTRADA** (cria Contact) assim que o worker tem campos mínimos (nome + email; phone se houver) — espelho precoce. **ATUALIZAÇÃO** (upsert idempotente) a CADA mudança relevante do perfil, não só de contato. **BAIXA** reflete desativação (#3, `status=DISABLED`) e merge (#5, `merged_into_id`) no HubSpot via deactivation/arquivamento do Contact. **BACKFILL** roda **DEPOIS da dedup (#5)**, limitado a `created_at >= 2026-04-01`. Schema = **`worker_crm_links`** (genérico, ADR-004). PII do Contact **aprovada**; KMS decrypt só no mapper. Sem decisão pendente bloqueante — task executável.

---

## 1. Contexto

A Enlite já capta ATs de múltiplas fontes (app, Talentum, planilhas) e unifica num perfil único (`worker-management.md`). O HubSpot aparece como CRM-alvo desde o desenho original — **mas a integração nunca foi implementada em código**: ela só existe como nó de um workflow **n8n legado** (`worker-onboarding-example.json`), o mesmo intermediário n8n que está sendo descontinuado em favor de chamadas diretas (ver `docs/features/webhooks-integrations.md`: "n8n: intermediário histórico, sendo substituído por chamada direta").

Esta task formaliza essa integração como código de primeira classe (não mais via n8n), reusando o padrão de integração outbound já consolidado para o Talentum, e **eleva o modelo de "push único" para "espelho contínuo"**: a base de prestadores do HubSpot reflete em (quase) tempo real o estado da base Enlite — entrada precoce, upsert em qualquer mudança relevante, e baixa quando o prestador é desabilitado ou mesclado.

**Há um MCP do HubSpot conectado nesta sessão (`mcp__hubspot__*`)** porém exige autenticação OAuth (`mcp__hubspot__authenticate`). **Não foi autenticado** — registrado aqui apenas como recurso disponível para exploração de schema de objetos/propriedades do HubSpot durante a implementação. Não é o canal de runtime (runtime usa API HTTP server-to-server com Private App token próprio).

---

## 2. Objetivo

Manter um **espelho contínuo** do cadastro de cada prestador (worker) num **Contact do HubSpot**, com vínculo idempotente (external_id) entre o registro Enlite e o objeto HubSpot, para que a equipe comercial/recrutamento opere o CRM sem digitação manual e sempre sobre dados atuais. O espelho cobre o ciclo de vida inteiro do prestador: **nasce** (Contact criado assim que há mínimos), **muda** (upsert a cada mudança relevante) e **sai** (desativação/merge refletidos como deactivation/arquivamento do Contact).

---

## 3. Escopo

### Dentro (espelho contínuo — TRAVADO §9)
- Provider de integração outbound HubSpot **one-way push (Enlite→HubSpot)**, plugável, nos moldes do `TalentumApiClient` + `ITalentumApiClient`. Port vendor-agnostic `ICrmProvider`.
- **ENTRADA (criar Contact) — espelho precoce:** assim que o worker atinge os **campos mínimos** (`firstName` + `email`; `phone` se houver), cria o Contact. **Não** espera `REGISTERED` nem cadastro 100% completo (diferença chave vs Ana Care — ver §6.2).
- **ATUALIZAÇÃO (upsert) — espelho contínuo:** a **CADA mudança relevante do perfil** (não só campos de contato) re-dispara o upsert. Idempotente por `email`/`external_id` via `worker_crm_links`. Mudança relevante = qualquer write que altere um campo mapeado pro Contact (nome, email, phone, `profession`, `status`, country, linkedin).
- **BAIXA (espelho completo):**
  - **Desativação (#3, `status='DISABLED'`):** refletir no HubSpot via deactivation — setar property `enlite_status='DISABLED'` **e** arquivar o Contact (`DELETE`/archive da API; o HubSpot **não** apaga no fluxo normal — semântica em §5.5).
  - **Merge (#5, `merged_into_id`):** o Contact do **duplicado** é arquivado/baixado; o Contact do **sobrevivente** é mantido (e recebe upsert com os dados consolidados).
- Mapper `worker → HubSpot Contact` **completo**: `email` + `firstname`/`lastname` + `phone` + custom properties (`enlite_profession`, `enlite_status`, e `enlite_country`/`enlite_linkedin` quando houver). PII aprovada (§9 nº 3) — campos KMS descriptografados **no mapper**, nunca em SQL.
- Persistência do vínculo (external_id HubSpot ↔ worker_id) para idempotência — tabela genérica **`worker_crm_links`** (§6).
- **Gatilho via outbox:** cada write elegível de worker enfileira um job no **`messaging_outbox`** (ou outbox dedicado de CRM); processador assíncrono chama o upsert. Reusa o precedente de trigger→outbox da mig 060 (§5.4). Core do cadastro **nunca** depende do HubSpot online.
- **BACKFILL — pós-dedup:** carga inicial **depois** da dedup (#5) ter rodado, limitada ao predicado de §6.2 (`created_at >= 2026-04-01 AND merged_into_id IS NULL AND não-conta-de-teste AND mínimos`). Em batch/throttle assíncrono (rate-limit, §8).
- Carga de credenciais via Secret Manager (prd/stg) / env (local), nos moldes do `TalentumApiClient.fromSecretManager()`.
- Teste E2E do fluxo (mock do HTTP do HubSpot — nunca chamar HubSpot real em CI).

### Fora (v1)
- **Bi-direcional / webhook de entrada do HubSpot → Enlite** — fora do v1 (§9 nº 1). Sem sync de volta. O espelho é **one-way** (Enlite é a fonte da verdade).
- Migrar/retomar o workflow n8n de HubSpot (será substituído, não reativado).
- Sincronização de pacientes/responsáveis para o HubSpot (escopo é **prestador**).
- Sincronização de **Deals/Companies/Tickets** do HubSpot (escopo é Contact — §9 nº 2).
- **Hard-delete** de Contacts no HubSpot no fluxo normal: o modelo usa **deactivation/arquivamento**, não exclusão (§5.5).
- Microservice CRM dedicado: TD-034 **não atendido** no v1 (fica em `worker-functions`, ver §5.1). Reavaliar extração só se escopo crescer.

---

## 4. Estado atual do código — EVIDÊNCIA

### 4.1 HubSpot já existe no código? — NÃO (só em doc/n8n legado)

`grep -ri hubspot` no monorepo (excluindo `node_modules`, `.git`, `playwright-report`): **0 ocorrências em código TS/JS de runtime**. Todas as ~20 ocorrências são **documentação legada + workflow n8n**:

- `worker-functions/docs/API_DOCUMENTATION.md`: "Step 2: Endereço e Localização → Dispara HubSpot CRM"
- `worker-functions/docs/AUTHORIZATION_ARCHITECTURE.md`: "[Webhook Trigger] → [Enlite API: Get Worker] → [HubSpot: Create Contact]"
- `worker-functions/docs/FULLMAP_ANALYSIS.md`: "Step 2 completo | Webhook n8n | Criar contato HubSpot | ✅ Sem código" / "[ ] Workflow Step 2 → HubSpot"
- `worker-functions/docs/progress.md`: "External Services: HubSpot (CRM)..."
- `n8n-workflows/worker-onboarding-example.json`: nó `"type": "n8n-nodes-base.hubspot"`, `"name": "Create HubSpot Contact"`, credencial `hubspotOAuth2Api`.

**Conclusão:** confirmado — nenhuma implementação de runtime. O "✅ Sem código" no FULLMAP_ANALYSIS confirma que sempre foi só n8n. Integração é greenfield no backend.

### 4.2 Padrão atual de integração outbound — EVIDÊNCIA (Talentum)

O padrão de referência já existe e é maduro. Módulo: `worker-functions/src/modules/integration/`.

| Camada | Arquivo (file) | Papel |
|---|---|---|
| Port (domain) | `src/modules/integration/domain/ITalentumApiClient.ts` | Interface do client externo (DTOs de entrada/saída) |
| Adapter (infra) | `src/modules/integration/infrastructure/TalentumApiClient.ts` | Implementação HTTP + auth + carga de secret |
| Use case (app) | `src/modules/integration/application/PublishVacancyToTalentumUseCase.ts` | Orquestra publicação outbound |
| Mapper (domain) | `src/modules/matching/domain/FunnelStageMapper.ts` (interface genérica `FunnelStageMapper<TProviderState>`) | Tradução vocabulário provider ↔ canônico Enlite |

Evidências-chave em `TalentumApiClient.ts`:
- **Factory com prioridade env→secret** (cabeçalho do arquivo, linhas 7-9): "1. Se `TALENTUM_API_EMAIL` + `TALENTUM_API_PASSWORD` em env → `fromEnv()`; 2. senão → `fromSecretManager()` (produção via GCP)".
- `static async fromSecretManager()` (linha 86): lê via `@google-cloud/secret-manager`, `accessSecretVersion`, projeto default `enlite-prd` (`process.env.GCP_PROJECT_ID ?? 'enlite-prd'`), secrets `talentum-api-email` / `talentum-api-password` (linhas 99-104).
- Constantes de endpoint externo no topo do adapter (`BASE_URL`, `ORIGIN`), nunca espalhadas.

Padrão **inbound** (webhook, caso a integração vire bi-direcional num v2) também existe: `src/modules/matching/application/ProcessTalentumPrescreening.ts` + `PartnerAuthMiddleware` + endpoint `/api/webhooks/<provider>/<event>` (`webhooks-integrations.md`).

### 4.3 Write-paths de worker + outbox/audit — onde plugar o gatilho (EVIDÊNCIA)

O espelho contínuo precisa enfileirar um job a **cada write elegível** de worker. Há **precedente canônico** de "trigger Postgres → outbox" no repo (não inventar fila do zero):

**Outbox existente — `messaging_outbox` (mig 060):**
- `worker-functions/migrations/060_talent_search_outbox_trigger.sql:6-16` — tabela `messaging_outbox(id, worker_id, template_slug, variables JSONB, status pending|sent|failed, attempts, error, created_at, processed_at)`.
- Índice parcial de polling: `idx_messaging_outbox_pending` em `(status, created_at) WHERE status='pending'` (`060:19-21`).
- **Trigger que enfileira on-write:** `fn_queue_talent_search_welcome()` + `CREATE TRIGGER trg_talent_search_welcome AFTER INSERT OR UPDATE OF data_sources ON workers FOR EACH ROW` (`060:27-49`). Insere em `messaging_outbox` via `ON CONFLICT DO NOTHING` (idempotente). **Este é exatamente o padrão a reusar para o gatilho "qualquer mudança relevante".**
- Processador outbox de referência: `src/modules/notification/infrastructure/OutboxProcessor.ts` (`BATCH_SIZE=50`, `MAX_ATTEMPTS=3`, retry) — citado na #5/#7.

**Write-paths de worker (onde a mudança relevante nasce) — `WorkerRepository.ts`:**
| Write | file:line | Relevante p/ espelho? |
|---|---|---|
| `create` (auto-cadastro) | `WorkerRepository.ts:33,38` (`INSERT INTO workers (...)`) | **ENTRADA** — dispara create do Contact assim que há mínimos |
| `updatePersonalInfo` | `WorkerRepository.ts:129` | **UPDATE** — nome/sexo/etc. (campos do Contact) |
| `updateAuthUid` | `WorkerRepository.ts:158` | UPDATE — pode mudar phone |
| `updateFromImport` / `updateImportedWorkerData` | `WorkerRepository.ts:199,236` | UPDATE — sync de import |
| `updateStatus` | `WorkerRepository.ts:214,219` (`UPDATE workers SET status=$2`) | **BAIXA/ENTRADA** — `DISABLED` → deactivation; `REGISTERED` → upsert |

**Setter de merge (BAIXA do duplicado) — dedup:**
- `WorkerDeduplicationService.ts:285` — `UPDATE workers SET merged_into_id = $1, updated_at = NOW() WHERE id = $2`. É o ponto onde o Contact do duplicado deve ser arquivado e o sobrevivente mantido.

**Tabela de audit de perfil (sinal de "mudou") — `worker_profile_changes_audit` (mig 202):**
- `worker-functions/migrations/202_worker_profile_changes_audit.sql:9-20` — `worker_profile_changes_audit(worker_id, field_name, old_value_redacted, new_value_redacted, changed_by DEFAULT 'luz', source DEFAULT 'triage', created_at)`. Audita mudanças aplicadas pelo fluxo propose/confirm da Luz (triage). **Útil como sinal de mudança**, mas hoje só cobre o canal triage — **não** todos os writes. Por isso o gatilho preferencial é o **trigger Postgres on `workers`** (cobre 100% dos writes), não o audit.

**Proposta de gatilho (§5.4):** trigger `AFTER INSERT OR UPDATE ON workers` (espelhando `trg_talent_search_welcome`) que enfileira no outbox a cada write elegível (predicado §6.2 avaliado no trigger ou no processador). Falha do HubSpot = retry no outbox, **nunca** erro no cadastro.

### 4.4 Campos de worker mapeáveis → HubSpot Contact — EVIDÊNCIA

Entidade `worker-functions/src/modules/worker/domain/Worker.ts`. Campos reais candidatos a um Contact:

| Worker (Enlite) | file:line | Candidato a propriedade HubSpot Contact |
|---|---|---|
| `email` | `Worker.ts:4` (UNIQUE NOT NULL em `001_create_workers_schema.sql:16`) | `email` (chave de dedupe natural no HubSpot) |
| `firstName` | `Worker.ts:9` | `firstname` |
| `lastName` | `Worker.ts:10` | `lastname` |
| `phone` / `whatsappPhone` | `Worker.ts:5-6` | `phone` |
| `profession` | `Worker.ts:19` | custom (`enlite_profession`) |
| `status` (`REGISTERED`/`INCOMPLETE_REGISTER`/`DISABLED`) | `Worker.ts:50` (`WorkerStatus`) | custom `enlite_status` (lifecycle + baixa) |
| `linkedinUrl` | `Worker.ts:35` | custom `enlite_linkedin` |
| `country` / `timezone` | `Worker.ts:40-41` | custom `enlite_country` |

**`created_at` confirmado:** `workers.created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()` — `001_create_workers_schema.sql:24`. **Existe** e serve de cutoff do backfill (§6.2). ✅

**Schema base** em `001_create_workers_schema.sql`: `workers(full_name, email UNIQUE, phone, status, ...)`. Cabeçalho da migration: "HIPAA Compliant: ... No PII in logs".

**ARMADILHA PII (crítica):** `full_name` (→ `first_name_encrypted`/`last_name_encrypted`, `002_add_kms_encrypted_columns.sql:8-9`) e `phone` estão sob **Google Cloud KMS** (worker-management.md §"Nomes criptografados"; uso em `WorkerRepository.ts`, `WorkerPersonalInfoRepository.ts`, `src/shared/security/BlindIndexService.ts`). Enviar pro HubSpot expõe PII em claro num serviço externo — **aprovado** em §9 nº 3, com decrypt **no mapper** (nunca em SQL). `profession` é NULL em ~68% dos workers de prod (memória `project_worker_profession_null_bug`) — mapear com tolerância.

### 4.5 Onde ficam secrets/credenciais de integração hoje — EVIDÊNCIA

**GCP Secret Manager**, criados via Terraform (estrutura) + `gcloud secrets versions add` (valores, nunca no TF):

- `terraform/environments/prd/secrets.tf` e `terraform/environments/stg/secrets.tf` — lista `automatic_secrets` inclui `talentum-api-email`, `talentum-api-password`, `internal-token-secret`. Comentário: *"Os valores dos secrets NÃO ficam no Terraform. O TF cria a estrutura; valores são populados via `gcloud secrets versions add`."*
- Leitura em runtime: `TalentumApiClient.fromSecretManager()` (`TalentumApiClient.ts:86-113`) via `@google-cloud/secret-manager`.
- Naming idêntico prd↔stg (memória `feedback_naming_prd_stg`): o secret novo deve existir nos dois projetos com o **mesmo nome** (ex: `hubspot-api-token` em `enlite-prd` E `enlite-stg`).

### 4.6 Marcador de conta de teste — **agora existe (via #5)** + heurística de email como rede

`grep -rniE "is_test|test_account|is_seed|synthetic|fixture|qa_account"` em `migrations/` e `src/modules/worker/` no estado atual do código: **nenhuma coluna/flag de conta de teste existe ainda em `workers`**. Por isso a decisão de 2026-06-19 (Gabriel) cria o marcador limpo:

- **Marcador primário — `workers.is_test BOOLEAN NOT NULL DEFAULT false`:** coluna aditiva criada na **#5** (migration **221**, `05-merge-perfis-duplicados.md` §6/§9.7), marcada/desmarcada por um **checkbox admin-only** no perfil do prestador (escopo da **#2**, `02-match-modal-perfil-prestador.md`). É o filtro de exclusão **principal**: `AND is_test = false`.
- **Rede secundária — heurística por email:** mantida para pegar **históricos ainda não marcados** (contas de teste antigas que ninguém desmarcou manualmente). Predicado de exclusão (SQL, reusável pela #7):

```sql
-- marcador limpo (primário) — workers.is_test (migration 221 da #5; toggle admin-only na #2)
AND is_test = false
-- anti-conta-de-teste (rede secundária por email, para históricos não marcados)
AND email IS NOT NULL
AND email NOT ILIKE '%+test%@%'            -- aliases de teste do dev (gabriel.g.stein+testN@gmail.com)
AND email <> 'gabriel.g.stein@gmail.com'   -- conta E2E canônica (memória project_e2e_test_account)
AND email NOT LIKE '%@enlite.import'       -- emails gerados pelo import (precedente: 021/023/028)
AND email NOT LIKE 'anacareimport_%'       -- fichas importadas Ana Care (prefixo isImportedWorker)
```

> O padrão `%@enlite.import` já é tratado como "email gerado, não real" em produção: `021_fix_dedup_cross_source.sql:43-44`, `023_encrypt_all_pii.sql:140-141`, `028_cleanup_unused_tables_and_columns.sql:112`. Reusar esse mesmo critério evita inventar regra nova. **Se a #7 e a #6 divergirem aqui, é bug** — a regra anti-teste (`is_test = false` + heurística de email) deve ser idêntica nos dois docs. **Dependência de ordem:** a coluna `is_test` precisa existir (migration 221 da #5) antes do go-live do espelho; se ainda não rodou, o predicado cai só na heurística de email temporariamente.

---

## 5. Arquitetura proposta

### 5.1 Onde mora — `worker-functions` (não MS novo, agora)

**Implementar dentro de `worker-functions/src/modules/integration/`**, reusando o padrão Talentum.

Justificativa contra extrair um MS agora (TD-034, `docs/FOLLOWUPS.md`):
- Critérios de extração do TD-034 (stack diferente, ciclo de vida independente, equipe própria, boundary claro) **não são atendidos**: mesmo stack (Node/TS), o gatilho é um evento de worker que já vive no worker-functions, sem equipe separada.
- O dado-fonte (worker, com PII sob KMS) já mora aqui; um MS novo reabriria acesso a PII criptografada — mais superfície de risco sem ganho.
- ADR-004 (`docs/adr/004-prescreening-providers-pluggable.md`) prevê um `enlite-prescreening-service` futuro, mas **CRM-sync não está mapeado como MS**. Não criar serviço especulativo.

**TD-034 não atendido (registrado, não bloqueante):** o v1 conscientemente **não** extrai microservice. Registrar em `docs/FOLLOWUPS.md` que TD-034 não foi atendido para CRM-sync por decisão de 2026-06-19. Se um v2 trouxer sync bi-direcional pesado + outros objetos (Deals/Companies), reavaliar extração de um `crm-sync-service` em repo próprio (org `enlite-health`).

### 5.2 Provider plugável (não acoplar core a "HubSpot") — port vendor-agnostic

Seguir o espírito do ADR-004 (HubSpot é UM provider, não O modelo):
- **Port genérico no domain:** `ICrmProvider` (ou `IContactSyncProvider`) com:
  - `upsertContact(input): Promise<{ externalId }>` (ENTRADA + ATUALIZAÇÃO — idempotente por email/external_id);
  - `deactivateContact(externalId): Promise<void>` (BAIXA — arquiva/baixa o Contact, §5.5).
  - **Não** chamar a interface de `IHubSpotClient` — o nome do vendor mora só no adapter.
- **Adapter concreto na infra:** `HubSpotApiClient implements ICrmProvider` (nome de vendor aceitável **no adapter**, igual `TalentumApiClient`).
- **Mapper dedicado** `WorkerToCrmContactMapper` (domain) traduz a entidade `Worker` canônica → DTO de Contact vendor-agnostic; o adapter HubSpot adapta o DTO ao payload de propriedades do HubSpot.
- Core (cadastro do worker) **não pode depender** do HubSpot estar online (princípio 5 do ADR-004): disparo assíncrono via outbox, nunca no path síncrono do save. Falha de sync = retry, não erro no cadastro.

### 5.3 Direção do sync (v1 — TRAVADO)

**One-way push: Enlite → HubSpot.** O espelho é unidirecional — **Enlite é a fonte da verdade**; o HubSpot reflete. Sem bidirecional no v1 (§9 nº 1). Se bi-direcional entrar num v2, seguir o padrão webhook `/api/webhooks/hubspot/<event>` + `PartnerAuthMiddleware` (§4.2) — não implementar agora.

### 5.4 Gatilho do espelho contínuo via outbox (TRAVADO §9 nº 4)

**Reusar o precedente trigger→outbox da mig 060** (`060_talent_search_outbox_trigger.sql:27-49`), que já enfileira em `messaging_outbox` a cada UPDATE de `workers`. Modelo:

1. **Trigger Postgres** `AFTER INSERT OR UPDATE ON workers` (espelha `trg_talent_search_welcome`) **enfileira um job de sync** no outbox a cada write elegível (predicado §6.2). `ON CONFLICT DO NOTHING` / debounce para não duplicar (§8).
2. **Processador assíncrono** (molde `OutboxProcessor.ts`) lê o outbox, restaura `loggingAls` (`traceId`, `workerId`) e chama:
   - `UpsertWorkerToCrmUseCase` para **ENTRADA/ATUALIZAÇÃO** (`upsertContact`);
   - `DeactivateWorkerCrmUseCase` para **BAIXA** quando `status='DISABLED'` (`WorkerRepository.ts:214`) ou `merged_into_id IS NOT NULL` (`WorkerDeduplicationService.ts:285`).

**Pontos de write que alimentam o gatilho** (§4.3): `create` (`:33`), `updatePersonalInfo` (`:129`), `updateAuthUid` (`:158`), `updateFromImport`/`updateImportedWorkerData` (`:199,236`), `updateStatus` (`:214`), e o merge em `WorkerDeduplicationService.ts:285`. Como o trigger é a nível de tabela, ele cobre **todos** esses paths sem instrumentar cada um — vantagem sobre enfileirar manualmente em cada use case.

> **Por que outbox e não chamada direta no use case:** (a) cobre 100% dos writes via trigger único; (b) desacopla do HubSpot estar online (retry); (c) habilita **debounce/batch** contra rate-limit (§8); (d) reusa infra existente (`OutboxProcessor`). O CLAUDE.md do worker-functions exige "LLM/integração nunca no path síncrono — sempre background".

### 5.5 Fluxo de BAIXA / deactivation no HubSpot (TRAVADO §9 nº 5)

O HubSpot **não deleta** Contact no fluxo normal — exclusão é destrutiva e perde histórico de CRM. Semântica de "deactivation" **escolhida**:

1. **Soft (property):** setar custom property `enlite_status='DISABLED'` no Contact (via `upsertContact`). Mantém o registro visível no CRM, marcado como inativo — comercial vê que o prestador saiu sem perder o histórico.
2. **Archive (API):** **arquivar** o Contact via `DELETE /crm/v3/objects/contacts/{id}` da API do HubSpot, que **arquiva** (recuperável por 90 dias / restaurável no portal), **não** faz hard-delete. Tira da lista ativa.

**Decisão escolhida:** aplicar **os dois** — primeiro `enlite_status='DISABLED'` (mantém auditável), depois `archive` (tira da operação ativa). **Por quê:** o property preserva a razão da baixa para o comercial e mantém o link `worker_crm_links` válido para reconciliação; o archive evita que o Contact "morto" polua listas/segmentações ativas, sem perder reversibilidade (archive do HubSpot é recuperável; hard-delete não). Isso é coerente com o princípio Enlite de **soft-merge reversível** (#5 não faz hard-delete; usa `merged_into_id`).

- **Desativação (#3):** worker `status='DISABLED'` → `enlite_status='DISABLED'` + archive do Contact.
- **Merge (#5):** Contact do **duplicado** → archive (e `enlite_status` marcando baixa por merge, ex. valor `MERGED`); Contact do **sobrevivente** → upsert com dados consolidados, **mantido**. O `worker_crm_links` do duplicado pode ser marcado/limpo; o do sobrevivente persiste.

### 5.6 Backfill — pós-dedup (TRAVADO §9 nº 6)

O backfill da carga inicial roda **DEPOIS da dedup (#5)** ter executado, **nunca antes**. Razão (ordem dura): se backfillar antes da cura, o espelho nasce já com os duplicados de prod (~146 grupos por phone, memória `project_workers_duplication_state`) refletidos como Contacts duplicados no HubSpot — lixo no espelho desde o dia zero. Rodar a dedup primeiro garante que só sobreviventes (`merged_into_id IS NULL`) entram. Seletor = predicado de §6.2. Batch/throttle assíncrono (rate-limit, §8). O cutoff `created_at >= 2026-04-01` limita a carga ao período relevante (espelho não precisa de fichas antigas/mortas).

---

## 6. Schema / migrations

### 6.1 Tabela de mapping — `worker_crm_links` (TRAVADA, ADR-004)

Idempotência do upsert e da baixa exige guardar o vínculo worker ↔ Contact HubSpot. **Tabela genérica `worker_crm_links`** (vendor-agnostic, alinhada ao ADR-004 — provider plugável). **Não** poluir `workers` com colunas de vendor.

```sql
-- worker-functions/migrations/<NNN>_create_worker_crm_links.sql  (aditiva)
CREATE TABLE worker_crm_links (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  worker_id    UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  provider     VARCHAR(50)  NOT NULL,            -- ex: 'hubspot' (vendor mora aqui, não em workers)
  external_id  VARCHAR(255) NOT NULL,            -- Contact id no provider
  synced_at    TIMESTAMPTZ,                      -- último upsert/baixa bem-sucedido
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT worker_crm_links_uq UNIQUE (worker_id, provider)
);
```

Migration **aditiva** (regra do projeto: nunca dropar sem deprecação), prefixo numérico sequencial em `worker-functions/migrations/` (próximo livre após `215`). Idempotência: dedupe natural no HubSpot por `email`; chave local pela `UNIQUE(worker_id, provider)` (insert-or-update do `external_id`). O `synced_at` registra o último espelhamento e habilita reconciliação/debounce.

> **Decisão de schema (perguntar antes de criar — memória `feedback_schema_decisions`):** uma coluna opcional `enlite_status` espelhada ou `last_event` em `worker_crm_links` **não** é criada no v1 a menos que a observabilidade exija — o estado canônico mora em `workers.status`; o link guarda só o vínculo. Registrar como follow-up se necessário.

### 6.2 Predicado de elegibilidade do espelho/backfill (TRAVADO) — EVIDÊNCIA

**O HubSpot é menos estrito que a Ana Care (#7).** O mínimo para entrar no espelho HubSpot é **só nome + email** (espelho precoce), **não** cadastro 100% completo. Diferença documentada:

| Critério | HubSpot (#6 — esta task) | Ana Care (#7) |
|---|---|---|
| Mínimo de campos | `firstName` + `email` (phone se houver) | cadastro **100% completo** (`fn_worker_missing_fields(id)='[]'`) |
| Status exigido | **nenhum** (entra antes de `REGISTERED`) | `status='REGISTERED'` |
| Cutoff temporal | `created_at >= 2026-04-01` | (sem cutoff temporal próprio; usa completude) |
| Anti-merge | `merged_into_id IS NULL` | `merged_into_id IS NULL` |
| Anti-teste | `is_test = false` **+ mesma heurística** de email como rede (§4.6) | `is_test = false` **+ mesma heurística** de email como rede (§4.6) |

**Predicado canônico de elegibilidade — HubSpot (ENTRADA + backfill):**

```sql
SELECT id FROM workers
WHERE created_at >= '2026-04-01'                  -- cutoff (workers.created_at: 001_create_workers_schema.sql:24)
  AND merged_into_id IS NULL                      -- só sobreviventes da dedup (020_analytics_and_dedup.sql; setado em WorkerDeduplicationService.ts:285)
  AND is_test = false                             -- marcador limpo de conta de teste (workers.is_test, migration 221 da #5; toggle admin-only na #2)
  AND first_name_encrypted IS NOT NULL            -- "nome" mínimo (002_add_kms_encrypted_columns.sql:8) — decrypt vem depois, no mapper
  AND email IS NOT NULL                           -- "email" mínimo (UNIQUE NOT NULL: 001_create_workers_schema.sql:16)
  -- anti-conta-de-teste — REDE para históricos não marcados ainda (heurística por email; §4.6; MESMA regra da #7):
  AND email NOT ILIKE '%+test%@%'
  AND email <> 'gabriel.g.stein@gmail.com'
  AND email NOT LIKE '%@enlite.import'
  AND email NOT LIKE 'anacareimport_%';
```

- **Evidência dos campos do predicado:**
  - `created_at` existe e é NOT NULL — `001_create_workers_schema.sql:24` (✅ verificado).
  - `merged_into_id` — `020_analytics_and_dedup.sql`; é setado no merge em `WorkerDeduplicationService.ts:285`.
  - `email` UNIQUE NOT NULL — `001_create_workers_schema.sql:16`.
  - `first_name_encrypted` (proxy de "tem nome") — `002_add_kms_encrypted_columns.sql:8`.
  - **`is_test` (marcador limpo)** — coluna `workers.is_test BOOLEAN NOT NULL DEFAULT false`, criada na **#5** (migration 221, `05-merge-perfis-duplicados.md` §6/§9.7); marcada/desmarcada pelo checkbox admin-only da **#2**. É o filtro primário anti-teste.
  - Anti-teste por email (`%@enlite.import` etc.) — **rede secundária** para históricos ainda não marcados; precedente em `021:43-44`, `023:140-141`, `028:112`.
- **Diferença vs #7 (Ana Care):** a Ana Care usa `status='REGISTERED' AND merged_into_id IS NULL AND fn_worker_missing_fields(id)='[]'::jsonb` (cadastro 100% completo). O HubSpot **não** exige `REGISTERED` nem `fn_worker_missing_fields='[]'` — só nome+email — porque o espelho é **precoce** (queremos o Contact no CRM assim que o prestador aparece, mesmo incompleto). O cutoff temporal (`>= 2026-04-01`) é específico do HubSpot.
- **`fn_worker_missing_fields(id)`** (SSOT de completude, `migrations/212_relax_dni_verso.sql:101-224`) **não** entra no predicado HubSpot — é o que torna o HubSpot menos estrito. Citado só para contraste com #7.

Workers que não satisfazem o predicado ficam fora do espelho até baterem os mínimos (entram pelo gatilho incremental, §5.4).

---

## 7. Critérios de aceite

1. Existe port `ICrmProvider` (domain) + adapter `HubSpotApiClient` (infra); o nome "HubSpot" não aparece em `domain/` nem em `application/` (grep como evidência).
2. Credenciais lidas via Secret Manager em prd/stg (`fromSecretManager`), env em local; secret existe em `enlite-prd` E `enlite-stg` com **nome idêntico**; **nenhum token commitado** (grep limpo + `.env.example` atualizado).
3. Sync é **assíncrono via outbox** — uma falha do HubSpot não quebra nem atrasa o cadastro do worker (teste cobrindo o caminho de falha; job fica `failed`/retry no outbox, cadastro segue).
4. **ENTRADA precoce:** worker novo com **só nome+email** (sem `REGISTERED`) gera Contact no HubSpot (teste com worker `INCOMPLETE_REGISTER` → Contact criado).
5. **ATUALIZAÇÃO contínua:** qualquer write que altere campo mapeado (nome/email/phone/profession/status/country/linkedin) re-dispara o upsert; writes irrelevantes não disparam (teste).
6. **Upsert idempotente:** rodar o sync 2× para o mesmo worker **não** cria Contact duplicado (1 registro em `worker_crm_links`, mesmo `external_id`).
7. **BAIXA por desativação (#3):** worker `status='DISABLED'` → Contact recebe `enlite_status='DISABLED'` + é arquivado (`deactivateContact`); teste cobrindo a transição.
8. **BAIXA por merge (#5):** após merge, o Contact do **duplicado** é arquivado e o do **sobrevivente** mantido/atualizado; nenhum Contact órfão duplicado fica ativo (teste).
9. **Backfill pós-dedup:** o seletor usa exatamente o predicado de §6.2 (cutoff `2026-04-01` + `merged_into_id IS NULL` + `is_test = false` + mínimos nome/email + anti-teste por email como rede); roda **depois** da dedup; em batch com throttle/backoff; workers fora do predicado não entram (teste com worker pré-abril, com `is_test = true`, e com conta de teste por email → nenhum sincroniza).
10. **PII no mapper:** os campos sob KMS são descriptografados **no mapper** (camada app), nunca em SQL (grep: nenhuma query lê coluna `*_encrypted` direto pro payload). Nenhum log expõe o payload (só `workerId`/`traceId`/`externalId`).
11. Direção é **one-way** (Enlite→HubSpot): não existe rota/handler que escreva no banco a partir de evento do HubSpot (grep limpo).
12. Migration aditiva cria `worker_crm_links` com `UNIQUE(worker_id, provider)`; nenhuma coluna de vendor adicionada em `workers`.
13. Gatilho via trigger Postgres `AFTER INSERT OR UPDATE ON workers` → outbox (molde mig 060); processador restaura `loggingAls`; debounce/batch contra rate-limit.
14. Teste E2E mocka o HTTP do HubSpot (nunca chama real em CI), com screenshot assertion se houver superfície de UI.
15. Logging via `@shared/logging` (sem `console.*`), com `workerId`/`traceId`.

---

## 8. Riscos & armadilhas

- **Lixo no espelho (ordem dedup→backfill — CRÍTICO):** se o backfill rodar **antes** da dedup (#5), os ~146 grupos de duplicados de prod (memória `project_workers_duplication_state`) viram Contacts duplicados no HubSpot já no dia zero. **Travado:** backfill **só depois** da dedup (§5.6, §9 nº 6). O predicado (`merged_into_id IS NULL`) é a segunda linha de defesa.
- **Espelho contínuo = muitas chamadas → rate-limit do HubSpot:** a API tem limites por conta (~100–190 req/10s no tier padrão). Upsert a cada write relevante pode explodir chamadas (ex: import em massa toca milhares de workers). **Mitigações obrigatórias:** (a) **debounce** no outbox — coalescer múltiplos writes do mesmo `worker_id` pendentes num único upsert antes de processar; (b) **batch** — usar o batch API do HubSpot (`/crm/v3/objects/contacts/batch/upsert`, até 100 por chamada) no processador; (c) **backoff** exponencial em `429`. Outra razão para o gatilho ser outbox, não chamada síncrona.
- **Deactivation mal-feita perde dado de CRM:** hard-delete no HubSpot é irreversível. **Travado:** usar archive (recuperável) + property `enlite_status`, nunca `DELETE` permanente (§5.5). Coerente com soft-merge reversível da #5.
- **PII saindo para serviço externo (APROVADO, com cuidado):** nome/telefone/email em claro foi **aprovado** (§9 nº 3). Campos sob KMS descriptografados **no mapper**, nunca em SQL. Não logar o payload (schema "HIPAA Compliant: No PII in logs"). O espelho precoce (nome+email, sem gate de cadastro completo) significa que **mais** workers vão pro HubSpot que na Ana Care — o filtro anti-teste (§4.6) é o que segura conta sintética de fora.
- **Marcador de conta de teste — agora existe (via #5):** a flag `workers.is_test` é criada na #5 (migration 221) e marcada pelo checkbox admin-only da #2. O predicado usa `is_test = false` como filtro primário **+** a heurística por email como rede para históricos não marcados (§4.6). A heurística por email sozinha é frágil (depende de naming) — por isso o marcador limpo. **Ordem:** a coluna precisa existir antes do go-live do espelho. **Manter idêntico ao da #7** (mesmo `is_test = false` + mesma heurística).
- **`profession` NULL em ~68%** (memória `project_worker_profession_null_bug`): mapear com tolerância a campo ausente; não falhar o sync por campo vazio.
- **Ordem de eventos no espelho:** um worker pode ser criado e desabilitado em sequência rápida; o outbox deve preservar ordem por `worker_id` (ou reconciliar pelo estado final em `workers`) para não deixar o Contact "ativo" depois de uma baixa. Reconciliar sempre contra o estado atual da row, não contra o delta.
- **n8n legado:** desativar o nó HubSpot do n8n quando o código entrar, para não duplicar Contacts (dois caminhos escrevendo no mesmo CRM).
- **Naming prd↔stg:** esquecer o secret no stg quebra staging silenciosamente.
- **Multi-repo (TD-034) não atendido no v1:** decisão consciente (§5.1) de ficar em `worker-functions`. Registrar follow-up.

---

## 9. Decisões TRAVADAS (2026-06-19, Gabriel) — modelo ESPELHO

Modelo **re-travado**: de "push único no `REGISTERED`" para **sincronização espelho contínua**. Não reabrir sem nova decisão explícita. Pendência residual = provisionar o token (dependência externa, §11).

1. **Direção — TRAVADO:** **one-way push Enlite→HubSpot** (espelho; Enlite é a fonte da verdade). Sem bidirecional no v1. (§5.3)
2. **Objeto HubSpot — TRAVADO:** **Contact apenas**. Sem Company/Deal/Ticket no v1.
3. **ENTRADA (espelho precoce) — TRAVADO:** criar Contact **assim que o worker tem campos mínimos** = `firstName` + `email` (`phone` se houver). **Não** esperar `REGISTERED` nem cadastro completo. Predicado em §6.2.
4. **ATUALIZAÇÃO (espelho contínuo) — TRAVADO:** upsert a **cada mudança relevante do perfil** (não só contato), idempotente por `email`/`external_id`. **Gatilho via outbox** (trigger Postgres on `workers` → `messaging_outbox`, molde mig 060 — §5.4). Nunca no path síncrono.
5. **BAIXA (espelho completo) — TRAVADO:** desativação (#3, `status='DISABLED'`) → `enlite_status='DISABLED'` + **archive** do Contact; merge (#5, `merged_into_id`) → archive do Contact do **duplicado**, mantém o **sobrevivente**. Semântica de deactivation = property + archive (recuperável), **nunca hard-delete** (§5.5).
6. **BACKFILL — TRAVADO (pós-dedup):** carga inicial roda **DEPOIS da dedup (#5)**; predicado `created_at >= 2026-04-01 AND merged_into_id IS NULL AND is_test = false AND <mínimos nome+email> AND <anti-conta-de-teste por email como rede>` (§6.2). O `is_test = false` (coluna criada na #5, migration 221; toggle admin-only na #2) é o filtro de teste **primário**; a heurística de email fica como rede para históricos não marcados. Em batch/throttle assíncrono.
7. **PII / campos — TRAVADO (APROVADO):** Contact **completo** — `email` + `firstname`/`lastname` + `phone` + custom `enlite_profession`/`enlite_status` (+ `enlite_country`/`enlite_linkedin` quando houver). Campos sob KMS descriptografados **no mapper**, **nunca em SQL**. Custom properties a criar no portal: `enlite_status`, `enlite_profession` (e `enlite_country`/`enlite_linkedin` se enviadas).
8. **Schema — TRAVADO:** tabela genérica **`worker_crm_links` (`worker_id`, `provider`, `external_id`, `synced_at`)**, ADR-004. Não poluir `workers` com colunas de vendor. DDL em §6.1.
9. **Arquitetura — TRAVADO:** reusar o padrão outbound do Talentum (`ITalentumApiClient`/`TalentumApiClient` + `fromSecretManager`) **dentro de `worker-functions/src/modules/integration/`**, port vendor-agnostic `ICrmProvider`. **SEM microservice novo no v1** — TD-034 registrado como não atendido (§5.1).
10. **Secret — TRAVADO:** **Private App token** do HubSpot no GCP Secret Manager, nome **IDÊNTICO em `enlite-prd` e `enlite-stg`**. Provisionar é dependência externa (§11).

---

## 10. Estimativa

**Estimativa (espelho contínuo: entrada precoce + upsert em qualquer mudança + deactivation + backfill pós-dedup):** ~5-7 dias de dev backend.
- Port `ICrmProvider` (upsert + deactivate) + adapter `HubSpotApiClient` + factory env/secret: ~1d (espelha `TalentumApiClient`).
- Mapper `Worker→CrmContact` (decrypt KMS no mapper) + use cases `UpsertWorkerToCrmUseCase` + `DeactivateWorkerCrmUseCase`: ~1.5d.
- Gatilho: trigger Postgres on `workers` + processador outbox (debounce/batch/backoff) — molde mig 060 + `OutboxProcessor`: ~1.5d.
- Migration `worker_crm_links` + idempotência do upsert: ~0.5d.
- Backfill pós-dedup (seletor §6.2 + batch/throttle): ~0.5-1d.
- Testes (unit + E2E com HTTP mockado: entrada/update/baixa/idempotência/backfill) + lint/type-check: ~1d.

---

## 11. Dependências externas (não-código — bloqueiam GO-LIVE, não o início do dev)

A task é **executável agora** — o dev começa e testa com mock/env local. Pendências externas (PO/infra) só bloqueiam o **go-live em prd/stg**:

1. **[EXTERNA — PO/infra] Provisionar o Private App token do HubSpot** e gravá-lo no GCP Secret Manager com **nome IDÊNTICO em `enlite-prd` e `enlite-stg`** (ex.: `hubspot-api-token`) via `gcloud secrets versions add`. Adicionar à lista `automatic_secrets` em `terraform/environments/prd/secrets.tf` **e** `terraform/environments/stg/secrets.tf` (valor nunca no TF).
2. **[EXTERNA — PO/ops] Criar as custom properties no portal HubSpot:** `enlite_status` (precisa de valores como `DISABLED`/`MERGED` para a baixa), `enlite_profession` (e `enlite_country`/`enlite_linkedin` se enviadas). O mapper depende desses nomes existirem.
3. **[DEPENDÊNCIA DE ORDEM — interna] Dedup (#5) executada em prod antes do backfill** (§5.6/§9 nº 6). O backfill **não** deve rodar antes da cura de duplicados, senão o espelho nasce sujo.
4. **[EXTERNA — ops] Desativar o nó HubSpot do n8n legado** no go-live, para não duplicar Contacts.

**Dependência interna (não bloqueante):** parecer do Architect sobre a migration `worker_crm_links` e sobre o trigger on `workers` (impacto em writes de alto volume) antes de criar — schema já travado, parecer é confirmação.
