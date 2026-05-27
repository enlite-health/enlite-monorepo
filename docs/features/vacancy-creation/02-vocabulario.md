# 02 — Vocabulário

Três níveis: termos operacionais (que recrutadoras e PO usam), termos técnicos (que aparecem no schema/código) e termos legados (a deprecar).

## Operacional

| Termo | Significado |
|---|---|
| **Vaga** / **Vacante** | Solicitação ativa por um prestador. PT-BR e ES-AR; mesma entidade. |
| **Caso** | Identificador clínico do paciente (`case_number`). Várias vagas no mesmo caso são esperadas (substituições). |
| **Recrutadora** | Operadora que cria a vaga, gerencia candidaturas e fecha o caso. |
| **Prestador** | AT (Acompañante Terapéutico) ou Cuidador alocado à vaga. |
| **Postularse** | Ação do prestador de se candidatar (gera [`worker_job_applications`](../worker-job-applications/)). |
| **Enquadre** | Entrevista entre prestador, paciente e supervisão. 3 datas via Meet links na vaga. |
| **Endereço atual** vs **endereço da vaga** | Paciente pode ter mudado de endereço depois da vaga ser criada. "Endereço atual" = `patient_addresses` ativo (`archived_at IS NULL`). "Endereço da vaga" = `patient_addresses` linkado via FK, podendo estar arquivado se já mudou. Ver [06](06-endereco-servico.md). |

## Técnico

| Termo | Local | Significado |
|---|---|---|
| **`job_postings`** | Tabela | Tabela canônica de vagas. |
| **`vacancy_number`** | Coluna | int incremental via SEQUENCE `job_postings_vacancy_number_seq`. Único. |
| **`case_number`** | Coluna em `job_postings` + `patients` | int do caso clínico. Herdado do paciente; **não único** em `job_postings`. |
| **`patient_id`** | FK | Aponta pra `patients.id`. Nullable em vagas históricas; obrigatório em vagas novas. |
| **`patient_address_id`** | FK | Aponta pra `patient_addresses.id`. Identifica QUAL endereço do paciente esta vaga atende. Pode apontar pra row arquivada (preservação histórica). |
| **`archived_at`** | Coluna em `patient_addresses` (migration 198) | Quando preenchido, a row foi versionada — uma nova row substituiu este endereço pra novas vagas. Vagas existentes que apontam pra row arquivada continuam funcionando. Ver [06](06-endereco-servico.md). |
| **WJA / Worker Job Application** | Tabela `worker_job_applications` | Candidatura. Feature separada — ver [worker-job-applications/](../worker-job-applications/). |
| **Encuadre (legacy)** | Tabela `encuadres` | Vocabulário legado para WJA. Em deprecação — ver [worker-job-applications/02-vocabulario.md](../worker-job-applications/02-vocabulario.md). |
| **Short link** | `social_short_links` JSONB | Encurtado via Short.io por canal (site, instagram, etc.). |
| **`PENDING_ACTIVATION`** | Status | Rascunho — invisível no público. Default de toda vaga nova até passar pelo Step 2. |
| **`SEARCHING`** | Status | Busca ativa — pública. Outros públicos: `SEARCHING_REPLACEMENT`, `RAPID_RESPONSE`. |
| **Versioning** | Conceito | Quando ClickUp atualiza endereço com `address_formatted` diferente, sync ARQUIVA a row antiga + INSERE nova row no mesmo `display_order`. |
| **In-place UPDATE** | Conceito | Quando ClickUp atualiza endereço com `address_formatted` IGUAL, sync UPDATE in-place (corrige só geocoding/neighborhood/city/state). Não arquiva. |

## Legado

| Termo | Onde aparece | Status atual |
|---|---|---|
| `BUSQUEDA`, `ACTIVO`, `REEMPLAZOS`, `rta_rapida`, `paused`, `draft`, `filled` | strings antigas em `job_postings.status` | Normalizadas em migration 137 (Fase 3 do `SPRINT_VACANCIES_REFACTOR`). CHECK constraint bloqueia novas. |
| `service_address_formatted`, `service_address_raw`, `state`, `city`, `service_device_types`, `pathology_types`, `dependency_level` | colunas dropadas de `job_postings` | Dropadas na migration 152 (Fase 9). Quem precisa do dado puxa do paciente via JOIN. |
| `service_lat`, `service_lng`, `service_location` | colunas em `job_postings` | Movidas pra `patient_addresses` nas migrations 153-156 (`SPRINT_CREATE_VACANCY_FORM_REFACTOR` Fase 0). |
| `FULLY_STAFFED` | status antigo | Renomeado pra `RAPID_RESPONSE` em 2026-04-27. |
| Wizard de 6 steps de criação | `CreateVacancy/` pasta | Deletada inteira em `SPRINT_CREATE_VACANCY_FORM_REFACTOR`. |
| `VacancyModal` legacy | `presentation/components/features/admin/VacancyModal/` | Ainda em uso pra edição da listagem (TD-003 deprecação pendente). |
| Patient-level fields `Provincia/Ciudad/Zona Paciente` | ClickUp custom fields | Hoje servem como **fallback** apenas pra slot 1 quando `Domicilio 1 Principal` não traz `address_components`. Antes da fix de 2026-05-26 eram a fonte primária de state/city/neighborhood — o que causava drift quando operador atualizava só o `Domicilio Principal`. |
