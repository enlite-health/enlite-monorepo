# 05 — Fluxo de Criação (Step 1 → 2 → 3)

Wizard de 3 passos linkados via Stepper. Cada passo é uma rota dedicada do frontend; submissão de cada um navega pro próximo.

## Step 1 — Datos de la vacante

**Rota:** `/admin/vacancies/new` (criação) ou `/admin/vacancies/:id/edit` (edição draft).
**Página:** [`CreateVacancyPage.tsx`](../../../enlite-frontend/src/presentation/pages/admin/CreateVacancyPage.tsx).
**Form core:** [`VacancyFormSection.tsx`](../../../enlite-frontend/src/presentation/components/features/admin/VacancyModal/VacancyFormSection.tsx).

### Fluxo de seleção

1. Recrutadora seleciona **caso** no SearchableSelect.
   - Endpoint: `GET /api/admin/vacancies/cases-for-select` → lista de `{ caseNumber, patientId, dependencyLevel }`. Filtro: paciente ativo + **EXISTS `patient_addresses` com `archived_at IS NULL`** (não dá pra criar vaga pra paciente sem endereço ativo).
2. `selectCase(caseNumber, patientId)` em [`useVacancyModalFlow`](../../../enlite-frontend/src/hooks/admin/useVacancyModalFlow.ts) dispara `Promise.all([getPatientById, listPatientAddresses])`.
3. **Guard-rail 1 — rascunho do paciente:** `useEffect` em `CreateVacancyPage` chama `GET /api/admin/vacancies/in-progress?patient_id=X`. Se houver vagas em draft (`is_draft = true`) → `ResumeDraftVacancyDialog` aparece com lista. Recrutadora pode retomar (`navigate /edit`) ou criar nova.
4. `GET /api/admin/patients/:patientId/addresses` retorna **somente os endereços ativos** (filtro `archived_at IS NULL`, migration 198).
5. Form hidrata: nome do paciente, diagnosis, dependency_level, service_type, lista de endereços ATIVOS. **Múltiplos endereços** (ex: paciente com `Domicilio 1` + `Domicilio 2` ambos ativos) são listados todos como botões clicáveis em `VacancyFormRightColumn:155-174`.
6. Em modo `create`, `selectedAddressId` auto-fila no primeiro endereço ATIVO da lista. Em modo `edit`, vem como `preferredAddressId = existingVacancy.patient_address_id` (mesmo se arquivado — preserva binding histórico).
7. Recrutadora muda o endereço clicando num address button → `selectAddress(addr.id)`.
8. **Guard-rail 2 — endereço já com vaga:** `useEffect` em `CreateVacancyPage` chama `GET /api/admin/vacancies/by-address?patient_address_id=X` quando `selectedAddressId` muda. Se houver vagas (não `CLOSED`, não soft-deleted) apontando pra esse endereço → `AddressHasVacancyDialog` aparece com lista:
   - **"Editar a vaga"**: navega pra `/admin/vacancies/:id/edit` (drafts) ou `/admin/vacancies/:id` (operacionais).
   - **"Criar nova mesmo assim"**: registra override em ref + fecha modal; segue criação.
   - **"Escolher outro endereço"**: limpa `selectedAddressId`, recrutadora escolhe outro botão.
9. Recrutadora preenche schedule (split shifts suportados), profession, meet links.
10. Click **Guardar** → RHF dispara `onSubmit` → `buildVacancyPayload(data, caseNumber, patientId, addressId)` → `POST /api/admin/vacancies`.
11. Backend valida `patient_address_id` está **ativo** (FK + `archived_at IS NULL`). Rejeita 400 se arquivado.
12. Vacancy criada com `status='PENDING_ACTIVATION'`.
13. **Imediatamente após**: `PUT /api/admin/vacancies/:id/meet-links` persiste os 3 Meet links + datetimes resolvidos.
14. `handleSuccess(vacancyId)` dispara overlay "Gerando contenido IA..." + `POST /api/admin/vacancies/:id/generate-ai-content` → `navigate('/admin/vacancies/:id/talentum', { state: { description, prescreeningQuestions, prescreeningFaq } })`.

### Validação Zod (resumo)

Schema em [`vacancy-form-schema.ts`](../../../enlite-frontend/src/presentation/components/features/admin/vacancy-form-schema.ts):

| Campo | Regra |
|---|---|
| `required_professions` | array, min 1 |
| `providers_needed` | número, min 1 |
| `schedule` | array, min 1 entry; cada entry tem `days[]` min 1 + `timeFrom`/`timeTo` non-empty |
| `meet_links` | tuple `[string, string, string]`; refinement global: pelo menos 1 slot tem que matchar `MEET_LINK_REGEX` strict |
| `published_at` | YYYY-MM-DD; default = `todayIsoDate()` |

## Step 2 — Configuración Talentum

**Rota:** `/admin/vacancies/:id/talentum`.
**Página:** [`TalentumConfigPage.tsx`](../../../enlite-frontend/src/presentation/pages/admin/TalentumConfigPage.tsx).

### Fluxo

1. Recebe `location.state` do Step 1 com `{ description, prescreeningQuestions, prescreeningFaq }` já gerados.
2. **Fallback** (refresh/nav direta): se `hasGeneratedContent === false`, useEffect dispara `generateAIContent()` no mount.
3. **VacancySummaryCard** read-only mostra: `CASO X-Y`, paciente, status badge (i18n), datas.
4. **AIDescriptionEditor**: textarea com counter `{n}/4000`, controlled input.
5. **PrescreeningStep**: editor de perguntas + FAQ.
6. Click **Publicar en Talentum**:
   - `useTalentumConfig.publish()` auto-salva prescreening primeiro (`POST /:id/prescreening-config`).
   - Depois `POST /:id/publish-talentum`.
   - Re-fetch da vaga.
   - Navega pra `/admin/vacancies/:id` (Step 3).

### Backend AI generation

`POST /api/admin/vacancies/:id/generate-ai-content` em [`VacancyTalentumController.ts`](../../../worker-functions/src/modules/matching/interfaces/controllers/VacancyTalentumController.ts):

1. Load vacancy + patient + address (JOIN read-only — pega a row apontada por `patient_address_id` mesmo se arquivada).
2. Worker type resolution: `required_professions.includes('CAREGIVER') ? 'CUIDADOR' : 'AT'`.
3. `TalentumDescriptionService.generateDescriptionPreview(id)` — chama Gemini com prompt do Google Docs, `responseMimeType: 'application/json'` + `responseSchema` com `{ propuesta, perfilProfesional }`.
4. `GeminiVacancyParserService.generateFromVacancyData()` — gera prescreening questions + FAQ.
5. Retorna `{ description, prescreening: { questions, faq } }` sem persistir.

## Step 3 — Detalle y postulantes

**Rota:** `/admin/vacancies/:id`.
**Página:** [`VacancyDetailPage.tsx`](../../../enlite-frontend/src/presentation/pages/admin/VacancyDetailPage.tsx).

Página existente do painel. Mostra:

- Cards de info (paciente, profissão, schedule, social links, Meet links).
- Card de location ([`VacancyCaseCard.tsx`](../../../enlite-frontend/src/presentation/components/features/admin/VacancyDetail/VacancyCaseCard.tsx)) usa `patientCity` + `patientNeighborhood`, vindos do JOIN com `patient_addresses` da row linkada (mesmo arquivada).
- Tabs: Convidados / Postulados / Pré Selecionados / Rejeitados / Desistentes (alimentados por `WJAFunnelController` — feature [worker-job-applications](../worker-job-applications/)).
- Botões de ação: editar (abre `VacancyModal` legacy em modo edit), encerrar (soft-delete).
