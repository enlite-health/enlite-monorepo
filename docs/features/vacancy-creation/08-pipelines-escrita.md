# 08 — Pipelines de escrita

Quais caminhos podem criar/alterar uma `job_postings` row em prod, e quais escrevem em `patient_addresses` (versionando ou não).

## Vagas

### P1 — Form admin (criação) — `CreateVacancyPage`

- **Trigger:** recrutadora clica "Guardar" em `/admin/vacancies/new`.
- **Endpoint:** `POST /api/admin/vacancies` → `VacancyCrudController.createVacancy`.
- **Persistência:**
  - SELECT `patients` (valida exists + not deleted).
  - Owner check: `patient_address_id` pertence ao paciente E **está ativo (`archived_at IS NULL`)** — rejeita 400 se arquivado.
  - INSERT em `job_postings` com `status='PENDING_ACTIVATION'`.
  - `setImmediate` → INSERT em `domain_events` (`vacancy.created`) + `tryEnsureShortLink` se status público.

### P2 — Form admin (edição) — Step 1 modo edit OU `VacancyModal` legacy

- **Trigger:** click no ícone de edit na listagem ou rota `/admin/vacancies/:id/edit`.
- **Endpoint:** `PUT /api/admin/vacancies/:id` → `VacancyCrudController.updateVacancy`.
- **Permissão:** isDraft (`PENDING_ACTIVATION`) permite edição ampla; operational permite só `{ schedule, status }`.

### P3 — Step 2 Talentum publish

- **Trigger:** "Publicar en Talentum" no Step 2.
- **Endpoint:** `POST /api/admin/vacancies/:id/publish-talentum`.
- **Persistência:** atualiza `talentum_*` colunas + `is_draft = false` + insere em `publications`.

### P4 — Step 2 generate AI content

- **Trigger:** Step 1 dispara após save, ou Step 2 dispara no mount como fallback.
- **Endpoint:** `POST /api/admin/vacancies/:id/generate-ai-content`.
- **Persistência:** nenhuma. Retorna preview puro.

### P5 — `/meet-links` (PUT 3 slots)

- **Trigger:** após criar vaga (frontend automático) ou edição.
- **Endpoint:** `PUT /api/admin/vacancies/:id/meet-links`.
- **Persistência:** UPDATE em `meet_link_*` + `meet_datetime_*`.

### P6 — `/meet-links/lookup` (POST)

- **Trigger:** onBlur de input Meet link no form.
- **Endpoint:** `POST /api/admin/vacancies/meet-links/lookup`.
- **Persistência:** nenhuma — só lookup.

### P7 — Soft delete

- **Trigger:** "Encerrar" na listagem.
- **Endpoint:** `DELETE /api/admin/vacancies/:id`.
- **Persistência:** `UPDATE job_postings SET status = 'CLOSED'`.

## Endereço do paciente (`patient_addresses`)

### P8 — Sync ClickUp paciente (HISTÓRICO — webhook removido 11/09/2026)

> ⚠️ O webhook `POST /api/webhooks/clickup/patient` e o reconciliador foram removidos em
> 11/09/2026 (decisão do Gabriel: a plataforma é a fonte, sem sync automático). A carga do
> ClickUp agora é só pontual/manual via `scripts/import-patients-from-clickup.ts`
> (dry-run por padrão, grava só com `--apply`), que chama o MESMO motor
> (`SyncPatientFromClickUpTaskUseCase`) descrito abaixo — a regra de versionamento de
> endereço não mudou, só o gatilho deixou de ser automático.

- **Trigger (antigo):** ClickUp disparava webhook (taskCreated/taskUpdated).
- **Trigger (atual):** operador roda o script manual numa sessão.
- **Persistência via `PatientService.upsertFromClickUp` → `PatientRelatedWriter.replacePatientAddresses`:**
  - Lê endereços ATIVOS do paciente (`archived_at IS NULL`).
  - Pra cada slot do ClickUp (1, 2, 3):
    - Compara `address_formatted` atual vs novo:
      - **Igual** → UPDATE in-place (corrige só geocoding/components)
      - **Diferente** → `archived_at = NOW()` na antiga + INSERT nova row no mesmo slot
      - **Slot novo (sem ativa)** → INSERT
  - Slots que sumiram do ClickUp:
    - Se referenciado por vaga: `archived_at = NOW()` (preserva contexto)
    - Se órfão: `DELETE`

### P9 — CLI `import-patients-from-clickup.ts` (ÚNICO pipeline de sync ativo desde 11/09/2026)

- **Trigger:** `npx ts-node scripts/import-patients-from-clickup.ts --task-id <id> --apply`
  (dry-run por padrão; `--live` não existe mais).
- **Lógica:** mesmo motor do P8 (`SyncPatientFromClickUpTaskUseCase` → `PatientService.upsertFromClickUp`
  → `PatientRelatedWriter.replacePatientAddresses`), agora também sincronizando diagnóstico
  (`ClickUpDiagnosisMapper`, decisão do Gabriel 11/09/2026).
- **Regras de operação (decisão do Gabriel + parecer do lex, 11/09/2026 — NÃO é mais "correção
  de massa"):**
  1. `--apply` só é aceito junto de `--task-id` — carga em massa (lista inteira) nunca grava.
  2. Só CRIA paciente novo — recusa se `clickup_task_id` já existir na plataforma (nunca UPDATE).
  3. Autorização ESCRITA do Gabriel por carga, ANTES de rodar.
  4. Registro em `docs/legal/registros/AAAA-MM-DD-carga-clickup.md` por carga executada — sem
     nome do paciente nem rótulo clínico.
  5. Nunca agendar (Cloud Scheduler/cron/CI) — carga PONTUAL numa sessão de terminal.
- **Uso:** carga de UM paciente novo por vez, numa sessão manual — não é mais um mecanismo de
  backfill em lote.

### P10 — POST `/api/admin/patients/:patientId/addresses`

- **Trigger:** UI manual (recrutadora cria endereço novo).
- **Endpoint:** `AdminPatientsController.createPatientAddress`.
- **Persistência:** INSERT direto, `source='admin_manual'`, `display_order = MAX(display_order WHERE archived_at IS NULL) + 1`.

## Pipelines depreciados / removidos

| Pipeline | Status |
|---|---|
| Wizard de 6 steps (`CreateVacancy/`) | Removido (`SPRINT_CREATE_VACANCY_FORM_REFACTOR`) |
| `parseFromPdf` / `parseFromText` endpoints | Removidos |
| `MatchPdfAddressToPatientAddressUseCase` | Removido |
| `JobScraperService` (cheerio + WP) | Removido |
| Sync de **vagas** ClickUp (`import-vacancies-from-clickup.ts`) | Depreciado (memória `project_clickup_deprecation`). |
| Webhook + reconciliador automático de paciente (P8) | Removido 11/09/2026 — decisão do Gabriel, sem sync automático. Sync de pacientes (P9, manual) é o único ativo. |

## Auditoria

- `created_at` / `updated_at` em todas as tabelas.
- `archived_at` em `patient_addresses` registra o instante do versionamento.
- `domain_events` registra `vacancy.created`.
- `patient_field_overrides_audit` registra updates feitos via vaga (campo `updatePatient`).
- `publications` registra cada canal publicado.
