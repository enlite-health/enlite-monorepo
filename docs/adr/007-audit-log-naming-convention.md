# ADR 007: audit-log-naming-convention

- **Status:** Proposed
- **Data:** 2026-06-20
- **Decisor(es):** architect + PO + Gabriel
- **Contexto técnico:** worker-functions/ — camada de persistência (PostgreSQL)

## Context

O backend `worker-functions/` possui 8+ tabelas de auditoria/history com sufixos inconsistentes, criadas ad-hoc ao longo do tempo:

- Sufixo `_history` (trigger-driven, sem actor rico): `worker_status_history` (mig 079), `worker_job_application_stage_history` (mig 169), `worker_employment_history` (mig 027).
- Sufixo `_audit` (application-level com actor, mas sem `event_type` estruturado): `worker_profile_changes_audit` (mig 202), `patient_field_overrides_audit` (mig 151), `vacancy_relink_audit` (mig 165).
- Sufixo `_audit_log` (application-level, actor completo + `event_type` enum + `changes` JSONB): `permission_audit_log` (mig 206), `job_posting_audit_log` (mig 217).
- Sufixo `_audits` (legacy de import, semântica de dado de negócio, não log): `worker_placement_audits` (mig 043).
- `domain_events` (mig 099) é Transactional Outbox de integração assíncrona — não é auditoria.

Não havia decisão registrada sobre o padrão. Ao implementar o audit log de vagas (`job_posting_audit_log`, mig 217), surgiu a pergunta: usar tabela genérica polimórfica única (`audit_log` com `entity_type`+`entity_id`) ou manter per-entity? E qual sufixo padronizar?

A arquitetura-alvo da Enlite prevê 9 microservices NestJS com Postgres compartilhado; entidades migram para serviços próprios ao longo do tempo (ex: case-service no mês 6-7).

## Decision

A auditoria é per-entity, com sufixo padronizado `_audit_log` para toda criação nova.

- Cada entidade auditada tem sua própria tabela com FK tipada (`REFERENCES <entity>(id)`). Veto explícito a uma tabela genérica polimórfica `audit_log` (com `entity_type`+`entity_id` sem FK tipada).
- Convenção de sufixo:
  - `<entidade>_audit_log` — padrão para TODA nova tabela de auditoria application-level com actor rico (`actor_user_id` + `actor_type` + `event_type` enum + `changes` JSONB before/after). Exemplos futuros: `worker_audit_log`, `patient_audit_log`.
  - `_history` — permanece válido apenas para tabelas trigger-driven que rastreiam mudança de campo/status sem actor rico.
  - `_audit` (sem `_log`) fica proibido para tabelas novas. As existentes são legado e não serão renomeadas.
- `job_posting_audit_log` (mig 217) já está correta — nome e schema seguem o padrão. Não renomear.
- Schema de referência para `_audit_log`: colunas `id`, `<entity>_id (FK)`, `event_type (CHECK enum UPPERCASE EN)`, `field_name`, `changes JSONB {before, after}`, `actor_user_id (FK→users, nullable)`, `actor_type (CHECK: HUMAN/SYSTEM/WEBHOOK/CLI)`, `actor_label`, `trace_id`, `created_at`.

## Consequences

### Positivas

- FK referencial garante integridade por entidade (cascade on delete); queries tipadas e indexadas sem ambiguidade.
- Isolamento de bounded context preservado: quando uma entidade migra para um microservice próprio, seu `_audit_log` vai junto, sem acoplamento cross-service.
- Convenção clara elimina decisão ad-hoc por desenvolvedor a cada nova tabela de auditoria.

### Negativas

- N tabelas + N repositórios (uma tabela `_audit_log` por entidade auditada): mais arquivos e migrations ao longo do tempo.
- Feed de auditoria cross-entity exigiria UNION explícito no SQL (necessidade avaliada como ~zero — o feed é sempre consultado por entidade na prática).
- Coexistência temporária de 3 sufixos (`_history`, `_audit`, `_audit_log`) no banco por causa do legado não-renomeado, o que pode gerar confusão inicial em novos desenvolvedores.

### Neutras

- `domain_events` (Transactional Outbox) permanece fora desta convenção — não é auditoria e tem semântica diferente.

## Alternatives Considered

### Alternativa A: Tabela genérica polimórfica `audit_log` (entity_type + entity_id)

Tabela única com colunas `entity_type` (ex: `'job_posting'`, `'worker'`) e `entity_id` (UUID sem FK) registrando todos os eventos de todas as entidades num único lugar. Feed cross-entity seria uma query simples; estrutura única de repositório.

**Descartada porque:** elimina FK tipada (sem integridade referencial, cascade impossível), acopla bounded contexts numa tabela compartilhada (incompatível com a arquitetura-alvo de 9 MS onde cada entidade migra para serviço próprio), e não atende necessidade cross-entity que foi avaliada como inexistente na prática da Enlite.

### Alternativa B: Manter sufixos ad-hoc por decisão de cada desenvolvedor

Continuar sem convenção, deixando cada dev escolher `_history`, `_audit` ou `_audit_log` conforme julgamento local.

**Descartada porque:** é o estado atual que gerou o problema — 4 sufixos diferentes para o mesmo conceito, sem semântica clara e sem previsibilidade para novos desenvolvedores ou revisores de PR.

## Rollback

Esta decisão afeta apenas criações futuras — nenhuma tabela existente é renomeada ou alterada. Não há migration a reverter.

Se a convenção precisar ser revisada (ex: surgimento de necessidade cross-entity real), cria-se novo ADR que supersede este; tabelas existentes criadas sob `_audit_log` permanecem válidas e apenas novas tabelas seguem o padrão revisado. Não há operação destrutiva associada.

## Implementation Notes

- Migrations envolvidas: N/A (convenção para criações futuras; `job_posting_audit_log` via mig 217 já está conforme)
- Feature flags: N/A
- Follow-up TD (em `docs/FOLLOWUPS.md`): Sem follow-up necessário — decisão encerrável

## References

- Supabase: Postgres Auditing in 150 lines of SQL — https://supabase.com/blog/postgres-audit
- Cybertec: Performance differences between normal and generic audit triggers — https://www.cybertec-postgresql.com/en/performance-differences-between-normal-and-generic-audit-triggers/
- microservices.io: Pattern — Audit Logging — https://microservices.io/patterns/observability/audit-logging.html
- `job_posting_audit_log` — migration 217 (tabela de referência que já segue o padrão)
- ADR-004: prescreening-providers-pluggable (arquitetura multi-provider; mesmo princípio de isolamento por bounded context)
