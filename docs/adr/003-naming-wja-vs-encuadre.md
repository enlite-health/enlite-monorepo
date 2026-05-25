# ADR 003: Convenção de naming — WJA* vs Encuadre*

- **Status:** Accepted
- **Data:** 2026-05-24
- **Decisor(es):** Gabriel + PO + Architect (decisão tomada em 2026-05-24, aplicada em F7.a)
- **Contexto técnico:** worker-functions/src/modules/matching + enlite-frontend/src/hooks/admin + enlite-frontend/src/presentation

## Context

O plano de consolidação WJA/Encuadre ([ADR-002](002-wja-canonico-encuadres-deprecada.md)) introduziu duas tabelas com responsabilidades distintas após F6:

- `worker_job_applications` (WJA) — SSOT do funil, stage, score, agendamento, canal de aquisição
- `encuadres` — dados exclusivos da entrevista presencial (`has_*`, `obs_*`, `role`, `resultado` narrativo, identidade fallback)

Antes do plano, classes do módulo `matching` tinham nomes inconsistentes:

- `EncuadreFunnelController` operava primariamente sobre WJA (governa funil), apesar do nome `Encuadre*`
- `EncuadreRepository.syncToWorkerJobApplications` escrevia em WJA via reverso (deprecado em F6, commit `616ff1c`)

Essa mistura confundia onboarding e refactors. Discovery Profunda F7 (2026-05-24) detectou 18 inconsistências entre docs canônicos e código real — várias relacionadas a essa confusão.

Sem uma regra explícita formalizada, futuros refactors continuariam misturando os nomes.

## Decision

Regra de naming: **o prefixo do arquivo/classe deve refletir a entidade primária que manipula no banco**.

- **`Encuadre*`** — quando a operação principal é em `encuadres` (CRUD da tabela legada, queries que retornam colunas de `encuadres` como entidade primária, mappers de linhas `encuadres → DTO`)
- **`WJA*`** — quando a operação principal é em `worker_job_applications` (funil, stage, agendamento, canal), OU JOIN entre ambas com WJA como fonte primária da perspectiva do endpoint

Sigla `WJA` é canônica do projeto (branch `fix/kanban-orphan-wja-visibility`, CLAUDE.md, memórias, ADR-002). Prefere-se sobre `WorkerJobApplication*` (verboso) e `Application*` (colide com camada arquitetural `application/`).

### Aplicação concreta em F7.a (2026-05-24)

**Renomeadas para `WJA*`** (tocam funil WJA primariamente):

| De | Para | Justificativa |
|---|---|---|
| `EncuadreFunnelController` | `WJAFunnelController` | SQL acessa WJA + encuadres via JOIN; governa `application_funnel_stage` via `moveEncuadre` |
| `EncuadreFunnelTableController` | `WJAFunnelTableController` | Idem (view tabela do mesmo funil) |
| `useEncuadreFunnel` (frontend) | `useWJAFunnel` | Consome endpoint Kanban de WJA; gerencia `FunnelStages` |

**MANTÊM `Encuadre*`** (tocam exclusivamente a tabela `encuadres`):

| Classe/arquivo | Justificativa |
|---|---|
| `EncuadreController` | Exibe `encuadres.resultado` pra histórico do worker; CRUD via `EncuadreRepository` |
| `EncuadreRepository` | CRUD de `encuadres` incl. `has_*`/`obs_*` |
| `EncuadreQueryRepository` | Queries de leitura em `encuadres` |
| `EncuadreMappers` | Mapeia linhas `encuadres → DTO` |
| `EncuadreControllerHelpers` | Funções puras que processam `encuadres.resultado` |
| `WorkerEncuadresCard.tsx` (frontend) | Exibe `encuadres.resultado`, `has_*`, `obs_*` |
| `VacancyFunnelKanban.tsx` (frontend) | Nome neutro (sem "Encuadre" — não precisa renomear) |

### Endpoints HTTP

Paths legados **NÃO mudam** em F7.a:
- `PUT /api/admin/encuadres/:id/move`
- `GET /api/admin/vacancies/:id/funnel`

Razão: breaking change na API sem ganho operacional. O frontend continua chamando paths atuais. Custo aceito: vocabulário inconsistente na API (path diz "encuadres" mas semanticamente opera sobre WJA).

## Consequences

### Positivas

- **Navegação imediata**: `grep WJA` retorna apenas classes que tocam o funil; `grep Encuadre` retorna apenas as que tocam a tabela legada
- **Onboarding mais rápido** — nome explica responsabilidade primária sem precisar abrir arquivo
- **Alinhamento com domínio**: a entidade no banco se chama `worker_job_applications`, não `encuadres_funnel`
- **Regra determinística** para refactors futuros — qual tabela é primária define o prefixo
- **Sem breaking change** na API HTTP (paths preservados)

### Negativas

- **Período de ambiguidade durante migração incremental**: F7.a renomeia 3 símbolos; outras `Encuadre*` continuam com nome legado mas tocando `encuadres` legitimamente. Devs precisam consultar essa ADR pra desambiguar
- **Cloud Logging queries** que filtram por `[EncuadreFunnelController]` no log prefix vão parar de retornar novos erros após F7.a. Runbooks/alertas precisam atualizar
- **Inconsistência API vs código**: endpoint diz `encuadres` mas controller é `WJAFunnelController`. Comentários internos resolvem

### Neutras

- HTTP paths mantidos (decisão do user pra evitar breaking change)
- Renomeio é puro código (zero dependência de migration)
- F7.a manteve shims de re-export nos arquivos antigos (`EncuadreFunnelController.ts` re-exporta `WJAFunnelController`) por defesa extra. Podem ser removidos em fase futura se confirmar zero leitores externos

## Alternatives Considered

### Alternativa A: `WorkerJobApplication*` (verboso oficial)

`WorkerJobApplicationFunnelController`, `useWorkerJobApplicationFunnel`.

Match exato com nome da tabela. **Rejeitado:** 23 caracteres vs 3. Imports verbosos sem ganho semântico — WJA é sigla amplamente usada nos commits e docs do projeto.

### Alternativa B: `Application*` (sigla nova)

`ApplicationFunnelController`, `useApplicationFunnel`.

Auto-explicativo. **Rejeitado:** colide com conceito genérico de "application" em Clean Architecture (camada `application/`). Cria confusão com a camada arquitetural.

### Alternativa C: Manter `Encuadre*` em todas as classes

Evita renomeio mas perpetua a confusão. **Rejeitado:** F6 tornou a separação explícita (sync deprecada); o nome deve seguir a responsabilidade real.

## Rollback

Renomear de volta é puro `git revert` (pure code, sem migration). Imports voltam, classe volta. Sem perda de dados. Shims de re-export em `EncuadreFunnelController.ts` adicionam resiliência extra durante transição.

## Implementation Notes

- Migrations envolvidas: nenhuma específica deste ADR
- Follow-up TD: nenhum
- Aplicação inicial: F7.a (3 renomeios + shims de re-export)
- Futuras aplicações: qualquer nova classe/hook no módulo `matching` segue a regra

## References

- [ADR-002](002-wja-canonico-encuadres-deprecada.md) — promoção WJA a SSOT canônico (origem do plano de 8 fases)
- [`docs/features/worker-job-applications/02-vocabulario.md`](../features/worker-job-applications/02-vocabulario.md) — regras de uso do vocabulário em código novo, conversas, UI, endpoints
- [`docs/features/worker-job-applications/README.md`](../features/worker-job-applications/README.md) — tabela do plano de 8 fases (F7.a entrega esta ADR)
- `worker-functions/CLAUDE.md` — regra max 400 linhas (motivo do split prévio dos tests do controller)
- Memória: `feedback_discovery_profunda_metodo.md` — método de Discovery 5-fontes que identificou as 18 inconsistências corrigidas antes de F7.a
