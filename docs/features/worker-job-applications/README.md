# Worker Job Applications (Funil de Candidatura)

> **Status:** Feature fechada. Fonte canônica do funil de candidatura de prestadores (workers) a vagas (job postings) na Enlite.
> **Última atualização:** 2026-05-25 (auditoria pré-F7 corrigiu 18 inconsistências detectadas)

## Visão executiva

Um **Worker Job Application (WJA)** representa a candidatura de UM prestador a UMA vaga. É a entidade canônica que vive do momento em que o prestador entra no funil (convite ou interesse) até um estado terminal (`CONFIRMED` ou `REJECTED`).

Regras inegociáveis:

- **Cardinalidade 1:1** — UNIQUE `(worker_id, job_posting_id)`. Nunca há duas WJAs para o mesmo par.
- **Estado único e linear** — `application_funnel_stage` é o único SSOT do funil; transições respeitam precedência canônica (não regridem).
- **Encuadre ≡ WJA** — `encuadres` é vocabulário operacional em espanhol para a mesma entidade. Historicamente existiu tabela `encuadres` separada (vinda de planilha legada), hoje em deprecação.

## Índice

1. [Conceito](01-conceito.md) — o que é WJA, por que existe, cardinalidade
2. [Vocabulário](02-vocabulario.md) — WJA / Encuadre / Funil de Candidatura: 3 nomes, 1 entidade
3. [SSOT por conceito](03-ssot-por-conceito.md) — qual tabela/coluna detém autoridade sobre cada dado
4. [Estados do funil (Kanban)](04-estados-funil-kanban.md) — 7 colunas visíveis + stages internos + badges + regras de drag
5. [Fluxo de transições (T1→T7)](05-fluxo-transicoes.md) — gatilho, ator, pré/pós, idempotência
6. [Regra de cardinalidade e REPROGRAMAR](06-regra-cardinalidade.md) — 1:1 worker/vaga; REPROGRAMAR edita, não cria
7. [Tabelas envolvidas](07-tabelas-envolvidas.md) — estado-alvo após deprecação progressiva
8. [Pipelines de escrita](08-pipelines.md) — 6 ativos + 3 deprecados

## Plano de fases

Esta tabela é a **fonte da verdade da numeração das fases**. Qualquer menção a "F2", "F4" etc. nos outros docs deve bater com esta lista.

| Fase | Escopo | Status | Commit / Migration |
|---|---|---|---|
| **F1** | Doc canônico desta feature + cleanup de 48 docs com refs ambíguas a encuadre/WJA | ✅ Concluída 2026-05-23 | `5ce2cab`, `3904c3e`, `dc630b1` |
| **F2** | Consolidar `RECHAZADO` → `REJECTED` no `application_funnel_stage` (CHECK + `funnel_stage_precedence`) | ✅ Concluída 2026-05-23 | `64d9af8` / migration 190 |
| **F3** | Auto-rejeição `NOT_QUALIFIED` → `REJECTED` no use case + remover `NOT_QUALIFIED` do enum | ✅ Concluída 2026-05-23 | `b26e8e2` / migration 191 |
| **F4** | Adicionar badges visuais (QUALIFIED/IN_DOUBT/COMPLETED puro) na coluna COMPLETADO; botão dedicado "Rejeitar" no card com modal de motivo; ajustar drag rules (não droppable: INITIATED, IN_PROGRESS, COMPLETADO — controle Talentum). Kanban mantém 7 colunas atuais (revisão 2026-05-24) | ✅ Concluída 2026-05-24 | `a26f0a2` |
| **F5** | UNIQUE `(worker_id, job_posting_id)` em `encuadres` + consolidar ~20k duplicatas históricas (richness score + recência) + 6 call sites atualizados de `ON CONFLICT (dedup_hash)` para par composto + trigger 189 atualizado. REPROGRAMAR já edita WJA sem criar encuadre novo (descoberto no Explore — desnecessário mexer no use case) | ✅ Concluída 2026-05-24 | `2cc7d06` |
| **F6** | Matar `EncuadreRepository.syncToWorkerJobApplications` como pipeline recorrente: chamada removida do script de import + função mantida com `@deprecated`. CLAUDE.md "Sequência obrigatória pós-import" → "Pipelines de import legados". SEM backfill das 19k inconsistências (user aceitou como histórico). SEM converter 1.450 órfãos ClickUp. Bloqueador residual: TD-047 (identificar quem ainda dispara o script) | ✅ Concluída 2026-05-24 | `616ff1c` |
| **F7.a** | Limpeza enxuta (baixo risco): remover `ANALYZED` da função SQL `funnel_stage_precedence()` (mantém em `FunnelStage` TS como vocab protocolo Talentum); remover `PLACED` totalmente (CHECK + `FunnelStage` + `ApplicationFunnelStage` + arrays); renomear 3 classes (`EncuadreFunnelController` → `WJAFunnelController`, `EncuadreFunnelTableController` → `WJAFunnelTableController`, `useEncuadreFunnel` → `useWJAFunnel`); criar ADR-003 com regra de nomeio. **NÃO toca SELECTED/REPROGRAM/application_status** | ✅ Concluída 2026-05-25 | `a0a95e3` / migration 194 |
| **F7.b** | Refatorar `HandleReminderResponseUseCase.handleRescheduleYes` que ainda escreve `REPROGRAM` ativamente. Requer **ADR-003 ampliado** decidindo destino dos workers que pedem reagendamento (volta pra QUALIFIED? vira REJECTED? fica em CONFIRMED com flag?). Após refator: backfill rows históricas + drop REPROGRAM do CHECK + atualizar `funnel_stage_precedence()` + limpar consumers (`KanbanCard` badge "REMARCADO", `GetFunnelTableUseCase` bucket WITHDREW) | ⏳ Pendente | — |
| **F7.c** | Drop coluna `application_status` (legada): localizar todos os writers (`'applied'` ativo com 2030 modificações em 7d; `'under_review'` ativo com 297 em 7d), remover/redirecionar escritas, deploy, esperar 7-14 dias estáveis, então `ALTER TABLE DROP COLUMN`. Também remover `funnelStage` (campo redundante com `internal_stage` desde F4) | ⏳ Pendente | — |
| **F8** | `encuadres.origen` → `import_source_audit` (auditoria de import histórico apenas, sem authority de classificação) | ⏳ Pendente | — |

## Referências cruzadas

- ADR-001 (Accepted 2026-05-24): [`docs/adr/001-encuadres-unique-worker-job-posting-constraint.md`](../../adr/001-encuadres-unique-worker-job-posting-constraint.md) — UNIQUE composta em encuadres (parte da F5)
- ADR-002 (Proposed 2026-05-23, refinado 2026-05-24): [`docs/adr/002-wja-canonico-encuadres-deprecada.md`](../../adr/002-wja-canonico-encuadres-deprecada.md) — promoção WJA a SSOT canônico + plano de 8 fases
- ADR-003 (a criar em F7.a): regra de nomeio "toca encuadres → mantém prefix `Encuadre*`; toca WJA → renomeia `WJA*`"
- Decisão arquitetural: memória `~/.claude/projects/.../memory/project_wja_canonical_encuadres_deprecated.md`
- Método de Discovery Profunda (aplicado em F7+): memória `feedback_discovery_profunda_metodo.md`
- Histórico de bugs corrigidos: [POSTMORTEM_KANBAN_FUNNEL_BUGS.md](../../POSTMORTEM_KANBAN_FUNNEL_BUGS.md)
- TDs ativos relevantes: TD-041 (drop `dedup_hash` UNIQUE após F5 estável 14d), TD-043 (cobertura visual E2E F4), TD-044 (hook `validate-migration.sh` opt-in), TD-045 (verificar `dedup_hash` antes deploy 193), TD-046 (`console.error` → `logger`), TD-047 (identificar disparador de `import-encuadres-from-clickup.ts`)
