# Vacancy — Guia de Referência (estado atual)

> **Para quê esse doc existe:** documentar como o fluxo de criação de vaga
> (`/admin/vacancies/new`), o match e os fluxos auxiliares (geocoding, datas,
> endereço, mapa, schedule) funcionam **hoje**. Pra sessão nova mexer em vaga
> sem precisar ler 20 arquivos.
>
> **Quando atualizar:** sempre que mudar contrato (whitelist, tipos), regras
> de negócio (defaults, validações) ou padrão arquitetural relacionado à vaga.
>
> **NÃO é:** sprint doc (esses ficam em `docs/SPRINT_*.md` e descrevem
> intenção/aspiração). Esse aqui descreve **realidade hoje**.

---

## Visão geral do fluxo

```
/admin/vacancies/new   ──►  POST /api/admin/vacancies  ──►  PG INSERT
       │                            │                              │
       ▼                            ▼                              ▼
 (caminho feliz: case-select → hidratação → preencher → "Continuar")
       │
       ▼
/admin/vacancies/:id/talentum  (POST /generate-ai-content [GEMINI mockado em test])
       │
       ▼
       (POST /publish-talentum [mockado em test])
       │
       ▼
/admin/vacancies/:id  (detail)
```

**Auto-match em background:** ao criar uma vaga, `setImmediate` dispara
`MatchmakingService.matchWorkersForJob(newId, {})` sem bloquear o POST.

---

## Frontend — Arquitetura

| Arquivo | Função |
|---|---|
| [`pages/admin/CreateVacancyPage.tsx`](../enlite-frontend/src/presentation/pages/admin/CreateVacancyPage.tsx) | Página, controla `formComplete` e o botão "Continuar" |
| [`hooks/admin/useVacancyModalFlow.ts`](../enlite-frontend/src/hooks/admin/useVacancyModalFlow.ts) | Estado: case selecionado, paciente, endereços. **Auto-select do endereço quando há só 1.** |
| [`features/admin/VacancyModal/VacancyFormSection.tsx`](../enlite-frontend/src/presentation/components/features/admin/VacancyModal/VacancyFormSection.tsx) | RHF + Zod, 2 colunas, calcula `isComplete` via `useWatch` e expõe via `onCompleteChange` |
| [`features/admin/VacancyModal/VacancyFormLeftColumn.tsx`](../enlite-frontend/src/presentation/components/features/admin/VacancyModal/VacancyFormLeftColumn.tsx) | Case-select, dados do paciente (read-only), profissão, idade, **`published_at`/`closes_at`** |
| [`features/admin/VacancyModal/VacancyFormRightColumn.tsx`](../enlite-frontend/src/presentation/components/features/admin/VacancyModal/VacancyFormRightColumn.tsx) | Status, tipo serviço, endereço selector, **mapa**, payment, schedule, meet links |
| [`features/admin/VacancyModal/VacancyDaySchedulePicker.tsx`](../enlite-frontend/src/presentation/components/features/admin/VacancyModal/VacancyDaySchedulePicker.tsx) | Picker por dia, slots inteligentes, "+" disabled quando saturado |
| [`features/admin/vacancy-form-schema.ts`](../enlite-frontend/src/presentation/components/features/admin/vacancy-form-schema.ts) | Zod, `DEFAULT_FORM_VALUES`, `buildVacancyPayload`, `todayIsoDate()` (TZ local) |
| [`molecules/ServiceAreaMap.tsx`](../enlite-frontend/src/presentation/components/molecules/ServiceAreaMap.tsx) | Google Maps embed. Recebe `lat`/`lng`, sem geocoding cliente. |
| [`infrastructure/services/loadGoogleMaps.ts`](../enlite-frontend/src/infrastructure/services/loadGoogleMaps.ts) | Single-flight loader do script (compartilhado entre `ServiceAreaMap` e `GooglePlacesAutocomplete`) |

### Entry point: case-select (NÃO autocomplete)

**Pattern atual** = dropdown de case_number (`data-testid="case-select"`).
O sprint doc original menciona autocomplete de paciente — **não está implementado**. Specs antigos que assumem `Buscar paciente` estão quebrados ou marcados como skip.

### Botão "Continuar"

- **Texto** = `"Continuar"` (não "Guardar"). i18n keys `admin.createVacancyV2.saveButton`.
- **Disabled** até **todos** os obrigatórios:
  - case selecionado
  - endereço selecionado (auto-select quando 1 endereço)
  - profissão
  - schedule com pelo menos 1 slot completo (dia + horários)
  - 1 meet link válido (regex `MEET_LINK_REGEX`)
  - `providers_needed >= 1`
- Cálculo em `VacancyFormSection.tsx` via `useWatch`, exposto via `onCompleteChange(isComplete)` pra página gateá-lo.

### Datas

- **Publish date** (`published_at`): pré-preenchido com **hoje em TZ local** (`todayIsoDate()` evita o bug do `toISOString().slice(0,10)` virar ontem em UTC-3). Editável, opcional. Backend defaulta `NOW()` se chegar null.
- **Closing date** (`closes_at`): vazio, opcional. Pode ficar `NULL` no banco.
- Edit mode: backend retorna `timestamptz` ISO; o input `<type="date">` precisa de `YYYY-MM-DD`, então slica `String(val).slice(0, 10)`.

### Endereço

- Backend retorna `lat`/`lng` como `numeric` em string — [`AdminVacancyAddressApiService.listPatientAddresses`](../enlite-frontend/src/infrastructure/http/AdminVacancyAddressApiService.ts) normaliza pra `number` na borda.
- Display usa **fallback** `address_formatted || address_raw || '—'` — ~55% do seed local tem `address_formatted=''` mas `address_raw` preenchido.
- **Auto-select**: 1 endereço único → `selectedAddressId` populado em `useVacancyModalFlow.selectCase`. Sem isso, o mapa fica em placeholder.
- **Mapa**: `ServiceAreaMap` recebe só `lat`/`lng` do banco. Sem coords → placeholder. Geocoding cliente foi **removido** — server é fonte única (`PatientService.replaceAddresses` geocoda no upsert + script de backfill).

### Schedule picker

- Default 1º slot = **09:00 – 17:00**.
- Adicionar mais slot:
  - Sem espaço: nada acontece, botão "+" fica **disabled** (cinza).
  - Com espaço: começa onde último slot termina, vai até `23:59`.
  - Sem espaço no tail: pega maior gap interno.
- **`23:59`** é o cap (não `24:00` — quebra Postgres `time` e validators canônicos).
- Lógica pura em [`vacancyScheduleUtils.findNextAvailableSlot`](../enlite-frontend/src/presentation/components/features/admin/vacancyScheduleUtils.ts).
- `TimeSelect` com `includeEndOfDay` adiciona `23:59` no select de endTime apenas.

---

## Backend — Arquitetura

| Arquivo | Função |
|---|---|
| [`modules/matching/interfaces/controllers/VacancyCrudController.ts`](../worker-functions/src/modules/matching/interfaces/controllers/VacancyCrudController.ts) | POST / PUT / DELETE de vaga. Auto-match em `setImmediate`. |
| [`modules/matching/interfaces/controllers/vacancyCrudHelpers.ts`](../worker-functions/src/modules/matching/interfaces/controllers/vacancyCrudHelpers.ts) | `buildInsertQuery` + `buildInsertParams`. Whitelist de status. |
| [`modules/matching/interfaces/controllers/VacancyMatchController.ts`](../worker-functions/src/modules/matching/interfaces/controllers/VacancyMatchController.ts) | `triggerMatch`, `getMatchResults`, `updateEncuadreResult`. |
| [`modules/matching/infrastructure/MatchmakingService.ts`](../worker-functions/src/modules/matching/infrastructure/MatchmakingService.ts) | Orquestrador (Fase 1: hard filter; opcional Fase 2: structured; opcional Fase 3: LLM). |
| [`modules/matching/infrastructure/MatchmakingHardFilterPath.ts`](../worker-functions/src/modules/matching/infrastructure/MatchmakingHardFilterPath.ts) | Path sem score (default agora). |
| [`modules/matching/infrastructure/MatchmakingStructuredScorer.ts`](../worker-functions/src/modules/matching/infrastructure/MatchmakingStructuredScorer.ts) | Função pura — Fase 2 (disabled por default). |
| [`modules/matching/infrastructure/MatchmakingLLMScorer.ts`](../worker-functions/src/modules/matching/infrastructure/MatchmakingLLMScorer.ts) | Groq — Fase 3 (disabled por default). |
| [`modules/matching/infrastructure/MatchmakingTypes.ts`](../worker-functions/src/modules/matching/infrastructure/MatchmakingTypes.ts) | Tipos + `DEFAULT_RADIUS_KM=30`. |
| [`modules/case/application/PatientService.ts`](../worker-functions/src/modules/case/application/PatientService.ts) | `upsertFromClickUp` → chama `replaceAddresses` que geocoda inline. |
| [`modules/case/infrastructure/geocodePatientAddresses.ts`](../worker-functions/src/modules/case/infrastructure/geocodePatientAddresses.ts) | Best-effort wrapper do `GeocodingService` com timeout. |
| [`infrastructure/services/GeocodingService.ts`](../worker-functions/src/infrastructure/services/GeocodingService.ts) | Google Maps Geocoding API + retry. |
| [`scripts/backfill-patient-addresses-geocoding.ts`](../worker-functions/scripts/backfill-patient-addresses-geocoding.ts) | One-off pra geocodar legados (`lat IS NULL`). |

### Whitelist do POST/PUT (campos aceitos)

```ts
// CREATE — extraídos de req.body em VacancyCrudController.createVacancy
case_number, patient_id, patient_address_id,
required_professions, required_sex, age_range_min, age_range_max,
worker_profile_sought, required_experience, worker_attributes,
schedule, work_schedule, providers_needed, salary_text, payment_day,
daily_obs, status, published_at, closes_at, updatePatient

// UPDATE — VacancyCrudController.updateVacancy.allowedFields
title, case_number, patient_id, patient_address_id,
required_professions, required_sex, age_range_min, age_range_max,
worker_profile_sought, required_experience, worker_attributes,
schedule, work_schedule, providers_needed, salary_text, payment_day,
daily_obs, status, published_at, closes_at
```

> **Toda vez que adicionar campo editável**: adicionar no `allowedFields` E ter spec integration que faça PUT e leia do DB. Senão o backend ignora silenciosamente.

### SQL do INSERT — `published_at` defaultando NOW()

```sql
COALESCE($20::timestamptz, NOW())  -- published_at
$21::timestamptz                    -- closes_at (NULL ok)
```

---

## Match — Hard Filters

### Comportamento atual (default)

`matchWorkersForJob(jobId, options)` com `useScoring=false`:

1. **Hard filter SQL** elimina por status/blacklist/profession/geo.
2. **Post-filter** decifra sex e aplica regras conservadoras.
3. **Sort** por distância ASC (workers sem coords no fim).
4. **Top N** (default 20).
5. **Persistência** em `worker_job_applications` com `match_score=NULL`.

### Os 3 critérios

| Critério | Regra |
|---|---|
| **Sexo** | Vaga `required_sex='M'/'F'` → exige worker com `sex_encrypted` cadastrado E batendo. Worker sem sex → **excluído**. Vaga `BOTH`/`null` → aceita qualquer. |
| **Profissão** | Vaga `required_professions=['AT']` → worker.occupation deve estar na lista. Vaga `null`/`[]` → aceita qualquer. |
| **Distância** | Default 30km (`DEFAULT_RADIUS_KM`). Excluí worker apenas se **vaga e worker têm coords E distância > raio**. Worker sem coords passa como `distanceKm: null` (distance unknown). |

### Endpoint

`POST /api/admin/vacancies/:id/match?radius_km=30&top_n=20&exclude_active=false&use_scoring=false`

- `use_scoring=true` liga Fase 2 (structured) + Fase 3 (LLM Groq) — desligadas por default porque histórico (rejection, quality_rating, diagnostic_preferences) não está maduro.

### Fase 2 e 3 (não usadas hoje)

Código preservado em `MatchmakingStructuredScorer.ts` e `MatchmakingLLMScorer.ts`. Pra reativar: passar `useScoring: true`. Quando o histórico amadurecer, alguém deve revisitar:
- `computeStructuredScore` — pesos (occupation 40, geo 35, dx 25) + penalties por rejection
- LLM — formula `final = structured*0.35 + llm*0.65`

---

## Geocoding — Pipeline e backfill

### No upsert (forward fix)

`PatientService.replaceAddresses` chama `geocodePatientAddressesBestEffort` antes do INSERT em `patient_addresses`. **Best-effort:**
- Timeout 8s no batch inteiro
- Falhas (quota, ZERO_RESULTS, sem key) → `lat=lng=NULL`, mas o INSERT continua
- Nunca derruba o sync do paciente

### Backfill one-off

```bash
GOOGLE_MAPS_API_KEY=xxx npx ts-node -r dotenv/config \
  scripts/backfill-patient-addresses-geocoding.ts [--dry-run] [--limit N]
```

Custo: ~$0.005/endereço. Idempotente (`WHERE lat IS NULL`).

### `.env` necessário

```
GOOGLE_MAPS_API_KEY=AIza...      # backend (PatientService, backfill)
VITE_GOOGLE_MAPS_API_KEY=AIza... # frontend (mapa, GooglePlacesAutocomplete)
```

---

## Testes

### Os 3 níveis

| Nível | Onde | Quando | Roda em CI |
|---|---|---|---|
| **Unit / component** | `*.test.ts(x)` (Vitest FE / Jest BE) | Funções puras, componentes isolados, schemas Zod, repositórios mockados | ✓ |
| **E2E mockado** | `e2e/*.e2e.ts` | UI completa de uma página, regressão visual | ✓ |
| **E2E integration** | `e2e/integration/*.integration.e2e.ts` | Persistência, contratos backend, drift de schema | ✗ (só local) |

### Como rodar integration

```bash
make test-integration                                                 # todos
make test-integration ARGS="e2e/integration/foo.integration.e2e.ts"   # arquivo
make test-integration ARGS="--grep 'PUT updates'"                     # filtro
```

Faz setup automático: recria `enlite-api` com `USE_MOCK_AUTH=true`, roda, restaura prod-auth no exit (trap).

### O que mockar em integration (e SÓ esses)

- `/generate-ai-content` (Gemini — custo)
- `/publish-talentum` (não polui prod do Talentum)
- `/api/admin/auth/profile`
- Firebase Identity Toolkit (auth fake JWT)
- `/meet-links/lookup` (Google Calendar)

**Tudo o resto bate no backend real.**

### Auth em integration

Backend roda `USE_MOCK_AUTH=true`. Token mock direto:
```ts
const MOCK_TOKEN = 'mock_' + Buffer.from(JSON.stringify({ uid, email, role })).toString('base64');
// header: Authorization: Bearer ${MOCK_TOKEN}
```

### Helpers DB (`e2e/helpers/db-test-helper.ts`)

```ts
insertTestPatient({ withAddress, addressLat, addressLng })   // → { patientId, addressId }
insertBaseVacancy({ patientId, patientAddressId, caseNumber }) // necessário pro case-select carregar
insertTestWorker({ sex, occupation, lat, lng, ... })         // base64 PII (KMS testMode)
cleanupTestPatient(id) / cleanupTestWorker(id) / cleanupVacancies(ids[])
getVacancyById(id) → JobPostingRow (inclui published_at, closes_at)
```

### Specs integration cobrindo vaga

| Arquivo | Specs | Cobre |
|---|---|---|
| [`vacancy-dates.integration.e2e.ts`](../enlite-frontend/e2e/integration/vacancy-dates.integration.e2e.ts) | 4 | POST/PUT de `published_at`/`closes_at` (default NOW, NULL opcional) |
| [`full-create-vacancy.integration.e2e.ts`](../enlite-frontend/e2e/integration/full-create-vacancy.integration.e2e.ts) | 1 caminho feliz + health | UI completa: case-select → hidratação → mapa → schedule → meet → submit → AI mock → Talentum mock → SELECT no DB |
| [`match-hard-filter.integration.e2e.ts`](../enlite-frontend/e2e/integration/match-hard-filter.integration.e2e.ts) | 1 | 5 workers cobrem sex/profession/distance/no-coords |
| [`admission-patient-flow.integration.e2e.ts`](../enlite-frontend/e2e/integration/admission-patient-flow.integration.e2e.ts) | 1 skip | TODO: migrar pro pattern case-select |

**Suite completa atual:** 8 passed / 1 skipped em ~11s.

---

## Aprendizados / regras críticas

> Cada item já mordeu o time. Verificar SEMPRE.

### Schema drift no banco local
Migrations não aplicadas → backend retorna 500 silencioso, frontend mostra tela vazia sem erro. Sempre: `node worker-functions/scripts/run-migrations-docker.js`.

### Drift TS ↔ SQL
Postgres `numeric` vira string em JSON. Tipos TS com `number` causam `NaN` silencioso. **Normalize na borda do API service** (`Number(r.lat)`).

### Whitelist de UPDATE/CREATE esquecido
Adicionou campo no DTO mas não no `allowedFields`? Backend ignora, UI parece funcionar. **Spec integration que faz PUT e lê do DB** é o gate.

### Geocoding NÃO é cliente
Frontend não chama `Geocoder` direto. Coords vêm do banco, populadas no upsert ou via backfill.

### `address_formatted` vazio é normal
Use sempre `formatted || raw || '—'` em qualquer display de endereço.

### Auto-select de endereço
1 endereço → `useVacancyModalFlow.selectCase` auto-popula `selectedAddressId`. Sem isso, mapa fica em placeholder.

### `23:59`, NUNCA `24:00`
HH:mm canônico. `24:00` quebra Postgres `time`, JS `Date`, validators.

### Timezone — `todayIsoDate()` em vez de `toISOString().slice(0,10)`
UTC-3 (AR) → `toISOString` virava ontem. Sempre construir `${y}-${m}-${day}` com getters locais.

### `any` proibido em código novo
Use interfaces dedicadas, `unknown` + narrowing, ou tipos do Zod inferidos. Dívida pré-existente NÃO justifica propagar.

### Sprint doc ≠ realidade
`SPRINT_CREATE_VACANCY_FORM_REFACTOR.md` descreve autocomplete de paciente. **A UI real usa case-select.** Antes de escrever spec/feature, abra `/admin/vacancies/new` no browser e veja qual pattern está hoje.

### Limite 400 linhas (backend)
Ao tocar arquivo já no limite: split na mesma PR. `MatchmakingService.ts` foi de 401 → 363 extraindo `MatchmakingStructuredScorer.ts` + `MatchmakingHardFilterPath.ts`.

### CI atual NÃO roda integration
Os specs `*.integration.e2e.ts` só rodam local (`make test-integration`). Gap conhecido — não confiar em CI verde como prova de integração ponta-a-ponta.

---

## Quick reference

### Criar nova vaga via API (raw)

```bash
curl -X POST http://localhost:8080/api/admin/vacancies \
  -H "Authorization: Bearer mock_$(echo '{"uid":"x","email":"x","role":"admin"}' | base64)" \
  -H "Content-Type: application/json" \
  -d '{
    "case_number": 12345,
    "patient_id": "...",
    "patient_address_id": "...",
    "required_professions": ["AT"],
    "required_sex": "M",
    "providers_needed": 1,
    "schedule": [{"dayOfWeek":1,"startTime":"09:00","endTime":"17:00"}],
    "status": "SEARCHING",
    "published_at": "2026-05-05",
    "closes_at": null
  }'
```

### Disparar match

```bash
curl -X POST "http://localhost:8080/api/admin/vacancies/$VACANCY_ID/match?radius_km=30" \
  -H "Authorization: Bearer mock_$(echo '{"uid":"x","email":"x","role":"admin"}' | base64)"
```

### Backfill geocoding (em massa, $)

```bash
GOOGLE_MAPS_API_KEY=$KEY npx ts-node -r dotenv/config \
  worker-functions/scripts/backfill-patient-addresses-geocoding.ts
```
