# Sprint — MCP Server Interno (worker-functions ↔ triage-service)

> **Status:** PR 1 em implementação (Backend Dev)
> **Owner:** Gabriel Stein
> **Início:** 2026-05-20
> **Estimativa total:** ~12.5 dias de dev + ~5 dias de review (~3 semanas calendário)

---

## TL;DR

Construir um MCP (Model Context Protocol) server interno no `worker-functions`, exposto exclusivamente para o `triage-service` (NestJS, microservice de atendimento via WhatsApp). Substitui o canal HTTP+axios atual por uma interface contratual padronizada, restrita a tráfego VPC interno, com auditoria estruturada e whitelist de campos editáveis aderente à LGPD.

**Não é refactor:** o triage-service já chama 3 endpoints do worker-functions em produção. Dois deles **não existem** no worker-functions hoje (regressão silenciosa). O PR 1 tampa esse bug ANTES de qualquer trabalho de MCP.

---

## 1. Motivação

### 1.1 Bug crítico de produção (urgente)

O `triage-service` em produção chama 3 endpoints HTTP no `worker-functions`:

| Endpoint | Status no worker-functions |
|---|---|
| `GET /api/admin/workers/by-phone?phone=...` | ✅ existe |
| `GET /api/admin/workers/:id/available-vacancies` | ❌ **não existe** — triage quebra |
| `GET /api/admin/workers/:id/current-interview` | ❌ **não existe** — triage quebra |

Sem ação, o agente de IA do triage não consegue responder corretamente perguntas como "quais minhas vagas?" e "quando é minha entrevista?" — funcionalidades centrais do canal WhatsApp.

### 1.2 Canal estruturado (médio prazo)

Hoje o triage fala com worker-functions via `axios + Bearer ENLITE_API_KEY`. Funciona, mas:
- Sem contrato formal de capabilities (shape do payload é convenção implícita)
- Sem auditoria padronizada de o-que-quem-fez-com-quem
- Sem restrição de campos editáveis (qualquer field do worker pode ser PATCH-ado)
- Tráfego sai pela internet pública mesmo entre serviços do mesmo projeto GCP
- Sem versionamento de schema

MCP resolve isso com tipos formais, ferramentas (tools) descobríveis, auditoria built-in via spec, e transport stateless adequado pra Cloud Run.

### 1.3 Compliance LGPD

A Enlite opera ATs (Acompanhantes Terapêuticos) — dados em escopo são PII regular do contratado MEI (CPF, RG, endereço, doc profissional). Não é dado sensível LGPD (saúde/biometria/raça/etc. são dados do paciente, fora do escopo MCP). Mas a operação cruza o canal **WhatsApp**, que tem riscos específicos: vazamento por device pessoal, sequestro de conta via troca de SIM, ausência de criptografia controlada.

Mitigação documentada na seção 5 (Compliance).

---

## 2. Decisões fechadas

Lista cronológica das decisões tomadas durante o refinamento, com o "porquê" pra evitar re-discussão futura.

### 2.1 Cloud Run service separado (vs route adicional)

**Decidido:** O MCP roda como **Cloud Run service separado** (`worker-functions-mcp`), mesma imagem Docker do `worker-functions`, com env `MCP_ONLY=true` que faz o `index.ts` montar apenas rotas `/mcp/*` e healthcheck. Service tem `--ingress=internal`.

**Por que:**
- O `worker-functions` atual recebe tráfego público (frontend admin, n8n, webhooks Twilio/Chatwoot, Cloud Tasks). **Não pode** virar internal-only.
- Cloud Run service separado isola completamente o blast radius do MCP.
- Mesma imagem = sem duplicação de código nem CI.
- Min-instances=0 nos dois services = custo extra trivial (paga só por request).

**Alternativas rejeitadas:**
- (B) Route `/mcp/v1` no worker-functions existente com auth fortalecida — mantém superfície pública desnecessária.
- (C) Cloud Run job — não cabe (jobs são batch one-shot, MCP precisa de server long-lived).

### 2.2 Restrição a microserviços internos via 3 camadas de defesa

**Decidido:** O MCP service só aceita tráfego de service principals internos autorizados.

| Camada | Mecanismo |
|---|---|
| 1. Network ingress | `--ingress=internal` no Cloud Run MCP — só VPC + serviços GCP do mesmo projeto |
| 2. IAM invoker | `roles/run.invoker` concedido ao service account do triage-service (remover `allUsers`) |
| 3. App-level auth | Bearer token validado contra Secret Manager (multi-version, ver §2.7) + allowlist de capabilities por principal |

**Por que defesa em profundidade:**
- Camada 1 sozinha vaza se um Cloud Function/Run **comprometido** no mesmo projeto for usado como pivot. Camada 2 limita pra apenas o service account autorizado.
- Camada 2 sozinha vaza se IAM for misconfigurado (drift, fix temporário). Camada 3 ainda exige token.
- Cada camada é independente — falha de uma não compromete as outras.

**Implicação operacional:** triage-service precisa de **Direct VPC Egress** (forma nova/recomendada desde 2024, GA) ou Serverless VPC Connector pra sair pela VPC. Hoje sai pela internet. Mudança no deploy do triage no PR 5.

### 2.3 Streamable HTTP stateless (vs SSE / stateful)

**Decidido:** Transport **Streamable HTTP** em modo **stateless** (cada request independente, sem sessions).

**Por que:**
- SSE foi depreciado pelo spec MCP em Nov/2025 em favor de Streamable HTTP.
- Cloud Run **explicitamente suporta** Streamable HTTP. Não suporta stdio. Suporta SSE mas com limitações de scaling.
- Sessions stateful + Cloud Run autoscaling = problema sério (sessions presas a instância). O roadmap 2026 do MCP ainda está resolvendo isso.
- Stateless = funciona com `min-instances=0` e autoscaling horizontal sem workaround.

**Trade-off aceito:** Se um dia precisar streaming progress (LLM tool com saída longa), terá que migrar pra stateful. Não é caso atual — capabilities são CRUD-ish.

### 2.4 Auth middleware híbrido (vs API key dedicada)

**Decidido:** Criar `requireStaffOrApiKey()` em `AuthMiddleware`. Ordem de tentativa: **API key primeiro** (lookup O(1) na `apiKeyStore` em memória), Firebase ID token depois.

**Por que ordem invertida (ressalva do Architect):**
- A ordem natural seria Firebase primeiro (consistente com `requireStaff` atual). Mas isso faria toda chamada do triage gerar erro Firebase no Cloud Logging antes de cair no fallback. Volume: centenas/hora.
- Inverter: API key primeiro é lookup em memória, sem I/O, sem erro logado. Só tenta Firebase se token não está no apiKeyStore (caso = usuário admin real).
- Custo zero, ruído zero.

**Por que híbrido (vs trocar triage pra `X-Api-Key`):**
- Mantém escopo do PR 1 confinado ao worker-functions.
- Triage continua mandando `Authorization: Bearer ...` (não mexer no que funciona).
- Migração pra MCP no PR 7 vai mudar o transport inteiro — não vale otimizar HTTP hoje.

### 2.5 Endpoint B `available-vacancies` inclui workers em `PLACED`

**Decidido:** Filtro do endpoint B é `application_funnel_stage NOT IN ('REJECTED', 'NOT_QUALIFIED', 'RECHAZADO')`. Workers em `PLACED` **aparecem** na lista.

**Por que:**
- AT em `PLACED` está operando numa vaga ativa. Quando ele pergunta no WhatsApp "quais minhas vagas?", ele espera ver a vaga onde está.
- UX-wise faz mais sentido que "available" inclua "currently active" do que excluir.
- Fácil reverter no futuro: 1 linha de SQL muda o filtro.

**Trade-off:** semanticamente "available vacancies" é ambíguo (vagas disponíveis pra processo vs vagas envolvidas com o AT). Decisão consciente de seguir a interpretação UX, não a literal.

### 2.6 Timezone via `job_postings.timezone` (vs hardcode)

**Decidido:** Adicionar coluna `timezone TEXT NOT NULL` em `job_postings` (migration `180_add_timezone_to_job_postings.sql`). Backfill via `country`:
```sql
'AR' → 'America/Argentina/Buenos_Aires'
'BR' → 'America/Sao_Paulo'
```

**Por que essa tabela e não outra:**
- `workers.timezone` já existe mas **todos os dados estão `'UTC'`** (default nunca foi populado). Usar levaria a horários errados.
- Semanticamente: entrevista é propriedade da **vaga** (acontece num local físico associado ao paciente), não do worker (que pode atender remotamente de outro fuso).
- `interview_slots.job_posting_id` é a FK direta — derivação imediata.

**Por que não migrar `slot_date+slot_time` pra `TIMESTAMPTZ`:**
- Refactor estrutural pesado: afeta `InterviewSlotRepository`, `ScheduleInterviewsUseCase`, frontend `ScheduleInterviewModal`, E2Es de agendamento.
- É a solução correta a longo prazo, mas merece PR próprio. Registrar como TD em [FOLLOWUPS.md](FOLLOWUPS.md).

**Extensibilidade:** Util `countryToTimezone(country)` no código, com map. Adicionar México/Colômbia/Chile no futuro = 1 linha no map + 1 linha no CHECK de `job_postings.country`. Sem refactor.

### 2.7 Rotação de token Secret Manager (2 versions ativas)

**Decidido:** Secret `mcp-internal-token-triage` com até 2 versions `ENABLED` simultâneas. App lê todas as versions ativas a cada 60s e mantém um `Set<string>` em memória de tokens válidos. Auth aceita match em qualquer um.

**Fluxo de rotação operacional:**
1. Criar v2 enabled (v1 segue enabled)
2. Aguardar ≥60s (TTL do cache) — todas as instâncias agora aceitam v1+v2
3. Triage troca env e redeploy
4. Aguardar 24h (margem)
5. Desabilitar v1

**Por que cache 60s em memória:**
- GCP suporta múltiplas versions ativas — leitura constante é cara
- Cache 60s + autoscaling = trivial overhead (1 RPC/min/instância)
- Cloud Run native secret mount **não serve** (só monta uma version por vez)

### 2.8 Whitelist de campos LGPD-aderente em `profile.update`

**Decidido:** Lista exata na seção 5 (Compliance). Resumo: PII regular do contratado é editável; phone (canal WhatsApp em si), status interno, dados sensíveis LGPD são vetados.

**Por que phone está vetado explicitamente (mesmo sendo PII regular):**
- Atualizar phone via WhatsApp é circular: o canal usa o phone como identidade
- Sequestro de conta SIM/WhatsApp pode permitir atacante mudar o phone do alvo
- Phone update deve passar por flow administrativo, não bot

### 2.9 SSRF defesa em profundidade no endpoint D

**Decidido:** Antes de qualquer `fetch(url)` no endpoint `documents/ingest-from-url`:
1. Validar hostname contra `ALLOWED_MEDIA_HOSTS` env (allowlist)
2. Resolver IP via DNS
3. Rejeitar se IP for: RFC 1918 (10/8, 172.16/12, 192.168/16), link-local (169.254/16, incluindo metadata server GCP `169.254.169.254`), loopback (127/8), IPv6 equivalentes

**Por que dupla:**
- Allowlist sozinha não basta: host comprometido (ou DNS rebinding) pode redirecionar pra IP interno
- Bloqueio de IP sozinho não basta: atacante pode achar URL de host externo "público" que aponta pra ranges sensíveis
- Combinação cobre os dois vetores
- Metadata server `169.254.169.254` no GCP retorna service account tokens — vetor crítico

### 2.10 Não emitir domain event `worker.document.uploaded` neste sprint

**Decidido:** Endpoint D não emite event. Registrar TD em [FOLLOWUPS.md](FOLLOWUPS.md) pro PR que implementar notificações pós-upload.

**Por que:**
- Não há subscriber definido pra esse event
- Event sem consumer = débito técnico puro
- Adicionar depois é trivial (chamada de `eventBus.publish` no use case)

---

## 3. Arquitetura

### 3.1 Desenho de deploy

```
┌─────────────────────────────────────────────────────────────────┐
│  PROJETO enlite-prd                                              │
│                                                                   │
│  Cloud Run: worker-functions          (ingress=all, público)     │
│  ─────────────────────────────────────────────────────────       │
│  ← Frontend (admin)                                               │
│  ← n8n                                                            │
│  ← Webhooks Twilio/Chatwoot                                       │
│  ← Cloud Tasks / Pub/Sub                                          │
│  Rotas: /api/*, /webhooks/*, /health                              │
│                                                                   │
│  Cloud Run: worker-functions-mcp      (ingress=internal)    NOVO  │
│  ─────────────────────────────────────────────────────────       │
│  ← triage-service (via Direct VPC Egress)                         │
│  Rotas: /mcp/v1 apenas                                            │
│                                                                   │
│  Mesma imagem Docker; diferença = env MCP_ENABLED=true            │
│  Mesma conexão DB (Cloud SQL via private IP)                      │
│                                                                   │
│  Secret Manager: internal-token-secret (multi-version)            │
└─────────────────────────────────────────────────────────────────┘
```

**Estratégia de deploy por ambiente (PR 5):**

- **prd:** deploy via `.github/workflows/backend-mcp-prd.yml` (gcloud run deploy, workflow_run trigger após backend-prd.yml). Decisão de não-IaC alinhada com pattern existente — prd inteiro não está sob Terraform (ver TD-010 e TD-032 em FOLLOWUPS.md).
- **stg:** deploy via `terraform apply` para criar o service skeleton (`terraform/environments/stg/cloud_run.tf`, módulo `cloud_run_worker_functions_mcp`) + workflow `backend-mcp-stg.yml` popula image e env vars (mesmo pattern do `cloud_run_worker_functions` stg).

**Smoke test:** `worker-functions/scripts/mcp-smoke-test.sh` — executar manualmente após deploy ou via pipeline de validação pós-deploy.

### 3.2 Estrutura de módulo (worker-functions)

Seguindo o pattern de `src/modules/case/` (único módulo já migrado pro pattern DDD em `src/modules/`):

```
worker-functions/src/modules/mcp/
├── application/
│   ├── capabilities/                       # 6 capabilities, 1 arquivo cada
│   ├── IngestDocumentFromUrlUseCase.ts     # download + SSRF + upload GCS
│   ├── ListAvailableVacanciesForWorkerUseCase.ts
│   ├── GetCurrentInterviewUseCase.ts
│   └── CapabilityRegistry.ts               # registra tools no McpServer
├── domain/
│   ├── ServicePrincipal.ts                 # name, allowedCapabilities[]
│   └── McpAuditEvent.ts
├── infrastructure/
│   ├── ServicePrincipalSecretManagerRepo.ts  # cache 60s multi-version
│   ├── ExternalMediaDownloader.ts            # host+IP allowlist
│   └── McpAuditLogger.ts                     # Pino + PII redaction
└── interfaces/
    ├── middleware/
    │   ├── requireServicePrincipal.ts
    │   └── enforceOnBehalfOf.ts              # header X-On-Behalf-Of-Worker-Id == args.workerId
    └── routes/
        └── mcpRoutes.ts                       # /mcp/v1 Streamable HTTP stateless
```

### 3.3 Capabilities expostas pelo MCP

| Capability | Read/Write | Use case base |
|---|---|---|
| `worker.profile.get(workerId)` | R | `GetWorkerProgressUseCase` (existente) |
| `worker.profile.update(workerId, fields)` | W | `SavePersonalInfoUseCase` + Zod whitelist |
| `worker.documents.list(workerId)` | R | `WorkerDocumentsRepository.findByWorkerId` |
| `worker.documents.upload(workerId, type, mediaUrl)` | W | `IngestDocumentFromUrlUseCase` (novo) |
| `worker.vacancies.list(workerId)` | R | `ListAvailableVacanciesForWorkerUseCase` (novo) |
| `worker.interview.get(workerId)` | R | `GetCurrentInterviewUseCase` (novo) |

### 3.4 Modelo de autorização (on-behalf-of)

Pra cada tool call:

1. **Auth de service principal:** Bearer token no header `Authorization` → match contra `Set<string>` em memória (refresh 60s do Secret Manager).
2. **Validação dupla de workerId:**
   - Header `X-On-Behalf-Of-Worker-Id` define o worker alvo (source of truth)
   - Argumento `workerId` do tool call (obrigatório no schema Zod) deve casar com header
   - Divergência → 400 imediato (anti-confused-deputy)
3. **Allowlist de capabilities por principal:**
   - `ServicePrincipal` (ex: `triage-service`) tem `allowedCapabilities[]` definido em Secret Manager
   - Capability fora da allowlist → 403
4. **Audit log obrigatório:**
   - Cada call gera log Pino com: `principal`, `onBehalfOfWorkerId`, `capability`, `argsRedacted`, `outcome`, `latencyMs`
   - Redaction de PII validada por unit test

---

## 4. Plano de 8 PRs

| # | Título | Estado | Dias | PR |
|---|---|---|---|---|
| 1 | Use cases que faltam em prod + middleware híbrido + migration timezone | ✅ | 3.5 | [#24](https://github.com/gabrielgstein-dev/enlite-monorepo/pull/24) |
| 2 | Domain + infra do MCP (sem rotas) | ✅ | 2 | [#25](https://github.com/gabrielgstein-dev/enlite-monorepo/pull/25) |
| 3 | Middleware MCP + auth de principal | ✅ | 1 | [#26](https://github.com/gabrielgstein-dev/enlite-monorepo/pull/26) |
| 4 | MCP server stateless + capabilities de read | ✅ | 2 | [#27](https://github.com/gabrielgstein-dev/enlite-monorepo/pull/27) |
| 5 | Deploy MCP em Cloud Run separado (terraform + workflows) | ✅ | 1.5 | [#28](https://github.com/gabrielgstein-dev/enlite-monorepo/pull/28) |
| 6 | Capabilities de write (`profile.update` Zod whitelist + `documents.upload`) | ✅ | 2 | [#29](https://github.com/gabrielgstein-dev/enlite-monorepo/pull/29) |
| 7 | Triage-service migra de HTTP pra MCP client | ✅ | 1.5 | [enlite-health/triage-service#1](https://github.com/enlite-health/triage-service/pull/1) |
| 8 | Cleanup HTTP antigo no worker-functions — **fase 1 (deprecation)** | ✅ | 0.5 | TBD |
| 8b | Cleanup HTTP — **fase 2 (delete físico)** | ⏳ aguardando PR 7 estável em prod ≥ 7d | 0.5 | — |

**Total entregue:** PRs 1-8a (todos os escopos). PR 8b condicionado a estabilização em prod.

### 4.x Decisão arquitetural — triage-service em repo separado

Durante a execução do PR 7, ficou claro que o `triage-service/` (microservice NestJS independente) merece **repo próprio** em vez de viver dentro do monorepo. Razões:
- Stack diferente (NestJS vs Express direto do worker-functions)
- Ciclo de vida e deploy independentes
- Boundary claro entre serviços
- Onboarding mais simples pra novos devs no domínio de triagem

**Repo:** [github.com/enlite-health/triage-service](https://github.com/enlite-health/triage-service)

### 4.y PR 8 em duas fases

**Fase 1 (✅ neste PR):** Deprecation markers (`@deprecated` JSDoc) no `WorkerContextController` e em `workerContextRoutes.ts` apontando que os 3 endpoints HTTP serão removidos quando o triage migrar 100% pro canal MCP. Código continua funcionando — apenas sinaliza intenção de remoção.

**Fase 2 (futuro PR, condicionado):** Remoção física dos endpoints HTTP + use cases relacionados. Critérios pra disparar:
1. `triage-service` rodar com `USE_MCP_GATEWAY=true` em produção ≥ 7 dias sem incidentes
2. `grep -r '/api/admin/workers/.*/(current-interview|available-vacancies|documents/ingest-from-url)' enlite-frontend/ n8n-workflows/ worker-functions/scripts/` retornar zero referências
3. Confirmar via Cloud Logging que os endpoints HTTP tiveram zero hits nos últimos 7 dias

Quando o critério for atingido, abrir PR removendo:
- `WorkerContextController`, `workerContextRoutes`, montagem no `index.ts`
- Use cases que ficarem órfãos (verificar dependentes antes — alguns podem ser usados internamente)
- `ENLITE_API_KEYS` do triage env (token vira só via MCP secret manager principal)

### 4.1 PR 1 — Escopo detalhado (em implementação)

**Objetivo:** Tampar regressão de produção + estabelecer base contratual pra MCP.

**Arquivos criados/modificados:**

| Caminho | Operação | Razão |
|---|---|---|
| `worker-functions/migrations/180_add_timezone_to_job_postings.sql` | criar | Multi-país sem hardcode (§2.6) |
| `worker-functions/src/modules/case/domain/CountryTimezone.ts` (ou shared) | criar | Util `countryToTimezone(country)` |
| `worker-functions/src/modules/matching/application/GetCurrentInterviewUseCase.ts` | criar | Endpoint que faltava |
| `worker-functions/src/modules/matching/application/ListAvailableVacanciesForWorkerUseCase.ts` | criar | Endpoint que faltava |
| `worker-functions/src/modules/worker/application/IngestDocumentFromUrlUseCase.ts` | criar | Capability nova |
| `worker-functions/src/modules/worker/infrastructure/GCSStorageService.ts` | editar | Adicionar `uploadBuffer()` |
| `worker-functions/src/modules/worker/infrastructure/ExternalMediaDownloader.ts` | criar | SSRF defense dupla (§2.9) |
| `worker-functions/src/modules/identity/interfaces/middleware/AuthMiddleware.ts` | editar | `requireStaffOrApiKey()` (API key first) |
| `worker-functions/src/modules/matching/infrastructure/EncuadreQueryRepository.ts` | editar | Adicionar `findUpcomingByWorkerId` |
| `worker-functions/src/modules/worker/infrastructure/WorkerApplicationRepository.ts` | editar | Adicionar `findActiveByWorkerId` |
| `worker-functions/src/modules/matching/interfaces/controllers/WorkerContextController.ts` | criar | 3 handlers |
| `worker-functions/src/modules/matching/interfaces/routes/workerContextRoutes.ts` | criar | Registra 3 endpoints |
| Tests unit/integration correspondentes | criar | Cobertura obrigatória |

**Ressalvas do Architect (obrigatórias):**

1. **Auth ordem invertida:** API key primeiro (lookup O(1)), Firebase depois — evita poluir Cloud Logging
2. **Migration em `job_postings.timezone`** (não `workers.timezone` — dados zerados)
3. **SSRF dupla:** allowlist hostname + bloqueio IP RFC 1918/link-local/metadata GCP
4. **Query endpoint C** parte de `encuadres WHERE worker_id = $1`, JOIN `interview_slots` (slot pode ter `max_capacity > 1`)

**Critérios de aceite:**
- [ ] 3 endpoints respondendo com Bearer atual do triage (sem mudar triage)
- [ ] Migration aplicada com backfill correto pros 2 países atuais (AR/BR)
- [ ] Unit tests + integration tests via supertest cobrindo happy path + edge cases
- [ ] Zero `any`, zero `console.*` no código novo
- [ ] `externalUrl` redactado em logs (sem query string)
- [ ] Lint + type-check + E2E verde antes do commit

### 4.2 PRs 2-8 — Escopo resumido

PR 2 (Domain + infra MCP), PR 3 (Middleware MCP), PR 4 (Server + reads), PR 5 (Deploy), PR 6 (Writes), PR 7 (Triage migra), PR 8 (Cleanup) — detalhados no histórico do refinamento. Cada um vai passar pelo fluxo PO → Architect → Backend Dev → QA → PO antes de implementar.

---

## 5. Compliance LGPD / PII

### 5.1 Base legal do tratamento

| Categoria | Base legal LGPD | Justificativa |
|---|---|---|
| PII regular do AT (nome, CPF, RG, email, endereço, MEI) | Execução de contrato (art. 7º, V) | Necessário pra cumprir contrato MEI |
| Documentos (CV, antecedentes, MEI cert, etc.) | Execução de contrato + obrigação legal | Exigência regulatória pro contrato com paciente |
| Dados de operação (status, role interno) | Legítimo interesse do controlador | Operação interna |
| **NÃO TRATAMOS:** saúde, biometria, raça, religião, opinião política, vida sexual | N/A | Não coletado do AT (dados do paciente são de outro escopo, fora do MCP) |

### 5.2 Whitelist final de campos editáveis via `worker.profile.update`

| Campo | Editável via WhatsApp/MCP | Justificativa |
|---|---|---|
| `firstName`, `lastName` | ✅ | PII regular |
| `email` | ✅ | PII regular |
| `cpf` | ✅ | PII regular; base legal = contrato MEI |
| `rg` | ✅ | PII regular |
| `address.street`, `number`, `complement`, `neighborhood`, `city`, `zipCode`, `state` | ✅ | Cadastral |
| `meiNumber`, `meiCnpj` | ✅ | Operacional |
| `birthDate` | ✅ | PII regular |
| **`phone` / `whatsapp`** | ❌ | Veto explícito do user. Risco: sequestro de conta SIM permite atacante redirecionar o canal pra phone próprio |
| **`criminal_record` (texto)** | ❌ | Dado sensível por interpretação ANPD. Upload via doc OK; texto livre não |
| **`status`, `role`, `internal_notes`, `riskScore`, flags internas** | ❌ | Decisão de negócio/admin, fora do escopo do worker |
| **`bankAccount`, `pix`** | ❌ por enquanto | Vetar até definir verificação anti-fraude explícita |

Schema Zod no `WorkerProfileUpdateCapability` valida a whitelist exatamente. Tentativa de update fora da whitelist → 400.

### 5.3 Log redaction obrigatória

| Campo | Como aparece em log |
|---|---|
| `cpf`, `rg` | Apenas `last4` (ex: `***123-45`) ou hash SHA256 |
| `email` | Domínio preservado, local part hash (`x@gmail.com` → `***@gmail.com`) |
| `birthDate` | Apenas ano |
| Endereço completo | Apenas `city/state` |
| `mediaUrl` (Twilio/Chatwoot) | Sem query string (tokens TTL) |

Validado por unit test do `McpAuditLogger`.

### 5.4 Princípios alinhados a HIPAA (mesmo não sendo aplicável diretamente)

- **Minimum necessary:** capability retorna apenas o necessário pra resposta (não dump completo do worker)
- **Audit log:** todo acesso a PII fica registrado com principal/onBehalfOf/timestamp
- **Acesso baseado em propósito:** capability allowlist por principal (triage só pode chamar capabilities que precisa)

---

## 6. Riscos e mitigações

| # | Risco | Severidade | Mitigação |
|---|---|---|---|
| R1 | Migração Direct VPC Egress requer infra; DevOps pode estar bloqueado | Média | Validar com infra antes do PR 5 |
| R2 | SSRF no endpoint D pode dar acesso a metadata server GCP | Alta | Defesa dupla (§2.9); pen test antes do PR 5 |
| R3 | Coexistência HTTP+MCP por 1-2 semanas (PRs 5-8) pode causar drift | Média | PR 6 só toca MCP; HTTP fica congelado até cleanup |
| R4 | Stateless trap: streaming progress não funciona | Baixa | Não é caso atual; migrar pra stateful se aparecer |
| R5 | Cache de tokens em memória dá +200ms latência no primeiro request da instância | Baixa | Aceito (Cloud Run autoscaling natural) |
| R6 | Twilio media URL tem TTL ~1h — token expira durante flow longo | Baixa | Triage chama upload em <1min do recebimento |
| R7 | `job_postings.timezone` precisa ser passado adiante quando novo país for adicionado | Média | Documentar no util `countryToTimezone()` + CHECK constraint |

---

## 7. Decisões pendentes (acompanhar)

Nenhuma bloqueante no PR 1. Pra rodadas futuras:

- [ ] Migrar `slot_date+slot_time` pra `TIMESTAMPTZ` (TD-XXX em [FOLLOWUPS.md](FOLLOWUPS.md))
- [ ] Domain event `worker.document.uploaded` (TD-XXX em [FOLLOWUPS.md](FOLLOWUPS.md))
- [ ] Popular `workers.timezone` corretamente no signup (TD-XXX)
- [ ] Definir critério se `bankAccount/pix` será editável via WhatsApp com 2FA

---

## 8. Referências

- [Plano original do sprint](#) — gerado em conversa com Claude 2026-05-20
- [Architect parecer PR 1](#) — agentId `a8ee3b0ac2a6bb0da`
- [PO refinamento PR 1](#) — agentId `a07712ac75bfa7f75`
- Memórias correlatas:
  - [Migração de módulos](../../.claude/projects/-Users-gabrielstein-dev-projects-enlite-infra/memory/project_module_migration_state.md)
  - [Sprint vacancies refactor](SPRINT_VACANCIES_REFACTOR.md)
  - [FOLLOWUPS](FOLLOWUPS.md)
- Fontes externas:
  - [The 2026 MCP Roadmap](https://blog.modelcontextprotocol.io/posts/2026-mcp-roadmap/)
  - [Host MCP servers on Cloud Run — Google Cloud](https://docs.cloud.google.com/run/docs/host-mcp-servers)
  - [MCP Authorization Patterns for Upstream API Calls — Solo.io](https://www.solo.io/blog/mcp-authorization-patterns-for-upstream-api-calls)
  - [Dados Sensíveis no WhatsApp Business em 2026: LGPD](https://www.socialhub.pro/blog/dados-sensiveis-whatsapp-lgpd-saude-financeiro-juridico/)
  - [LGPD nas Relações de Trabalho — Barbieri Advogados](https://www.barbieriadvogados.com/barbieri-advogados-lgpd-nas-relacoes-de-trabalho/)
  - [Secret Manager rotation — Google Cloud](https://cloud.google.com/secret-manager/docs/secret-rotation)

---

## 9. Changelog do documento

| Data | Autor | Mudança |
|---|---|---|
| 2026-05-20 | Gabriel + Claude | Versão inicial do sprint após refinamento PO + parecer Architect |
