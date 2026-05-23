# 04 — Estados do funil e Kanban

## Kanban visível — 5 colunas

A tela administrativa de vagas exibe um Kanban com **5 colunas fixas**. Estados internos do enum `application_funnel_stage` agrupam-se nessas colunas conforme tabela abaixo.

| Coluna Kanban | Stages internos agrupados | Badges no card |
|---|---|---|
| **INVITADO** | `INVITED` | — |
| **INITIATED** | `INITIATED` | — |
| **IN_PROGRESS** | `IN_PROGRESS` | — |
| **COMPLETADO** | `COMPLETED`, `QUALIFIED`, `IN_DOUBT` | 🟢 "Aprovado Talentum" (QUALIFIED) · 🟡 "Em dúvida" (IN_DOUBT) · ⚪ "Aguardando análise" (COMPLETED puro) |
| **CONFIRMADO** | `CONFIRMED` | — |

## Estados fora do Kanban

| Estado interno | Destino | Razão |
|---|---|---|
| `NOT_QUALIFIED` | Auto-move para `REJECTED` | Talentum reprovou. Não há motivo operacional para manter visível no Kanban — vira REJECTED automaticamente (fase F3). |
| `REJECTED` | Não exibido no Kanban | Estado terminal negativo. Pode aparecer em outra tela (lista de rejeitados / histórico). |
| `RECHAZADO` | Consolidado em `REJECTED` | Duplicata em espanhol do mesmo estado. Eliminado na fase F2. |
| `SELECTED`, `PLACED` | Não exibido; deprecados | CONFIRMADO é estado terminal positivo do Kanban. Alocação efetiva ao paciente acontece em outra tela. Remoção em F7. |
| `REPROGRAM` | Não exibido; deprecado | Substituído por `interview_response='awaiting_reschedule'` na própria WJA. Sem coluna dedicada. Remoção em F7. |
| `ANALYZED` | Não exibido; deprecado | Estado transitório interno do Talentum (precedência 4, igual a IN_DOUBT). Sem uso real após F3. Remoção em F7. |

## Precedência canônica (não-regressão)

Stages têm ordem fixa — uma WJA nunca regride espontaneamente para um estado anterior. A função SQL `funnel_stage_precedence` (migration 185) define os pesos:

```
INVITED(0) < INITIATED(1) < IN_PROGRESS(2) < COMPLETED(3)
< ANALYZED(4) = IN_DOUBT(4)
< QUALIFIED(5) = NOT_QUALIFIED(5) = REPROGRAM(5)
< CONFIRMED(6)
< SELECTED(7) = PLACED(7) = REJECTED(7) = RECHAZADO(7)
```

Qualquer upsert que tente baixar a precedência é silenciosamente ignorado pelo SQL — não levanta erro, apenas mantém o estado atual.

**Exceção:** drag manual no Kanban (admin) **pode** mover para qualquer coluna, inclusive regredir. É uma operação intencional de correção e fica registrada em `worker_job_application_stage_history`.

## Como os badges são calculados

O endpoint `GET /api/admin/vacancies/:id/funnel` retorna cada card com:

```json
{
  "wja_id": "...",
  "worker_id": "...",
  "kanban_column": "COMPLETADO",
  "internal_stage": "QUALIFIED",
  "badge": "talentum_approved"
}
```

O frontend renderiza o badge a partir de `internal_stage`. A coluna do Kanban vem de `kanban_column` (já agrupado pelo backend).

## Trigger automático: QUALIFIED → envio de 3 meet links

A transição para `QUALIFIED` emite o domain event `funnel_stage.qualified`, consumido por `QualifiedInterviewHandler`, que enfileira mensagem WhatsApp interativa com até 3 botões (1 por meet link configurado na vaga).

Apenas `QUALIFIED` dispara o envio. `IN_DOUBT` e `COMPLETED` puros ficam parados até admin agir ou Talentum reanalisar.

Detalhes da transição em [05-fluxo-transicoes.md](05-fluxo-transicoes.md) (T6).
