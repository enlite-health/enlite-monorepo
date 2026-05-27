# 04 — Estados e Status

Sete status canônicos em `job_postings.status` (CHECK constraint reinstalado na migration 137, Fase 3 do `SPRINT_VACANCIES_REFACTOR`).

> **Importante:** "draft" e "status" são EIXOS INDEPENDENTES (migration 168). `job_postings.is_draft` (boolean) controla se a vaga já passou pela publicação Talentum; `job_postings.status` é o estado operacional que o operador escolhe no Step 1 (default `SEARCHING`). Vaga pode ser `is_draft=true` com `status='SEARCHING_REPLACEMENT'` — coerente. Veja [09-edicao-e-restricoes.md](09-edicao-e-restricoes.md) pro gate de edição.

## Tabela canônica

| Status | Significado operacional | Público (endpoint `/api/public/v1/jobs`)? | Visível no painel admin? |
|---|---|---|---|
| `PENDING_ACTIVATION` | Status reservado pra vagas que aguardam reativação operacional; raramente usado na criação (default real do form é `SEARCHING`) | ❌ | ✅ (tab "Rascunhos") |
| `SEARCHING` | Búsqueda ativa — vaga publicada, captando candidatos | ✅ | ✅ |
| `SEARCHING_REPLACEMENT` | Reemplazo — prestador anterior saiu, busca substituto | ✅ | ✅ |
| `RAPID_RESPONSE` | Equipo de respuesta rápida — mantém captação mesmo com time formado pra cobertura de emergências | ✅ | ✅ |
| `ACTIVE` | Tem prestador alocado, sem time de resposta rápida | ❌ | ✅ |
| `SUSPENDED` | Suspendido temporalmente (paciente internado, viagem, etc.) | ❌ | ✅ |
| `CLOSED` | Encerrada (baja, alta clínica, paciente discontinued) | ❌ | ✅ (tab "Encerradas") |

## Transições

```
                  ┌────────────────────────┐
                  │   is_draft = true      │  ← criação (default da coluna)
                  │   status = 'SEARCHING' │     (default real do form)
                  │  (rascunho — wide edit)│
                  └───────────┬────────────┘
                              │ publish via Step 2 (Talentum)
                              │ flippa is_draft → false
                              ▼
   ┌──────────────────────────────────────────────────────┐
   │  SEARCHING ──► SEARCHING_REPLACEMENT ──►             │  ← públicos
   │     ▲ ▲                                              │
   │     │ │                                              │
   │     │ └── RAPID_RESPONSE                             │
   │     │            │                                   │
   │     └────────────┘                                   │
   └──────────────────────────────────────────────────────┘
                              │
                              ▼
                          ACTIVE             ← prestador alocado
                          │   │
                          │   ▼
                          │  SUSPENDED       ← paciente internado etc.
                          │   │
                          ▼   ▼
                         CLOSED              ← terminal (soft-delete)
```

**Notas operacionais:**

- Transições são livres dentro do banco (sem state machine). O controller PUT permite qualquer status canônico.
- **Gate de edit amplo é `is_draft`, não status:** enquanto `is_draft = true` (vaga ainda não passou pela publicação Talentum) TODOS os campos do form são editáveis. Quando `is_draft` vira `false` (publicação) o controller restringe pra `OPERATIONAL_EDITABLE_FIELDS = { schedule, status }` (helper `authorizeVacancyUpdate` em `vacancyCrudHelpers.ts`). Não dá pra trocar paciente, perfil ou endereço de uma vaga já publicada — abrir nova.
- **DELETE é soft:** `DELETE /api/admin/vacancies/:id` faz `UPDATE job_postings SET status = 'CLOSED'`, não remove a row.
- **Sync ClickUp paciente como `admisión`:** mapper retorna `[]` (skip) — vaga não é criada (memória `project_admission_is_patient_status`).
- **Mudança de endereço do paciente NÃO altera status da vaga.** Decisão deliberada: vaga preserva o endereço que tinha na criação ([06-endereco-servico.md](06-endereco-servico.md)). Se a mudança implica que o atendimento mudou de área geográfica, é operador quem decide fechar a vaga antiga e criar nova.

## Visibilidade

- **Public statuses** (`/api/public/v1/jobs`): `SEARCHING | SEARCHING_REPLACEMENT | RAPID_RESPONSE`. Mais filtro: `social_short_links ? 'site'`.
- **Kanban (frontend):** consome `WJAFunnelController` — não filtra por status da vaga, e sim por estágio de WJA. Vagas em `CLOSED` continuam visíveis no Kanban se ainda tiverem WJAs ativas (histórico).

## Status legados

| Antigo | Canônico atual |
|---|---|
| `BUSQUEDA` / `searching` | `SEARCHING` |
| `REEMPLAZO` / `REEMPLAZOS` / `replacement` | `SEARCHING_REPLACEMENT` |
| `rta_rapida` / `EQUIPO RESPUESTA RAPIDA` / `FULLY_STAFFED` | `RAPID_RESPONSE` |
| `EN ESPERA` / `ACTIVACION PENDIENTE` | `PENDING_ACTIVATION` |
| `ACTIVO` / `active` | `ACTIVE` |
| `SUSPENDIDO TEMPORALMENTE` | `SUSPENDED` |
| `CLOSED` / `paused` / `closed` / NULL | `CLOSED` |
