# Postmortem — Bugs do Funil/Kanban da vaga (Talentum)

> ⚠️ **Documento histórico (2026-05-22).** Originou a consolidação WJA ≡ Encuadre.
> Para o modelo canônico do funil hoje, ver **[features/worker-job-applications/](features/worker-job-applications/README.md)**.
> Trechos que descreviam encuadre como entidade separada de WJA, pipeline `encuadres → WJA`,
> ou Kanban com 7+ colunas foram superados pela decisão de 2026-05-23.

> **Data do diagnóstico:** 2026-05-22
> **Severidade:** Alta — afeta visibilidade operacional do estado de candidatos
> **Status:** 2 bugs corrigidos em código, 2 bugs pendentes de fix, 1 backfill pendente

---

## 1. Resumo executivo

A operação reportou dois sintomas:

1. Vagas com 20+ pessoas em "POSTULADOS" na visão lista, mas Kanban vazio quando trocava de visualização.
2. Vagas onde todos os candidatos pareciam "presos" em "Iniciado" indefinidamente.

A investigação descobriu **5 bugs distintos** que se reforçavam, todos relacionados ao funil interno (`worker_job_applications.application_funnel_stage`) e à integração Talentum. Os bugs #4 e #8 foram corrigidos com uma rede de segurança de 17 testes E2E backend + 7 cenários visuais frontend; os bugs #1, #2 e #3 ainda têm fix pendente.

Adicionalmente, durante a investigação ficou explícito um problema **arquitetural** — o funil interno está acoplado ao vocabulário Talentum, o que bloqueia a adoção de futuros providers de triagem. Decisão registrada em [`memory/project_funnel_internal_abstract.md`](.).

---

## 2. Inventário dos bugs

| # | Bug | Severidade | Volume em prod | Status |
|---|---|---|---|---|
| #1 | Admin manual cria WJA sem encuadre correspondente | Média | 183 órfãs | Pendente |
| #2 | Webhook Talentum em edge case não cria encuadre | Baixa | 30 órfãs | Pendente |
| #3 | `SyncTalentumWorkersUseCase` cria WJA sem `application_funnel_stage` | Reclassificada — ver §5 | 1.332 em `INITIATED` (estado correto) | **Resolvido por design** (TD-035) |
| #4 | UPSERT de WJA regride stage em out-of-order delivery | **Alta** | 2 confirmados, potencial centenas | **Corrigido** ([TalentumPrescreeningRepository.ts:157-196](../worker-functions/src/modules/matching/infrastructure/TalentumPrescreeningRepository.ts#L157-L196)) |
| #8 | `handleNotQualifiedTransition` faz UPDATE em `encuadres` antes do INSERT | Alta (integridade) | 2 confirmados | **Corrigido** ([ProcessTalentumPrescreening.ts:194-205](../worker-functions/src/modules/matching/application/ProcessTalentumPrescreening.ts#L194-L205)) |

*Numeração não-sequencial reflete a ordem em que foram descobertos durante a investigação.*

---

## 3. Diagnóstico do funil — modelo mental antes da investigação vs. realidade

### O que a operação esperava

```
INVITADO (clicou no link) → INICIADO (entrou no WhatsApp) → EN PROGRESO (1ª pergunta Talentum)
  → COMPLETADO (terminou Talentum, com subtag QUALIFIED/NOT_QUALIFIED)
```

### O que o código tinha

- `worker_job_applications.application_funnel_stage` é o funil — fonte da verdade.
- Vocabulário do enum copiado **1:1 do Talentum** (`INITIATED`, `IN_PROGRESS`, `COMPLETED`, `QUALIFIED`, `NOT_QUALIFIED`).
- Default da coluna é `INITIATED` quando a WJA é criada sem `application_funnel_stage` explícito.
- Guard em [`EncuadreRepository.ts:227-231`](../worker-functions/src/modules/matching/infrastructure/EncuadreRepository.ts#L227-L231) impedia qualquer fonte diferente de `talentum` de atualizar o stage.

### Quais entidades alimentam quais views

| View | Endpoint | Lê de | Mostra |
|---|---|---|---|
| Lista / Aba POSTULADOS | `GET /api/admin/vacancies/:id/funnel-table?bucket=POSTULATED` | `worker_job_applications` | TODOS os candidatos com stage ∈ `{INITIATED, IN_PROGRESS, COMPLETED}` |
| Kanban | `GET /api/admin/vacancies/:id/funnel` | `encuadres LEFT JOIN worker_job_applications` | SÓ quem tem linha em `encuadres` |

**O sintoma "20 na lista, 0 no Kanban" se explica:** WJA existe mas não há `encuadre` correspondente. O `encuadre` só nasce em 3 cenários ([VacancyAutoInviteHandler](../worker-functions/src/shared/events/handlers/VacancyAutoInviteHandler.ts), [ProcessTalentumPrescreening.ensureEncuadre](../worker-functions/src/modules/matching/application/ProcessTalentumPrescreening.ts), [WorkerApplicationsController.trackChannel](../worker-functions/src/modules/matching/interfaces/controllers/WorkerApplicationsController.ts)) — fora deles, a WJA fica órfã.

---

## 4. Bugs corrigidos

### Bug #4 — Regressão de stage por out-of-order delivery

**Causa raiz:** o webhook Talentum, ao processar `subtype='ANALYZED'`, faz UPSERT em `worker_job_applications` sobrescrevendo `application_funnel_stage` incondicionalmente. Se o Talentum entrega eventos fora de ordem (cenário comum em sistemas distribuídos), um evento mais antigo regride o stage avançado. Ex: `QUALIFIED` é setado, depois chega um `INITIATED` tardio → WJA volta a `INITIATED`.

**Evidência:**

```
SELECT tp.status AS talentum, wja.application_funnel_stage AS funnel, COUNT(*) AS qtd
FROM talentum_prescreenings tp
JOIN worker_job_applications wja USING (worker_id, job_posting_id)
WHERE tp.status = 'ANALYZED'
GROUP BY 1, 2;

talentum  | funnel        | qtd
----------+---------------+----
ANALYZED  | QUALIFIED     | 92   ← caminho feliz
ANALYZED  | NOT_QUALIFIED | 3    ← caminho feliz
ANALYZED  | INITIATED     | 2    ← BUG (regrediu)
ANALYZED  | COMPLETED     | 1    ← suspeito
ANALYZED  | IN_DOUBT      | 18
ANALYZED  | REJECTED      | 3
ANALYZED  | CONFIRMED     | 1
```

**Fix aplicado:** [TalentumPrescreeningRepository.ts:157-196](../worker-functions/src/modules/matching/infrastructure/TalentumPrescreeningRepository.ts#L157-L196) — UPSERT agora usa CASE de precedência canônica:

```
INVITED(0) < INITIATED(1) < IN_PROGRESS(2) < COMPLETED(3)
  < ANALYZED|IN_DOUBT(4) < QUALIFIED|NOT_QUALIFIED|REPROGRAM(5)
  < CONFIRMED(6) < SELECTED|PLACED|REJECTED|RECHAZADO(7)
```

Eventos com precedência ≥ atual passam; precedência menor mantém o stage atual. Stage desconhecido = -1 (nunca substitui).

**Cobertura de regressão:**
- [`talentum-prescreening-funnel-regression.test.ts`](../worker-functions/tests/e2e/talentum-prescreening-funnel-regression.test.ts) — testes D, E, #6, #7

### Bug #8 — Ordering encuadre/WJA dentro de `syncFunnelAndEncuadre`

**Causa raiz:** em [`ProcessTalentumPrescreening.syncFunnelAndEncuadre`](../worker-functions/src/modules/matching/application/ProcessTalentumPrescreening.ts), o `handleNotQualifiedTransition` fazia `UPDATE encuadres SET resultado='RECHAZADO'` **antes** de o `ensureEncuadre` ter feito o INSERT. Resultado: o UPDATE afetava 0 rows, encuadre nascia com `resultado=NULL` mesmo após `NOT_QUALIFIED`.

**Fix aplicado:** reordenado em [ProcessTalentumPrescreening.ts:194-205](../worker-functions/src/modules/matching/application/ProcessTalentumPrescreening.ts#L194-L205):

```
Antes: upsertApplicationAndEmitEvent() → ensureEncuadre()
Depois: ensureEncuadre() → upsertApplicationAndEmitEvent()
```

**Cobertura:** [`talentum-prescreening-funnel-edge-cases.test.ts`](../worker-functions/tests/e2e/talentum-prescreening-funnel-edge-cases.test.ts) — teste #8.

---

## 5. Bugs pendentes

### Bug #3 — `SyncTalentumWorkersUseCase` cria WJA sem stage

**Causa raiz original:** [SyncTalentumWorkersUseCase.ts:277-283](../worker-functions/src/modules/integration/application/SyncTalentumWorkersUseCase.ts#L277-L283) sincroniza workers do dashboard Talentum criando WJA com `source='talentum'` sem setar `application_funnel_stage`. Combinado com o guard em [`EncuadreRepository.ts:227-231`](../worker-functions/src/modules/matching/infrastructure/EncuadreRepository.ts#L227-L231) que protegia WJAs `source='talentum'` contra atualização, as WJAs ficavam eternamente em `INITIATED`.

**Evidência:**

| source | acquisition_channel | qtd em INITIATED |
|---|---|---|
| talentum | (null) | 1.332 |
| manual | (null) | 123 |
| manual | site | 111 |
| talent_search | (null) | 11 |
| candidatos | (null) | 10 |
| planilla_operativa | (null) | 3 |
| talentum | site | 1 |

97% deles (2.044 de 2.065 com idade > 3 dias) **não têm registro em `talentum_prescreenings`** — confirma que vieram via dashboard sync, não via webhook.

**Spike temporal:** 1.447 WJAs criadas na semana de 2026-05-11 — bate com janela de sync em massa.

---

**Reclassificação após investigação aprofundada (2026-05-22):**

A discussão inicial tratou esses 1.332 como dado errado a ser corrigido por backfill. Durante a investigação da Opção B (sync que aplica `profile.status` global no funil), o dono do produto esclareceu o modelo de domínio:

> *"Worker tem um status, MAS eles precisam ter um status para CADA ENCUADRE. A Talentum só mexe nos status de ENCUADRE. Quando o prestador entra via Talentum é criado um encuadre para ele para AQUELA VAGA."*

E quando perguntado se a Talentum expõe status per-encuadre via API:

> *"Sim, é um webhook."*

**Implicação:** o webhook `PRESCREENING_RESPONSE` é a **única fonte canônica per-encuadre** de `application_funnel_stage`. O `profile.status` global no payload `TalentumDashboardProfile` é informação agregada per-worker, sem semântica per-(worker, vaga). Usá-lo como fonte do funil contamina dado clínico.

Os 1.332 presos em `INITIATED` portanto **estão no estado correto operacionalmente**: workers cadastrados como candidatos via dashboard mas que nunca tiveram webhook canônico per-encuadre (provavelmente nunca entraram no WhatsApp daquela vaga ou abandonaram antes). `INITIATED` aqui é o default técnico que reflete a realidade — não evolução posterior porque não houve sinal canônico per-encuadre.

**O que foi feito (TD-035, implementado):**

1. ✓ Guard `source='talentum'` removido em `EncuadreRepository.syncToWorkerJobApplications` — proteção contra regressão agora vem do CASE de precedência canônica (mesma do fix #4), não da fonte
2. ✓ Migration 185 — função SQL `funnel_stage_precedence(text) RETURNS int IMMUTABLE` reutilizável
3. ✓ `FunnelStageMapper` interface + `TalentumFunnelStageMapper` extraídos de `ProcessTalentumPrescreening.deriveFunnelStage` — preparam terreno pro TD-037 sem mudar comportamento atual
4. ✓ Migration 183 (`enforce_worker_registered_for_application`) atualizada para incluir `'talentum'` no bypass — workers `INCOMPLETE_REGISTER` continuam sendo aceitos no sync (autoCreateWorker)
5. ✓ `SyncTalentumWorkersUseCase` simplificado: **nunca seta `application_funnel_stage`**. Insere com colunas mínimas, `ON CONFLICT DO NOTHING`, stage cai no default `INITIATED`. Único caminho, sem branches, sem decider.
6. ✓ Suite de testes E2E: 21/21 passing (8 transition + 4 regression + 6 edge-cases + 3 sync)

**O que NÃO precisa ser feito:**

- Backfill via re-sync dos 1.332 — **cancelado**. Estado é correto.
- `SyncTalentumWorkersUseCase` aplicar `profile.status` — **rejeitado**. Contamina modelo per-encuadre.
- Coluna nova para `talentum_profile_status` global — não solicitado pela operação. Se UI quiser exibir, lê do dashboard direto.

**Próximo passo (operacional, não técnico):** sinalizar na UI que cards "stuck in INITIATED há N dias com source talentum e sem prescreening" são casos de "candidato cadastrado mas sem retorno do worker", não bugs do sistema. Ver TD-040.

**Tracking:** TD-035 em `docs/FOLLOWUPS.md` — marcado como concluído com nota da reclassificação. TD-040 (novo) cobre a sinalização UI.

### Bugs #1 e #2 — WJA órfãs sem encuadre

215 WJAs em `POSTULATED` sem encuadre correspondente. 183 vieram do admin manual (path não chama `ensureEncuadre`), 30 do webhook em edge cases. Quando aparecerem na lista mas sumirem do Kanban — esse é o caso.

**Tracking:** TD-036 em `docs/FOLLOWUPS.md`.

---

## 6. Decisão arquitetural — Funil interno abstrato

Tomada em 2026-05-22 durante a investigação. Detalhes em `memory/project_funnel_internal_abstract.md`.

**Contrato novo:**

| Conceito | Antes | Agora |
|---|---|---|
| `worker_job_applications.application_funnel_stage` | Vocabulário Talentum copiado | **Funil interno Enlite** (vocabulário herdado da Talentum, mas conceitualmente Enlite) |
| Valor `QUALIFIED` | "Talentum disse qualificado" | "Enlite considera qualificado" (qualquer provider certificado) |
| Guard `source='talentum'` é imutável | Existe em 2 lugares | **Será removida** quando bug #3 for fixado |
| Mapper provider→funil | Implícito (identity) | **Explícito** — cada provider tem `FunnelStageMapper` próprio |

A operação aprovou usar **o vocabulário Talentum como referência canônica** para o funil interno. Futuros providers traduzem seus estados pra esse vocabulário; Talentum vira UM provider entre vários, sem privilégios.

**Tracking de implementação completa:** TD-037 em `docs/FOLLOWUPS.md`.

---

## 7. Métricas operacionais (snapshot prod 2026-05-22)

```
Vagas abertas: 6.819 WJAs ativas
  - IN_PROGRESS: 2.473 (idade média 27 dias)  ← maior bucket, funil saudável
  - INITIATED:   1.694 (idade média 10 dias)  ← 2.044 com >3 dias = bug #3
  - QUALIFIED:   1.217
  - NOT_QUALIFIED: 1.208
  - INVITED:     151
  - IN_DOUBT:    57
  - CONFIRMED:   3
  - REJECTED:    3
  - COMPLETED:   2
  - SELECTED:    1

Webhooks Talentum recebidos últimos 30 dias: 7-46/dia (saudável, sem silêncio)
```

---

## 8. Rede de segurança criada

### Backend (`worker-functions`)
- **17 testes E2E** em 3 arquivos cobrindo happy paths, regressões out-of-order, edge cases, side effects, idempotência, domain events:
  - [`tests/e2e/talentum-prescreening-funnel-transition.test.ts`](../worker-functions/tests/e2e/talentum-prescreening-funnel-transition.test.ts) (308 linhas)
  - [`tests/e2e/talentum-prescreening-funnel-regression.test.ts`](../worker-functions/tests/e2e/talentum-prescreening-funnel-regression.test.ts) (384 linhas)
  - [`tests/e2e/talentum-prescreening-funnel-edge-cases.test.ts`](../worker-functions/tests/e2e/talentum-prescreening-funnel-edge-cases.test.ts) (336 linhas)

### Frontend (`enlite-frontend`)
- **7 cenários E2E integration** com snapshots visuais (PNG commitados):
  - [`e2e/integration/vacancy-kanban-talentum-webhook.integration.e2e.ts`](../enlite-frontend/e2e/integration/vacancy-kanban-talentum-webhook.integration.e2e.ts) (350 linhas)
  - [`e2e/helpers/talentumWebhookHelper.ts`](../enlite-frontend/e2e/helpers/talentumWebhookHelper.ts) (261 linhas)
- `data-testid` adicionados em [KanbanBoard.tsx](../enlite-frontend/src/presentation/components/features/admin/Kanban/KanbanBoard.tsx), [KanbanColumn.tsx](../enlite-frontend/src/presentation/components/features/admin/Kanban/KanbanColumn.tsx), [KanbanCard.tsx](../enlite-frontend/src/presentation/components/features/admin/Kanban/KanbanCard.tsx)

**Como rodar:** ver [`runbooks/RUNBOOK_KANBAN_FUNNEL_TESTING.md`](./runbooks/RUNBOOK_KANBAN_FUNNEL_TESTING.md).

---

## 9. Lições aprendidas

1. **Cópia de vocabulário sem tradução acopla domínio interno a fonte externa.** O enum `application_funnel_stage` virou prisioneiro do Talentum. Decisão arquitetural acima descola isso.
2. **UPSERT sem precedência sempre vai sofrer com out-of-order delivery.** Qualquer integração assíncrona precisa de protection contra regressão (timestamp do payload, precedência de estado, ou idempotency key).
3. **Bugs de ordenação dentro de transação são difíceis de pegar sem teste E2E.** O teste #8 só falhou porque assertou o estado FINAL de `encuadres.resultado`, não a sequência de queries.
4. **DraggableCard e KanbanCard com mesmo `data-testid`** quase passou despercebido — Playwright `.locator()` pega o primeiro match silenciosamente. Lição: testar a uniqueness de testids quando wrapper + inner compartilham ID.
5. **Vite dev server pode estar rodando de outro diretório** sem aviso. Conferir `ps aux | grep vite` antes de depurar "minha mudança não chegou no navegador".

---

## 10. Próximos passos

- [ ] Executar backfill — ver [`runbooks/RUNBOOK_KANBAN_FUNNEL_BACKFILL.md`](./runbooks/RUNBOOK_KANBAN_FUNNEL_BACKFILL.md)
- [ ] Implementar fix bug #3 + remover guard (TD-035)
- [ ] Implementar fix bug #1 (admin manual sem encuadre) (TD-036)
- [ ] Implementar arquitetura funil interno abstrato completa (TD-037)
- [ ] Considerar TD-038: separação semântica de `data-testid` em DraggableCard vs KanbanCard
