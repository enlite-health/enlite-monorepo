# 03 — SSOT por conceito

Quem é a fonte da verdade pra cada dado que aparece na vaga. Quando duas fontes divergem, a SSOT vence.

| Conceito | SSOT | Como a vaga obtém |
|---|---|---|
| **Identificação da vaga** (`vacancy_number`, `case_number`, `title`) | `job_postings` | Coluna própria; `title` auto-gerado no INSERT |
| **Paciente vinculado** (`patient_id`) | `job_postings.patient_id` | Coluna FK direta |
| **Endereço de prestação** (formatted/raw/lat/lng/state/city/neighborhood/complement) | `patient_addresses` linkado via FK `patient_address_id` (pode estar `archived`) | JOIN. Quando arquivado, vaga continua mostrando o endereço congelado da época da criação. Novas vagas usam a versão ATIVA (`archived_at IS NULL`). Ver [06](06-endereco-servico.md). |
| **Catálogo de endereços do paciente** | `patient_addresses` ativos | JOIN no form de criação de vaga e em endpoints de paciente — sempre filtra `archived_at IS NULL` |
| **Status da vaga** | `job_postings.status` | Coluna própria com CHECK constraint (7 canônicos) |
| **Horários** (`schedule`) | `job_postings.schedule` JSONB | Coluna própria — array `[{dayOfWeek, startTime, endTime}, ...]` |
| **Perfil buscado** (`required_professions`, `required_sex`, `age_range_*`, `worker_attributes`, `required_experience`) | `job_postings.*` colunas próprias | Editáveis em draft; congelados depois |
| **Dados clínicos do paciente** (`service_type`, `dependency_level`, `diagnosis`) | `patients` | JOIN. Vaga não duplica — colunas equivalentes foram dropadas em migration 152. |
| **Nome do paciente** (`first_name`, `last_name`) | `patients` | JOIN |
| **Cidade/zona do paciente** (`patient_zone`, `patient_city`, `patient_neighborhood`) | `patient_addresses` (mesmo row linkado pela vaga) + `patients` (fallback) | JOIN com COALESCE: `COALESCE(pa.neighborhood, p.zone_neighborhood)` |
| **Description Talentum** (`talentum_description`) | `job_postings.talentum_description` | Coluna própria, escrita pelo `TalentumDescriptionService` ao gerar IA (Step 2) |
| **Prescreening** (perguntas + FAQ) | tabelas separadas vinculadas por `job_posting_id` | Escritas via Step 2 (`/prescreening-config`) |
| **Status no Talentum** (`talentum_project_id`, `talentum_slug`, `talentum_published_at`, `talentum_whatsapp_url`) | `job_postings.talentum_*` | Coluna própria; populadas pelo `PublishVacancyToTalentumUseCase` |
| **Links Meet** (`meet_link_1/2/3` + `meet_datetime_1/2/3`) | `job_postings.meet_link_*` | Coluna própria; populada via `PUT /:id/meet-links` |
| **Short links sociais** (`social_short_links` JSONB) | `job_postings.social_short_links` | Coluna própria; populada via `EnsureVacancyShortLinkUseCase` (Short.io) |
| **Candidaturas vinculadas** | `worker_job_applications` | Tabela separada — ver [worker-job-applications](../worker-job-applications/) |
| **Publicações por canal** | `publications` | Tabela separada |

## Princípios

1. **Vaga é derivada de paciente** — todos os dados clínicos e demográficos vêm de `patients` via JOIN. Decisão arquitetural 4.1 do `SPRINT_VACANCIES_REFACTOR`.
2. **Endereço da vaga é congelado no momento da criação** — porque `patient_address_id` aponta pra uma row específica de `patient_addresses`, e mudança no endereço do paciente é versionada (nova row criada, antiga arquivada). Detalhes em [06-endereco-servico.md](06-endereco-servico.md).
3. **Endereço atual do paciente é dinâmico** — qualquer listagem do paciente (form de criação de vaga, ficha do paciente) filtra `archived_at IS NULL` e mostra só os ativos.
4. **Sobrescrita de paciente requer consentimento** — campos read-only no form de criação refletem o estado atual de `patients`. Quando recrutadora quer mudar (raro), passa por fluxo explícito de `updatePatient` em `createVacancy` que escreve em `patient_field_overrides_audit`. Memória `feedback_patient_overwrite_consent`.
