# 07 — Tabelas envolvidas

Resumo do schema relevante pra criação e ciclo de vida de vagas. **Estado atual em 2026-05-26**, após migrations 137 (status normalization), 149-156 (FK + drop columns), 157 (complement), 198 (archived_at).

## `job_postings`

| Coluna | Tipo | Default | Observações |
|---|---|---|---|
| `id` | UUID | `gen_random_uuid()` | PK |
| `vacancy_number` | int | seq | Único; `nextval('job_postings_vacancy_number_seq')` |
| `case_number` | int | NULL | Herdado do paciente; não único |
| `title` | text | — | Auto-gerado `"CASO {case_number}-{vacancy_number}"` |
| `description` | text | `''` | Empty no INSERT, populado depois |
| `status` | text | `'PENDING_ACTIVATION'` | CHECK aceita os 7 canônicos |
| `country` | text | `'AR'` | Hardcoded no INSERT |
| `patient_id` | UUID | NULL | FK `patients.id` |
| `patient_address_id` | UUID | NULL | FK `patient_addresses.id` ON DELETE RESTRICT. Pode apontar pra row arquivada. |
| `required_professions` | text[] | `'{}'` | Subset de `['AT', 'CAREGIVER', 'NURSE', ...]` |
| `required_sex` | text | NULL | `M\|F\|BOTH` |
| `age_range_min/max` | int | NULL | |
| `worker_profile_sought`, `required_experience`, `worker_attributes` | text | NULL | |
| `schedule` | JSONB | NULL | `[{dayOfWeek, startTime, endTime}, ...]` |
| `work_schedule` | text | NULL | Legacy |
| `providers_needed` | int | — | Obrigatório, min 1 |
| `salary_text` | text | `'A convenir'` | |
| `payment_day`, `daily_obs` | text | NULL | |
| `published_at` | timestamptz | `NOW()` | COALESCE no INSERT |
| `closes_at` | timestamptz | NULL | Opcional |
| `meet_link_1/2/3` | text | NULL | Google Meet URL canônica |
| `meet_datetime_1/2/3` | timestamptz | NULL | Resolvido via `googleCalendarService` |
| `social_short_links` | JSONB | NULL | `{ "site": {"url":"...","id":"..."}, ... }` |
| `talentum_description`, `talentum_project_id`, `talentum_slug`, `talentum_published_at`, `talentum_whatsapp_url` | text | NULL | Populadas pelo Step 2 |
| `is_draft` | bool | true | Migration 168 |
| `created_at`, `updated_at`, `deleted_at` | timestamptz | — | Standard audit |

### Colunas dropadas (migration 152)

`state`, `city`, `service_address_formatted`, `service_address_raw`, `service_device_types`, `pathology_types`, `dependency_level`, `service_lat`, `service_lng`, `service_location` — agora via JOIN.

### Índices

- `idx_job_postings_patient_address_id` `(patient_address_id) WHERE patient_address_id IS NOT NULL`
- FK `job_postings_patient_address_id_fkey` ON DELETE RESTRICT

## `patients`

| Coluna | Tipo | Como flui pra vaga |
|---|---|---|
| `id` | UUID | FK em `job_postings.patient_id` |
| `case_number` | int | Copiado pra `job_postings.case_number` no INSERT |
| `first_name`, `last_name` | text | JOIN |
| `dependency_level`, `service_type[]`, `diagnosis` | text | JOIN — read-only no form |
| `zone_neighborhood`, `city_locality` | text | Fallback no COALESCE |
| `status` | text | `ACTIVE | ADMISSION | SUSPENDED | DISCHARGED | DISCONTINUED`. `ADMISSION` skipa criação de vaga via mapper |
| `health_insurance_*`, `neighborhood`, `province`, `city_locality` | text | Extensões da migration 136 |
| `clickup_task_id` | text | Identifica a task ClickUp espelhada |

## `patient_addresses`

| Coluna | Tipo | Default | Observações |
|---|---|---|---|
| `id` | UUID | `gen_random_uuid()` | PK |
| `patient_id` | UUID | — | FK `patients(id) ON DELETE CASCADE` |
| `address_type` | text | — | `primary | secondary | service` |
| `address_formatted` | text | NULL | Google Places formatted. **Chave de detecção de mudança** (versionamento). |
| `address_raw` | text | NULL | User-entered original |
| `display_order` | int | 0 | Slot do ClickUp (1/2/3). Pode ter múltiplas rows no mesmo slot (uma ativa + N arquivadas). |
| `source` | text | `'clickup'` | `clickup | admin_manual | clickup_sync` |
| `state`, `city`, `neighborhood` | text | NULL | Extraídos de `address_components` do MESMO location field (`Domicilio N Principal Paciente`). Fallback nos custom fields legacy patient-level apenas no slot 1. |
| `lat`, `lng` | numeric(10,7) | NULL | Migration 153. Geocoding best-effort. |
| `complement` | text | NULL | Migration 157. Não vem do ClickUp. |
| **`archived_at`** | timestamptz | NULL | **Migration 198.** NULL = ativo. Não-NULL = versão histórica preservada porque há vaga referenciando. |
| `created_at`, `updated_at` | timestamptz | — | `updated_at` é populado por trigger BEFORE UPDATE |

### Índices

- `idx_patient_addresses_patient` `(patient_id)`
- `idx_patient_addresses_active` `(patient_id, display_order) WHERE archived_at IS NULL` — acelera lookups dos endereços ativos pro form de criação + sync ClickUp

### Constraints

- **Não há UNIQUE** em `(patient_id, display_order)` — historicamente havia colisões; permite múltiplas rows no mesmo slot (uma ativa + N arquivadas).
- FK `patient_id` → `patients(id)` ON DELETE CASCADE
- Sem trigger de dedup

## `worker_job_applications` (WJA)

Tabela canônica do funil de candidatura. Relação com vaga: `worker_job_applications.job_posting_id` FK pra `job_postings.id`. UNIQUE `(worker_id, job_posting_id)`. Detalhes em [worker-job-applications/07-tabelas-envolvidas.md](../worker-job-applications/07-tabelas-envolvidas.md).

`getVacancyById` faz JOIN agregando WJAs em array `encuadres[]` no response (compatibilidade legacy — nome do array é "encuadres" mas o conceito é WJA).

## Tabelas auxiliares (escritas pelo flow)

| Tabela | Quando escreve | O quê |
|---|---|---|
| `domain_events` | Após INSERT em `job_postings` | `{ event: 'vacancy.created', payload: { jobPostingId }, trace_id }` via `setImmediate` |
| `social_short_links` (JSONB em `job_postings`) | `tryEnsureShortLink` pós-create/update quando status público | `{ "site": {"url":"...","id":"..."} }` |
| `patient_field_overrides_audit` | `createVacancy` com `updatePatient` populado | `{ patient_id, field_name, old_value, new_value, source: 'vacancy_create_pdf' }` |
| Tabelas Talentum (prescreening) | `POST /:id/prescreening-config` | Questions + FAQ; FK `job_posting_id` |
| `publications` | Sync Talentum + canais sociais | `{ channel, published_at, recruiter, job_posting_id }` |
