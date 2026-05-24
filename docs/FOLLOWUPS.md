# Follow-ups — Débitos Técnicos e Decisões Pendentes

> Registro central de itens descobertos durante implementações que **não bloqueiam o trabalho atual**, mas precisam ser tratados depois (ou dependem de decisão fora da engenharia).
>
> Convenção: cada item tem **status**, **descoberto em** (data + contexto), **dono provável** e **bloqueador? sim/não**.

---

## Débitos Técnicos

### TD-001 — `ClickUpVacancyMapper` não estrutura `Días y Horarios`

- **Status:** aberto
- **Descoberto em:** 2026-05-01, durante spike do refactor de criação de vaga
- **Dono provável:** backend (worker-functions)
- **Bloqueador?** Não — afeta o cálculo de availability de endereços (Tela 1 nova), mas o fallback "endereço com vagas sem schedule não fica disabled" cobre

**O que é:**

A list ClickUp `Estado de Pacientes` tem **295 tasks** com o custom field `Días y Horarios de Acompañamiento` populado (em texto livre tipo `"Lunes a Viernes 07-10 y 16-21"`). O `ClickUpVacancyMapper.ts` lê esse campo como string crua e grava em `job_postings.schedule_days_hours`, mas **não** parseia para o array jsonb estruturado em `job_postings.schedule`.

Resultado: das 295 tasks com schedule textual, só **29 vagas no banco** têm o array jsonb populado (~10%) — a maioria provavelmente veio do form de criação manual antigo, não do sync ClickUp.

**Impacto:**

- Endpoint `GET /patients/:id/full` (novo) retorna availability de endereço com base em `job_postings.schedule` jsonb. Vagas sem o array contam como "schedule indefinido" — o algoritmo trata como "horas não conhecidas" e não desabilita o endereço, mas perde precisão.
- Quando 90% das vagas ativas vierem do ClickUp via sync, a UX do dropdown fica degradada até esse parser ser implementado.

**Proposta de solução:**

1. Criar parser `parseScheduleText(raw: string): ScheduleSlot[]` que reconheça os padrões observados:
   - `"Lunes a Viernes de HH:MM a HH:MM"`
   - `"Lunes; Miércoles y Viernes de HH a HH"`
   - `"Lunes 07-10 y 16-21"` (split shift no mesmo dia)
   - `"Mañana (HH:MM a HH:MM) y Tarde (HH:MM a HH:MM)"`
   - Retornar `[]` quando padrão não reconhecido (manter `schedule_days_hours` como fallback)
2. `ClickUpVacancyMapper` chama o parser e popula `job_postings.schedule` quando reconhece
3. Backfill one-shot: rodar parser contra as 266 vagas que hoje têm `schedule_days_hours` mas `schedule = []`
4. Métrica de cobertura no log do sync: `% de vagas com schedule estruturado pós-sync`

**Cases de teste reais (do ClickUp em 2026-05-01):**

| Padrão | Texto cru | Esperado |
|---|---|---|
| Range simples | `"Lunes a Viernes de 08:00 a 14:00"` | 5 slots (DOW 1-5, 08:00-14:00) |
| Lista discreta | `"Lunes, Miércoles y Viernes 18-21"` | 3 slots (DOW 1,3,5, 18:00-21:00) |
| Split shift | `"Lunes a Viernes 07-10 y 16-21"` | 10 slots (5 dias × 2 turnos) |
| Manhã+tarde | `"Mañana (09:00 a 11:30) y Tarde (17:00 a 19:00)"` | depende do dia base — ambíguo, registrar em log |
| Horas variáveis | `"Lunes: 7h (11-18), Martes: 7h (11-18), Miércoles: 4h (14-18)"` | 1 slot por dia explícito |

---

### TD-002 — Scripts CLI ad-hoc viram bombas-relógio quando schema muda

- **Status:** mitigado em 2026-05-01
- **Descoberto em:** 2026-05-01, durante Fase 0.5 do refactor de criação de vaga (E2E baseline fix)
- **Dono provável:** todo dev que escrever script CLI novo
- **Bloqueador?** Não (foi mitigado)

**O que aconteceu:**

Migration 152 (Fase 9 do sprint anterior) dropou colunas de `job_postings` (`pathology_types`, `dependency_level`, `service_device_types`, etc.). O código de produção foi atualizado em sequência. Mas o script `worker-functions/scripts/enrich-vacancies-with-gemini.ts` — um CLI ad-hoc não invocado por ninguém (não tava em `package.json` scripts, cron, Makefile ou docs) — ficou referenciando as colunas dropadas em SQL strings cruas. tsc não pegou (SQL é string opaca). Nenhum E2E exercitava o script. Bomba-relógio passou despercebida ~1 semana até virar visível durante esse refactor.

**Padrão geral:**

Scripts em `scripts/*.ts` que fazem SQL direto via `pg` Pool são vulneráveis a:
- Drift silencioso quando coluna é dropada/renomeada
- Falta de cobertura E2E (especialmente CLIs one-shot)
- Esquecimento (script criado pra fix pontual, fica esquecido, ninguém percebe que quebrou)

**Mitigações aplicadas em 2026-05-01:**

1. **Script morto deletado:** `enrich-vacancies-with-gemini.ts` removido. Helpers e testes E2E (`phase3-enrichment-invariants.e2e.test.ts`, `enrich-vacancies-validation.test.ts`) ficam — testam invariantes I14-I18 (idempotência, fill-only, etc.) e exercitam SQL real, então são "vivos".
2. **`.claude/hooks/validate-migration.sh` estendido:** quando uma migration faz `DROP COLUMN`, o hook faz grep em `worker-functions/src/` e `worker-functions/scripts/` pelo nome da coluna. Se houver referência fora de comentário e fora de arquivos `_deprecated_`, **bloqueia a migration** e lista os arquivos. Isso fecha a categoria do problema — próximo DROP que esquecer de atualizar código vai bater no hook ANTES de a migration ser aplicada.

**Recomendações pra desenvolvedores futuros:**

- Antes de criar script CLI em `scripts/`, pergunte: "isso é one-shot ou vai virar rotina?" Se rotina, wire em `package.json` + adicionar ao Cloud Scheduler. Se one-shot, **delete depois de rodar**.
- Se o script vai persistir, adicione um teste E2E que exercite a query principal contra postgres real.
- Nunca confie só em tsc pra mudanças de schema — SQL string é opaco.

---

### TD-003 — Deprecar `VacancyModal/` legacy

- **Status:** aberto, proposta
- **Descoberto em:** 2026-05-02, durante Sprint de criação de vaga V2 (form único)
- **Dono provável:** frontend
- **Bloqueador?** Não — workaround aplicado (endpoint `cases-for-select` restaurado)

**Contexto:**

Hoje convivem 2 fluxos de criação/edição de vaga no admin:

1. **`CreateVacancyV2/`** (novo, em `enlite-frontend/src/presentation/components/features/admin/CreateVacancyV2/`) — form único, autocomplete de paciente, navegação `/admin/vacancies/new` → `/admin/vacancies/:id/talentum` → `/admin/vacancies/:id`
2. **`VacancyModal/`** (legacy, em `enlite-frontend/src/presentation/components/features/admin/VacancyModal/`) — modal aberto da `AdminVacanciesPage` ao clicar em "Editar" numa linha. Usa `CaseSelectStep`, `VacancyFormSection` etc. Depende dos endpoints `getCasesForSelect()` e `getNextVacancyNumber()`.

**Por que isso é débito:**

- 2 caminhos para criar/editar vaga = inconsistência de UX (recrutadora vê 2 layouts diferentes)
- 2 implementações de hidratação de paciente, schedule picker, address selector
- O `VacancyModal/` ainda usa estilo antigo (parcialmente migrado pelos atoms globais que mudaram, mas a estrutura é diferente)
- Descoberta: durante Fase 2 do refactor, o endpoint `cases-for-select` foi deletado por engano porque o architect's audit assumiu que era exclusivo do wizard. **Foi restaurado** (em `VacanciesController.getCasesForSelect()` + rota em `adminVacanciesRoutes.ts`) porque `VacancyModal` ainda depende.

**Proposta:**

1. Adicionar rota `/admin/vacancies/:id/edit` no `App.tsx`
2. `CreateVacancyPage` recebe parâmetro `:id` opcional. Se presente: hidrata via `getVacancyByIdFull(id)` em modo edit. Botão "Salvar" chama `PUT /api/admin/vacancies/:id` em vez de `POST`.
3. `AdminVacanciesPage` ao clicar em "Editar": `navigate('/admin/vacancies/:id/edit')` em vez de abrir o modal.
4. Apaga `VacancyModal/` inteiro (16 arquivos), `useVacancyModalFlow` hook + testes.
5. Remove endpoint `cases-for-select` (segunda tentativa, agora alinhada).
6. Remove `getCasesForSelect()` e `getNextVacancyNumber()` do `AdminApiService.ts` (depois de migrar consumidores).

**Critérios de aceite:**

- 1 caminho único pra criar/editar vaga
- Pasta `VacancyModal/` apagada
- `cases-for-select` removido (segunda tentativa)
- Tests E2E que cobriam edição via modal migram pra cobrir edição via page

**Estimativa:** sprint de 1-2 semanas, depende da complexidade de adaptar o `CreateVacancyForm` pra modo edit (carregar dados existentes, distinguir POST de PUT, validação diferente).

**Memória relevante:** o que mantém o endpoint vivo enquanto não rolar é `VacanciesController.getCasesForSelect()` em `worker-functions/src/modules/matching/interfaces/controllers/VacanciesController.ts` + rota `/vacancies/cases-for-select` em `adminVacanciesRoutes.ts:47-49`.

---

### TD-004 — Vagas órfãs (`patient_id IS NULL`) ficam invisíveis no select de "Nova Vacante"

- **Status:** aberto, mitigado parcialmente em 2026-05-08 (5 vagas relinkadas manualmente em prod)
- **Descoberto em:** 2026-05-08, ao investigar por que `CASO 763-471` não aparecia no select da tela de criação de vaga
- **Dono provável:** backend (worker-functions) + integração com webhook ClickUp (em construção pelo Gabriel em paralelo)
- **Bloqueador?** Não — operação edita vaga manualmente pra linkar paciente; apenas degrada UX e esconde casos.

**Sintoma:**

Operação cria a vaga `CASO X-N` na UI Enlite enquanto o paciente correspondente ainda não foi sincronizado pra `patients` (ou tá flagged). O backend aceita `patient_id=null` sem validar. A vaga é publicada no Talentum mesmo órfã. Quando o sync de pacientes finalmente roda, ele popula `patients`, **mas não relinka vagas pré-existentes**. Resultado: a vaga vira invisível no select porque `getCasesForSelect()` faz `INNER JOIN patients` ([VacanciesController.ts:283-305](../worker-functions/src/modules/matching/interfaces/controllers/VacanciesController.ts#L283-L305)).

**Estado em prod (2026-05-08, antes do fix):**

- 11 vagas órfãs (`patient_id IS NULL`, `case_number IS NOT NULL`) — 8 SEARCHING + 1 RAPID_RESPONSE + 2 CLOSED
- 5 com match identificável no ClickUp via custom field `Caso Número` → relinkadas manualmente em prod (cases 664, 760, 761, 762, 763)
- 6 históricas (cases 112, 119, 469, 514, 650, 733) sem match na lista atual do ClickUp — provavelmente digitadas manualmente sem task correspondente, decisão pendente da operação

**Causa raiz — 3 falhas combinadas:**

1. **Backend permissivo na criação de vaga.** `VacancyCrudController.createVacancy` ([VacancyCrudController.ts:41-137](../worker-functions/src/modules/matching/interfaces/controllers/VacancyCrudController.ts#L41-L137)) e `updateVacancy` ([:205-277](../worker-functions/src/modules/matching/interfaces/controllers/VacancyCrudController.ts#L205-L277)) não validam que `patient_id` é obrigatório. Aceitam `null` e fazem INSERT/UPDATE sem reclamar. O frontend `buildVacancyPayload` ([vacancy-form-schema.ts:202-232](../enlite-frontend/src/presentation/components/features/admin/vacancy-form-schema.ts#L202-L232)) tem `patientId = null` como default — qualquer caminho que chame com `selectedPatientId=null` produz vaga órfã.

2. **Mapper de paciente não persiste `case_number`.** O custom field `Caso Número` existe nas tasks do ClickUp (`Estado de Pacientes` 901304883903), mas `ClickUpPatientMapper.map()` ([ClickUpPatientMapper.ts:39-100](../worker-functions/src/modules/integration/infrastructure/clickup/ClickUpPatientMapper.ts#L39-L100)) ignora esse campo. A tabela `patients` não tem coluna `case_number`. Resultado: **não dá pra cruzar `job_postings.case_number` com `patients.id` via SQL puro** — só consultando o ClickUp por `clickup_task_id`.

3. **Sync de pacientes não tenta relinkar vagas órfãs.** `import-patients-from-clickup.ts` chama `PatientService.upsertFromClickUp()` que toca `patients` + tabelas filhas (responsibles, addresses, professionals), mas **não toca `job_postings`**. Vaga criada antes do paciente fica esquecida.

**Mitigação feita em 2026-05-08:**

UPDATE manual em prod das 5 vagas com match confirmado via API ClickUp (custom field `Caso Número`):

```sql
-- caso 664 → Aparicio (clickup 86ad6x8u6)
UPDATE job_postings SET patient_id = '2f5fe9de-a0fd-49a3-b26f-c4c4b3a6bcee' WHERE id = 'e5d906bc-6367-48d1-a298-5aa5194d2614';
-- caso 760 → Pasqualini (clickup 86ah4mewt)
UPDATE job_postings SET patient_id = '6e92f1af-7b90-4415-9edb-dd958e8a7b0a' WHERE id = 'db2a6e9f-9066-4ad4-8342-997c376d1e7d';
-- caso 761 → TORRES LI DESTRI (clickup 86ah8p6nz)
UPDATE job_postings SET patient_id = 'cda51107-279b-43ed-ba60-9b1958b7ab1e' WHERE id = '2644f0d3-8293-42ef-ae1a-40f92c056165';
-- caso 762 → CUESTA (clickup 86ah8yd62) — ainda invisível porque needs_attention=true (MISSING_INFO)
UPDATE job_postings SET patient_id = '718fed11-3b39-469f-a277-2045c6635382' WHERE id = 'c01ca3dd-bbb8-4df2-8473-5852a927b82a';
-- caso 763 → Guidobono (clickup 86ahapzeg)
UPDATE job_postings SET patient_id = 'afcd1669-fa59-4125-9214-9a2f1994e16c' WHERE id = '8c0ccaca-c9f2-40fd-8bd9-c75bf9a599e6';
```

Após o UPDATE: 4/5 voltaram a aparecer no select. O 5º (caso 762, CUESTA) tem `needs_attention=true` por falta de canal de contato (regra `MISSING_INFO` documentada em `memory/project_patient_contact_channels.md`) — destrava só quando operação preencher responsável no ClickUp.

**Proposta de solução sistêmica (3 frentes):**

### Frente 1 — Validação preventiva no backend

Adicionar guard em `VacancyCrudController.createVacancy`:

```ts
if (!patient_id) {
  res.status(400).json({
    success: false,
    error: 'patient_id é obrigatório. Cadastre o paciente no ClickUp antes de criar a vaga.',
  });
  return;
}
```

E no `updateVacancy`, **proibir** que `patient_id` seja setado pra `null` (permitir só atualizar para outro UUID válido). Isso fecha a entrada do bug — vagas novas não nascem órfãs. Não resolve o legacy (mas o legacy é número finito e cai com o relink da Frente 3).

### Frente 2 — Persistir `case_number` em `patients`

1. **Migration aditiva:** `ALTER TABLE patients ADD COLUMN case_number INTEGER;` + `CREATE INDEX patients_case_number_idx ON patients(case_number) WHERE case_number IS NOT NULL;`. Não unique (caso pode ter histórico de pacientes anteriores reaproveitando o mesmo número, embora seja raro).
2. **Mapper:** `ClickUpPatientMapper` extrai `cf['Caso Número']` (cuidado: vem como string `'762'` no JSON do ClickUp; cast pra `parseInt`).
3. **Backfill one-shot:** script que itera `patients` com `clickup_task_id IS NOT NULL`, busca a task no ClickUp, lê `Caso Número` e roda UPDATE. ~311 chamadas — custo trivial.

### Frente 3 — Auto-relink no webhook (recomendação direta pro Gabriel)

Quando o webhook do ClickUp processar uma task da lista `Estado de Pacientes` (criação OU update), depois de fazer upsert do paciente:

```ts
// Após o upsertFromClickUp() retornar { id: patientId, created, flagged }
const caseNumber = mapper.extractCaseNumber(task); // novo método no mapper
if (caseNumber != null) {
  // Reconcilia vagas órfãs criadas antes do paciente existir.
  // FK em job_postings.patient_id é nullable, não há cascade. Update é idempotente.
  await client.query(
    `UPDATE job_postings
       SET patient_id = $1, updated_at = NOW()
     WHERE case_number = $2
       AND patient_id IS NULL
       AND deleted_at IS NULL`,
    [patientId, caseNumber],
  );
}
```

**Pontos de atenção pra implementação do webhook:**

- **Idempotência:** o webhook do ClickUp pode disparar múltiplas vezes pro mesmo evento. O UPDATE com `WHERE patient_id IS NULL` garante que não sobrescreve um link já feito (humano ou outro relink). Bom.
- **Duplicate case_number:** em prod hoje há cases com múltiplas vagas (caso 760 tem 10 vagas pra Pasqualini). O UPDATE acima linka **todas** as órfãs com aquele case_number ao novo patient — comportamento desejado quando o caso é o mesmo paciente.
- **Coleção de risco:** se a operação errou o `case_number` ao criar a vaga (digitou 763 em vez de 762), o auto-relink **vai vincular ao paciente errado**. Sugestão: emitir um log de auditoria (`patient_field_overrides_audit` ou tabela nova `vacancy_relink_audit`) sempre que o relink rodar com `affected_rows > 0`, com `patient_id` antigo (NULL), novo, `case_number`, source='clickup_webhook'. Operação revisa se virar problema.
- **Concorrência com sync manual:** enquanto o webhook não está coberto (rollback ou indisponibilidade do ClickUp), o `import-patients-from-clickup.ts --live` deve ter a mesma lógica de relink — caso contrário o sync recorrente regride o estado pra "órfã" se a flag `case_number` for considerada autoritativa do ClickUp e o auto-relink só estiver no webhook. **Recomendação: extrair o relink pra um helper compartilhado** (`relinkOrphanVacanciesByCaseNumber(client, patientId, caseNumber)`) usado tanto pelo webhook quanto pelo script de sync.
- **Vagas históricas sem match no ClickUp atual** (cases 112/119/469/514/650/733 hoje) **não vão ser resolvidas pelo webhook** — elas só são reconciliáveis se a operação criar uma task ClickUp com o `Caso Número` correspondente. Decisão fora da engenharia.

**Critérios de aceite:**

- POST/PUT `/api/admin/vacancies` rejeita `patient_id=null` com 400
- `patients.case_number` populado pra todos os patients sincronizados (≥99% — alguns ClickUp tasks podem ter `Caso Número` vazio, que é OK)
- Após upsert via webhook ou sync, vagas órfãs com `case_number` matching ficam linkadas em ≤1s do upsert
- Tabela de auditoria registra cada relink com origem (`clickup_webhook` vs `clickup_sync`)
- E2E novo: cria vaga órfã → simula webhook do ClickUp → verifica que `job_postings.patient_id` ficou populado

**Estimativa:** 2-3 dias de eng. As Frentes 1 e 2 são triviais (migration aditiva + 1 método no mapper + guard em controller); a Frente 3 é o que requer cuidado com idempotência e auditoria.

---

**Atualização 2026-05-08 (continuação) — design do select estava invertido:**

Após relinkar as 5 vagas, descoberta: **3 dos 6 patients novos sincronizados hoje (Héctor Arnaldo Montenegro, Susana Collia, Noelia Soledad Álvarez Romero — cases 764, 765, 766) continuaram invisíveis no select** mesmo passando todos os filtros (`needs_attention=false`, com endereço, etc.). Causa: a query `cases-for-select` é populada por `job_postings.case_number`, então **paciente sem nenhuma vaga jamais aparece** — e justamente patient novo (cenário comum: "criar primeira vaga pra paciente que acabou de entrar") não entra na lista.

Diagnóstico em prod (2026-05-08):
- **8 patients** em prod sem vaga e não-flagged → invisíveis no select. Inclui os 3 novos de hoje + 5 mais antigos (Castillo, Avalos, Gimenez, Maciel, Ojeda).
- **Bug adicional descoberto:** `ClickUpPatientMapper` **não captura `task.status`** em nenhum lugar ([ClickUpPatientMapper.ts](../worker-functions/src/modules/integration/infrastructure/clickup/ClickUpPatientMapper.ts) — zero refs). Resultado: 37/311 patients sincronizados com `status=''` em prod (incluindo TODOS os 6 criados pelo sync de hoje). O `vacancyStatusMap` que faz `'busqueda' → ACTIVE` etc. está usado só pelo `ClickUpVacancyMapper`.

**Confirmação do PO (Gabriel, 2026-05-08):** o select da tela "Nova Vacante" **deve listar pacientes**, não vagas — porque vaga é criada **justamente para pacientes que ainda não têm**. Status que devem aparecer: `ACTIVE`, `PENDING_ADMISSION`, `ADMISSION` (não `SUSPENDED`/`DISCONTINUED`/`DISCHARGED`).

**Plano revisado (substitui o anterior — Frente 3 deixa de ser obrigatória, ganha-se Frente 0 e 4):**

### Frente 0 — `ClickUpPatientMapper` capturar `status` *(novo, crítico)*

Sem isso o filtro por status no select não funciona pra patients que vieram do sync.

```ts
// Em ClickUpPatientMapper.map(task):
import { mapClickUpStatusToCanonical } from './mappings/vacancyStatusMap'; // exportar o helper se ainda não estiver exposto
const canonical = mapClickUpStatusToCanonical(task.status?.status);
input.status = canonical?.patientStatus ?? null;
```

Backfill one-shot: rodar contra os 37 patients com status vazio (consultar ClickUp API por `clickup_task_id`, mapear `task.status.status` → `PatientStatus`, UPDATE).

### Frente 1 — Validação `patient_id` no backend *(mantida)*

Inalterada. Com Frente 4 funcionando, operador sempre seleciona patient antes de submeter, então o guard só serve como defensa de profundidade contra bugs de form.

### Frente 2 — `patients.case_number` *(promovida a pré-requisito)*

Antes era nice-to-have, agora é **obrigatória** porque a query nova do select (Frente 4) precisa dela. Schema/mapper/backfill como descrito acima.

### Frente 3 — Auto-relink no webhook *(rebaixada)*

Não é mais necessária pra **prevenir** órfãs futuras (Frente 1 + 4 cobrem). Continua relevante apenas como **cleanup** de órfãs já-existentes (5 mitigadas hoje + 6 históricas pendentes). Pode ser deletada do escopo OU implementada como cron one-shot/admin endpoint (`POST /admin/vacancies/relink-orphans`) que roda manualmente quando operação pedir.

### Frente 4 — Reescrever `cases-for-select` para puxar de `patients` *(novo, central)*

Substitui o `INNER JOIN` que pega case de `job_postings`:

```sql
-- Em VacanciesController.getCasesForSelect()
SELECT
  p.case_number   AS "caseNumber",
  p.id            AS "patientId",
  COALESCE(p.dependency_level, '') AS "dependencyLevel"
FROM patients p
WHERE p.case_number IS NOT NULL
  AND p.needs_attention = false
  AND p.status IN ('ACTIVE', 'PENDING_ADMISSION', 'ADMISSION')
  AND EXISTS (
    SELECT 1 FROM patient_addresses pa WHERE pa.patient_id = p.id
  )
ORDER BY p.case_number DESC;
```

Notas:
- Sem JOIN com `job_postings` — patients novos sem vaga são listáveis.
- `p.case_number` requer Frente 2 aplicada antes (caso contrário todos viram NULL e a lista fica vazia).
- `p.status` requer Frente 0 aplicada antes (caso contrário 37 patients legacy ficam de fora).
- Mantém `p.needs_attention=false` e `EXISTS patient_addresses` — operação só cria vaga quando o paciente tem dado completo + endereço.

**Ordem de implementação obrigatória:** Frente 0 → Frente 2 → Frente 4 (eles têm dependência). Frente 1 pode entrar paralela. Frente 3 fica fora ou no fim.

**Critérios de aceite atualizados:**

- `patients.status` populado pra ≥99% dos patients sincronizados (alguns podem ter status ClickUp não-mapeado e ficar null — log de warning)
- `patients.case_number` populado pra ≥99% dos patients sincronizados
- POST/PUT `/api/admin/vacancies` rejeita `patient_id=null` com 400
- Após sync de patient novo (via webhook ou script), o paciente aparece no select da tela de "Nova Vacante" em ≤1s, **sem precisar de vaga prévia**
- E2E novo: sync de paciente ACTIVE sem vaga → verifica que `cases-for-select` retorna ele

**Estimativa revisada:** 2-3 dias. Frentes 0, 2 e 4 são changes pequenas e localizadas. Frente 1 mantém escopo mínimo. Total fica próximo do estimate anterior porque Frente 3 (que era a mais cara em auditoria) sai do escopo MVP.

---

### TD-008 — case_number duplicado entre patients (descoberto 2026-05-08)

- **Status:** mitigado por código (constraint UNIQUE parcial + handling no PatientService); 2 cases pendentes de resolução operacional no ClickUp
- **Descoberto em:** 2026-05-08 durante re-sync após implementar `patients.case_number`
- **Dono provável:** operação (resolver duplicidade no ClickUp)
- **Bloqueador?** Não — código persiste paciente com `case_number=NULL` + `needs_attention='CASE_NUMBER_CONFLICT'`

**Casos identificados em 2026-05-08:**

| case_number | Tasks ClickUp | Diagnóstico |
|---|---|---|
| 695 | `86aebfbdq` (Ojeda Noha Valentín — com acento) vs `86aeb40w6` (Ojeda Noha Valentin — sem acento) | Mesma pessoa cadastrada 2x. Ops deve deletar a duplicada |
| 759 | `86ah4khcj` (Páez Sofía Jeanette) vs `86ah2uub7` (Krncsek Benicio) | Pessoas diferentes, case_number digitado igual por engano. Ops deve corrigir um dos dois |

**Ação operacional:** revisar ambos os casos no ClickUp e corrigir. Após correção, rodar `import-patients-from-clickup.ts --live --status "<status_relevante>"` pra re-sync.

---

### TD-009 — `patients.affiliate_id` é coluna obsoleta (descoberto 2026-05-08)

- **Status:** identificado, não-bloqueante, deprecação pendente
- **Descoberto em:** 2026-05-08 ao escrever comprehensive fixture test do `ClickUpPatientMapper`
- **Dono:** backend
- **Bloqueador?** Não — coluna existe mas está sempre NULL

**Sintoma:**

`patients.affiliate_id` aparece em `PatientIdentityUpsertInput` mas **não é setada por nenhum mapper** ([ClickUpPatientMapper.map()](../worker-functions/src/modules/integration/infrastructure/clickup/ClickUpPatientMapper.ts) não inclui a chave). 0/318 patients em prod local têm valor não-nulo. O conceito ("ID do afiliado no plano de saúde") é coberto por `health_insurance_member_id` desde a [migration 147](../worker-functions/migrations/147_*.sql).

**Causa raiz:**

Coluna criada antes da migration 147 que separou identidade do plano de saúde em campos dedicados (`health_insurance_name`, `health_insurance_member_id`). O `affiliate_id` ficou órfão — é semanticamente equivalente ao novo `health_insurance_member_id` mas nunca foi populado.

**Plano de deprecação (incremental, conforme regra do projeto):**

1. **Migration N**: `ALTER TABLE patients RENAME COLUMN affiliate_id TO affiliate_id_deprecated_20260508` + remover do `INSERT` em `PatientIdentityRepository`. Sem perda de dados (já é null em todos).
2. **Aguardar 30 dias** sem reclamações (nenhum código deveria estar lendo).
3. **Migration N+M**: `DROP COLUMN affiliate_id_deprecated_20260508`.

**Risco:** baixo — grep prévio confirma só referências em ClickUp mapper TS (que não usa), não há SQL externo nem backfill scripts referenciando.

---

### TD-010 — Cloud Run prd não está sob Terraform (descoberto 2026-05-08)

- **Status:** aberto, deferred
- **Descoberto em:** 2026-05-08 durante setup do mirror enlite-stg via Terraform (Fase 1.F)
- **Dono:** infra
- **Bloqueador?** Não — prd continua deployando normal via CI/CD

**O que é:**

Os 3 services Cloud Run em `enlite-prd` (enlite-frontend, worker-functions, enlite-n8n) foram criados manualmente via gcloud como Cloud Run **v1** (knative-style). O resto da infra está sob TF (Cloud SQL, Secrets, IAM, AR, GCS), mas Cloud Run prd ficou de fora porque importar v1 pra schema v2 do provider Google envolve incompatibilidades (annotations, labels, autogen fields).

**Impacto:** drift potencial entre o que prd tem hoje e o que stg tem (declarado em TF v2). Não bloqueia, mas significa que mudanças manuais em prd não aparecem em stg.

**Plano:** quando estabilizar stg, importar prd Cloud Run pra TF como passo dedicado — provavelmente migrar prd pra Cloud Run v2 no processo (gcloud run services replace + ajustes de manifest).

---

### TD-011 — Cloud SQL prd com `authorized_networks: 0.0.0.0/0` (descoberto 2026-05-08)

- **Status:** aberto, segurança
- **Descoberto em:** 2026-05-08 ao inspecionar config Cloud SQL para mirror stg
- **Dono:** infra + sec
- **Bloqueador?** Não — SSL é obrigatório (sslMode=TRUSTED_CLIENT_CERTIFICATE_REQUIRED), mas o IP público está aberto pra internet

**O que é:**

`enlite-ar-db` em prd está com `authorizedNetworks=[{value: "0.0.0.0/0"}]`, ou seja, qualquer IP do mundo pode tentar TCP no Postgres. SSL + cert client são exigidos, então autenticação não vaza, mas o atacante pode enumerar versão / fazer brute-force / DDoS no listener.

Stg foi configurado com a mesma rule por paridade. Idem `enlite-n8n-db-ar` (que tem `requireSsl=false` — pior ainda, mas o n8n acessa via Cloud SQL Proxy interno, não via IP público; a rule 0.0.0.0/0 não está nesse).

**Plano:** restringir authorized_networks a IPs específicos (Cloud Run NAT, GitHub Actions runners, IPs do escritório) ou migrar pra Private IP exclusivamente. Cloud SQL Proxy via service account já cobre acesso via aplicação.

---

### TD-012 — Pipeline de anonimização prd→stg pendente (descoberto 2026-05-08)

- **Status:** aberto, faz parte do plano original de stg
- **Descoberto em:** 2026-05-08 setup do mirror staging
- **Dono:** infra + dados
- **Bloqueador?** Não — stg pode rodar com seeds sintéticos enquanto isso

**O que é:**

A decisão da sessão de setup foi que stg deveria receber dump anonimizado de prd para reprodução de bugs com dados realistas. A Fase 3 do plano (`scripts/anonymize-prod-to-stg.sh`) ainda não foi escrita. Por hora, stg vai com seeds sintéticos via runner do worker-functions.

**Plano:** criar `scripts/anonymization/*.sql` com regras determinísticas (Faker BR mantendo FKs, scrubbing de PHI, hash de identificadores) + runner que dump → restore temp → anonymize → dump → restore stg. Documentar em RUNBOOK auditável.

**Risco LGPD:** alto se for executado sem cuidado — qualquer leak de PII em stg é incidente. Implementação deve ter dry-run obrigatório com sample antes do run completo.

---

### TD-013 — `PublicApiService.getPublicJobs()` ignora `country` no painel do worker (descoberto 2026-05-11)

- **Status:** aberto
- **Descoberto em:** 2026-05-11, revisão final da PR de filtros públicos em `/api/public/v1/jobs`
- **Dono provável:** frontend (enlite-frontend)
- **Bloqueador?** Não — hoje só existem vagas AR no banco

**O que é:**

`PublicApiService.getPublicJobs()` em `enlite-frontend/src/infrastructure/http/PublicApiService.ts` chama `GET /api/public/v1/jobs` **sem nenhum query param**. Como o endpoint agora aplica `country='AR'` por default, o consumo atual continua funcionando.

**Quando vira problema:**

Quando entrarem vagas BR/US no banco, a tela do worker AR vai continuar vendo só AR (correto pra perfil AR), mas uma AT brasileira logada também só vai ver AR (errado).

**Proposta:**

`PublicApiService.getPublicJobs()` deve passar `?country={X}` baseado no perfil da AT logada. Campo de origem ainda a definir — possíveis fontes: `workers.country`, primeira letra de `workers.service_area`, ou perfil explícito no signup.

**Pré-requisito:** primeira vaga não-AR entrar no banco (sync ClickUp / form manual) — antes disso, é só armadilha latente.

---

### TD-014 — `PublicJobsFilters` interface e schema Zod do controller podem driftar (descoberto 2026-05-11)

- **Status:** aberto
- **Descoberto em:** 2026-05-11, revisão final da PR de filtros públicos
- **Dono provável:** backend (worker-functions)
- **Bloqueador?** Não

**O que é:**

`PublicJobsFilters` (em `domain/`) e `PublicJobsQuerySchema` (em `interfaces/controllers/PublicJobsController.ts`) são tipos estruturalmente idênticos hoje, mantidos separados. Qualquer adição de filtro num lado sem atualizar o outro vai gerar drift silencioso que o tsc não pega — o controller faz cast implícito via `z.infer<typeof PublicJobsQuerySchema>` que é parametricamente compatível.

**Proposta:**

Duas opções:
1. **Source of truth = Zod**: exportar `type PublicJobsFilters = z.infer<typeof PublicJobsQuerySchema>` e deletar a interface separada (mais simples, mas acopla domain a Zod)
2. **Source of truth = domain**: adicionar teste `expectTypeOf<z.infer<typeof PublicJobsQuerySchema>>().toEqualTypeOf<PublicJobsFilters>()` que falha em compile-time se driftarem

Decidir junto com Architect quando houver demanda real de adicionar/remover filtro.

---

### TD-015 — Documentação pública do endpoint `/api/public/v1/jobs` ausente (descoberto 2026-05-11)

- **Status:** aberto
- **Descoberto em:** 2026-05-11, durante entrega dos filtros públicos para o time WordPress
- **Dono provável:** produto/comms (com input técnico do backend)
- **Bloqueador?** Não — spec pode ser passada de outras formas inicialmente

**O que é:**

Não existe `docs/api-public-jobs.md` ou equivalente. O time WordPress vai precisar de:
- URL canônica do endpoint (hoje `https://worker-functions-byh3gvl5yq-tl.a.run.app/api/public/v1/jobs` — bruto do Cloud Run; falta custom domain tipo `api.enlite.health`)
- Tabela de query params com exemplos por país
- Schema JSON da resposta (19 campos)
- Política de rate-limit e cache
- Comportamento de erros (400 em params inválidos)

**Proposta:**

1. Criar `docs/api-public-jobs.md` com OpenAPI-lite (markdown estruturado) + exemplos `curl`
2. Avaliar custom domain `api.enlite.health` no Cloud Run prd (decisão de infra/DNS)
3. Quando custom domain estiver no ar, atualizar o doc + comunicar ao WP

---

## Decisões Pendentes (precisam de alinhamento operacional)

### DP-001 — Split shifts: 1 vaga ou 2 vagas?

- **Status:** aberto, em conversa com gestão
- **Descoberto em:** 2026-05-01, spike de horários no refactor de criação de vaga
- **Dono provável:** Gabriel (eng) + Gestão de Operações
- **Bloqueador?** Não — schema atual já suporta as duas modelagens

**Contexto:**

Existem hoje pelo menos 4 vagas em ClickUp `activo`/`reemplazos` com **horários separados no mesmo dia** (split shift), tipo:

- `"Lunes a Viernes 07:00-10:00 y 16:00-21:00"` (Cueto Mercier)
- `"Lunes a Viernes 09:00-11:00 y 19:00-21:00"` (Malachovsky)

**Opinião do PO/eng (Gabriel, 2026-05-01):**

> Dois horários distintos assim precisam ser **duas vagas diferentes**, não faz sentido deixar um prestador com um buraco de 6 horas entre um período e outro. Um prestador não fica "à disposição" 6h grátis no meio do dia — ou ele cobre uma das janelas, ou são dois prestadores diferentes (potencialmente).

**Implicação técnica das duas modelagens:**

| Caminho | Schema | UX criação | Cálculo de availability |
|---|---|---|---|
| **Manter como 1 vaga** (modelo atual) | `schedule` jsonb aceita N slots por dia | `WeeklySchedulePicker` permite "+ horário" no mesmo dia | Soma simples por endereço continua válida |
| **Forçar 2 vagas separadas** | sem mudança de schema | Form de criação **bloqueia** 2+ slots no mesmo `dayOfWeek`. Recrutadora cria 2 vagas com mesmo `case_number` | Cada vaga ocupa só sua faixa; availability soma ambas |

**Decisão pendente:**

Conversar com gestão pra alinhar:
1. O que a operação considera correto: 1 vaga split ou 2 vagas separadas?
2. Se "2 vagas", o que muda na contratação MEI / nota fiscal / pagamento? (1 contrato com 2 vagas vs 2 contratos)
3. Como o prestador vê isso no Talentum (1 anúncio com horário "estranho" vs 2 anúncios consecutivos)?

**Registro:** até a decisão sair, o form do refactor **suporta as duas modelagens** (permite N slots por dia mas não obriga). Os 4 casos atuais em ClickUp permanecem como 1 vaga cada. Decisão muda só o frontend (validação) — sem migration.

---

## Como usar este doc

- **Adicionou um item?** Coloca data, contexto e dono.
- **Resolveu um item?** Move pra seção `## Resolvidos` no fim do arquivo com data de fechamento + PR/commit.
- **Bloqueou em algo?** Marca `**Bloqueador?** Sim` e referencia no doc da feature bloqueada.

### TD-020 + TD-022 — Template Twilio `talentum_incomplete_reminder` (parcialmente resolvido — aguardando aprovação Meta)

- **Status:** parcialmente resolvido
- **Descoberto em:** 2026-05-19/20
- **Resolvido em:** 2026-05-20 (criado + submetido) — aguardando aprovação Meta (1-3d)
- **Dono provável:** Meta (aprovação automática), depois Backend (1 UPDATE)
- **Bloqueador?** Sim pra ativação real do cron Talentum — sim, mas auto-resolvido quando Meta aprovar

**O que foi feito em 2026-05-20:**

1. Template criado no Twilio via Content API:
   - `friendly_name`: `talentum_incomplete_reminder`
   - `sid`: `HX90b0cf73ba47f12016c02cfb8d4161df`
   - `language`: `es_AR`
   - `variable {{1}}`: `worker_name`
   - `body`: "¡Hola {{1}}! Tu proceso de selección en EnLite quedó pendiente de completar. Ingresá a https://app.enlite.health para retomarlo. ¡Te esperamos!"
2. Submetido pra aprovação Meta (category=UTILITY) — status `received`
3. Aguardando aprovação automática (1-3 dias úteis tipicamente)

**Quando Meta aprovar (verificar com `GET /Content/HX90b0cf73ba47f12016c02cfb8d4161df/ApprovalRequests`):**

```sql
UPDATE message_templates
SET content_sid = 'HX90b0cf73ba47f12016c02cfb8d4161df'
WHERE slug = 'talentum_incomplete_reminder';
```

Não popular o SID antes da aprovação Meta — Twilio rejeita send com erro, OutboxProcessor marca `status='error'`, gera ruído em logs sem benefício.

---

## Resolvidos

### TD-017 — `onUserCreate.ts` (Firebase Functions trigger) sem traceId via ALS (resolvido 2026-05-20)

- **Status:** resolvido
- **Descoberto em:** 2026-05-19, durante Fase 0 do Sprint
- **Resolvido em:** 2026-05-20

**Como foi resolvido:**

Aplicada opção 3 do TD original — envolveu o corpo do handler em `loggingAls.run({ traceId: uuidv4() }, ...)` localmente, gerando traceId próprio por execução do trigger (sem correlação com a request original, aceitável pra esse caso). Também trocou `functions.logger.*` por `logger`/`reportError` de `@shared/logging` pra consistência com o resto do código.

Arquivo: `worker-functions/src/infrastructure/triggers/onUserCreate.ts`

### TD-025 — Dedup atomic em `qualified_worker_response` + `qualified_reprogram_confirm` (resolvido 2026-05-20)

- **Status:** resolvido
- **Descoberto em:** 2026-05-20, durante teste end-to-end Fluxo A em prod (worker recebeu 4x confirmação idêntica de entrevista + 2x de reagendamento)
- **Resolvido em:** 2026-05-20

**O que era:**

Worker pode tocar várias vezes no botão de slot do WhatsApp (ou Twilio retentar webhook), gerando N inserts idênticos no `messaging_outbox` com template `qualified_worker_response` (confirmação de entrevista) ou `qualified_reprogram_confirm` (reagendamento). Sem dedup, todas as N mensagens saem pro AT.

Evidência (worker `2efe4ef8-...`, 10/abr/2026): 4 inserts de `qualified_worker_response` em 32min + 2 de `qualified_reprogram_confirm` em 11min, todos chegando ao AT depois (drenados por sweep manual).

**Como foi resolvido:**

Pattern Fase 3 (`VacancyAutoInviteHandler`) aplicado em ambos callers:

```sql
INSERT INTO messaging_outbox (...)
SELECT $1, '<template>', $2::jsonb, 'pending', 0
WHERE NOT EXISTS (
  SELECT 1 FROM messaging_outbox
  WHERE worker_id = $1 AND template_slug = '<template>'
    AND status IN ('pending', 'sent')
    AND created_at > NOW() - INTERVAL '5 minutes'
    AND variables->>'job_posting_id' = $3
)
RETURNING id
```

- Janela: 5 minutos (curta o suficiente pra dedup de double-tap/retry, não bloqueia re-confirmação legítima horas depois)
- Quando RETURNING vem vazio: log info "Dedup hit" e early return Result.ok() (não publica no Pub/Sub)

Arquivos:
- `worker-functions/src/modules/notification/application/BookSlotFromWhatsAppUseCase.ts` (qualified_worker_response)
- `worker-functions/src/modules/notification/application/HandleReminderResponseUseCase.ts` (qualified_reprogram_confirm)

### TD-023 + TD-024 — Outbox sem auto-expire de pending velho + sweep sem filtro etário (resolvido 2026-05-20)

- **Status:** resolvido
- **Descoberto em:** 2026-05-20, durante teste end-to-end em prod (sweep drenou 6 mensagens stuck de 40 dias atrás junto com o teste novo)
- **Resolvido em:** 2026-05-20 (mesmo dia)

**O que era:**

`messaging_outbox` não tinha mecanismo de auto-expire pra rows que ficavam stuck em `status='pending'` por dias/semanas. Quando o sweep rodava após período de inatividade, processava lixo histórico e enviava mensagens stale (vagas que não existem mais, slots de entrevista vencidos, etc).

No teste prod do Fluxo A, 6 outbox rows de 10/abril (40 dias antes) foram drenadas junto com o teste novo, gerando 6 mensagens WhatsApp irrelevantes pro worker.

**Como foi resolvido:**

1. `OutboxProcessor.markStalePendingAsFailed()` — novo método que roda no início de `processBatch()`, marca como `failed` qualquer row em `pending` com `created_at < NOW() - 7 days` e loga `warn` com count
2. `OutboxProcessor.fetchPending()` — query agora filtra `created_at > NOW() - 7 days` (defesa em profundidade — mesmo se markStale não rodou)
3. `OutboxProcessor.processById()` — mesmo filtro etário, pra cobrir Pub/Sub push de IDs stale
4. Constante `MAX_PENDING_AGE_DAYS = 7` centraliza o limite

**Validação:**

- 1633/1633 unit tests passing (1 novo cenário "TD-023: loga warn quando neutraliza rows velhas")
- 1112/1112 E2E passing
- tsc --noEmit zero erros

**Cleanup manual aplicado no momento da descoberta:**

- 29 rows em `pending` de 7-8/abril marcadas `failed` via UPDATE direto
- 2 rows de 14-18/maio (`qualified_worker_request` slot vencido) idem
- Total: 31 rows neutralizadas em produção

### TD-016 — Gap de i18n no feature VacancyMatch (resolvido 2026-05-19)

- **Status:** resolvido
- **Descoberto em:** 2026-05-19, durante audit de i18n disparado por bug do chip `SEVERE` cru em `CaseSelectStep.tsx`
- **Resolvido em:** 2026-05-19 (mesmo dia)

**O que era:**

Audit do `src/presentation/**/*.tsx` (214 arquivos) achou strings hardcoded — concentradas no feature **VacancyMatch** (5 arquivos) + `templates/DashboardLayout/Header.tsx`. Pior: vários textos em **PT-BR** dentro de uma app cujo idioma principal é **es-AR** (ex: "Já candidatou", "Notificado", "Enviar para", "Carregando templates…").

**Como foi resolvido:**

1. Adicionados 3 novos namespaces em `src/infrastructure/i18n/locales/es.json` e `pt-BR.json`:
   - `admin.match.*` — estados de match, empty/loading states, botões, badges
   - `admin.messaging.*` — modal de envio de WhatsApp, com `_one`/`_other` pra pluralização (`selectedWorkers`, `alreadyNotified`, `alreadyReceivedMessage`, `notYetReceived`, `doneSent`, `doneErrors`)
   - `admin.interviews.*` — modal de agendamento, durações via `durationMinutes` com `count`, disponibilidade de slots via `slotAvailability_one/other`
2. Adicionado `common.cancel`, `common.close`, `common.logout` ao namespace `common` (não existiam ainda no top-level).
3. Refatorados 7 arquivos:
   - `VacancyMatch/SendMessageModal.tsx` (reescrito com 20+ chaves)
   - `VacancyMatch/ScheduleInterviewModal.tsx` (reescrito com 15+ chaves)
   - `VacancyMatch/MatchVacancyModal.tsx` (header/footer/empty/loading states)
   - `VacancyMatch/MatchCandidateRow.tsx` (badges + tooltip + locale do `toLocaleDateString` agora segue `i18n.language`)
   - `VacancyMatch/MatchBucketSection.tsx` (contador + empty bucket)
   - `VacancyMatch/MatchMissingMeetLinksAlert.tsx` (alerta inteiro)
   - `templates/DashboardLayout/Header.tsx` (botão Logout)
4. Decisões de pluralização: `doneSummary` que mistura 2 contadores independentes (`sent` e `errors`) foi splittado em 3 chaves (`doneLabel` + `doneSent_*` + `doneErrors_*`) pra cada um ter seu próprio inflection.
5. `<h1>Enlite</h1>` no Header mantido literal (marca registrada).
6. `placeholder="https://meet.google.com/xxx-yyy-zzz"` no ScheduleInterview mantido literal (exemplo de formato técnico, não texto pro user).

**Validação:**

- `pnpm type-check` ✓
- `pnpm test:run` ✓ 2883/2883 testes verdes
- `pnpm lint` ✓ sem warnings
- Grep manual nos 7 arquivos: zero ocorrências de texto cru remanescente

**Fix relacionado já aplicado:**

- Enum cru `{dependencyLevel}` em `VacancyCaseCard.tsx:129` corrigido no mesmo dia (mesmo padrão do fix de `CaseSelectStep.tsx:109`).

---

### TD-019 — Template `vacancy_invited_auto` usa `workZone` do AT como `patient_zone` (copy enganador) — resolvido 2026-05-20

- **Status:** resolvido
- **Descoberto em:** 2026-05-19, durante revisão da Fase 3
- **Resolvido em:** 2026-05-20, PR `fix/twilio-templates-integration`

**Como foi resolvido:**

Refactor de `VacancyAutoInviteHandler.ts`: a primeira query do handler agora faz JOIN `job_postings → patients` para buscar `patients.zone_neighborhood AS patient_zone`. O `workZone` do AT deixou de ser usado como `patient_zone`. Fallback `'tu zona'` mantido quando o campo é NULL no banco.

---

### TD-018 — Template `vacancy_invited_auto` precisa de `content_sid` Twilio HSM antes do go-live — resolvido 2026-05-20

- **Status:** resolvido
- **Descoberto em:** 2026-05-19, durante implementação da Fase 3 do Sprint de Automação de Recrutamento
- **Resolvido em:** 2026-05-20, PR `fix/twilio-templates-integration`

**Como foi resolvido:**

O template `vacancy_invited_auto` (migration 174) foi substituído pelos dois templates aprovados pela Meta (`ar_vacancy_match_complete` via `HXa1ff7c9189b625587929c5f19e4e614f` e `ar_vacancy_match_incomplete` via `HXd8cd5071c998317731286be3e5164854`). Migration 178 inseriu os novos slugs com `content_sid` definitivos e desativou `vacancy_invited_auto` (`is_active=false`). O `VacancyAutoInviteHandler.ts` foi refatorado para escolher entre os dois templates com base em `workers.status`. Nenhum HSM pendente para o Fluxo A.

---

### TD-021 — `INCOMPLETE_WORKERS_QUERY` quebra com `malformed array literal: ""` — resolvido 2026-05-20

- **Status:** resolvido
- **Descoberto em:** 2026-05-19, durante implementação da Fase 5 (dedup atomic) do Sprint de Automação de Recrutamento
- **Resolvido em:** 2026-05-20, PR `fix/twilio-templates-integration`

**Como foi resolvido:**

Substituídas as comparações `preferred_types = '{}'` e `experience_types = '{}'` por `preferred_types = '{}'::text[]` e `experience_types = '{}'::text[]` em `BulkDispatchIncompleteWorkersUseCase.ts`. Postgres agora interpreta corretamente como array literal tipado em vez de string. E2E `bulk-dispatch-incomplete.e2e.test.ts` criado para cobrir o endpoint `/api/internal/bulk-dispatch/process` e prevenir regressão.

---

### TD-026 — Migrar `interview_slots.slot_date + slot_time` para `TIMESTAMPTZ`

- **Status:** aberto
- **Descoberto em:** 2026-05-20, durante PR 1 do Sprint MCP Internal Server
- **Dono provável:** backend (worker-functions)
- **Bloqueador?** Não — `AT TIME ZONE jp.timezone` no SQL cobre o caso de uso atual

**O que é:**

`interview_slots` guarda `slot_date DATE NOT NULL` + `slot_time TIME NOT NULL` em colunas separadas, sem timezone embedded. PR 1 contorna via `(slot_date::timestamp + slot_time::time) AT TIME ZONE jp.timezone` mas a representação canônica de instante absoluto seria `slot_at TIMESTAMPTZ`.

**Impacto:**

- Queries de range temporal exigem o cast + AT TIME ZONE toda vez (verbose, propenso a esquecer)
- Mudança de timezone da vaga após criação dos slots não invalida agendamentos (slots ficam com o timezone interpretado errado)
- Operações de comparação entre múltiplas vagas com timezones diferentes ficam complexas

**Proposta de solução:**

1. Migration aditiva: adicionar `slot_at TIMESTAMPTZ`
2. Backfill: `UPDATE interview_slots SET slot_at = (slot_date::timestamp + slot_time::time) AT TIME ZONE (SELECT timezone FROM job_postings WHERE id = interview_slots.job_posting_id)`
3. Deprecar `slot_date+slot_time` (deixar coexistir 1-2 sprints, depois remover)
4. Atualizar `InterviewSlotRepository`, `ScheduleInterviewsUseCase`, frontend `ScheduleInterviewModal`, E2Es de agendamento

Refactor estrutural — PR próprio, fora do escopo MCP.

---

### TD-027 — Domain event `worker.document.uploaded` pós `IngestDocumentFromUrlUseCase`

- **Status:** aberto
- **Descoberto em:** 2026-05-20, durante PR 1 do Sprint MCP Internal Server
- **Dono provável:** backend (worker-functions)
- **Bloqueador?** Não — não há consumer definido hoje

**O que é:**

Quando o triage-service envia um documento do AT via WhatsApp, o `IngestDocumentFromUrlUseCase` persiste no GCS e atualiza `worker_documents` sem emitir nenhum domain event. Outros pontos de upload do sistema também não emitem — é gap geral.

**Impacto:**

- Sem ponto de extensão pra notificações pós-upload (ex: alerta pra coordenação que AT enviou doc novo)
- Sem ponto de extensão pra validações automatizadas (ex: OCR no antecedentes penais, validação de CPF no RG)
- Auditoria centralizada via event log fica incompleta

**Proposta de solução:**

Emitir `WorkerDocumentUploadedEvent { workerId, documentType, filePath, uploadedAt, source: 'triage' | 'admin' | 'portal' }` ao final do `IngestDocumentFromUrlUseCase.execute()` e em outros pontos de upload. Definir handlers conforme necessidade aparecer (notification, validation, audit).

---

### TD-028 — `workers.timezone` populado com `'UTC'` em 100% dos casos

- **Status:** aberto
- **Descoberto em:** 2026-05-20, durante PR 1 do Sprint MCP Internal Server (Architect parecer)
- **Dono provável:** backend (worker-functions)
- **Bloqueador?** Não — PR 1 evita usar `workers.timezone` e usa `job_postings.timezone`

**O que é:**

A coluna `workers.timezone VARCHAR(50)` foi criada em migration 003 com `DEFAULT 'UTC'`. Nenhum fluxo posterior populou o valor real — todos os ATs do banco têm `'UTC'` (semanticamente errado pra ATs operando em AR/BR).

**Impacto:**

- Qualquer use case futuro que tente derivar fuso horário do AT via `workers.timezone` retornará UTC errado
- PR 1 contornou usando `job_postings.timezone` (timezone da vaga, não do worker), o que é semanticamente correto pra "current interview"
- Cenários futuros (ex: notificação proativa "bom dia AT" no fuso local do AT) vão precisar do valor real

**Proposta de solução:**

1. Backfill: derivar de `workers.country` via `countryToTimezone()` (util criada em PR 1, em `src/shared/locale/CountryTimezone.ts`)
2. Atualizar signup do worker pra capturar/derivar timezone explicitamente
3. Considerar adicionar coluna `country` consistente com `job_postings.country` se ainda não houver

---

### TD-029 — Critério de update de `bankAccount`/`pix` via WhatsApp com 2FA

- **Status:** aberto (decisão de produto pendente)
- **Descoberto em:** 2026-05-20, durante PR 1 do Sprint MCP Internal Server (whitelist LGPD §5.2)
- **Dono provável:** produto + backend
- **Bloqueador?** Não — campos atualmente vetados na whitelist do PR 6

**O que é:**

Whitelist de campos editáveis via WhatsApp (sprint MCP §5.2) veta `bankAccount` e `pix` por enquanto, até definir verificação anti-fraude explícita (ex: 2FA, confirmação por canal alternativo, prazo de carência).

**Impacto:**

- AT que precisa atualizar dados bancários pra receber pagamento precisa contatar a operação manualmente (canal humano)
- Reduz autoatendimento, aumenta carga no time de operações

**Proposta de solução:**

Definir com produto:
- 2FA via SMS/email pra confirmar update de dados bancários?
- Prazo de carência (24-48h) entre update e efeito no próximo pagamento?
- Notificação automatizada pra antifraude/compliance?

Após decisão, adicionar à whitelist do `WorkerProfileUpdateCapability` (PR 6 do sprint MCP).

---

### TD-030 — Triage-service deserializa contrato HTTP wrapped vs direto

- **Status:** aberto
- **Descoberto em:** 2026-05-20, durante PR 1 do Sprint MCP Internal Server (PO revisão final)
- **Dono provável:** backend (triage-service)
- **Bloqueador?** Não — vai ser resolvido naturalmente no PR 7 (triage migra HTTP→MCP)

**O que é:**

O `HttpEnliteGateway` do triage-service em `triage-service/src/modules/worker-context/infrastructure/HttpEnliteGateway.ts` consome respostas dos endpoints `current-interview` e `available-vacancies` como valores diretos:

```typescript
const { data } = await this.http.get<VacancySummary[]>(...);  // espera array
const { data } = await this.http.get<InterviewSummary>(...);  // espera objeto direto
```

Mas os endpoints retornam wrapped:
- `{ vacancies: VacancyDTO[] }`
- `{ interview: CurrentInterviewDTO | null }`

**Impacto:**

- Estado atual em prod = 404 (endpoints não existiam). Após PR 1 = 200 com objeto wrapped.
- Triage não estoura erro mas itera `.map()` em `{ vacancies: [...] }` (objeto) tratando como array — resultado: agente IA do WhatsApp recebe lista vazia ou undefined
- Não piora vs estado atual (que era 404 e quebra silenciosa também), só desbloqueia parcialmente

**Proposta de solução:**

PR 7 do sprint MCP migra triage de HTTP pra cliente MCP. O contrato MCP é fonte da verdade; o adapter `HttpEnliteGateway` será removido. Resolve-se sozinho ao trocar o canal.

Se necessário antes do PR 7 (ex: produto pede o fix urgente): adicionar `data.vacancies` e `data.interview` no triage — mudança de 2 linhas em `HttpEnliteGateway.ts`.

Tipos: `WorkerSummary.id: number` no triage também precisa ser corrigido pra `string` (UUIDs) — TS runtime não verifica, mas é gap.

---

### TD-032 — `worker-functions-mcp` em prd não está sob Terraform

- **Status:** aberto
- **Descoberto em:** 2026-05-20, durante PR 5 do Sprint MCP Internal Server
- **Dono provável:** infra/devops
- **Bloqueador?** Não — alinhado com pattern existente (prd inteiro não está sob Terraform, ver TD-010)

**O que é:**

O service `worker-functions-mcp` foi criado em prd via `gcloud run deploy` no workflow `.github/workflows/backend-mcp-prd.yml`, sem instanciação Terraform. Em stg o módulo existe em `terraform/environments/stg/cloud_run.tf` (`module "cloud_run_worker_functions_mcp"`). Replica a mesma decisão arquitetural pré-existente descrita em TD-010 (prd inteiro não está sob IaC).

**Impacto:**

Drift potencial entre stg e prd. Mudanças manuais em prd no service `worker-functions-mcp` não são rastreadas em código. Mesma situação dos outros 3 services prd (worker-functions, enlite-frontend, enlite-n8n).

**Proposta de solução:**

Quando o TD-010 geral de "prd sob Terraform" for atacado (importar Cloud Run v1 → v2), incluir `worker-functions-mcp` no mesmo esforço de import. Não fazer em separado — o esforço de migrar v1→v2 é compartilhado entre todos os services.

---

### TD-031 — `ENLITE_API_KEYS` não documentada em `.env.example`

- **Status:** aberto
- **Descoberto em:** 2026-05-20, durante PR 1 do Sprint MCP Internal Server (PO revisão final)
- **Dono provável:** backend (worker-functions)
- **Bloqueador?** Não — provisionamento manual em prod via secret manager funciona

**O que é:**

Env var `ENLITE_API_KEYS` (usada por `ApiKeyAuthStrategy.loadFromEnv()` pra carregar tokens de service principals) não está documentada em `.env.example`. Formato esperado: `triage-service:TOKEN_VALUE,other-principal:OTHER_TOKEN`.

**Impacto:**

- Operação que vai provisionar a env var em produção (Cloud Run env / Secret Manager) precisa adivinhar o formato
- Risco de configurar errado em ambiente novo (staging) e o triage receber 401 sem causa óbvia

**Proposta de solução:**

Adicionar entrada em `.env.example` no PR 2 (que já vai tocar configuração de service principals):

```bash
# Service principals para auth interno (API key per principal, separados por vírgula).
# Formato: <principal-name>:<token>,<other-principal>:<other-token>
# Exemplo: triage-service:eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
ENLITE_API_KEYS=
```

---

### TD-033 — Avaliar remoção dos endpoints HTTP do worker-context (conservador, sem prazo)

- **Status:** aberto, **conservador** — manter por padrão; remover só se evidência forte de zero uso
- **Descoberto em:** 2026-05-20, durante PR 8 do Sprint MCP Internal Server
- **Dono provável:** backend (worker-functions)
- **Bloqueador?** Não — endpoints continuam ativos com `@deprecated` JSDoc

**Histórico:**

PR 1 do sprint MCP criou 3 endpoints HTTP no worker-functions porque o `triage-service` (em desenvolvimento local) chamava via axios e dois deles não existiam. Foram criados como pré-requisito do sprint, NÃO porque o MCP precisa deles (o MCP propriamente dito usa `/mcp/v1` JSON-RPC stateless, sem endpoints REST adicionais).

**Endpoints especificamente em escopo deste TD (NENHUM outro):**

```
GET  /api/admin/workers/:id/current-interview
GET  /api/admin/workers/:id/available-vacancies
POST /api/admin/workers/:id/documents/ingest-from-url
```

**NÃO ESTÁ em escopo deste TD** (continuam intocados, sem deprecation, sem cleanup):

- Qualquer outro endpoint de `/api/admin/workers/...` usado pelo frontend admin (`/api/admin/workers/:id`, `/api/admin/workers/:id/documents`, `/api/admin/workers/by-phone`, `/api/admin/workers`, `/api/admin/workers/:id/progress`, etc.)
- Endpoints de auth, identity, patients, vacancies, matching, etc.
- Use cases compartilhados (`GetCurrentInterviewUseCase`, `ListAvailableVacanciesForWorkerUseCase`, `IngestDocumentFromUrlUseCase`) — esses ficam, são usados pelas capabilities MCP

**Mudança de postura (2026-05-20, após revisão):**

A versão inicial deste TD propunha cleanup após 7 dias estável em prod. **Postura revisada pra conservadora** com base em 2 fatos:

1. `triage-service` **ainda não está em produção** em `enlite-prd` (confirmado via `gcloud run services list`). Os 3 endpoints HTTP, portanto, nunca tiveram tráfego prd — não há histórico real de uso pra comparar.
2. Manter código já testado e estável tem custo de manutenção baixo. Recriar depois se outro consumer aparecer é mais caro que manter.

**Critérios pra eventualmente remover (cumulativos, todos obrigatórios):**

1. `triage-service` em produção real (`enlite-prd`) por ≥ 30 dias com `USE_MCP_GATEWAY=true`
2. **Zero hits** nos 3 endpoints no Cloud Logging por ≥ 30 dias consecutivos (não 7) — filter por path exato
3. `grep -rE '/api/admin/workers/.+/(current-interview|available-vacancies|documents/ingest-from-url)' enlite-frontend/ n8n-workflows/ worker-functions/scripts/ triage-service/` em **todos** os repos da org retorna zero
4. Pull request de remoção passa por review com explícito ACK de "ninguém usa, podemos remover"

**Se algum critério falhar, NÃO remover.** Custo de manter é baixo. Custo de remover prematuramente e quebrar consumer escondido é alto.

**Quando (eventualmente) remover, escopo:**

- `src/modules/matching/interfaces/controllers/WorkerContextController.ts`
- `src/modules/matching/interfaces/routes/workerContextRoutes.ts`
- Linha de montagem em `src/index.ts`
- Tests de E2E `tests/e2e/worker-context-api.test.ts`

**Nunca remover** (mesmo se TD for fechado):

- `ApiKeyAuthStrategy`, `requireStaffOrApiKey` middleware (úteis pra futuros service principals)
- Migration 180 (timezone) — irreversível e útil pra MCP também
- Use cases base (`GetCurrentInterviewUseCase`, `ListAvailableVacanciesForWorkerUseCase`, `IngestDocumentFromUrlUseCase`) — usados pelas capabilities MCP

---

### TD-034 — Estratégia de repos por serviço (multi-repo)

- **Status:** aberto, decisão de arquitetura
- **Descoberto em:** 2026-05-20, durante PR 7 do Sprint MCP Internal Server
- **Dono provável:** Gabriel + futura empresa
- **Bloqueador?** Não — convive com monorepo atual

**O que é:**

O `triage-service` foi extraído pra repo próprio em `enlite-health/triage-service` durante o sprint MCP. Decisão alinhada com o user: "vamos fazer um repo pra cada um futuramente".

**Serviços que continuam no monorepo `enlite-monorepo`:**
- `worker-functions/` (backend principal)
- `enlite-frontend/` (admin)
- `terraform/` (IaC)
- `n8n-workflows/` (workflows)
- `docs/`

**Próximos candidatos a extração (quando fizer sentido):**
- `worker-functions` (se ficar grande demais — improvável a curto prazo)
- `enlite-frontend` (deploy independente do backend já justifica)
- Novos microservices (e.g. notifications, analytics) — nascem em repo próprio

**Critérios pra extrair:**
1. Serviço tem stack/runtime diferente do resto
2. Ciclo de vida e deploy independentes
3. Equipes diferentes (futuro)
4. Boundary de domínio claro

**Padrão de organização:**
- Org: `enlite-health` no GitHub (criada 2026-05-20)
- Naming: `<service-name>` sem prefixo `enlite-` (org já dá contexto)
- Deploy: cada repo tem seus próprios workflows no `.github/workflows/`

---

### TD-035 — `SyncTalentumWorkersUseCase` cria WJA sem `application_funnel_stage` — **CONCLUÍDO 2026-05-22**

- **Status:** concluído (com reescopo)
- **Descoberto em:** 2026-05-22, durante investigação dos bugs do Kanban (ver [`POSTMORTEM_KANBAN_FUNNEL_BUGS.md`](POSTMORTEM_KANBAN_FUNNEL_BUGS.md) bug #3)
- **Dono:** backend (worker-functions)

> **Atualização 2026-05-23:** consolidado em [features/worker-job-applications/](features/worker-job-applications/README.md). Pipeline `EncuadreRepository.syncToWorkerJobApplications` será deprecado integralmente em F6 do plano.

**Histórico de execução:**

1. **Iteração 1 (Opção B)** — implementado decider que aplicava `profile.status` global do TalentumDashboardProfile quando o worker não tinha prescreening em vaga nenhuma. 35/35 testes passing.
2. **Reescopo durante revisão arquitetural** — dono do produto esclareceu que webhook `PRESCREENING_RESPONSE` é a **única fonte canônica per-encuadre**. `profile.status` global não tem semântica per-(worker, vaga) — usá-lo como fonte do funil contamina dado clínico.
3. **Iteração 2 (final)** — `TalentumSyncStageDecider` removido. `SyncTalentumWorkersUseCase` simplificado: nunca seta `application_funnel_stage`. Único caminho: `INSERT INTO worker_job_applications (worker_id, job_posting_id, application_status, source) VALUES (...) ON CONFLICT DO NOTHING`. Stage cai no default `INITIATED` até webhook canônico chegar.

**O que ficou (mudanças em produção):**

1. ✓ Migration 185 — função SQL `funnel_stage_precedence(text) RETURNS int IMMUTABLE` reutilizável
2. ✓ Migration 183 — `enforce_worker_registered_for_application` adiciona `'talentum'` no bypass
3. ✓ `FunnelStageMapper` interface + `TalentumFunnelStageMapper` (usados pelo webhook em `ProcessTalentumPrescreening`)
4. ✓ Webhook usa `funnel_stage_precedence` no UPSERT (extraído do CASE inline anterior — bug #4 da Fase 5)
5. ✓ Guard `source='talentum' immutable` removido em `EncuadreRepository.syncToWorkerJobApplications` — precedência canônica protege contra regressão sem acoplamento de fonte
6. ✓ `SyncTalentumWorkersUseCase` simplificado: nunca seta `application_funnel_stage`
7. ✓ Suite E2E 21/21 passing (8 transition + 4 regression + 6 edge-cases + 3 sync simplificado)

**Impacto sobre os 1.332 presos:**

- Não vão ser corrigidos por backfill — **estado é correto operacionalmente**. São candidatos cadastrados via dashboard que nunca tiveram webhook canônico per-encuadre (não entraram no WhatsApp daquela vaga específica ou abandonaram antes).
- Sintoma operacional ("vaga com 20 em INITIATED parece estagnada") é endereçado pelo TD-040 (UI feedback), não por mudança no banco.

---

### TD-036 — Admin/canais alternativos criam WJA sem `encuadre`

> **SUPERSEDED 2026-05-23:** invariante WJA-com-encuadre garantida pelo trigger 189 (commit `be5c06d`). Detalhes em [features/worker-job-applications/06-regra-cardinalidade.md](features/worker-job-applications/06-regra-cardinalidade.md).

- **Status:** aberto
- **Descoberto em:** 2026-05-22, durante investigação dos bugs do Kanban (bugs #1 e #2 do postmortem)
- **Dono provável:** backend (worker-functions)
- **Bloqueador?** Não — afeta UX do Kanban mas não dado crítico

**O que é:**

215 WJAs em estados `POSTULATED` (INITIATED/IN_PROGRESS/COMPLETED) **não têm linha correspondente em `encuadres`**. Como o Kanban faz `FROM encuadres LEFT JOIN worker_job_applications`, esses 215 não aparecem no Kanban — mas aparecem na lista (que lê de `worker_job_applications` direto). Daí a queixa "20 na lista, 0 no Kanban".

Quebra por origem:

| source | qtd | encuadre criado por qual path? |
|---|---|---|
| manual | 183 | path admin não chama `ensureEncuadre` |
| talentum | 30 | edge case no `ProcessTalentumPrescreening.ensureEncuadre` (provavelmente exception swallowed) |
| candidatos | 1 | path desconhecido |
| talent_search | 1 | path desconhecido |

**Proposta de solução:**

1. Identificar TODOS os pontos de inserção em `worker_job_applications` (grep `INSERT INTO worker_job_applications`)
2. Para cada um que ainda não chama `ensureEncuadre`: ou chama, ou marca como exceção documentada com motivo
3. Para os 30 do webhook Talentum: instrumentar `ensureEncuadre` com `reportError` para capturar a exceção real
4. Backfill SQL pontual pros 215 órfãos (criar encuadre com `origen='backfill-TD-036'`) — pode ir junto com o RUNBOOK_BACKFILL ou separado

**Cuidado:** atenção pra não criar encuadres duplicados em fluxos que já têm encuadre via outra rota. Sempre `ON CONFLICT (dedup_hash) DO NOTHING`.

---

### TD-037 — Funil interno abstrato + mappers por provider

> **Atualização 2026-05-23:** mapper já implementado (TD-035 item 3). Sub-item 5 endereçado por [features/worker-job-applications/04-estados-funil-kanban.md](features/worker-job-applications/04-estados-funil-kanban.md) (Kanban com badges em COMPLETADO; layout de 7 colunas mantido — revisão 2026-05-24).

- **Status:** decisão tomada 2026-05-22, implementação pendente
- **Descoberto em:** 2026-05-22, durante investigação dos bugs do Kanban (seção 6 do postmortem)
- **Dono provável:** backend (worker-functions)
- **Bloqueador?** Não — desacopla domínio do Talentum sem mudar comportamento atual

**O que é:**

`worker_job_applications.application_funnel_stage` foi criado copiando o vocabulário do Talentum 1:1 (`INITIATED`, `IN_PROGRESS`, `COMPLETED`, `QUALIFIED`, `NOT_QUALIFIED`). Hoje o webhook Talentum joga esses valores direto, sem tradução ([`ProcessTalentumPrescreening.deriveFunnelStage`](../worker-functions/src/modules/matching/application/ProcessTalentumPrescreening.ts) é identity). E há guards no código (`source='talentum' is immutable`) que codificam Talentum como autoridade exclusiva.

A operação aprovou em 2026-05-22 (após o postmortem) que **o vocabulário Talentum vira referência canônica do funil interno Enlite**. Futuros providers de triagem (já decidido que virão) traduzem seus estados pra esse mesmo vocabulário via mapper próprio.

**Implicações concretas a executar:**

1. **Conceitual:** documentar em `docs/ARCHITECTURE.md` (ou criar `docs/DOMAIN_FUNNEL.md`) que `application_funnel_stage` é vocabulário Enlite, não Talentum, embora coincidam por origem histórica.
2. **Interface:** criar `FunnelStageMapper` interface com método `mapToInternalStage(providerPayload): FunnelStage`. Implementações: `TalentumFunnelStageMapper` (identity), futuros providers vão herdar.
3. **Refactor:** `ProcessTalentumPrescreening.deriveFunnelStage` vira chamada ao `TalentumFunnelStageMapper.mapToInternalStage(payload)`.
4. **Guards removidas:** o CASE `source='talentum' immutable` em `EncuadreRepository.syncToWorkerJobApplications` sai (alinhado com TD-035). Proteção contra regressão fica APENAS no CASE de precedência canônica.
5. **API:** `EncuadreFunnelController` linha 51-53 deve parar de derivar `talentum_status` do `application_funnel_stage` — passar a ler direto de `talentum_prescreenings.status`. Quando outro provider entrar, ele terá sua própria tabela e a API retornará `provider_status: { provider: 'talentum', status: 'ANALYZED' }` ou similar.
6. **Memory atualizada:** `feedback_qualified_only_talentum.md` precisa virar `feedback_qualified_only_via_certified_provider.md` quando o 2º provider chegar.

**Referência da decisão:** `memory/project_funnel_internal_abstract.md`.

Esse TD é **arquitetural** — não precisa ser executado de uma vez. Pode ir junto com o TD-035 (que já faz o passo 4 e parte do passo 2).

---

### TD-038 — `DraggableCard` e `KanbanCard` compartilham mesmo `data-testid`

- **Status:** aberto, low prio
- **Descoberto em:** 2026-05-22, durante criação dos testes E2E visuais do Kanban
- **Dono provável:** frontend (enlite-frontend)
- **Bloqueador?** Não — testes lidam com a duplicação via seletor `[data-stage]`

**O que é:**

[`DraggableCard.tsx:14`](../enlite-frontend/src/presentation/components/features/admin/Kanban/DraggableCard.tsx#L14) atribui `data-testid="kanban-card-${id}"` no wrapper. [`KanbanCard.tsx:76`](../enlite-frontend/src/presentation/components/features/admin/Kanban/KanbanCard.tsx#L76) atribui o **mesmo `data-testid`** no inner. Resultado: o DOM tem 2 elementos com o mesmo testid pra cada card, e `page.locator('[data-testid="kanban-card-xxx"]')` retorna o primeiro (wrapper, que não tem `data-stage`).

Workaround atual nos testes: usar seletor `[data-testid="kanban-card-${id}"][data-stage]` pra filtrar só o inner. Funciona, mas é frágil — se alguém adicionar `data-stage` no wrapper, quebra.

**Proposta de solução:**

Opção A (simples): renomear testid do wrapper pra `kanban-card-${id}-draggable` ou remover (se não houver teste usando).
Opção B (semântica): mover `data-stage` pro wrapper junto com `data-testid` — wrapper passa a representar a "posição do card no kanban", inner passa a ser estritamente conteúdo.

Verificar antes: quais testes usam `kanban-card-{id}` hoje (grep em `e2e/`). Se nenhum precisa do wrapper, opção A é trivial.

---

### TD-039 — Suite E2E integration do frontend não roda em CI

- **Status:** aberto
- **Descoberto em:** 2026-05-22, durante validação visual do funil Kanban
- **Dono provável:** DevOps / frontend
- **Bloqueador?** Não — testes rodam localmente, snapshots commitados

**O que é:**

`worker-functions/.github/workflows/e2e.yml` roda os testes E2E do backend em todo PR. O frontend tem `pnpm test:e2e` em CI **apenas para os projetos chromium/firefox/webkit** (mockados). A suite `integration` (full-stack: backend Docker + frontend dev server + DB real) — incluindo os 7 cenários visuais do Kanban Talentum criados em 2026-05-22 — **não roda em CI**.

**Proposta:**

1. Adicionar job em `enlite-frontend/.github/workflows/e2e-integration.yml` que:
   - Sobe `worker-functions` Docker stack
   - Sobe Vite dev server do `enlite-frontend`
   - Roda `pnpm test:e2e:integration`
   - Sobe artefatos de screenshot diff em falha
2. Definir trigger — provavelmente só em PRs com label `integration` ou em push pra `main` (custo de CI alto pra Docker stack)
3. Manter snapshots em git (já estão) — CI vira validação contra eles

**Risco de flake:** screenshots têm `maxDiffPixelRatio: 0.05`. Avaliar se aumenta em CI (fontes podem renderizar diferente em Linux vs Mac, onde os baselines foram gerados — `vacancy-kanban-*-integration-darwin.png`). Pode precisar de baseline `-linux.png` separado.

---

### TD-040 — UI feedback "candidato cadastrado sem retorno do worker"

- **Status:** aberto
- **Descoberto em:** 2026-05-22, durante reescopo do TD-035 (ver [`POSTMORTEM_KANBAN_FUNNEL_BUGS.md`](POSTMORTEM_KANBAN_FUNNEL_BUGS.md) §5)
- **Dono provável:** frontend (enlite-frontend) + design
- **Bloqueador?** Não — operacional, não técnico

**O que é:**

Após simplificação do TD-035, ficou claro que workers em `application_funnel_stage='INITIATED'` com `source='talentum'` e sem registro em `talentum_prescreenings` são **estado correto** do modelo — não bug. Representam candidatos cadastrados via dashboard Talentum cujos webhooks `PRESCREENING_RESPONSE` nunca chegaram (provavelmente o worker não entrou no WhatsApp daquela vaga ou abandonou antes da 1ª pergunta).

Hoje, no Kanban, esses cards ficam indistinguíveis de "worker que acabou de iniciar triagem agora" — daí a queixa operacional "vaga com 20 em INITIATED parece estagnada".

**Proposta de solução (mínima):**

1. No card do Kanban (KanbanCard.tsx), quando o card está em `INITIATED` há mais de 7 dias **e** o worker não tem `talentum_prescreenings.status` registrada pra essa vaga, exibir badge/ícone "sem retorno do worker" (texto em es-AR: *"Sin respuesta del prestador"*).
2. Tooltip explicando: "Candidato cadastrado via Talentum há X dias mas não iniciou o prescreening desta vaga."
3. Opcional fase 2: filtro no Kanban "ocultar candidatos sem retorno" pra reduzir poluição visual.

**API necessária:**

O endpoint `GET /api/admin/vacancies/:id/funnel` (no [`EncuadreFunnelController.ts`](../worker-functions/src/modules/matching/interfaces/controllers/EncuadreFunnelController.ts)) já retorna `talentumStatus` per card — basta o frontend usar:

```ts
const isStale =
  card.funnelStage === 'INITIATED'
  && card.talentumStatus === null
  && daysSince(card.updatedAt) > 7;
```

Sem mudança de backend necessária.

**Cobertura de teste:**

- Unit test no KanbanCard que valida renderização do badge condicional
- E2E visual integration adicionando 1 cenário ao [`vacancy-kanban-talentum-webhook.integration.e2e.ts`](../enlite-frontend/e2e/integration/vacancy-kanban-talentum-webhook.integration.e2e.ts): worker com WJA criada há 10 dias, sem prescreening — assert badge visível + screenshot.

**Métrica de sucesso:** operação consegue, sem perguntar pra eng, distinguir "vaga com 20 candidatos triando" de "vaga com 20 cadastros frios sem retorno".

---

### TD-041 — Remover `dedup_hash` como constraint primária de unicidade após F5 estável

- **Status:** aberto
- **Descoberto em:** 2026-05-24, durante refinamento de F5 do plano WJA
- **Dono provável:** backend (worker-functions)
- **Bloqueador?** Não — depende de F5 em produção estável por ≥ 14 dias
- **Origem:** [ADR-001](adr/001-encuadres-unique-worker-job-posting-constraint.md)

**O que é:**

Após a F5 (UNIQUE `(worker_id, job_posting_id)` em `encuadres` + consolidação de duplicatas) estar em produção por ≥ 14 dias sem incidentes, avaliar se `encuadres.dedup_hash` pode ser rebaixado de `UNIQUE` para campo de auditoria simples — ou migrado para `import_source_audit` em F8.

O ADR-001 mantém `dedup_hash` como `NOT NULL` por enquanto para preservar rastreabilidade do formato de origem (`talentum|...`, `auto-trigger|...` etc.), mas reconhece que a função de árbitro primário de unicidade foi substituída pela nova constraint composta.

**Critério para fechar:**

- F5 em produção sem violações de constraint inesperadas por 14 dias corridos
- Todos os 6 call sites de INSERT em `encuadres` migrados para `ON CONFLICT (worker_id, job_posting_id)` (não mais para `ON CONFLICT (dedup_hash)`)
- Decisão tomada sobre o destino final de `dedup_hash`: (a) drop da `UNIQUE` mantendo coluna como auditoria, (b) renomear/mover para `import_source_audit` em F8, ou (c) deprecação total

---

### TD-042 — Concluir deprecação de `encuadres` (F4-F8 do plano WJA)

- **Status:** aberto
- **Descoberto em:** 2026-05-23, durante refinamento do plano WJA e auditoria das 7 duplicações entre `encuadres` e `worker_job_applications`
- **Dono provável:** backend (worker-functions) + frontend (Kanban)
- **Bloqueador?** Não — sistema funciona no estado atual, mas duplicações continuam custando manutenção
- **Origem:** [ADR-002](adr/002-wja-canonico-encuadres-deprecada.md)

**O que é:**

F2 e F3 do plano de 8 fases de deprecação de `encuadres` já foram entregues (commits `64d9af8` e `b26e8e2`). As fases restantes são:

- F4 (Kanban: badges + botão rejeitar + drag rules): adicionar badges visuais (QUALIFIED/IN_DOUBT/COMPLETED puro) na coluna COMPLETADO; botão dedicado "Rejeitar" no card com modal de motivo; ajustar drag rules (não droppable: INITIATED/IN_PROGRESS/COMPLETADO — controle Talentum). Kanban mantém 7 colunas (revisão 2026-05-24). Impacto: backend (campo `internal_stage` no payload) + frontend.
- F5 (REPROGRAMAR edita): REPROGRAMAR passa a editar a linha existente de `encuadres` em vez de criar nova; depende da constraint UNIQUE de ADR-001 já em produção.
- F6 (matar `syncToWorkerJobApplications`): remover `EncuadreRepository.syncToWorkerJobApplications` do hot path do import; requer auditoria de todos os call sites de JOIN explícito antes do delete.
- F7 (limpar enum legado): remover valores ANALYZED/REPROGRAM/PLACED/SELECTED/application_status do enum de funil; requer migration com cuidado em linhas históricas.
- F8 (`origen` → `import_source_audit`): migrar dados de `encuadres.origen` para nova tabela `import_source_audit`; requer janela de manutenção (não pode ser rolling).

Plano completo em `docs/features/worker-job-applications/README.md`.

**Critério para fechar:**

- F4 entregue e validada em produção (Kanban com badges + botão rejeitar + drag rules; 7 colunas mantidas)
- F5 estável em produção por ≥ 14 dias sem violações de constraint (ver TD-041)
- F6 concluída: `syncToWorkerJobApplications` removido do pipeline de import e todos os JOIN explícitos auditados
- F7 concluída: enum limpo sem valores legados, migration aplicada em produção
- F8 concluída: `encuadres.origen` migrado para `import_source_audit`, dashboards/relatórios externos inventariados e atualizados

**Ver:** [ADR-002](adr/002-wja-canonico-encuadres-deprecada.md) — seção "Follow-up".

**Ver:** [ADR-001](adr/001-encuadres-unique-worker-job-posting-constraint.md) — seção "Follow-up".
