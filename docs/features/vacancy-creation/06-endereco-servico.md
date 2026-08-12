# 06 — Endereço de Serviço (fonte da verdade)

Doc canônico de como o endereço de prestação flui do ClickUp para a vaga, e por que **vagas antigas preservam o endereço escolhido na criação** mesmo quando o paciente muda de endereço no ClickUp.

> **Regra de ouro:**
> Vaga publicada **NUNCA** pode ter seu endereço alterado silenciosamente pelo sync do ClickUp. O endereço gravado na criação é congelado pela FK `patient_address_id`, e mudanças no ClickUp criam **uma nova row** em `patient_addresses` (versioning), preservando a antiga.

## O modelo

```
patient_addresses (tabela)
  ├─ id       (UUID, PK)
  ├─ patient_id
  ├─ address_formatted   ← Google Places, vem de "Domicilio N Principal Paciente" no ClickUp
  ├─ address_raw         ← texto livre, vem de "Domicilio Informado Paciente N"
  ├─ display_order       ← 1, 2, 3 (slot do ClickUp)
  ├─ state, city, neighborhood   ← extraídos de address_components do mesmo "Domicilio N Principal"
  ├─ lat, lng            ← do mesmo location field
  ├─ complement          ← editável manualmente (Apto, Piso)
  └─ archived_at         ← NULL = ativo; preenchido = versão antiga preservada

job_postings.patient_address_id  →  FK para patient_addresses.id (ON DELETE RESTRICT)
```

**Princípio chave:** uma vaga aponta para uma row específica de `patient_addresses`. Se essa row tem `archived_at IS NULL`, é o endereço **atual** do paciente. Se tem `archived_at != NULL`, é uma **versão histórica** preservada porque pelo menos uma vaga ainda aponta pra ela.

## Como o sync ClickUp escreve

O mapper [`ClickUpPatientMapper`](../../../worker-functions/src/modules/integration/infrastructure/clickup/ClickUpPatientMapper.ts) extrai `address_formatted`, `address_raw`, `state`, `city`, `neighborhood`, `lat`, `lng` para cada slot 1/2/3.

**Regra (migration 198 + fix do mapper 2026-05-26 + semântica híbrida 2026-05-27):**

| Cenário | Operação no banco |
|---|---|
| Slot 1 não existia, ClickUp tem `Domicilio 1` | **INSERT** nova row, `display_order=1`, `archived_at=NULL` |
| Slot 1 existe, `address_formatted` IGUAL, **nenhuma vaga publicada** aponta | **UPDATE in-place** (refresh barato de geocoding/components). Drafts apontando refletem o refresh. |
| Slot 1 existe, `address_formatted` IGUAL, **pelo menos 1 vaga publicada** (is_draft=false, not deleted) aponta | **VERSIONAR** mesmo sem mudança de rua: archive a row + INSERT nova. Vaga publicada preserva snapshot. Drafts (se houver) são REMAPADAS pra nova row. |
| Slot 1 existe, `address_formatted` DIFERENTE | **VERSIONAR**: archive a row antiga + INSERT nova. Vagas publicadas preservam snapshot. Drafts são REMAPADAS pra nova row. |
| Slot 1 existe no banco mas ClickUp não enviou mais nada nesse slot (operador limpou no ClickUp) | Se há vaga referenciando: **archive** (`archived_at = NOW()`). Se órfã: **DELETE** |

Implementação em [`PatientRelatedWriter.replacePatientAddresses`](../../../worker-functions/src/modules/case/application/PatientRelatedWriter.ts).

**Semântica resultante:**
- Vaga `is_draft=true` (rascunho): sempre vê o endereço **atual** — refresh livre.
- Vaga `is_draft=false` (publicada): sempre vê o endereço que estava ativo no momento da publicação — snapshot congelado.

## Como o sync extrai state/city/neighborhood

Cada slot extrai `state`, `city`, `neighborhood` **do PRÓPRIO `Domicilio N Principal Paciente`**, usando `address_components` do Google Places (variantes strict do helper [`locationHelpers`](../../../worker-functions/src/modules/integration/infrastructure/clickup/helpers/locationHelpers.ts)).

Apenas no **slot 1**, quando o location field não tem `address_components`, há fallback nos 3 custom fields legacy patient-level:

- `Provincia del Paciente` → state
- `Ciudad / Localidad del Paciente` → city
- `Zona o Barrio Paciente` → neighborhood

Esse fallback existe pra compatibilidade com dados históricos onde a ClickUp não retornou address_components. Antes da fix de 2026-05-26, esses 3 fields eram a **fonte primária** — o que causava drift: operador atualizava o `Domicilio Principal` no ClickUp mas esquecia de atualizar os 3 patient-level fields, e a vaga ficava com state/city/neighborhood do endereço antigo enquanto `address_formatted` mostrava o novo.

## Como o sync DETECTA "mudança"

Critério atual: **qualquer diferença textual em `address_formatted`**. Robusto e simples. Lat/lng não é critério (refresh de geocoding não dispara versioning).

```ts
const incomingFormatted = a.addressFormatted ?? null;
const currentFormatted  = existingForSlot?.address_formatted ?? null;
const formattedChanged  = existingForSlot !== undefined && incomingFormatted !== currentFormatted;

if (existingForSlot && !formattedChanged) {
  // Path 1: UPDATE in-place (no street change)
} else if (existingForSlot && formattedChanged) {
  // Path 2: VERSION — archive old + INSERT new
}
```

## Como os consumidores leem

### Form de criação de vaga (listagem de endereços do paciente)

`GET /api/admin/patients/:patientId/addresses` — filtra `archived_at IS NULL`. Recrutadora só vê endereços ativos.

Implementação em [`AdminPatientsController.listPatientAddresses`](../../../worker-functions/src/modules/case/interfaces/controllers/AdminPatientsController.ts).

### Validação no POST de vaga

`POST /api/admin/vacancies` em [`VacancyCrudController.createVacancy`](../../../worker-functions/src/modules/matching/interfaces/controllers/VacancyCrudController.ts): rejeita 400 se `patient_address_id` aponta pra uma row arquivada. Nova vaga só pode bind em endereço ativo.

### Detalhe da vaga (`getVacancyById`)

`GET /api/admin/vacancies/:id` em [`VacanciesController.getVacancyById`](../../../worker-functions/src/modules/matching/interfaces/controllers/VacanciesController.ts): JOIN `LEFT JOIN patient_addresses pa ON jp.patient_address_id = pa.id` **sem filtro de archived**. Permite que vaga antiga continue mostrando o endereço congelado da época da criação.

### Detalhe do paciente

`PatientDetailQueryHelper.fetchPatientAddresses` filtra `archived_at IS NULL`. Operador só vê os ativos quando olha a ficha do paciente.

### Endpoint público `/api/public/v1/jobs`

JOIN com `patient_addresses` sem filtro. Vagas públicas continuam mostrando o endereço escolhido na criação, mesmo que essa row tenha sido arquivada depois.

## Quando o operador deve fechar a vaga antiga?

Decisão operacional manual. Indicadores:

- Paciente mudou de endereço significativamente (outra cidade, outra zona)
- O prestador atribuído já não consegue cumprir o trajeto novo
- A vaga não faz mais sentido com o paciente no novo local

**O sistema não fecha nada automaticamente.** Versionamento existe pra preservar o contexto histórico — operador decide se mantém a vaga atual (porque, por exemplo, ainda há entrevistas marcadas com o endereço antigo) ou se fecha e abre nova com o novo endereço.

Decisão registrada em [README.md F6/F7](README.md#plano-de-fases-fix-mapper).

## E o `lat/lng` da vaga?

`patient_address.lat/lng` é usado pelo matchmaking (`MatchmakingService.loadJob` faz JOIN). Como a FK aponta pra row arquivada, vaga antiga continua usando coords antigas — coerente com "endereço antigo".

Pra vaga nova com endereço novo, o `MatchmakingService` puxa coords da nova row (ativa). Comportamento esperado.

## Tests de regressão

- **Unit:** [`ClickUpPatientMapper.test.ts`](../../../worker-functions/tests/unit/__tests__/ClickUpPatientMapper.test.ts) — 50/50 verdes; caso `(t) REGRESSION 429-948` cobre exatamente o cenário "Domicilio Principal atualizado, legacy fields stale, mapper escolhe os address_components".
- **E2E full flow:** [`vacancy-address-versioning.e2e.test.ts`](../../../worker-functions/tests/e2e/vacancy-address-versioning.e2e.test.ts) — paciente via webhook → vaga 1 → update webhook → vaga 2 → assert vaga 1 preserva antigo, vaga 2 tem novo, archived address rejeitado em novo binding.

## Migrations relacionadas

| # | O quê |
|---|---|
| 149 | ADD FK `patient_address_id` |
| 150 | Backfill por fuzzy match |
| 152 | DROP colunas duplicadas (`service_address_*`, `state`, `city`, etc.) |
| 153-156 | Move `lat/lng` para `patient_addresses` |
| 157 | ADD `complement` |
| **198** (este fix) | **ADD `archived_at` + índice parcial pra ativos** |
