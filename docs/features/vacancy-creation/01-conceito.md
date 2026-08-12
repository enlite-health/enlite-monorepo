# 01 — Conceito

## O que é uma vaga

Uma **vaga** (job posting / vacante) é a solicitação ativa por **UM prestador** (AT ou Cuidador) para acompanhar **UM paciente** num **endereço específico** com **horários definidos**. É a unidade operacional do recrutamento.

Cada vaga vive em uma única row de [`job_postings`](07-tabelas-envolvidas.md#job_postings) com:

- `id` — UUID, PK
- `vacancy_number` — int via SEQUENCE `job_postings_vacancy_number_seq` (único)
- `case_number` — herdado do paciente (NÃO único — várias vagas no mesmo caso clínico)
- `title` — auto-gerado: `"CASO {case_number}-{vacancy_number}"`
- `patient_id` — FK pra paciente (obrigatório em vagas novas)
- `patient_address_id` — FK pra endereço específico do paciente. Endereço de prestação (rua, lat/lng, bairro, cidade, estado) vive em [`patient_addresses`](07-tabelas-envolvidas.md#patient_addresses); a vaga **não duplica** nenhum desses campos
- `status` — um dos 7 canônicos (ver [04-estados-status.md](04-estados-status.md))
- `schedule` — JSONB array `[{dayOfWeek, startTime, endTime}, ...]`
- `required_professions` — array (`['AT']`, `['CAREGIVER']`, `['AT', 'CAREGIVER']`)
- `meet_link_1/2/3` + `meet_datetime_1/2/3` — links Meet pras entrevistas de enquadre

## Por que existe

Coordenadores recebem demanda por ATs com perfis e horários específicos. Cada demanda vira uma vaga que:

1. **É publicada** em canais externos (Talentum, redes sociais) via [Step 2](05-fluxo-criacao.md#step-2--configuração-talentum).
2. **Recebe candidaturas** ([`worker_job_applications`](../worker-job-applications/) — feature separada).
3. **Avança no funil** até `CONFIRMED` (prestador alocado) ou termina em `CLOSED`.
4. **Alimenta o matchmaking** (`MatchmakingService` cruza horário + endereço + perfil) com candidatos sugeridos.

## Ciclo de vida

```
Operador cria vaga via /admin/vacancies/new
  | POST /api/admin/vacancies
  | status = PENDING_ACTIVATION (rascunho — invisível ao público)
  v
Operador entra no Step 2 (Talentum)
  | POST /api/admin/vacancies/:id/generate-ai-content
  | Gemini gera description + prescreening questions/FAQ
  | Operador revisa, edita
  | POST /api/admin/vacancies/:id/publish-talentum
  | status = SEARCHING (publicada)
  v
Vaga vive na Step 3 (VacancyDetailPage)
  | Recebe WJAs via webhook Talentum, matchmaking automático, ou drag manual no Kanban
  | Edição operacional restrita: só schedule + status
  v
Terminal:
  - CONFIRMED via funil (prestador alocado)
  - CLOSED via DELETE (soft-delete, status='CLOSED')
  - SEARCHING_REPLACEMENT se prestador saiu e precisa substituto
```

## O que NÃO é

- **Vaga não armazena dados clínicos do paciente.** `service_type`, `dependency_level`, `diagnosis` foram dropados de `job_postings` na Fase 9 do `SPRINT_VACANCIES_REFACTOR` (migration 152). Tudo isso vive em `patients` e chega à vaga via JOIN.
- **Vaga não armazena o endereço de prestação.** A vaga só guarda a FK `patient_address_id` apontando pra uma linha de `patient_addresses`. Endereço formatado, bairro, cidade, estado, lat/lng tudo vive na FK. Mudança no `patient_addresses` propaga pra vaga via JOIN — é o comportamento desejado pra refletir endereço atual do paciente.
- **Vaga não é candidatura.** A relação prestador↔vaga vive em [`worker_job_applications`](../worker-job-applications/) (WJA). Vaga e WJA são entidades separadas com cardinalidade 1:N (uma vaga tem N candidaturas).
- **Vaga não é caso.** `case_number` é identificador clínico do paciente. Várias vagas podem compartilhar o mesmo `case_number` (substituições sucessivas, demandas paralelas).
