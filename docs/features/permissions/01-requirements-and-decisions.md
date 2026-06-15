# Permissões — Requisitos & Decisões de Produto (Fase 1)

> Parecer do PO técnico · 2026-06-15 · insumo do plano-mestre [00-master-plan.md](00-master-plan.md)
> Fontes: `EnliteRole.ts`, `index.ts` (requireAdmin/requireStaff), `migrations/003`,
> `figma-reference.md`, `_legacy-roadmap-*.md`, arquitetura-alvo (Bloco6/9-13, F03-F05), FOLLOWUPS.

## Atores e papéis

`EnliteRole` (`worker-functions/src/modules/identity/domain/EnliteRole.ts`) — 3 roles ativos:
- `admin` — full access, gestão de usuários e config da plataforma
- `recruiter` — recrutamento, vagas, onboarding (default `@enlite.health`)
- `community_manager` — comunidade AT, grupos, suporte operacional

Hoje os gates são grossos (`index.ts`): `requireAdmin()` em 6 endpoints (users CRUD, role, reset-password, dedup/run); `requireStaff()` em todo o resto.

| Ator | Necessidades |
|---|---|
| Admin | Tudo do Recruiter + gestão de usuários + dedup + gerir grupos |
| Recruiter | Vagas, workers, funil, entrevistas, recrutamento, analytics, upload, mensageria (read+write) |
| Community Manager | Workers (read+comunicação), mensageria, dashboard, funil (read) |
| Super Admin (futuro) | Edição estrutural de worker (`profession`), operações irreversíveis — `project_no_worker_edit_intentional` |

## Decisões de produto

### D-P1 · Super Admin = grupo de sistema, NÃO novo role no enum
**Recomendação:** não criar `super_admin` em `EnliteRole`. É um conjunto de permissões especiais → grupo de sistema `"Super Admin"` com permissions exclusivas (ex: `worker:write` estrutural). `permission_management:write` fica no grupo "Administrador".
**Por quê:** D5 trava `EnliteRole` como camada base ("quem é staff"), não "o que faz". Quarto enum mistura camadas. FOLLOWUPS chunk 215 fala "nível alto (Super Admin)" sem indicar novo enum.
**Sign-off Gabriel? SIM** — membros iniciais + lista de permissions exclusivas.

### D-P2 · Status do usuário = enum (não booleano)
**Recomendação:** `status VARCHAR(20) NOT NULL DEFAULT 'ACTIVE'` CHECK `IN ('ACTIVE','PENDING_ONBOARDING','SUSPENDED','DEACTIVATED')`; deprecar `is_active` mantendo em sync por transição.
**Por quê:** Figma mostra "Ativo" + "Em admissão" (node 10364-58515). "Em admissão" ≠ inativo; `is_active BOOLEAN` (migration 003 l.28) não captura. VARCHAR+CHECK evita migration de tipo futura.
**Sign-off Gabriel? SIM** — o que "Em admissão" implica (acesso zero / read-only / só onboarding); se "Suspenso" existe.

### D-P3 · Departamento multi-valor = metadado nesta fase (não scoping)
**Recomendação:** tabela `user_departments` (user_id, department_name) pro multi-select do Figma, como **metadado**. Scoping "só vê do meu depto" (camada DATA) fica como dúvida aberta até haver caso de uso + design. Cerbos usa atributo `department[]` do principal sem mudar schema depois.
**Por quê:** `figma-reference.md` registra ambiguidade dos 2 campos "Departamento"; sem semântica do designer, scoping é especulação. Camada DATA é a mais complexa, fora do escopo da Fase 1.
**Sign-off Gabriel? SIM** — qual campo é lotação RH (single) e qual é escopo (multi).

### D-P4 · Audit log = só DENY + ALLOW de PII/destrutivo
**Recomendação:** default `deny-only`; logar `ALLOW` apenas para `worker_pii`, `patient`, `document` e ações `delete/execute/export`. Parâmetro `logLevel` por rota.
**Por quê:** HIPAA 45 CFR 164.312(b) exige audit de ePHI; logar 100% dos checks explode volume (legado já previa partição mensal). Compromisso atende HIPAA/LGPD sem inchar a tabela.
**Sign-off Gabriel? NÃO** (recomendação técnica; Architect valida).

### D-P5 · Multi-tenant nesta fase = fundação backend, sem isolar queries de domínio
**Recomendação:** criar `tenants` + `tenant_id` nas tabelas IAM + claim `tenant_id` no JWT + validação no middleware. Tabelas de domínio recebem `tenant_id` nullable (preparação), mas **queries de domínio NÃO filtram ainda** — isolamento full vira item de roadmap com flag.
**Por quê:** D1 quer fundação sólida; plano-mestre (risco) diz isolamento full é trilha contínua. Enlite é single-tenant hoje; forçar filtro agora quebra tudo sem E2E multi-tenant. `iam.tenants` já é o shape da arquitetura-alvo (F03-F05).
**Sign-off Gabriel? NÃO** (alinhado a D1).

## Matriz recurso × ação v1 (visão de produto)

Rebuild do zero a partir do legado + rotas reais. Mudanças vs legado: +`patient`, `document` separado de `upload`, +`talentum`, +`prescreening`, +`match`, +`wja`; `encuadre`→`funnel` (a confirmar com ADR-002). **18 recursos.**

**Trabalhadores:** `worker` (read/write/delete/export) · `worker_pii` (read) 🔒PII · `worker_document` (read/write/delete/validate)
**Vagas e Funil:** `vacancy` (read/write/delete) · `funnel` (read/write) · `interview` (read/write/delete) · `match` (read/execute)
**Pacientes:** `patient` (read/write) 🔒PII — sem delete (dado clínico)
**Recrutamento:** `recruitment` (read/write) · `talentum` (read/write) · `prescreening` (read/write)
**Analytics/Operações:** `analytics` (read/export) · `dedup` (read/execute) · `dashboard` (read)
**Comunicação:** `messaging` (read/send)
**Importação:** `upload` (read/write)
**Administração:** `user_management` (read/write/delete) · `permission_management` (read/write)

🔒 PII-sensitive (camada FIELD, mascaramento): `worker_pii`, `patient`.

## Grupos de sistema sugeridos (`is_system: true`)

- **Acesso Master** (≈ admin) — todas as permissions.
- **Recrutador** (≈ recruiter) — pipeline completo; sem `worker:delete`, `dedup:execute`, `user_management:write/delete`, `permission_management:*`.
- **Community Manager** — read + comunicação; sem write em vacancy, sem interview/talentum/prescreening/dedup.
- **Financeiro** — Figma mostra mas sem escopo definido. Defensivo: `analytics:read/export`, `worker:read`, `vacancy:read`, `dashboard:read`. **Sign-off Gabriel.**
- **Super Admin** — placeholder sem membros; permissions exclusivas (worker estrutural). Architect decide se é `worker:write`+atributo ou recurso `worker_structure:write`.

## Critérios de aceite (alto nível)

- Usuário sem grupo → 403 em qualquer endpoint de dados.
- `status='PENDING_ONBOARDING'` → bloqueado no middleware antes de checar permissions.
- Grupo `is_system` não deletável, nome não renomeável; membros geríveis.
- Anti-lockout: não remover último membro de "Acesso Master".
- Permissões efetivas = UNION dos grupos (sem precedência negativa nesta fase).
- Audit: DENY sempre + ALLOW de PII/destrutivo; NUNCA grava PII no log.
- Bug `CerbosAuthorizationRepository` `roles:[]` corrigido antes de qualquer deploy com Cerbos.
- Troca allow-all → engine real é fail-closed, rota a rota com E2E.
- Novo `@enlite.health` → role `recruiter` + auto-adicionado ao grupo "Recrutador".
- Menu "Permisos" só com `permission_management:read`.
- Campos PII renderizam `***` sem a permission (sem erro/vazio).
- Multi-tenant: claim `tenant_id` no JWT + tabelas IAM com `tenant_id`; queries de domínio ainda não filtram.
- Cobertura: 100% domain/application/presentation; ≥80% infra/bootstrap.

## Dúvidas que precisam do Gabriel

1. Membros iniciais do grupo "Super Admin" + quando ativa.
2. Semântica de "Em admissão" (acesso zero / read-only / só onboarding).
3. Escopo do grupo "Financeiro" (resources × ações).
4. Dois campos "Departamento" no Figma: qual é lotação RH (single) e qual é escopo (multi)? — precisa da designer.
5. Nome canônico do recurso: `funnel` vs `encuadre` (ADR-002 deprecou encuadres).

## Sign-offs do Gabriel (2026-06-15) — RESOLVIDO

- **Escopo (CRÍTICO):** o ABAC vale **apenas para o painel `/admin`**. A app voltada ao worker/prestador está FORA do escopo de permissões — não gatear, não aplicar PermissionGate lá.
- **D-P1 Super Admin:** grupo de sistema. Membros iniciais: `gabriel.stein@enlite.health`, `diego.trevisan@enlite.health`. **Requisito:** adicionar/remover membros tem que ser FÁCIL (via UI de gestão de grupos / `user_groups`, nunca hardcoded). Seed inicial com esses 2; gestão posterior pela tela.
- **D-P2 "Em admissão" (PENDING_ONBOARDING):** **acesso ZERO** — só a tela de onboarding. Middleware bloqueia qualquer recurso operacional/admin; única rota permitida é a de onboarding.
- **Grupo "Financeiro":** **adiado** — não definir escopo agora. Requisito derivado: implementar tudo **modularizado** pra que adicionar a permissão a um componente depois seja trivial (PermissionGate plugável, sem reescrever a tela).
- **D-P3 Departamento (2 campos):** **não decidido ainda.** Mantém como metadado (`user_departments`); scoping fica na Fase 8 (roadmap). Não bloqueia.
- **`funnel` vs `encuadre`:** resolvido pelo Architect — usar `funnel`/`wja`, nunca `encuadre`.
