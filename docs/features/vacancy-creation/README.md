# Criação de Vagas (Vacancy Creation)

> **Status:** Feature ativa, doc canônico. Cobre criação (Step 1), configuração Talentum (Step 2), detalhe (Step 3) e o flow de edição (VacancyModal legacy).
> **Última atualização:** 2026-05-26 — fix do mapper ClickUp resolvendo bug "vaga grava com endereço antigo" (postmortem em [10-bug-historico-endereco-antigo.md](10-bug-historico-endereco-antigo.md)).
> **Sprints anteriores que chegaram aqui:** [`SPRINT_VACANCIES_REFACTOR.md`](../../SPRINT_VACANCIES_REFACTOR.md) (schema base, FK pra patient_addresses), [`SPRINT_CREATE_VACANCY_FORM_REFACTOR.md`](../../SPRINT_CREATE_VACANCY_FORM_REFACTOR.md) (wizard → form único + Stepper).

## Visão executiva

Uma **vaga** (job posting / vacante) é a solicitação ativa por um prestador (AT ou Cuidador) pra acompanhar um paciente num endereço específico. Vive em [`job_postings`](07-tabelas-envolvidas.md#job_postings), aponta pra UM paciente (`patient_id`) e UM endereço (`patient_address_id`), nasce em status `PENDING_ACTIVATION` e só vira pública quando o operador conclui a configuração Talentum (Step 2).

Regras inegociáveis:

- **Cardinalidade vaga ↔ paciente:** N vagas por paciente, mas cada vaga aponta pra UM único paciente. `patient_id` nullable em vagas históricas — toda vaga nova tem `patient_id` obrigatório.
- **Cardinalidade vaga ↔ endereço:** UMA vaga referencia UM `patient_address_id`. **Não há snapshot** — vaga puxa o estado atual do endereço via JOIN com `patient_addresses`. Toda mudança no endereço (via webhook ClickUp ou edição manual) propaga pra todas as vagas que apontam pra ele. Isso é DESEJADO operacionalmente.
- **Título auto-gerado:** `"CASO {case_number}-{vacancy_number}"`. `vacancy_number` é sequence (`job_postings_vacancy_number_seq`), `case_number` é herdado do paciente (não único — várias vagas no mesmo caso são esperadas).
- **Vaga é derivada de paciente:** campos clínicos (`service_type`, `dependency_level`, `diagnosis`) e endereço NÃO vivem em `job_postings` (dropados na Fase 9 do `SPRINT_VACANCIES_REFACTOR`). Vêm via JOIN com `patients` e `patient_addresses`.
- **Edição congelada após draft:** vagas que saíram de `PENDING_ACTIVATION` só permitem editar `schedule` e `status` (controller bloqueia outros campos com 403). Pra mudar perfil/horário base, é reabrir como nova vaga.

## Índice

1. [Conceito](01-conceito.md) — o que é uma vaga, por que existe, ciclo de vida
2. [Vocabulário](02-vocabulario.md) — vaga / vacante / job_posting / caso / case_number / vacancy_number
3. [SSOT por conceito](03-ssot-por-conceito.md) — qual tabela/coluna detém autoridade sobre cada dado
4. [Estados (status canônicos)](04-estados-status.md) — 7 status + transições + visibilidade pública
5. [Fluxo de criação (Step 1 → 2 → 3)](05-fluxo-criacao.md) — wizard atual, validações, gates
6. [Endereço do serviço — fonte da verdade](06-endereco-servico.md) — como `patient_addresses` flui da ClickUp pro `getVacancyById`; por que o JOIN é correto; armadilhas do sync ClickUp
7. [Tabelas envolvidas](07-tabelas-envolvidas.md) — schema atual de `job_postings` e dependências
8. [Pipelines de escrita](08-pipelines-escrita.md) — form admin, sync ClickUp, matchmaking, scripts
9. [Edição e restrições](09-edicao-e-restricoes.md) — VacancyModal legacy + draft vs operational
10. [Postmortem: endereço antigo na vaga (bug 2026-05-26)](10-bug-historico-endereco-antigo.md) — diagnóstico empírico via caso 429-948 + fix do mapper

## Plano de fases (fix mapper)

| Fase | Escopo | Status | Commit |
|---|---|---|---|
| **F1** | Discovery: mapear Step 1, Step 2, edit legacy, sync ClickUp. Primeira hipótese ("snapshot na vaga") refutada após user explicar que o ClickUp já mostra atualizado na ficha do paciente — bug está no sync, não na vaga. | ✅ Concluída 2026-05-26 | — |
| **F2** | DBA rastreou caso 429-948: `address_formatted` da row `patient_addresses` está NOVO, mas `neighborhood`/`city`/`state` ainda apontam pro endereço antigo. Causa: mapper extrai esses 3 campos de 3 custom fields SEPARADOS no ClickUp (`Provincia del Paciente`, `Ciudad / Localidad del Paciente`, `Zona o Barrio Paciente`) em vez de extrair dos `address_components` do mesmo `Domicilio N Principal Paciente` que dá origem ao `address_formatted`. Operador atualizou o "Domicilio Principal" mas não os 3 patient-level fields → split entre as 5 colunas da mesma row. | ✅ Concluída 2026-05-26 | — |
| **F3** | Discovery blast radius: 13 consumidores cobertos automaticamente se fix for no mapper. SQL queries em `VacanciesController`, `PublicJobsQueryBuilder`, `JobPostingARRepository`, `PublicVacancyController`, `MatchmakingService`, `RecruitmentController`, `RecruitmentAnalyticsController`. LLM enrichment em `TalentumDescriptionService` + `GeminiVacancyParserService`. Frontend `VacancyCaseCard`, `JobsEmbeddedSection`, `matchModalHelpers`, `AdminVacancyDetail` DTO. **Conclusão: só o mapper precisa mudar; todos consumidores continuam puxando dos mesmos campos.** | ✅ Concluída 2026-05-26 | — |
| **F4** | Fix do mapper: adicionar `extractNeighborhoodFromLocation` + variantes strict (`extractStateFromLocationStrict`, `extractCityFromLocationStrict`) em `locationHelpers.ts`. Refatorar `ClickUpPatientMapper.buildAddresses`: cada slot extrai state/city/neighborhood do **próprio** `Domicilio N Principal Paciente` (via address_components). Legacy patient-level fields (`Provincia/Ciudad/Zona Paciente`) ficam como fallback APENAS no slot 1 quando o `Domicilio 1` não tem components estruturados (compat com dados históricos só com string). | ✅ Concluída 2026-05-26 | (pendente commit) |
| **F5** | Unit tests do mapper: 50/50 verdes, incluindo case `(t) REGRESSION 429-948` que reproduz exatamente o cenário do bug: location nova com components + legacy fields stale → mapper escolhe os components, ignora o stale. | ✅ Concluída 2026-05-26 | (pendente commit) |
| **F6** | Doc canônico em `docs/features/vacancy-creation/` (este doc + 10 subdocs). | ✅ Concluída 2026-05-26 | (pendente commit) |
| **F7** | Backend: novo endpoint `GET /api/admin/vacancies/by-address?patient_address_id=X` retornando vagas (não soft-deleted, não CLOSED) que apontam pra aquele endereço. Frontend: `AddressHasVacancyDialog` integrado no `CreateVacancyPage` — quando `selectedAddressId` muda, frontend consulta o endpoint; se houver vagas, dispara modal bloqueante com lista + ações ("Editar a vaga", "Criar nova mesmo assim", "Escolher outro endereço"). Complementa o `ResumeDraftVacancyDialog` (per-patient) já existente. | ✅ Concluída 2026-05-26 | (pendente commit) |
| **F8** | E2E `vacancy-address-versioning.e2e.test.ts` estendido: adiciona `(it 2)` cobrindo paciente com 2 endereços ativos (slot 1 + slot 2 simultâneos) — operador pode escolher qualquer um. Adiciona assertions na `it 1` cobrindo o endpoint by-address (retorna vaga 1 pra address arquivado, vaga 2 pra address ativo). Total: 2/2 verdes; suite relacionada 132/132 verdes. | ✅ Concluída 2026-05-26 | (pendente commit) |
| **F9** | **Deploy + re-sync em prod:** rodar `npx ts-node scripts/import-patients-from-clickup.ts --live` depois do deploy do worker-functions. Re-aplica o mapper novo a todos os pacientes; backfilla `neighborhood/city/state` corretos pra todas as rows. Monitorar caso 429 + 5 amostras pós-sync. | ⏳ Pendente | — |

## Referências cruzadas

- Sprint anterior 1: [`docs/SPRINT_VACANCIES_REFACTOR.md`](../../SPRINT_VACANCIES_REFACTOR.md) — schema base, FK `patient_address_id`, status canônicos
- Sprint anterior 2: [`docs/SPRINT_CREATE_VACANCY_FORM_REFACTOR.md`](../../SPRINT_CREATE_VACANCY_FORM_REFACTOR.md) — wizard → form único + Stepper + lat/lng em patient_addresses
- Feature relacionada: [`docs/features/worker-job-applications/`](../worker-job-applications/) — funil de candidatura (depois de criada, a vaga recebe WJAs)
- Memória relacionada: `project_clickup_webhook_approved_for_patients` — webhook ClickUp aprovado em 2026-05-08 como sync oficial
- TD-003 pendente: depreciar `VacancyModal/` legacy (modal de edit da listagem) — sprint dedicada futura
