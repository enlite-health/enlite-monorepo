# Arquitetura — Enlite Worker Functions

> Documento vivo. Toda decisão arquitetural significativa deve gerar uma atualização aqui.
> Referenciado pelo `CLAUDE.md` como fonte principal de arquitetura.

---

## Sumário

1. [Visão Geral](#1-visão-geral)
2. [Camadas (Clean Architecture)](#2-camadas-clean-architecture)
3. [Banco de Dados — Schema e Regras](#3-banco-de-dados--schema-e-regras)
4. [Sistema de Roles (EnliteRole)](#4-sistema-de-roles-enliterole)
5. [Autenticação e Autorização](#5-autenticação-e-autorização)
6. [Pipeline de Importação](#6-pipeline-de-importação)
7. [Repositórios](#7-repositórios)
8. [Serviços LLM](#8-serviços-llm)
9. [Organização de Arquivos](#9-organização-de-arquivos)
10. [Testes](#10-testes)
11. [Padrões HTTP](#11-padrões-http)

---

## 1. Visão Geral

Backend de recrutamento de profissionais de saúde (Acompanhantes Terapêuticos). Gerencia o ciclo completo: importação de dados externos → seleção → matching → operação diária.

Fontes de dados: **Talentum**, **ClickUp**, ~~**Planilla Operativa**~~ (DESCONTINUADA em 2026-05-23), **Ana Care** — via CLI ou endpoint HTTP.

---

## 2. Camadas (Clean Architecture)

```
domain/          → entidades, interfaces, ports (IRepository, IFileConverter)
                   Nunca importa de application/ ou infrastructure/

application/     → use cases — orquestram domain + infrastructure
                   Nunca importa de interfaces/

infrastructure/  → repositórios, serviços externos, converters, scripts
                   Implementa as interfaces definidas em domain/

interfaces/      → controllers HTTP e rotas Express
                   Nunca contém lógica de negócio — só input/output
```

**Regra de dependência:** as setas só apontam para dentro. `interfaces → application → domain`. Nunca ao contrário.

---

## 3. Banco de Dados — Schema e Regras

### Tabela `users` — base de todos os usuários

```sql
users (
  firebase_uid  VARCHAR(128) PRIMARY KEY,
  email         VARCHAR(255) UNIQUE NOT NULL,
  display_name  VARCHAR(255),
  photo_url     TEXT,
  role          VARCHAR(50) NOT NULL
                CHECK (role IN ('worker','admin','manager','client','support','recruiter','community_manager')),
  is_active     BOOLEAN DEFAULT true,
  email_verified BOOLEAN DEFAULT false,
  created_at    TIMESTAMPTZ,
  updated_at    TIMESTAMPTZ
)
```

### Quando criar uma extension table

**Regra:** Extension tables só existem quando um role precisa de **colunas que não cabem em `users`**. O simples fato de um role existir **não justifica** uma extension table.

| Role | Extension table? | Motivo |
|---|---|---|
| `worker` | ✅ `workers_extension` | phone, fullmap_data, service_areas — dados operacionais extensos |
| `admin` | ✅ `admins_extension` | access_level, must_change_password, department, permissions |
| `recruiter` | ❌ nenhuma | apenas o campo `role` em `users` é suficiente |
| `community_manager` | ❌ nenhuma | apenas o campo `role` em `users` é suficiente |
| `manager` | ✅ `managers_extension` | department, team_name, reports_to |
| `client` | ✅ `clients_extension` | phone, address, payment_method |
| `support` | ✅ `support_extension` | specialization, department, is_available |

### Funções SQL helper

Definidas em `migrations/006_create_user_helper_functions.sql` (atualizadas em 101/102):

- `create_user_with_role(uid, email, name, photo, role, role_data)` — insere em `users` e na extension table correspondente (ou apenas em `users` se não há extension table para o role)
- `get_user_complete(uid)` — retorna JSON com dados base + extension por role
- `change_user_role(uid, new_role, role_data)` — migra o role preservando dados antigos
- `list_users_by_role(role, limit, offset)` — paginado

### Migrações

- Uma migration = uma mudança lógica. Nunca agrupar alterações não relacionadas.
- Migrações são aplicadas via `node scripts/run-migrations-docker.js` (local) e `cloud-sql-proxy + psql` (produção).
- A tabela `schema_migrations` rastreia o que já foi aplicado (local/docker).
- Produção usa GCP Cloud SQL (`enlite-prd:southamerica-west1:enlite-ar-db`).
- Nunca dropar coluna/tabela em produção sem período de deprecação (renomear para `_deprecated_YYYYMMDD` primeiro).
- Colunas `llm_*` sempre com migration própria e `DEFAULT NULL`.

---

## 4. Sistema de Roles (EnliteRole)

Roles que concedem acesso ao painel admin — definidos em `src/domain/entities/EnliteRole.ts`:

```typescript
enum EnliteRole {
  ADMIN             = 'admin',           // acesso total, gerencia usuários e configuração
  RECRUITER         = 'recruiter',       // recrutamento, vagas, onboarding de ATs
  COMMUNITY_MANAGER = 'community_manager', // comunidade AT, grupos, suporte operacional
}
```

**Provisionamento automático:** qualquer `@enlite.health` que logar via Google recebe `RECRUITER` por padrão. Promoção para `ADMIN` é manual via painel.

**Middleware disponíveis:**
- `requireAuth()` — só verifica que o token Firebase é válido
- `requireStaff()` — exige `admin | recruiter | community_manager`
- `requireAdmin()` — exige `admin` exclusivamente

**Regra de uso no `/api/admin/auth/profile`:** usa `requireAuth()` (não `requireAdmin()`) para permitir o auto-provisionamento na primeira entrada. O use case faz a checagem de domínio.

---

## 5. Autenticação e Autorização

### MultiAuthService (`src/infrastructure/services/MultiAuthService.ts`)

Suporta múltiplas estratégias detectadas pelos headers:

| Header | Tipo | Usado por |
|---|---|---|
| `Authorization: Bearer <token>` | Firebase ID Token | Frontend React / admin |
| `X-Api-Key: enlite_xxx` | API Key | n8n, SaaS externos |
| `X-Google-Id-Token` | Google ID Token | alternativo |
| `X-Internal-Token` | Token interno | service-to-service (não implementado) |

**Extração de roles:** para Firebase ID tokens, a claim `role` é lida do token decodificado (`decodedToken.role`). No modo emulator, lida do payload JWT diretamente (`payload.role`).

### Fluxo de auto-provisionamento admin

```
1. Usuário clica Google Login no /admin/login
2. Firebase popup → retorna user com email @enlite.health
3. Frontend: checa domínio → chama GET /api/admin/auth/profile
4. Backend: requireAuth() → token válido
5. GetAdminProfileUseCase: busca no DB → não encontra
6. autoProvisionIfEligible(): cria registro em users com role='recruiter'
7. Seta Firebase custom claim { role: 'recruiter' }
8. Retorna AdminRecord
9. Frontend: chama forceRefreshToken() → token agora tem role: recruiter
10. Próximas chamadas passam por requireStaff() normalmente
```

---

## 6. Pipeline de Importação

Detalhamento completo em `docs/IMPLEMENTATION_RULES.md`. Resumo dos invariantes:

**Estrutura:**
```
Buffer/Arquivo
  → ConverterRegistry.detect() → IFileConverter correto
  → converter.parse()          → DTO[] tipados
  → Repositório.upsert()       → DB
  → postImport()               → linking + sync
```

**Invariantes absolutos:**
- Cada fonte tem seu próprio Converter (`TalentumConverter`, `ClickUpConverter`, `PlanilhaOperativaConverter`, `AnaCareConverter`)
- `canHandle()` fica no Converter, nunca `if/else` no Importer
- Toda normalização em `import-utils.ts` — nunca inline em Converters ou repositórios
- LLM nunca no path síncrono de import — sempre background após upsert
- CLI e HTTP usam o mesmo `importBuffer()` — `onProgress` é o único ponto de divergência
- Erros de linha nunca param o import — acumulados em `ImportJob.errorDetails`

---

## 7. Repositórios

- Um arquivo por repositório em `src/infrastructure/repositories/`
- `OperationalRepositories.ts` é legado — não adicionar classes novas lá
- Repositórios recebem DTOs já normalizados — nunca normalizam internamente
- `upsert()` sempre retorna `{ entity, created: boolean }`
- Todo `ON CONFLICT ... DO UPDATE` tem comentário explicando a estratégia de cada campo

---

## 8. Serviços LLM

- Nunca chamados no path síncrono de import
- `RATE_LIMIT_MS` como constante nomeada em todo serviço LLM
- Campos `llm_*` sempre `nullable` — o sistema nunca falha por ausência de enriquecimento
- Prompts são constantes nomeadas no topo do arquivo, nunca strings inline

---

## 9. Organização de Arquivos

```
src/
  domain/
    entities/         → tipos de negócio, DTOs
    ports/            → interfaces (IRepository, IFileConverter, IAuthenticationService)
    interfaces/       → tipos compartilhados (Auth, etc.)
    shared/           → utilitários de domínio (Result)

  application/
    use-cases/        → um arquivo por use case

  infrastructure/
    converters/       → um arquivo por fonte de dados
    repositories/     → um arquivo por repositório
    services/         → serviços externos (Firebase, GCS, LLM)
    database/         → DatabaseConnection
    scripts/          → import-utils.ts e helpers

  interfaces/
    controllers/      → um arquivo por controller
    middleware/       → AuthMiddleware
    routes/           → rotas agrupadas por domínio (destino futuro — hoje em index.ts)

scripts/              → entrypoints CLI, máx 80 linhas, zero lógica de negócio
migrations/           → arquivos SQL numerados sequencialmente
```

**Limite de linhas:** máx 400 por arquivo de implementação.

---

## 10. Testes

- Testes unitários co-locados com o arquivo (`*.test.ts`)
- Testes de repositório nunca mocam o banco — usam banco real de teste
- Testes E2E em `e2e/` — criados/atualizados sempre que controller, route, use case ou converter é alterado
- Modos E2E: `npm run test:e2e:docker` (padrão local), `npm run test:e2e:full` (emulator), `npm run test:e2e` (CI)

---

## 11. Padrões HTTP

- `POST /api/import/upload` → sempre `202 Accepted` com `{ importJobId, statusUrl }`, nunca aguarda processamento
- `GET /api/import/status/:id` → status do ImportJob
- Respostas de sucesso: `{ success: true, data: T }`
- Respostas de erro: `{ success: false, error: string }`

---

## 12. Secrets obrigatórios por ambiente (Secret Manager)

Cada ambiente GCP (`enlite-prd`, `enlite-stg`, futuros) **precisa** ter os secrets abaixo criados no Secret Manager + IAM binding `roles/secretmanager.secretAccessor` na service account do Cloud Run (`enlite-functions-sa@<projeto>.iam.gserviceaccount.com`). Esquecer qualquer um desses **quebra fluxos críticos** em produção.

| Secret | Tipo | Usado por |
|---|---|---|
| `enlite-ar-db-password` | senha do user `enlite_app` | runtime + scripts de migration |
| `worker-trgm-hmac-key` | **32 bytes binários random** | `BlindIndexService` (busca de workers por nome) |
| `internal-token-secret` | HMAC interno | tokens internos do backend |
| `clickup-api-token`, `clickup-webhook-secret` | tokens ClickUp | integração ClickUp |
| `talentum-api-email`, `talentum-api-password` | credenciais Talentum | sync de workers |
| `groq-api-key`, `sendgrid-api-key`, `twilio-auth-token`, `short-io-api-token` | tokens de terceiros | features específicas |

### `worker-trgm-hmac-key` — observações importantes

- A chave gera HMAC-SHA256 dos trigrams do nome do worker (CipherSweet pattern). Cada ambiente **deve ter chave própria** — nunca copiar staging → prod.
- Se faltar: a busca por nome retorna lista vazia (falha silenciosa no fallback do controller). Foi exatamente o que aconteceu em prod entre 2026-05-09 e 2026-05-13.
- **Não pode ser rotacionada** sem reprocessar o blind index de todos os workers via `backfill-name-trgm-bidx.ts`.
- Criar: `openssl rand 32 | gcloud secrets create worker-trgm-hmac-key --replication-policy=automatic --project=<env> --data-file=-`
- Binding: `gcloud secrets add-iam-policy-binding worker-trgm-hmac-key --member="serviceAccount:enlite-functions-sa@<env>.iam.gserviceaccount.com" --role="roles/secretmanager.secretAccessor" --project=<env>`

### Checklist de provisionamento de novo ambiente

1. Criar todos os secrets da tabela acima
2. IAM binding `secretAccessor` pra `enlite-functions-sa` em cada secret
3. Rodar `npx ts-node scripts/backfill-name-trgm-bidx.ts` se já houver workers com `first_name_encrypted` populado
4. Rodar `npx ts-node scripts/backfill-worker-names-from-encuadres.ts` (one-shot; planilha não recebe novos dados) se houver workers sem nome encriptado (usa `encuadres.worker_raw_name` + Firebase `displayName`)
5. Validar visualmente no painel admin que a busca por nome retorna resultados
