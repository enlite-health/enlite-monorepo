# Proposal — Baja de serviço contratado desativa a vaga ligada

> Estado: **implementada, aguardando PR**. Aberta 28/09/2026, execução em
> `repos/_worktrees/baja-vacante-por-servico`, branch `feat/baja-vacante-quando-servico-de-baja`, base
> `origin/stage`. Requisito literal do dono do produto (ver task original).
>
> ⚠️ **Nota sobre este documento**: `openspec/` nunca existiu em `repos/infra` (confirmado:
> `git ls-tree -r --name-only origin/stage | grep -c '^openspec/'` = 0, sem commit tocando o caminho
> em todo o histórico). Rodar `openspec init` aqui bootstrapa configuração de ferramentas de IA
> repo-inteiro (`--tools amazon-q,cursor,claude,...`) — fora do escopo de uma migration+backend+
> frontend isolados. Este `proposal.md`/`tasks.md` foi escrito à mão, no MESMO formato usado pelo
> `openspec/changes/*` do repo orquestrador (`ebrain`), sem rodar `init`. Nomeado aqui para o Gabriel
> decidir se quer adotar OpenSpec de verdade neste repo — não é decisão desta change.

## Why

Requisito do dono do produto (literal): "TODOS os Serviços contratados que forem dado baja, PRECISAM
dar baixa também na vaga. Ou seja, ela não será mais disponibilizada via API para o WordPress e não vai
aparecer mais para os Prestadores. Só vai poder ser acessada a partir da PÁGINA DO PACIENTE clicando na
vaga do serviço contratado OU pelo Link diretamente e a página da vaga precisa mostrar que está
baixada, ou seja desativada."

Hoje `PATCH /api/admin/patients/:id/contracted-services/:sid { active: false }`
(`PatientContractedServiceRepository.update`) só grava `active=false` + `ended_at=NOW()` no serviço —
não toca `job_postings`. A vaga ligada (`job_postings.contracted_service_id`) continua com o status
antigo, então segue aparecendo no feed público (`GET /api/public/v1/jobs`, usado pelo WordPress) e nas
buscas do prestador, mesmo depois do serviço ter sido dado de baixa.

**Escopo**: só vaga com `contracted_service_id` preenchido. Vaga órfã (sem vínculo com nenhum serviço)
fica de fora por decisão do dono — ele já sabe delas e não quer que entrem neste trabalho.

## What Changes

- **Migration 483**: novo valor `DE_BAJA` no CHECK de `job_postings.status` (mesmo padrão aditivo da
  migration 166 — rename/drop/recria o CHECK ampliado) + coluna `status_before_baja TEXT NULL` (guarda
  o status anterior, só para a reativação restaurar).
- **Gatilho** (`PatientContractedServiceRepository.applyVacancyBajaGatilho`, chamado de dentro de
  `update`, MESMA transação do UPDATE do serviço): `active:false` → grava `status_before_baja =
  status` e `status = 'DE_BAJA'` em toda vaga viva (`contracted_service_id = :id AND deleted_at IS
  NULL`) que ainda não está `DE_BAJA`. `active:true` → restaura `status = COALESCE(status_before_baja,
  'SEARCHING')` e limpa `status_before_baja`, só nas vagas `DE_BAJA`. Hoje `active:true` é
  **inatingível via API** (o schema HTTP só aceita `false`, lex C-a.4: "reabrir não existe") — o
  repositório aceita as duas direções pela simetria pedida no contrato, testado direto no
  repositório (bypassa o schema, como os testes pré-existentes de `active:true` já faziam).
- **Some do WordPress e do prestador**: `DE_BAJA` fica fora, por construção, de toda allow-list
  pública já existente — `PublicJobsQueryBuilder.ACTIVE_STATUSES`, `PublicVacancyController.
  STATUS_PUBLICAVEL` (candidatável), `openJobStatuses.OPEN_JOB_STATUSES` e `FindNearbyVacanciesFor
  WorkerUseCase.ACTIVE_STATUSES` — as quatro já eram allow-list (nunca "tudo menos X"), então um
  status novo desaparece delas sem precisar editá-las.
- **Cinto de segurança**: `PublicJobsQueryBuilder` e `PublicVacancyController` ganham uma cláusula
  `NOT EXISTS (... patient_contracted_services pcs WHERE pcs.id = jp.contracted_service_id AND
  pcs.active = false)` — se o status da vaga divergir do serviço por algum motivo (sync atrasado,
  bug futuro), a vaga não vaza mesmo assim. No detalhe, essa exclusão é ignorada quando o status já é
  `DE_BAJA` (é exatamente o estado que a página passou a servir).
- **Página da vaga**: `PublicVacancyController.getById` passa a responder 200 (não 404) para
  `DE_BAJA`, com `is_disabled: true` no payload. `PublicVacancyPage.tsx` (frontend) esconde o botão
  "Postularse" e mostra mensagem de vaga desativada quando `is_disabled`. Reusa `VacancyStatusBadge`
  (ganhou entrada `DE_BAJA` no `STATUS_CONFIG` + chave i18n `es`/`pt-BR`) — nenhum componente novo.
- **Não muda**: fluxo de criação de vaga, vagas órfãs, ABAC, sync ClickUp,
  `computePatientCompleteness`. `VacancyStatusEditor` (dropdown admin de status manual) NÃO ganha
  `DE_BAJA` como opção — é estado derivado do serviço, não escolha manual do admin (mesmo raciocínio
  do backend: `adminVacancies.ts` documenta o valor no enum OpenAPI por completude, mas
  `VacancyCrudController.update` não valida contra ele, então nada muda ali na prática).

## Capabilities

### New Capabilities

- `vacante-de-baja-por-servico`: uma vaga ligada a um serviço contratado dado de baixa entra em
  estado `DE_BAJA` — invisível no feed público e nas listas do prestador, mas com a página de detalhe
  (link direto) servindo e mostrando "desativada", sem oferecer candidatura.

### Modified Capabilities

(nenhuma — o feed público e o detalhe continuam com o mesmo contrato para todo status pré-existente;
só ganham um valor novo tratado de forma consistente com o resto do allow-list)

## Impact

- **Afetados**: `worker-functions` (migration, `PatientContractedServiceRepository`,
  `PublicJobsQueryBuilder`, `PublicVacancyController`, `adminVacancies.ts` openapi), `enlite-frontend`
  (`VacancyStatusBadge`, `PublicVacancyPage`, `Vacancy.ts`, i18n `es`/`pt-BR`).
- **Riscos**: nomeados no corpo do PR (vagas órfãs fora do escopo por decisão do dono; a perna `main`
  precisará do par — `stage`→`main` é fluxo separado deste PR).
- **Não afetados**: schema de criação de vaga, ABAC, sync ClickUp, `computePatientCompleteness`,
  purga de short links (confirmado por leitura: `VacancyCrudController.INACTIVE_STATUSES =
  {'CLOSED','SUSPENDED'}` não inclui `DE_BAJA`, e o caminho da baja nem passa por aquele controller).
