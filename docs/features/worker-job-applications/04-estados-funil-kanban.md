# 04 — Estados do funil e Kanban

## Kanban visível — 7 colunas

A tela administrativa de vagas exibe um Kanban com **7 colunas fixas**. Estados internos do enum `application_funnel_stage` agrupam-se nessas colunas conforme tabela abaixo.

| # | Coluna Kanban | Stages internos agrupados | Badges no card | Drag permitido? |
|---|---|---|---|---|
| 1 | **INVITADO** | `INVITED` | — | ✅ Droppable (admin pode mover candidatos pra cá) |
| 2 | **INITIATED** | `INITIATED` | — | ❌ Não droppable (controle Talentum via webhook) |
| 3 | **IN_PROGRESS** | `IN_PROGRESS` | — | ❌ Não droppable (controle Talentum via webhook) |
| 4 | **COMPLETADO** | `COMPLETED`, `QUALIFIED`, `IN_DOUBT` | 🟢 "Aprovado Talentum" (QUALIFIED) · 🟡 "Em dúvida" (IN_DOUBT) · ⚪ "Aguardando análise" (COMPLETED puro) | ❌ Não droppable (controle Talentum via webhook) |
| 5 | **CONFIRMADO** | `CONFIRMED` | — | ✅ Droppable |
| 6 | **SELECTED** | `SELECTED` | — | ✅ Droppable |
| 7 | **REJECTED** | `REJECTED` | — | ✅ Droppable + acesso via botão "Rejeitar" no card |

**Regra de drag:** as 3 colunas intermediárias (INITIATED, IN_PROGRESS, COMPLETADO) refletem ações do prestador no fluxo Talentum — só são alteradas via webhook. As outras 4 (INVITADO, CONFIRMADO, SELECTED, REJECTED) aceitam drag manual do admin pra correções, casos especiais ou ações terminais.

## Rejeição manual

Como REJECTED é estado terminal negativo e exige justificativa, há mecanismo dedicado além do drag:

- **Botão "Rejeitar"** no card abre modal pedindo `rejection_reason_category` (categoria pré-definida) + texto livre opcional
- Move o card pra coluna REJECTED + grava `rejection_reason` + emite domain event `funnel_stage.rejected`
- Drag direto pra REJECTED também funciona, mas sem modal — admin é responsável por preencher motivo via edição posterior

## Estados fora do Kanban

| Estado interno | Destino | Razão |
|---|---|---|
| `NOT_QUALIFIED` | Auto-move para `REJECTED` | Talentum reprovou. Vira REJECTED automaticamente na F3 (migration 191). Removido do CHECK. |
| `RECHAZADO` | Consolidado em `REJECTED` | Duplicata em espanhol do mesmo estado. Eliminado na F2 (migration 190). |
| `REPROGRAM` | **REMOVIDO em F7.b (migration 195)** | Workers que pediam reschedule via WhatsApp agora ficam em `application_funnel_stage='CONFIRMED'` com `interview_response='awaiting_reschedule'` + `interview_meet_link=NULL` como distinguidor. Badge "🔄 REMARCADO" no card é derivado dessas duas flags (não mais do stage). ADR-003 seção F7.b. |
| `ANALYZED` | **Nunca esteve no CHECK de `worker_job_applications`** | É valor de transporte interno do mapper Talentum (`talentum_prescreenings.status`). `ProcessTalentumPrescreening` retorna `'ANALYZED'` quando `statusLabel='PENDING'` mas explicitamente pula upsert em WJA. Limpeza do tipo TS + `funnel_stage_precedence()` em **F7.a** (noop no banco). |
| `PLACED` | **REMOVIDO em F7.a (migration 194)** | 0 writers ativos após F6 (única fonte era `syncToWorkerJobApplications` deprecada). 0 linhas em prod. |

## Precedência canônica (não-regressão)

Stages têm ordem fixa — uma WJA nunca regride espontaneamente para um estado anterior. A função SQL `funnel_stage_precedence` (migration 185) define os pesos:

```
INVITED(0) < INITIATED(1) < IN_PROGRESS(2) < COMPLETED(3)
< IN_DOUBT(4)
< QUALIFIED(5)
< CONFIRMED(6)
< SELECTED(7) = REJECTED(7)
```

Stages removidos do enum em fases anteriores:
- `RECHAZADO` — consolidado em `REJECTED` na F2 (migration 190)
- `NOT_QUALIFIED` — auto-rejeitado pra `REJECTED` na F3 (migration 191)
- `ANALYZED` — nunca esteve no CHECK de WJA (transporte interno do mapper Talentum). Limpeza de tipo TS + função SQL em F7.a (noop no banco)
- `PLACED` — removido em F7.a (migration 194 — 0 writers ativos pós-F6, 0 linhas em prod)
- `REPROGRAM` — removido em F7.b (migration 195 — writer migrado pra `interview_response='awaiting_reschedule'` com `funnel_stage=CONFIRMED` preservado, 0 linhas em prod)

Qualquer upsert que tente baixar a precedência é silenciosamente ignorado pelo SQL — não levanta erro, apenas mantém o estado atual.

**Exceção:** drag manual no Kanban (admin) **pode** mover para qualquer coluna droppable, inclusive regredir. É uma operação intencional de correção e fica registrada em `worker_job_application_stage_history`.

## Como os badges são calculados

O endpoint `GET /api/admin/vacancies/:id/funnel` retorna cada card com:

```json
{
  "wja_id": "...",
  "worker_id": "...",
  "kanban_column": "COMPLETADO",
  "internal_stage": "QUALIFIED",
  "funnelStage": "QUALIFIED"
}
```

O frontend renderiza o badge a partir de `internal_stage` (apenas quando `kanban_column === 'COMPLETADO'`). A coluna do Kanban vem de `kanban_column` (já agrupado pelo backend).

**Campo `funnelStage`** é mantido por retrocompat durante F4 e será removido em F7 junto com outras limpezas.

**Labels dos badges:**

| internal_stage | PT-BR | ES |
|---|---|---|
| QUALIFIED | Aprovado Talentum | Aprobado Talentum |
| IN_DOUBT | Em dúvida | En duda |
| COMPLETED (puro) | Aguardando análise | En análisis |

## Trigger automático: QUALIFIED → envio de 3 meet links

A transição para `QUALIFIED` emite o domain event `funnel_stage.qualified`, consumido por `QualifiedInterviewHandler`, que enfileira mensagem WhatsApp interativa com até 3 botões (1 por meet link configurado na vaga).

Apenas `QUALIFIED` dispara o envio. `IN_DOUBT` e `COMPLETED` puros ficam parados até admin agir ou Talentum reanalisar.

Detalhes da transição em [05-fluxo-transicoes.md](05-fluxo-transicoes.md) (T6).

## Histórico de decisões

Em 2026-05-23, o user (Gabriel) inicialmente escolheu "CONFIRMADO terminal" — Kanban com 5 colunas e SELECTED/REJECTED fora. Em 2026-05-24, ao detalhar a implementação de F4, a decisão foi revisada para **manter 7 colunas com SELECTED e REJECTED visíveis**, com badges adicionados apenas em COMPLETADO. Razão: visibilidade operacional dos terminais — admin precisa ver quem foi selecionado/rejeitado sem trocar de tela.

Em F7.a (2026-05-24), `PLACED` foi removido do CHECK e da função de precedência (0 linhas em prod, sync F6 morta). Em F7.b (2026-05-25), `REPROGRAM` foi removido do CHECK e do precedence — workers que pedem reschedule agora ficam em `CONFIRMED` + `interview_response='awaiting_reschedule'` (ver ADR-003 seção F7.b). O badge "🔄 REMARCADO" no card permanece, mas é derivado dessas duas flags em vez do stage.
