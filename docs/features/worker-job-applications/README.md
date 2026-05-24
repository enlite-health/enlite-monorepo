# Worker Job Applications (Funil de Candidatura)

> **Status:** Feature fechada. Fonte canônica do funil de candidatura de prestadores (workers) a vagas (job postings) na Enlite.
> **Última atualização:** 2026-05-24

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
| **F4** | Adicionar badges visuais (QUALIFIED/IN_DOUBT/COMPLETED puro) na coluna COMPLETADO; botão dedicado "Rejeitar" no card com modal de motivo; ajustar drag rules (não droppable: INITIATED, IN_PROGRESS, COMPLETADO — controle Talentum). Kanban mantém 7 colunas atuais (revisão 2026-05-24) | ✅ Concluída 2026-05-24 | TBD (commit) |
| **F5** | REPROGRAMAR edita encuadre existente (não cria nova linha); consolidar duplicatas históricas em `encuadres` + UNIQUE `(worker_id, job_posting_id)` | ⏳ Pendente | — |
| **F6** | Matar `EncuadreRepository.syncToWorkerJobApplications` como pipeline recorrente (vira backfill one-shot); remover da "sequência obrigatória pós-import" | ⏳ Pendente | — |
| **F7** | Limpar enum: remover `ANALYZED`, `REPROGRAM`, `PLACED`, `SELECTED` do `application_funnel_stage`. Remover coluna legada `application_status`. Renomear classes/hooks legados (`EncuadreFunnelController` → `WorkerJobApplicationFunnelController` etc.) | ⏳ Pendente | — |
| **F8** | `encuadres.origen` → `import_source_audit` (auditoria de import histórico apenas, sem authority de classificação) | ⏳ Pendente | — |

## Referências cruzadas

- Decisão arquitetural: memória `~/.claude/projects/.../memory/project_wja_canonical_encuadres_deprecated.md`
- Histórico de bugs corrigidos: [POSTMORTEM_KANBAN_FUNNEL_BUGS.md](../../POSTMORTEM_KANBAN_FUNNEL_BUGS.md)
