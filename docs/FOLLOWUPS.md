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

### TD-017 — `onUserCreate.ts` (Firebase Functions trigger) não propaga traceId via ALS

- **Status:** aberto
- **Descoberto em:** 2026-05-19, durante implementação da Fase 0 do Sprint de Automação de Recrutamento
- **Dono provável:** backend (worker-functions)
- **Bloqueador?** Não — logs do trigger ficam sem `traceId`, mas não quebra funcionalidade

**Contexto:**

O Firebase Functions SDK (`firebase-functions`) não usa Express para despachar triggers como `auth.user().onCreate`. O `AsyncLocalStorage` (`loggingAls`) só propaga contexto dentro de uma cadeia de chamadas iniciada por `loggingAls.run(...)` — o que o `correlationMiddleware` faz para cada request HTTP. Triggers Firebase entram por outro caminho (Node.js callback do SDK), fora de qualquer `run()`, então `loggingAls.getStore()` retorna `undefined` nesses contextos.

**Efeito prático:**

Logs emitidos dentro de `onUserCreate.ts` (ou outros triggers Firebase) não carregam `traceId`, `workerId` etc. São logs válidos (pino JSON estruturado, `severity` correta), mas não agrupáveis por trace.

**Solução futura (opções):**

1. Envolver o corpo do handler em `loggingAls.run({ traceId: uuidv4() }, ...)` manualmente — gera traceId próprio por execução do trigger, sem correlação com a request que originou o evento.
2. Passar traceId via custom claims no token Firebase e lê-lo no handler — mais complexo, só vale se rastrear a cadeia completa user-creation → trigger for prioritário.
3. Usar `logger.child({ traceId: uuidv4(), source: 'firebase-trigger' })` localmente no handler — mais simples, mantém isolamento sem tocar no ALS global.

**Recomendação:** opção 3 como curto prazo ao tocar `onUserCreate.ts` pela próxima vez.

### TD-020 — Template `talentum_incomplete_reminder` precisa de `content_sid` Twilio HSM antes do go-live

- **Status:** aberto
- **Descoberto em:** 2026-05-19, durante implementação da Fase 4 do Sprint de Automação de Recrutamento
- **Dono provável:** Ops + Backend
- **Bloqueador?** Sim pra produção. Não pra E2E.

**Contexto:**

Template `talentum_incomplete_reminder` (migration 175) tem `content_sid = NULL`. WhatsApp Business rejeita mensagens proativas sem HSM aprovado. O `TwilioMessagingService` vai tentar enviar e receber erro da API Twilio em produção.

**Antes do deploy:**
1. Ops registra template no Twilio Content Builder com variável `worker_name`
2. Ops obtém aprovação HSM da Meta (pode levar dias)
3. Backend roda `UPDATE message_templates SET content_sid = 'HX...' WHERE slug = 'talentum_incomplete_reminder'` em prod

### TD-022 — Template `talentum_incomplete_reminder` precisa ser criado no Twilio Console + aprovado pela Meta

- **Status:** aberto
- **Descoberto em:** 2026-05-20, durante integração com templates aprovados
- **Dono provável:** Ops + Backend
- **Bloqueador?** Sim pra ativação do cron de lembrete Talentum. Não pra outros fluxos.

**Contexto:**

Os outros 3 templates do sprint estão aprovados. `talentum_incomplete_reminder` foi criado em migration 175 com `content_sid = NULL` e ainda não existe no Twilio Console.

**Próximos passos:**

1. Ops cria template no Twilio Content Builder:
   - friendly_name: `talentum_incomplete_reminder` (ou variante padrão `ar_*`)
   - Category: UTILITY
   - Language: es_AR
   - Variável: `worker_name`
   - Body sugerido: "¡Hola {{1}}! Tu proceso de selección en EnLite quedó pendiente de completar. Ingresá a https://app.enlite.health para retomarlo."
2. Submete pra aprovação Meta (~1-3 dias úteis)
3. Backend roda: `UPDATE message_templates SET content_sid = 'HX...' WHERE slug = 'talentum_incomplete_reminder';`

---

## Resolvidos

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
