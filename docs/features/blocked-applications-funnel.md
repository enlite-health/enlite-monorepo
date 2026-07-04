# Postulações Bloqueadas no Funil — Coluna BLOQUEADO + Promoção Automática

> Shipado em prod em 2026-07-04 (commit `c40ae7a`). Complementa a instrumentação
> de tentativas bloqueadas (mig 209) e o kanban Iniciados/Pre Screening (mig 230).

## O que é

Ciclo de vida completo de uma tentativa de postulação **bloqueada pelo gate de
cadastro incompleto**, do bloqueio até a entrada automática no funil:

1. Worker com cadastro incompleto clica "Postularse" → gate devolve 403 e grava
   a tentativa em `worker_blocked_applications`.
2. O card aparece na coluna **BLOQUEADO** do kanban da vacante (entre INVITED e
   INICIADO), com motivo, campos faltantes e contador de tentativas.
3. Quando o worker **completa o cadastro** (vira `REGISTERED`), a tentativa é
   promovida **automaticamente** para o funil como INICIADO — sem intervenção
   da operação. O card sai de BLOQUEADO e reaparece como card normal.

## Por que existe

Antes desta feature, quem era bloqueado ficava invisível no kanban (os cards
bloqueados existiam, mas mesclados dentro de INICIADO) e — pior — quem
completava o cadastro depois do bloqueio **nunca entrava no funil**: não havia
nenhum gatilho ligando "cadastro completo" a "tentativa bloqueada pendente".
Em 2026-07-03 havia 245 pares (worker, vaga) bloqueados sem application e 44
workers que já tinham completado o cadastro e estavam órfãos. O backfill da
mig 234 promoveu 42 deles no deploy (2 saíram do critério entre a análise e o
deploy).

Caso que motivou (Jennifer Silva, CASO 794-1841): bloqueada por documentos às
17:53, completou e re-postulou sozinha às 18:02, foi reprovada pelo
prescreening Talentum às 18:08 (`COMPLETED→REJECTED` automático, padrão de 34
casos/30 dias). Ela não tinha se perdido — mas os outros 44 órfãos sim.

## Como funciona

### Bloqueio (já existia — mig 209)

`POST /api/worker-applications/track-channel` → `assertWorkerCanApply`
(`modules/matching/domain/WorkerApplicationEligibility.ts`) lança 403 com
`missingFields` calculados por `fn_worker_missing_fields` (SSOT, versão vigente
na mig 212, espelha `fn_guard_registered_status`). O controller grava via
`RecordBlockedAttemptUseCase` → upsert em `worker_blocked_applications`
(UNIQUE `(worker_id, job_posting_id)`, incrementa `attempt_count`).

### Coluna BLOQUEADO no kanban

`GET /api/admin/vacancies/:id/funnel` (`WJAFunnelController`) devolve o bucket
`stages.BLOQUEADO` separado de `INICIADO`. A query
(`BlockedApplicationQueryRepository.listByVacancy`) só lista tentativas **sem
WJA no par** (`NOT EXISTS` contra `worker_job_applications`, qualquer stage) —
por isso a coluna esvazia sozinha quando a promoção cria a application.
Frontend: `KanbanBoard.tsx` (`COLUMN_CONFIG`, coluna com header de alerta
vermelho, não-droppable; cards bloqueados não têm `encuadreId` → não-dragáveis).

### Promoção automática (transactional outbox)

```
Worker completa cadastro (general-info / documents / availability / service-area / review)
  |  recalculateWorkerStatus (WorkerStatusRepository) — ponto ÚNICO da transição
  |  BEGIN
  |    UPDATE workers SET status='REGISTERED'
  |    INSERT domain_events ('worker.mirror_requested')        -- espelho AnaCare (já existia)
  |    INSERT domain_events ('worker.registration_completed')  -- NOVO, mesma transação
  |  COMMIT                                                    -- atômico: ou tudo, ou nada
  |  pubsub.publish('worker-registration-completed')           -- best-effort, só latência
  v
Pub/Sub push → POST /api/internal/events/process
  |  DomainEventProcessor → handler 'worker.registration_completed' (index.ts)
  v
PromoteBlockedApplicationsUseCase.execute(workerId)
  |  para cada linha de worker_blocked_applications sem promoted_at:
  |    guarda a: vaga existe, deleted_at IS NULL, is_draft=false, status<>'CLOSED'
  |    guarda b: NOT EXISTS WJA no par — QUALQUER stage (não ressuscita REJECTED)
  |    guarda c: worker REGISTERED e merged_into_id IS NULL (re-verificado no handler)
  |    → CreateManualWjaWithEncuadreUseCase (WJA source='manual', stage='INVITED' = coluna INICIADO)
  |    → UPDATE worker_blocked_applications SET promoted_at=NOW(), promoted_wja_id=<id>
  |  falha em uma linha não impede as outras; violação de UNIQUE = skip, nunca erro
  v
Cloud Scheduler → POST /api/internal/events/sweep   -- safety net p/ eventos órfãos (>5min)
```

### Por que evento/outbox e não um UPDATE inline?

Pergunta recorrente: "não é só mudar um status na tabela?" Não — o gatilho é um
UPDATE simples, mas a **consequência** é um conjunto de escritas condicionais em
outro módulo (matching): checar vaga, checar WJA existente, criar application +
encuadre, auditar a promoção. As alternativas foram avaliadas no parecer do
Architect e descartadas:

- **Inline na transação do cadastro**: acopla a latência/falha da promoção ao
  "salvar documentos" do prestador (bug na promoção = 500 no cadastro), viola a
  fronteira worker→matching, e **não tem retry**: se o processo cair entre o
  commit do status e a promoção, a intenção se perde para sempre — exatamente o
  bug de órfãos que a feature corrige.
- **Trigger no banco**: esconde regra de negócio rica em SQL (guardas de vaga,
  merge, dedup), difícil de testar; triggers já custaram deploys quebrados
  (ver mig 230 e histórico em `docs/FOLLOWUPS.md`).
- **Job periódico varrendo a tabela**: duplicaria o mecanismo de entrega que já
  existe (outbox + sweep).

O Pub/Sub **não é** o mecanismo de garantia — é só o entregador de baixa
latência. A garantia é o outbox: o evento nasce na mesma transação do status;
se o publish falhar, o sweep reprocessa. Mesma infraestrutura do espelho
AnaCare (ver [event-infrastructure.md](event-infrastructure.md)) — o custo da
feature foi 1 evento + 1 handler, zero infra nova.

## Schema

| Migration | O que faz |
|---|---|
| 209 | `worker_blocked_applications` + `fn_worker_missing_fields` (original) |
| 212 | `fn_worker_missing_fields` vigente (relaxou DNI verso) |
| 233 | `promoted_at TIMESTAMPTZ` + `promoted_wja_id UUID` + índice parcial `WHERE promoted_at IS NULL` |
| 234 | Backfill idempotente dos órfãos históricos (padrão da 213: `DO $$` + loop + skip por linha). **INVARIANTE**: espelha as guardas de `PromoteBlockedApplicationsUseCase.ts` — mudou o use case, mude a migration junto |

## Testes

- **Backend E2E** `worker-functions/tests/e2e/blocked-application-promotion.e2e.test.ts`:
  fluxo completo com banco real — 403 → card em BLOQUEADO → cadastro completado
  via API → evento na transação → `/api/internal/events/process` → WJA criada →
  card em INICIADO.
- **Frontend E2E visual** `enlite-frontend/e2e/integration/kanban-iniciado-blocked-columns.integration.e2e.ts`
  (K1–K7): bloqueio real pelo gate (zero seed SQL no caminho de negócio),
  promoção com cadastro completado pelos endpoints reais, e jornada do
  promovido até SELECTED (webhook Talentum real + drag real), screenshot
  assertion em cada etapa.
- Unit: `PromoteBlockedApplicationsUseCase.test.ts` (guardas, idempotência,
  UNIQUE→skip), `CreateManualWjaWithEncuadreUseCase.test.ts`,
  `WorkerStatusRepository.test.ts` (segundo evento na transação).

Pegadinhas de teste (aprendidas na implementação):

- `UPDATE workers SET status='REGISTERED'` direto no SQL **não testa nada**: o
  evento só nasce via `recalculateWorkerStatus` (e o trigger de guarda do banco
  pode rejeitar o UPDATE). Complete o cadastro pelos endpoints reais.
- O sweep só processa eventos com **>5 min** de idade; em teste, use
  `POST /api/internal/events/process` com o `eventId` (simulação do push).
- Com 9 colunas, SELECTED fica fora do viewport 1920px — scrollar o board
  (`board.scrollLeft = board.scrollWidth`) antes de drag/screenshot.

## Operação

- **Promoção não aconteceu?** Checar `domain_events` com
  `event='worker.registration_completed'` e `status='pending'`/`'failed'` para o
  worker. O sweep do Cloud Scheduler reprocessa pendentes; `failed` tem
  `last_error`. Auditoria por linha: `worker_blocked_applications.promoted_at`
  / `promoted_wja_id`.
- **Worker completou mas continua em BLOQUEADO?** Provavelmente caiu numa
  guarda: vaga fechada/draft/deletada, ou já existe WJA no par (inclusive
  REJECTED — comportamento intencional; caso Jennifer). O card só some quando
  existe WJA no par.
- **Edge conhecido (TD)**: tentativas bloqueadas registradas sob um `worker_id`
  que depois foi *merged* não são promovidas (a promoção dispara com o id do
  sobrevivente; `worker_blocked_applications` não é reescrita no merge).

## Referências

- [event-infrastructure.md](event-infrastructure.md) — outbox, sweep, Pub/Sub
- [talentum-prescreening-kanban.md](talentum-prescreening-kanban.md) — kanban e stages
- [worker-job-applications/README.md](worker-job-applications/README.md) — WJA como SSOT do funil
- `blocked-attempts-modal/` — modal do lado do worker + página admin de Postulaciones bloqueadas
