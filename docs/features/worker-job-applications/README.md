# Worker Job Applications (Funil de Candidatura)

> **Status:** Feature fechada. Fonte canônica do funil de candidatura de prestadores (workers) a vagas (job postings) na Enlite.
> **Última atualização:** 2026-05-23

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
4. [Estados do funil (Kanban)](04-estados-funil-kanban.md) — 5 colunas visíveis + stages internos + badges
5. [Fluxo de transições (T1→T7)](05-fluxo-transicoes.md) — gatilho, ator, pré/pós, idempotência
6. [Regra de cardinalidade e REPROGRAMAR](06-regra-cardinalidade.md) — 1:1 worker/vaga; REPROGRAMAR edita, não cria
7. [Tabelas envolvidas](07-tabelas-envolvidas.md) — estado-alvo após deprecação progressiva
8. [Pipelines de escrita](08-pipelines.md) — 6 ativos + 3 deprecados

## Referências cruzadas

- Decisão arquitetural: memória `~/.claude/projects/.../memory/project_wja_canonical_encuadres_deprecated.md`
- Histórico de bugs corrigidos: [POSTMORTEM_KANBAN_FUNNEL_BUGS.md](../../POSTMORTEM_KANBAN_FUNNEL_BUGS.md)
- Plano de deprecação: 8 fases (F1 documenta → F2 RECHAZADO→REJECTED → ... → F8 origen→import_source_audit)
