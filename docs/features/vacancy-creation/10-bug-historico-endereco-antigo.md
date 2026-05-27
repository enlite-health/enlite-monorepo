# 10 — Postmortem: "Vaga ficou com endereço antigo"

> **Reportado em:** 2026-05-26 pelo PO (Gabriel).
> **Diagnóstico + fix:** 2026-05-26 (mesma sessão).
> **Severidade:** Alta. Toda vaga pré-existente podia exibir endereço diferente do escolhido pelo operador na criação, sem que ele percebesse.
> **Status:** Fix implementado, testado (50/50 unit do mapper + E2E full flow + 9 suites E2E relacionadas), aguardando deploy em prod (rodar migration 198 + sync via `import-patients-from-clickup.ts`).

## 1. Sintoma

> "Quando editam o endereço DO PACIENTE no CLICKUP se atualiza visualmente na plataforma Enlite. MAS quando se cria a vacante para AQUELE PACIENTE com o NOVO ENDEREÇO DO PACIENTE grava desatualizado.
> O que NÃO PODEMOS DE JEITO NENHUM é atualizar o endereço de uma vaga existente pelo novo endereço que a operadora atualizou via ClickUp."

Duas reclamações entrelaçadas:

1. **Vaga nova grava com endereço antigo:** ao criar uma vaga depois de uma mudança no ClickUp, alguns campos da vaga aparecem com o endereço antigo.
2. **Vagas existentes mudam silenciosamente:** quando ClickUp atualiza, vagas que apontavam pra aquela row começam a refletir o conteúdo novo. Operacionalmente errado.

## 2. Investigação empírica (caso 429-948)

DBA rastreou o caso real "CASO 429-948":

| Campo | Valor no banco |
|---|---|
| `vacancy_id` | `371aea14-d36a-46d3-8707-2097b41a5560` |
| `patient_address_id` | `100a0298-6216-4f8d-9ece-872ebb918840` |
| `pa.address_formatted` | `"Av. Entre Ríos 2144, C1133AAJ CABA, Argentina"` ✅ NOVO |
| `pa.neighborhood` | `"Villa Ballester"` ❌ ANTIGO |
| `pa.city`, `pa.state` | vazio | empty |
| `pa.updated_at` | 2026-05-26 18:15 (poucas horas antes da reclamação) |
| 3 vagas referenciam essa row | 126, 931, 948 |

A row foi atualizada in-place pelo webhook ClickUp. `address_formatted` foi corrigido pra novo endereço, mas `neighborhood` ficou apontando pro endereço antigo.

## 3. Duas causas-raiz independentes

### Causa-raiz 1: Split nos custom fields ClickUp

O mapper [`ClickUpPatientMapper`](../../../worker-functions/src/modules/integration/infrastructure/clickup/ClickUpPatientMapper.ts) lia `state`, `city`, `neighborhood` de **3 custom fields SEPARADOS no ClickUp**:

- `Provincia del Paciente` → state
- `Ciudad / Localidad del Paciente` → city
- `Zona o Barrio Paciente` → neighborhood

Esses são patient-level, separados do `Domicilio 1 Principal Paciente` que dá origem a `address_formatted`. Operador atualizou só o `Domicilio Principal` e esqueceu (ou não soube) atualizar os 3 patient-level fields → row do banco fica com `address_formatted` novo + `neighborhood`/`city`/`state` velhos.

A página de detalhe da vaga ([`VacancyCaseCard.tsx:117`](../../../enlite-frontend/src/presentation/components/features/admin/VacancyDetail/VacancyCaseCard.tsx)) renderiza `patientCity + patientNeighborhood` → mostra "Villa Ballester" antigo enquanto a ficha do paciente mostra "Av. Entre Ríos CABA" novo (que vem de `address_formatted`).

### Causa-raiz 2: UPDATE in-place propaga pra todas as vagas

Mesmo se a causa 1 estivesse fixada, o sync ClickUp **mutava silenciosamente** a row de `patient_addresses` quando o operador atualizava o endereço. Toda vaga apontando pra essa row passava a "mostrar" o novo endereço — comportamento errado: operador escolheu o endereço A na criação da vaga e a vaga deveria preservar A.

DBA confirmou: **279 das 281 vagas ativas com endereço (99,3%)** tinham `patient_addresses.updated_at > job_postings.created_at`, com gaps que chegam a 51 dias. Quase toda vaga ativa já havia sido "mudada silenciosamente" pelo menos uma vez.

## 4. Fix

### Parte 1 — Mapper extrai do mesmo location field

Refatoração de [`ClickUpPatientMapper.buildAddresses`](../../../worker-functions/src/modules/integration/infrastructure/clickup/ClickUpPatientMapper.ts) + novos helpers em [`locationHelpers.ts`](../../../worker-functions/src/modules/integration/infrastructure/clickup/helpers/locationHelpers.ts):

```ts
// Cada slot extrai state/city/neighborhood do PRÓPRIO Domicilio N Principal
// (address_components do Google Places). Legacy patient-level fields ficam
// como fallback APENAS no slot 1 quando o location não tem components.
const state = extractStateFromLocationStrict(slot.location)
           ?? (slot.useLegacyFallback ? legacyPatientState : null);
const city = extractCityFromLocationStrict(slot.location)
          ?? (slot.useLegacyFallback ? legacyPatientCity : null);
const neighborhood = extractNeighborhoodFromLocation(slot.location)
                  ?? (slot.useLegacyFallback ? legacyPatientNeighborhood : null);
```

Helpers strict não fazem fallback de parse de `formatted_address` (porque o location é endereço completo — "Av Foo 100, CABA"; primeiro segmento é a rua, não o state).

### Parte 2 — Versionamento (migration 198)

Adição da coluna `archived_at TIMESTAMPTZ NULL` em `patient_addresses` (migration 198). Refatoração de [`PatientRelatedWriter.replacePatientAddresses`](../../../worker-functions/src/modules/case/application/PatientRelatedWriter.ts):

```ts
const formattedChanged = existingForSlot && incomingFormatted !== currentFormatted;

if (existingForSlot && !formattedChanged) {
  // Path 1: UPDATE in-place (no street change)
}
if (existingForSlot && formattedChanged) {
  // Path 2: VERSION — archive old + INSERT new
  await client.query(`UPDATE patient_addresses SET archived_at = NOW() WHERE id = $1`, [existingForSlot.id]);
}
// Path 2 (continued) or Path 3: INSERT new
await client.query(`INSERT INTO patient_addresses (...)`);
```

Vagas que apontam pra row arquivada **preservam** o endereço original (FK não muda).

### Parte 3 — Filtros archived_at em 6 lugares

Endpoints que listam endereços ATIVOS pro operador filtram `archived_at IS NULL`:

| Arquivo | Endpoint / função |
|---|---|
| `AdminPatientsController.listPatientAddresses` | `GET /api/admin/patients/:id/addresses` |
| `AdminPatientsController.createPatientAddress` | `MAX(display_order)` ao auto-incrementar |
| `PatientDetailQueryHelper.fetchPatientAddresses` | Listagem de endereços na ficha do paciente |
| `PatientQueryRepository.list` | `addressesCount` na listagem de pacientes |
| `VacanciesController.getCasesForSelect` | EXISTS check de endereço ativo |
| `VacancyCrudController.createVacancy` | Owner check: `patient_address_id` ativo |
| `VacancyAddressReviewController` | Owner check: `patient_address_id` ativo |
| `PatientAddressRepository` (legacy) | Lookups de match |

Endpoints que retornam DETALHE da vaga (`getVacancyById`, public jobs, matchmaking) continuam fazendo JOIN sem filtro — porque a vaga aponta pra row específica e queremos preservar o conteúdo histórico.

## 5. Validação

### Unit (Jest)

[`ClickUpPatientMapper.test.ts`](../../../worker-functions/tests/unit/__tests__/ClickUpPatientMapper.test.ts) — **50/50 verdes**. Casos relevantes:

- `(a)` Legacy fields stale → mapper escolhe address_components do `Domicilio 1`
- `(d)`, `(g)` Slot 1 com address_components → extrai correto
- `(e)`, `(e2)` Slot 1 sem components → cai no legacy fallback (slot 1 only)
- `(l)` Slot 2 com address_components → também extrai (não fica null, comportamento novo)
- `(t)` **REGRESSION 429-948**: location nova + legacy fields stale → mapper escolhe os components do location, NOT do legacy

### E2E full flow

[`vacancy-address-versioning.e2e.test.ts`](../../../worker-functions/tests/e2e/vacancy-address-versioning.e2e.test.ts) — **1/1 verde**. Cobre o fluxo completo pedido pelo PO:

1. Webhook ClickUp cria paciente com `"Av A 100, Villa Ballester"`.
2. POST `/api/admin/vacancies` cria vaga 1 → bind no address ativo.
3. Webhook ClickUp atualiza paciente pra `"Av B 999, CABA"`.
4. Assert: row antiga tem `archived_at != NULL`; nova row foi criada no mesmo `display_order=1`.
5. Assert: `GET /api/admin/patients/:id/addresses` retorna SÓ a nova.
6. POST `/api/admin/vacancies` cria vaga 2 → bind no address novo.
7. Assert: `GET /api/admin/vacancies/<vaga 1>` retorna "Av A 100, Villa Ballester" (preservado).
8. Assert: `GET /api/admin/vacancies/<vaga 2>` retorna "Av B 999, CABA".
9. Assert: tentar POST nova vaga com `patient_address_id` arquivado → 400.

### E2E sem regressão

9 suites relacionadas (`clickup-patient-webhook`, `patient*`, `phase1-new-vacancy-form`, `phase1-vacancies-invariants`, `admin-vacancy-detail`, `wave6-job-postings`, `vacancies-api`) — **177/178 verdes**. A 1 falha residual (`vacancies-api` test stale que tenta PUT title em vaga ACTIVE) é pré-existente.

### Type-check

- Backend `tsc --noEmit` verde
- Frontend `pnpm type-check` verde

## 6. Deploy em prod

1. **Rodar migration 198:**
   ```bash
   ./scripts/run-migration-prod.sh worker-functions/migrations/198_archive_patient_addresses.sql
   ```
2. **Deploy worker-functions** (Cloud Run) com o código novo.
3. **Re-sync paciente:**
   ```bash
   cd worker-functions && npx ts-node scripts/import-patients-from-clickup.ts --live
   ```
   Esse passo é importante porque:
   - Aplica o mapper NOVO a todos os pacientes existentes → corrige `neighborhood`/`city`/`state` de pacientes onde os custom fields legacy estavam stale.
   - O webhook ClickUp cobre pacientes futuros, mas pacientes inativos / sem alteração no ClickUp não disparam webhook automaticamente — o backfill via CLI cobre isso.
4. **Validação manual:** abrir o caso 429-948 no painel; verificar que o card mostra "Av. Entre Ríos 2144, CABA" no neighborhood — ou aceitar que vaga antiga preserva contexto histórico se a operadora preferir.
5. **Monitorar Cloud Logging** por 24h pelas mensagens `clickup_webhook.*` — confirmar que sync versiona ao invés de UPDATE.

## 7. Lições aprendidas

1. **Custom fields ClickUp espalhados em múltiplos slots** geram drift silencioso. Sempre que possível, extrair derivados (state/city/neighborhood) do MESMO source (address_components) em vez de campos separados que dependem da disciplina do operador.
2. **UPDATE in-place quando há referência** quebra contratos de imutabilidade implícitos. Versionamento (`archived_at`) é o padrão quando outras tabelas referenciam.
3. **Discovery profunda economiza fix errado.** Primeira hipótese ("snapshot na vaga") foi refutada após user explicar o cenário real ("ClickUp mostra novo no painel mas vaga grava antigo"). Sem isso, teríamos implementado snapshot inútil.
4. **Pedir caso concreto antes de inferir.** Caso 429-948 mostrou exatamente o split formatted vs neighborhood — sem essa amostra, o diagnóstico ficaria abstrato.
5. **Doc + E2E full flow valem o investimento.** Reproduz o cenário operacional ponta-a-ponta e protege contra regressão futura.
