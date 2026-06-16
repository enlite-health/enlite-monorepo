# Permissões / Controle de Acesso — Plano-Mestre

> **Status:** PLANEJAMENTO (feature aberta) · Criado 2026-06-15
> **Objetivo da pasta:** `docs/features/permissions/` guarda esta feature do
> planejamento → arquitetura → implementação → testes (100% cobertura) → fechada.
> Uma feature só é **fechada** quando tem: docs de design, implementação, E2E +
> integração + unit a 100%, e este plano marcado como concluído.

## 1. Objetivo

Construir o sistema de **controle de acesso** da Enlite — usuários, grupos de
permissão, matriz recurso×ação, atributos (empresa/tenant, departamento, status,
cargo) — com qualidade de fundação: feito **completo agora** pra não precisar
voltar. Inclui a base de **multi-tenant** e **Cerbos** como engine.

> **ESCOPO (Gabriel, 2026-06-15):** o ABAC vale **apenas para o painel `/admin`**.
> A app do worker/prestador está FORA. Implementar **modularizado** (PermissionGate
> plugável) pra que aplicar permissão a um novo componente depois seja trivial.

## 2. Decisões TRAVADAS (definidas com o Gabriel em 2026-06-15)

| # | Decisão | Detalhe |
|---|---|---|
| D1 | **Multi-tenant real — infra + backend agora** | Arquitetura e implementação completas de infra/backend para isolamento por empresa/tenant. Base sólida pra futuro. Frontend e isolamento full do sistema podem vir em fases, mas a fundação backend é agora. |
| D2 | **Cerbos é o engine de autorização** | Reverte a decisão do roadmap legado (que era DB-driven). Inclui resolver o que impede excelência (ex: bug `roles:[]`) — nada de atalho; bug que trava vai pro roadmap com resolução garantida. |
| D3 | **Matriz recurso×ação montada do zero** | Pensada já para Cerbos, e **fácil/legível/visualmente simples** para propagar quando surgirem novas telas. Roadmap legado serve de rascunho de referência, não de verdade final. |
| D4 | **Modular monolith pronto pra extração** | Construir em `worker-functions/src/modules/identity/permissions/`. Extração pro `permission-service` (MS #8, schema `iam`) acontece depois — ports já isolam o engine. |
| D5 | **EnliteRole permanece como camada base** | `admin/recruiter/community_manager` define "quem é staff". Grupos/permissões são a camada ACIMA ("o que cada staff faz"). Fluxo: `requireStaff()` → `requirePermission(resource, action)`. |
| D6 | **Qualidade de fechamento: 100% cobertura** | Unit + integração + E2E. Domínio/aplicação/apresentação a 100%; infra/bootstrap ≥80% (ver agente `qa`). Sem isso a feature não fecha. |

## 3. Pivôs vs. roadmap legado

O `_legacy-roadmap-db-driven-single-tenant.md` (recuperado do git, 1443 linhas) é
um esqueleto maduro de schema/use-cases/testes, **mas** foi escrito com 2 escolhas
que agora invertemos:

- **DB-driven → Cerbos** (D2). A justificativa legada ("grupos dinâmicos via UI
  não combinam com policy-as-code") **continua válida e é o problema central a
  resolver**: precisamos da ponte que traduz grupos do banco → políticas Cerbos
  via Admin API. Isso é design da Fase 1.
- **Single-tenant → multi-tenant** (D1). O schema legado não tem `tenant_id`.
  Remodelar tabelas com tenant desde a migration.

Reutilizar do legado: estrutura de tabelas (`permission_groups`, `group_permissions`,
`user_groups`, `permission_audit_log`), is_system logic, lista-base de ~30
permissions, cenários de teste, middleware shape.

## 4. Modelo conceitual

**Matriz recurso × ação** (a "planilha"): linhas = recursos (worker, vacancy,
patient, match, messaging, analytics, user_management, permission_management…),
colunas = ações (read, write, delete, export, send, execute…). Cada célula = 1
permission. Um **Grupo** = conjunto de células marcadas. Usuário ↔ grupos (N:N);
permissões efetivas = união dos grupos.

**4 camadas de controle (arquitetura-alvo — `EnLite_Arquitetura_Implementacao.md`):**
SCREEN (acesso à tela) · COMPONENT (seção) · FIELD (campo, mascaramento PII) ·
DATA (ABAC puro — depende de atributos do contexto). Multi-tenant e
"só vê do seu departamento/zona" vivem na camada DATA.

**Atributos (eixos ABAC):** tenant/empresa (D1, eixo de isolamento), departamento
(single + multi-valor), status (Ativo / Em admissão), cargo.

## 5. Fases

- **Fase 0 — Preparação de ambiente** (pré-requisito, não-ABAC)
  - Triagem das 45 mudanças no working tree → feature branch → PR → lint+type-check+E2E → merge na main (= deploy prod, com cuidado).
  - Reset `stage` → `main` (seguro, verificado) + deploy enlite-stg.
  - Validar staging OK.
- **Fase 1 — Arquitetura & design detalhado** (Architect + PO)
  - Parecer técnico: estratégia multi-tenant (onde `tenant_id`, como propaga no JWT/queries), ponte Cerbos↔grupos-dinâmicos, modelo de dados final (schema `iam`-ready), matriz recurso×ação v1.
  - Resolver as dúvidas abertas (§6). ADR(s) para D1/D2.
- **Fase 2 — Schema/migrations** (multi-tenant + permissões + audit).
- **Fase 3 — Backend** (módulo `identity/permissions`: domain/application/infra/interface, engine Cerbos + adapter, middleware `requirePermission`, estender perfil/JWT).
- **Fase 4 — Frontend** (store, hooks DB→Cerbos-aware, PermissionGate nas telas, telas de gestão de grupos — quando o design existir).
- **Fase 5 — Testes** (unit + integração + E2E + visual; 100% cobertura).
- **Fase 6 — Fechamento** (docs finais, este plano → concluído).

## 6. Dúvidas abertas a resolver na Fase 1 (gate — não codar antes)

1. **Estratégia multi-tenant:** modelo de tenant (tabela `tenants`?), onde mora
   `tenant_id` (todas as tabelas de domínio ou só permissões nesta fase?), como
   propaga (JWT claim → middleware → filtro de query / RLS Postgres?). D1 diz
   infra+backend completos — definir o alcance exato desta fase.
2. **Ponte Cerbos ↔ grupos dinâmicos:** como grupos criados na UI viram políticas
   Cerbos (Admin API sync? derivar principal policies dos claims?). É o nó central
   de D2.
3. **Matriz recurso×ação v1:** lista final de recursos e ações (rebuild do zero,
   referência no legado), categorizada pra propagação visual fácil.
4. **Super Admin:** novo role no enum ou gate `permission_management:write`? Edição
   de worker fica gated por ele (ver `project_no_worker_edit_intentional`).
5. **Status "Em admissão":** enum em `users.status` (não é booleano `is_active`).
6. **Departamento multi-valor:** scoping de acesso (ABAC, precisa tabela) ou só
   metadado?
7. **Herança/precedência:** união simples vs precedência (`user > org > role`,
   como a arquitetura-alvo define).
8. **Audit log:** logar todo check ou só DENY (volume em prod)?

## 7. Definition of Done — política ZERO-FOLLOWUP

Esta feature **não gera followup/débito**. Toda imperfeição dentro do escopo é
**resolvida + testada** dentro do build, não registrada como TD pra depois.
Itens que SÃO escopo desta feature e DEVEM ser resolvidos aqui (não viram TD):

- **Bug `CerbosAuthorizationRepository` `roles:[]`** — corrigido + coberto por E2E com Cerbos real, antes de qualquer deploy com Cerbos.
- **Troca allow-all → engine real (fail-closed)** — rollout gated por flag, rota a rota, com E2E de DENY por rota antes de ligar.
- **Deprecação de `is_active`** — substituído por `status` enum com trigger de sync, testado.
- **Split de `AuthMiddleware.ts` (>400 linhas)** — feito no mesmo PR, não adiado.
- **`PermissionGate` muda de API** — todos os callers migrados no mesmo escopo (grep obrigatório).

**Gate de fechamento:** 100% cobertura domain/application/presentation, ≥80% infra;
zero `.skip`/`.only`; zero TODO no código de produção; zero entrada nova em
`FOLLOWUPS.md` originada por esta feature. Se aparecer um bug que impede a
excelência, ele é **resolvido**, não catalogado.

## 8. Roadmap de evolução (fases COMPROMETIDAS — não são followup)

Capacidades **deliberadamente fora do escopo desta feature** (decisão D-P5), mas
**planejadas e comprometidas** — vivem aqui como roadmap, não como débito solto em
FOLLOWUPS. Cada uma vira seu próprio ciclo planejamento→impl→teste quando ativada.

- **Fase 7 — Isolamento full de domínio por tenant** (ref. ADR-005). `tenant_id` +
  filtro `WHERE tenant_id=$1` em workers/job_postings/patients, gated por
  `MULTI_TENANT_DOMAIN_ISOLATION`. **Gatilho:** incorporação do 2º tenant. Inclui
  interceptor/lint que exige o filtro pra evitar vazamento silencioso.
- **Fase 8 — ABAC camada DATA** (ref. ADR-006). Atributos `department[]`/`zone[]` no
  `principal.attr` pra regras "só vê do meu departamento/zona". **Gatilho:** caso de
  uso real + sign-off da semântica de departamento (D-P3).

> FOLLOWUPS.md TD-052 e DP-003 apontam pra cá e estão marcados **"Planejado
> (roadmap)"**, não como débito aberto.

## 9. Referências

- `docs/features/permissions/figma-reference.md` — telas extraídas do Figma.
- `docs/features/permissions/_legacy-roadmap-db-driven-single-tenant.md` — esqueleto histórico (superseded).
- `architecture/EnLite_Bloco8_Autenticacao.md`, `EnLite_Bloco6_Microservicos.md`, `EnLite_Arquitetura_Implementacao.md` — arquitetura-alvo (permission-service, schema `iam`, Cerbos, JWT claims).
