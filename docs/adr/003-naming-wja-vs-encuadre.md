# ADR 003: Convenção de naming WJA*/Encuadre* + destino canônico do reschedule

- **Status:** Accepted
- **Data inicial:** 2026-05-24 (F7.a — regra de naming)
- **Ampliado:** 2026-05-25 (F7.b — destino canônico do reschedule via WhatsApp)
- **Decisor(es):** Gabriel + PO + Architect
- **Contexto técnico:** worker-functions/src/modules/matching + worker-functions/src/modules/notification + enlite-frontend/src/hooks/admin + enlite-frontend/src/presentation

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

---

## F7.b — destino canônico do estado `REPROGRAM` (decisão de 2026-05-25)

### Contexto

ADR-002 prevê a remoção do estado `REPROGRAM` do enum `application_funnel_stage` em F7.b. O writer ativo é exclusivamente `HandleReminderResponseUseCase.handleRescheduleYes:188-200` (Discovery Profunda 2026-05-25, 5 fontes), disparado quando o worker clica `reschedule_yes` no template WhatsApp `qualified_reminder_reschedule`.

**Estado em prod:**
- 0 linhas em `worker_job_applications` com `application_funnel_stage='REPROGRAM'`
- 0 linhas em `worker_job_application_stage_history` mencionando REPROGRAM
- Migration 123 (criação do estado) aplicada em 2026-05-24
- Conclusão: feature recém-criada, sem dívida histórica — refator cirúrgico

**3 opções consideradas para o destino canônico:**

| Opção | funnel_stage | interview_response | Avaliação |
|---|---|---|---|
| A | `QUALIFIED` | `pending` | Volta ao pool. Conceitualmente correto (worker continua qualificado), mas perde a sinalização de que houve um agendamento prévio cancelado pelo worker |
| B | `REJECTED` | `awaiting_reschedule` | Conservador. Pune comportamento desejável (worker quer continuar). Esconde candidato qualificado |
| **C (escolhida)** | `CONFIRMED` | `awaiting_reschedule` | Worker permanece no funil canônico; o flag em `interview_response` carrega a semântica do reschedule. Aproveita estado já existente da state machine |

### Decision

**O estado REPROGRAM é eliminado. Quando worker clica reschedule_yes, a WJA permanece com `application_funnel_stage='CONFIRMED'` e o estado é representado exclusivamente por `interview_response='awaiting_reschedule'` combinado com `interview_meet_link=NULL`.**

**Diff de comportamento em `handleRescheduleYes`:**

```diff
 UPDATE worker_job_applications
-SET interview_response       = 'pending',
-    application_funnel_stage = 'REPROGRAM',
+SET interview_response       = 'awaiting_reschedule',
+    -- application_funnel_stage NÃO é tocado (permanece CONFIRMED)
     interview_responded_at   = NOW(),
     interview_meet_link      = NULL,
     interview_datetime       = NULL,
     interview_slot_id        = NULL,
     updated_at               = NOW()
```

### Distinguidor entre os 3 cenários de CONFIRMED

| Cenário | `funnel_stage` | `interview_response` | `interview_meet_link` |
|---|---|---|---|
| Entrevista agendada e confirmada pelo worker | `CONFIRMED` | `confirmed` | preenchido |
| Worker disse "não confirmo" (confirm_no) — aguardando resposta sobre reschedule | `CONFIRMED` | `awaiting_reschedule` | preenchido (ainda) |
| Worker pediu reschedule (reschedule_yes) — aguardando novo agendamento | `CONFIRMED` | `awaiting_reschedule` | **NULL** |

### Mudanças derivadas

1. **`InterviewStateMachine.canTransition`** passa a permitir self-transition `awaiting_reschedule → awaiting_reschedule` (idempotente para múltiplos cliques em reschedule_yes)

2. **`WJAFunnelController.getEncuadreFunnel`** remove `'REPROGRAM'` do array de COMPLETED bucket. Workers em CONFIRMED+awaiting_reschedule aparecem na coluna CONFIRMED do Kanban (não mais COMPLETADO).

3. **`KanbanCard` (frontend)** muda a condição do badge "🔄 REMARCADO":
   - **De:** `funnelStage === 'REPROGRAM'`
   - **Para:** `interviewResponse === 'awaiting_reschedule' && meetLink === null`
   - Requer expor `interview_response` na response da query do controller

4. **`GetFunnelTableUseCase` audit table** — worker em CONFIRMED+awaiting_reschedule+meet_link=NULL é classificado como **PRE_SELECTED** (não WITHDREW como era REPROGRAM). Justificativa: worker não desistiu, pediu remarcação. Continua candidato ativo.

5. **Type unions** removem `'REPROGRAM'`: `FunnelStage` (FunnelStageMapper.ts), `ApplicationFunnelStage` (WorkerJobApplication.ts), arrays em `applicationFunnelStages.ts`, entry em `TalentumFunnelStageMapper`.

6. **Migration 195** drop REPROGRAM do CHECK constraint em `application_funnel_stage` + remove da função `funnel_stage_precedence()`. **Sem backfill** (0 rows em prod).

7. **`funnel_stage_precedence()`** mantém peso 6 para CONFIRMED (não muda); peso 5 (que era de REPROGRAM/QUALIFIED) fica somente para QUALIFIED.

### Loop de reschedule (cenário não-feliz)

Worker pode clicar reschedule_yes múltiplas vezes (recebe o template `qualified_reprogram_confirm` mas insiste). Self-transition `awaiting_reschedule → awaiting_reschedule` é idempotente — UPDATE simplesmente atualiza `interview_responded_at` + `updated_at`. Não há loop ou regressão.

Reenvio automático de meet links **não** é implementado em F7.b. Admin continua intervindo manualmente no Kanban (mesmo comportamento de antes — REPROGRAM nunca teve automação de reenvio).

### Consequences específicas de F7.b

**Positivas:**
- 1 estado a menos no enum (de 11 para 10 valores em `application_funnel_stage`)
- Semântica unificada: estados do funil refletem progresso macro; `interview_response` carrega micro-estados do reagendamento
- Sem dívida histórica (0 rows pra backfillar)
- Visualização Kanban mais coerente: worker que pediu reschedule não some no bucket COMPLETADO; continua visível em CONFIRMED com sinalização

**Negativas:**
- `KanbanCard` agora precisa de 2 campos (`interviewResponse` + `meetLink`) pra decidir badge — antes precisava só de `funnelStage`. Mais acoplado à API
- Auditoria SQL ad-hoc de "quem pediu reschedule" requer query composta (`ir='awaiting_reschedule' AND meet_link IS NULL`) — antes era um simples `funnel_stage='REPROGRAM'`

**Neutras:**
- Endpoints HTTP não mudam
- Frontend continua chamando endpoints atuais; só muda renderização interna do badge

## Implementation Notes

- Migrations envolvidas: **migration 195** (F7.b — drop REPROGRAM do CHECK em `application_funnel_stage` + remove da função `funnel_stage_precedence()`)
- Follow-up TD: nenhum específico (loops e fluxo manual de reenvio de meet links continuam como antes)
- Aplicação inicial F7.a (2026-05-24): 3 renomeios + shims removidos
- Aplicação F7.b (2026-05-25): destino canônico do reschedule + remoção de REPROGRAM end-to-end
- Futuras aplicações: qualquer nova classe/hook no módulo `matching` segue a regra de naming

## References

- [ADR-002](002-wja-canonico-encuadres-deprecada.md) — promoção WJA a SSOT canônico (origem do plano de 8 fases)
- [`docs/features/worker-job-applications/02-vocabulario.md`](../features/worker-job-applications/02-vocabulario.md) — regras de uso do vocabulário em código novo, conversas, UI, endpoints
- [`docs/features/worker-job-applications/README.md`](../features/worker-job-applications/README.md) — tabela do plano de 8 fases (F7.a entrega esta ADR)
- `worker-functions/CLAUDE.md` — regra max 400 linhas (motivo do split prévio dos tests do controller)
- Memória: `feedback_discovery_profunda_metodo.md` — método de Discovery 5-fontes que identificou as 18 inconsistências corrigidas antes de F7.a
