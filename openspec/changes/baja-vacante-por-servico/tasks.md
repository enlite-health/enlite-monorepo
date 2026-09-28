# Tasks — Baja de serviço contratado desativa a vaga ligada

> Execução em 28/09/2026 — worktree `repos/_worktrees/baja-vacante-por-servico`, branch
> `feat/baja-vacante-quando-servico-de-baja`, base `origin/stage` @ `7c4fbed9`.

## 1. Migration

- [x] 1.1 `job_postings.status` CHECK ganha `DE_BAJA` (padrão aditivo da migration 166 — rename/drop/
      recria) + coluna `status_before_baja TEXT NULL`. **Termina quando:** arquivo
      `worker-functions/migrations/483_job_postings_de_baja.sql` existe, segue a numeração
      sequencial, e não usa `NOT VALID` (puramente aditivo, nenhuma linha existente viola o CHECK
      novo — diferente da migration 475, que restringia contra histórico não-conforme).
      **Evidência:** `worker-functions/migrations/483_job_postings_de_baja.sql` criado.

## 2. Gatilho no repositório (caso central)

- [x] 2.1 `PatientContractedServiceRepository.applyVacancyBajaGatilho` — `active:false` marca
      `status_before_baja`/`DE_BAJA` nas vagas vivas do serviço; `active:true` restaura. Mesma
      transação do UPDATE do serviço (`cli` de `withActorContext`). **Termina quando:** teste
      unitário RED contra o código de `origin/stage` (sem o gatilho), GREEN depois — saída colada no
      relatório de execução.
      **Evidência:** `PatientContractedServiceRepository.test.ts` — 2 testes novos ("active:false
      baixa...", "active:true reativa..."), RED (`git stash` do arquivo de implementação) → 2 failed
      / GREEN (stash pop) → 36/36 passed. `applyVacancyBajaGatilho` extraído como método privado
      (391 linhas no arquivo, dentro do teto de 400 do CLAUDE.md do worktree).
- [x] 2.2 Isolamento: PATCH sem `active` não dispara UPDATE em `job_postings`; vaga de outro serviço
      não é afetada (parâmetro escopado por `contracted_service_id = $1`).
      **Evidência:** testes "PATCH sem `active`... NÃO dispara" e e2e "ISOLAMENTO" (seção 5).

## 3. Some do WordPress e do prestador

- [x] 3.1 Confirmar que `DE_BAJA` fica fora das 4 allow-lists públicas (nenhuma editada — já eram
      allow-list). **Termina quando:** leitura de `PublicJobsQueryBuilder.ACTIVE_STATUSES`,
      `PublicVacancyController.STATUS_PUBLICAVEL`, `openJobStatuses.OPEN_JOB_STATUSES`,
      `FindNearbyVacanciesForWorkerUseCase.ACTIVE_STATUSES` confirma allow-list fechada.
      **Evidência:** as 4 listas lidas — nenhuma é "tudo menos X"; `DE_BAJA` ausente de todas.
- [x] 3.2 Cinto de segurança: `NOT EXISTS` contra `patient_contracted_services` inativo, no feed e no
      detalhe (ignorado quando o status já é `DE_BAJA`, no detalhe).
      **Evidência:** `PublicJobsQueryBuilder.test.ts` (2 testes novos) e
      `PublicVacancyController.test.ts` (guarda de fronteira atualizada + 3 testes DE_BAJA).
- [x] 3.3 Purga de short links (Short.io) NÃO dispara para `DE_BAJA`.
      **Evidência:** `VacancyCrudController.ts:32` `INACTIVE_STATUSES = new Set(['CLOSED',
      'SUSPENDED'])` — `DE_BAJA` ausente; e o caminho da baja (`PatientContractedServiceRepository`)
      nem passa por `VacancyCrudController`, então o hook de purga nunca é invocado por esta change.

## 4. Página da vaga (link direto)

- [x] 4.1 `PublicVacancyController.getById` responde 200 com `is_disabled: true` para `DE_BAJA` (não
      404). **Termina quando:** teste unitário confirma 200 + `is_disabled` + badge reusado.
      **Evidência:** `PublicVacancyController.test.ts` describe "DE_BAJA — serviço contratado deu
      baixa na vaga ligada" (3 testes).
- [x] 4.2 `PublicVacancyPage.tsx` esconde "Postularse" e mostra mensagem de desativada; reusa
      `VacancyStatusBadge` (sem componente novo); chaves i18n `es`/`pt-BR`.
      **Evidência:** `PublicVacancyPage.deBaja.test.tsx` (4 testes) + `VacancyStatusBadge.test.tsx`
      (2 testes novos DE_BAJA) + `es.json`/`pt-BR.json` (`statusBadge.DE_BAJA`,
      `postularseDisabled`).

## 5. E2E de API

- [x] 5.1 `tests/e2e/baja-vacante-por-servico.e2e.test.ts`: FELIZ (baja → some do feed → detalhe 200
      com `is_disabled`), ISOLAMENTO (outro serviço intocado), FORA DE ESCOPO (vaga órfã intocada).
      **Termina quando:** arquivo criado no molde `activation.e2e.test.ts`/`public-jobs.test.ts`,
      `tsc --noEmit` limpo, descoberto por `jest --config jest.config.e2e.js --listTests`.
      **Evidência:** arquivo criado; `tsc --noEmit` exit 0; listado pelo jest e2e config (1 match
      exato do caminho). NÃO executado localmente — Docker proibido nesta execução (máquina sob
      pressão de memória); roda no CI.

## 6. Verificação

- [x] 6.1 `tsc --noEmit` limpo nos dois pacotes.
      **Evidência:** `worker-functions` exit 0; `enlite-frontend` exit 0.
- [x] 6.2 Suíte de unit do escopo tocado verde nos dois pacotes.
      **Evidência:** `worker-functions` — `src/modules/case src/modules/matching src/shared/openapi`
      → 271 suites / 4102 tests passed. `enlite-frontend` — páginas públicas + badge + consumidores
      do badge + domain/http → 142 suites / 1894 tests passed. `enumTranslationCoverage.test.ts` —
      48/48 passed (chaves `DE_BAJA` cobertas nos dois idiomas).

## 7. OpenSpec (nota)

- [x] 7.1 `openspec/` nunca existiu em `repos/infra` — `proposal.md`/`tasks.md` escritos à mão, no
      formato do repo orquestrador (`ebrain`), sem rodar `openspec init` (bootstraparia config de
      ferramentas de IA repo-inteiro, fora do escopo desta change). Nomeado no `proposal.md` para o
      Gabriel decidir se adota OpenSpec de verdade aqui.
