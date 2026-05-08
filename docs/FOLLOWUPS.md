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

---

## Resolvidos

_(vazio por enquanto)_
