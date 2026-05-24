# ADR 002: WJA canônico, encuadres deprecada

- **Status:** Proposed
- **Data:** 2026-05-23 (refinada 2026-05-24 — detalhe sobre layout do Kanban revisado)
- **Decisor(es):** architect + PO + Gabriel (decisão tomada em 2026-05-23, aguardando aprovação humana formal)
- **Contexto técnico:** worker-functions/src/modules/matching + worker-functions/src/modules/encuadres + migrations + frontend Kanban

## Context

O monorepo tem duas tabelas que descrevem a relação entre um worker (AT) e uma vaga (job_posting): `encuadres` (legada, originada da planilha operativa morta em 2026-05-23) e `worker_job_applications` (WJA, criada para suportar webhook Talentum + matchmaking). Nunca foram fundidas. Resultado: 7 duplicações concretas mapeadas — `interview_datetime`, `meet_link`, `application_funnel_stage`/`resultado`, `source`/`origen` aparecem em ambas; 6 formatos de `dedup_hash` distintos para o mesmo par lógico `(worker_id, job_posting_id)`; 2 pipelines escrevendo o stage do funil; trigger 189 + backfill 188 tentando garantir invariante WJA-com-encuadre que só existe porque o Kanban lê `FROM encuadres LEFT JOIN worker_job_applications`. Suspeita inicial do Gabriel ("rotina do Encuadre está errada — duplicando informação e múltiplas fontes da verdade") confirmada por PO + Architect após auditoria.

A planilha operativa que originou `encuadres` foi descontinuada em 2026-05-23. Não há mais consumidor externo da tabela com authority de negócio. `worker_job_applications` já é SSOT de fato no caminho Talentum (webhook escreve nela) e no Kanban da F5 em diante.

## Decision

Promover `worker_job_applications` a SSOT canônico do funil de candidatura. `encuadres` torna-se tabela legada em deprecação progressiva ao longo de 8 fases (~3-4 semanas com paralelismo).

Mudanças concretas:

- `worker_job_applications.application_funnel_stage` é o SSOT do estágio do funil. `encuadres.resultado` vira narrativo histórico sem authority.
- `worker_job_applications.source` é o SSOT de origem. `encuadres.origen` será migrado para `import_source_audit` (F8).
- Agendamento de entrevista (datetime, meet_link, slot) mora em `worker_job_applications.interview_*`. Campos equivalentes em `encuadres` viram read-only legacy.
- Regra dura: 1 encuadre por par `(worker_id, vaga_id)`. REPROGRAMAR edita a linha existente em vez de criar nova (F5).
- Pipeline `EncuadreRepository.syncToWorkerJobApplications` vira backfill one-shot e é removido da sequência pós-import (F6).
- Kanban final = 7 colunas: INVITADO | INITIATED | IN_PROGRESS | COMPLETADO | CONFIRMADO | SELECTED | REJECTED. QUALIFIED/IN_DOUBT viram badges em COMPLETADO. NOT_QUALIFIED auto-move para REJECTED (F3 já entregue em commit `b26e8e2`). REJECTED tem botão dedicado no card além do drag. Drag NÃO permitido nas 3 colunas Talentum (INITIATED, IN_PROGRESS, COMPLETADO); permitido nas outras 4. **Revisão 2026-05-24:** layout original do ADR previa 5 colunas com SELECTED/REJECTED fora do Kanban — Gabriel revisou a decisão por visibilidade operacional (admin precisa ver terminais sem trocar de tela).
- Plano de 8 fases documentado em `docs/features/worker-job-applications/README.md` (commit `eb13c67`). Estado atual: F2 (commit `64d9af8`) e F3 (commit `b26e8e2`) concluídas. F4-F8 pendentes.

Decisões correlatas já formalizadas: [ADR-001](001-encuadres-unique-worker-job-posting-constraint.md) (UNIQUE worker_id+job_posting_id em encuadres, parte da F5).

## Consequences

### Positivas

- SSOT único por dimensão (stage, source, agendamento) — fim das 7 duplicações.
- Trigger 189 + backfill 188 + os 6 formatos de `dedup_hash` deixam de ser necessários no longo prazo (após F5/F8).
- Kanban e lista de candidatos passam a ler da mesma fonte (`worker_job_applications`) — fim do gap "20 na lista, 0 no Kanban" descrito em TD-036.
- REPROGRAMAR vira operação idempotente (edita 1 linha em vez de criar N) — alinhado com a regra de cardinalidade documentada em `docs/features/worker-job-applications/06-regra-cardinalidade.md`.
- Pipeline de sync (`EncuadreRepository.syncToWorkerJobApplications`) sai do hot path do import — reduz latência e pontos de falha do webhook ClickUp.

### Negativas

- Janela de transição de ~3-4 semanas onde os dois esquemas coexistem — exige disciplina pra novos campos não caírem em `encuadres`.
- F6 (matar `syncToWorkerJobApplications`) tem ripple em queries que ainda fazem JOIN explícito — auditoria de call sites é obrigatória antes do delete.
- F8 (migrar `origen` para `import_source_audit`) exige migration de dados com janela de manutenção — não pode ser rolling.
- Dashboards/relatórios externos que leem `encuadres.resultado` ou `encuadres.origen` precisam ser inventariados antes da F8 (risco de quebra silenciosa).

## Alternatives Considered

### Alternativa A: manter `encuadres` como SSOT e deprecar `worker_job_applications`

`encuadres` era a tabela de entrada de dados operacionais e continuaria como fonte primária. `worker_job_applications` seria reduzida a cache de leitura do Talentum.

**Descartada porque:** `worker_job_applications` é a tabela escrita pelo webhook Talentum (única integração externa com authority de stage) e pelo Kanban da F5 em diante. Deprecar WJA exigiria reescrever o adapter Talentum + Kanban + matchmaking, e a planilha operativa que justificava `encuadres` já está morta.

### Alternativa B: fundir as duas tabelas em uma terceira nova (`application_records`)

Criar tabela unificada `application_records` com todos os campos de ambas, migrar dados e redirecionar todos os call sites.

**Descartada porque:** custo de migração é proibitivo (todos os call sites em ambos os pipelines + frontend Kanban + queries de relatório), e o ganho semântico é zero — `worker_job_applications` já tem nome e schema corretos. Renomear-fundir é só mais churn.

### Alternativa C: manter ambas com fronteira clara de responsabilidade

`encuadres` para dados operacionais importados; `worker_job_applications` para dados do funil Talentum. Documentar fronteira e enforçar via code review.

**Descartada porque:** foi a tentativa do estado atual (trigger 189 + backfill 188 + 6 formatos de dedup_hash existem justamente para tentar manter consistência entre as duas). Não funcionou — as 7 duplicações são prova empírica de que fronteira clara entre tabelas com overlap semântico é instável sob pressão de novos requisitos.

## Rollback

Plano de rollback por fase (cada uma é independente e reversível):

- F2/F3 (já em prod): reverter via migration que reintroduz valor `RECHAZADO` no enum e remove o auto-reject de `NOT_QUALIFIED`. Custo baixo, dados não destruídos.
- F4 (Kanban 7 colunas + badges + botão rejeitar + drag rules): rollback do frontend (revert do PR). Sem mudança de schema.
- F5 (REPROGRAMAR edita): rollback parcial possível (volta a criar nova linha), mas constraint UNIQUE de ADR-001 precisa cair junto. Documentado em ADR-001 → Rollback.
- F6 (mata `syncToWorkerJobApplications`): rollback = revert do PR + re-adicionar chamada no pipeline de import.
- F7 (limpa enum): rollback exige migration reintroduzindo os valores removidos — viável mas exige cuidado com linhas históricas.
- F8 (origen → import_source_audit): rollback exige reverter migration de dados — janela de manutenção novamente.

Critério de "não rollback": após F5 estável em prod por ≥14 dias sem incidentes (alinhado com TD-041), considerar o caminho irreversível e deletar código legado de `encuadres` agressivamente.

## Implementation Notes

- Migrations envolvidas: migration 188 (backfill), migration 189 (trigger) — ambas legadas; novas migrations a partir de F5
- Feature flags: N/A (deploys incrementais por fase)
- Follow-up TD (em `docs/FOLLOWUPS.md`): TD-042

## References

- `docs/features/worker-job-applications/README.md` — plano de 8 fases (commit `eb13c67`)
- `docs/features/worker-job-applications/06-regra-cardinalidade.md` — regra 1:1 encuadre por par worker/vaga
- [ADR-001](001-encuadres-unique-worker-job-posting-constraint.md) — UNIQUE constraint em encuadres (F5)
- Commits de referência: `b26e8e2` (F3 — auto-reject NOT_QUALIFIED), `64d9af8` (F2 — consolidar RECHAZADO), `eb13c67` (README plano 8 fases)
