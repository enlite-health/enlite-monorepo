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
