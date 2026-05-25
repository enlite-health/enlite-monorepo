# 03 — SSOT por conceito

Cada dado da feature tem **uma única fonte da verdade** (Single Source of Truth). Esta tabela define qual.

## Tabela canônica

| Conceito | SSOT (tabela.coluna) | Tipo | Notas |
|---|---|---|---|
| Estado do funil | `worker_job_applications.application_funnel_stage` | enum VARCHAR(30) | Único campo com authority sobre a posição no Kanban. Precedência canônica via função SQL (migration 185). |
| Agendamento da entrevista — data/hora | `worker_job_applications.interview_datetime` | TIMESTAMPTZ | Substitui `encuadres.interview_date + interview_time`. |
| Agendamento da entrevista — link Meet | `worker_job_applications.interview_meet_link` | TEXT | Substitui `encuadres.meet_link`. |
| Agendamento da entrevista — slot escolhido | `worker_job_applications.interview_slot_id` | UUID FK | FK para `interview_slots`. Slot é entidade independente. |
| Estado da resposta à entrevista | `worker_job_applications.interview_response` | VARCHAR(30) | `pending`, `confirmed`, `declined`, `awaiting_reschedule`, etc. |
| Origem da candidatura | `worker_job_applications.source` | VARCHAR(50) | `system` (match automático), `manual` (admin drag ou worker link público), `talentum` (provider externo). ADR-004: providers de prescreening plugáveis — Talentum é um deles. Substitui `encuadres.origen`. |
| Canal de aquisição | `worker_job_applications.acquisition_channel` | VARCHAR(50) | `system` (match automático), `facebook`/`instagram`/`whatsapp`/`linkedin`/`site` (link público), NULL pros demais. |
| Score de match | `worker_job_applications.match_score` | NUMERIC | Calculado pelo matchmaking. |
| Histórico de transições de stage | `worker_job_application_stage_history` | tabela completa | Trilha de auditoria (insert-only). |
| Estado externo no Talentum | `talentum_prescreenings.status` | VARCHAR | Log do que o Talentum reporta. Não confundir com `wja.application_funnel_stage` (que é o estado interno derivado). |
| Slots fixos definidos pelo coordenador | `interview_slots` | tabela completa | Bloco de horário + meet link + capacidade. Independente de WJA. |
| Documentação verificada na entrevista presencial | `encuadres.has_cv`, `has_dni`, `has_cert_at`, `has_afip`, `has_cbu`, `has_ap`, `has_seguros` | BOOLEAN | **Legado.** Dados da planilha. Sem duplicata em WJA. |
| Observações textuais pós-entrevista | `encuadres.obs_reclutamiento`, `obs_encuadre`, `obs_adicionales` | TEXT | **Legado.** Dados da planilha. Sem duplicata em WJA. |
| Resultado narrativo da entrevista presencial | `encuadres.resultado` | enum VARCHAR | **Legado, sem authority.** Não dispara transição de stage. Apenas histórico narrativo. |
| Role da candidatura (TITULAR / RAPID_RESPONSE) | `encuadres.role` | VARCHAR(20) | **Legado.** Sem equivalente em WJA. Manter enquanto o conceito tiver uso operacional. |

## Campos com authority dupla — RESOLVIDO

Antes de 2026-05-23, os seguintes campos tinham authority dupla (dois lugares gravando, COALESCE na leitura). Após esta documentação, o pipeline para o lado deprecado é eliminado nas fases F2-F8:

| Conceito | Antes (duplicado) | Agora (SSOT único) |
|---|---|---|
| Data/hora da entrevista | `wja.interview_datetime` + `encuadres.interview_date+time` | `wja.interview_datetime` |
| Link Meet | `wja.interview_meet_link` + `encuadres.meet_link` | `wja.interview_meet_link` |
| Estado/resultado | `wja.application_funnel_stage` + `encuadres.resultado` | `wja.application_funnel_stage` |
| Origem | `wja.source` + `encuadres.origen` | `wja.source` |

## Campos deprecados, sem substituição (apenas removidos)

| Campo | Por quê |
|---|---|
| `worker_job_applications.application_status` | **REMOVIDO em F7.c (migration 196)** — legado pré-funil canônico, 100% redundante com `application_funnel_stage + source`. Discovery DBA mostrou 12.258 rows com divergências estruturais (448 rows `applied + QUALIFIED`, 3 rows `rejected + QUALIFIED`) — campo nunca foi atualizado após INSERT, virou stale. `alreadyApplied` no `/match-results` derivado de `source != 'system' OR messaged_at != null OR funnel_stage != 'INVITED'`. |
| Estado `ANALYZED` em `application_funnel_stage` | Nunca esteve no CHECK de WJA — só é valor de transporte interno do mapper Talentum (`talentum_prescreenings.status`). Limpeza do tipo TS + `funnel_stage_precedence()` em **F7.a**. |
| Estado `PLACED` em `application_funnel_stage` | 0 writers ativos (sync deprecada em F6), 0 linhas em prod. Remoção segura em **F7.a** com UPDATE preventivo defensivo. |
| Estado `REPROGRAM` em `application_funnel_stage` | **Writer ATIVO** em `HandleReminderResponseUseCase.handleRescheduleYes:192` (worker pede reschedule via WhatsApp). Remoção em **F7.b** após decisão de produto (ADR-003 ampliado) sobre destino canônico. |
| Estado `SELECTED` em `application_funnel_stage` | **MANTÉM** — F4 fixou como coluna do Kanban (estado terminal positivo após admin confirmar candidatura). |
| `encuadres.origen` (como classificador de origem) | Substituído por `wja.source`. **F8 (2026-05-25)**: renomeado para `encuadres.import_source_audit` — auditoria de import histórico apenas, sem authority de classificação de origem. SSOT real é `wja.source`. |

## Princípio operacional

> **Quem escreve um dado é dono dele.** Se um campo é gravado por mais de um pipeline, ele NÃO é SSOT.

Antes de criar uma nova coluna ou tabela:

1. Verificar se o dado já existe em `worker_job_applications`.
2. Se existir, usar a coluna existente.
3. Se for genuinamente novo, criar em `worker_job_applications` (não em `encuadres`).
4. Nunca criar pipeline reverso (e.g. "sincronizar X para Y").
