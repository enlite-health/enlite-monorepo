-- 483 — `DE_BAJA` em `job_postings.status` + `status_before_baja` (change
-- baja-vacante-por-servico)
--
-- Requisito do dono do produto: TODO serviço contratado dado de baixa (`patient_contracted_
-- services.active` → false) precisa dar baixa também na(s) vaga(s) ligada(s) a ele
-- (`job_postings.contracted_service_id`) — some do feed público (WordPress) e das listas do
-- prestador, mas a página da vaga (`/vacantes/:id`, link direto) continua servindo, mostrando
-- que está desativada. Escopo: só vaga com `contracted_service_id` — vaga órfã fica de fora
-- (decisão do dono, nomeada na proposta).
--
-- ── Por que um status NOVO, e não reusar CLOSED/SUSPENDED ────────────────────
-- `CLOSED`/`SUSPENDED` já carregam semântica própria (vaga encerrada / suspensão clínica) e
-- disparam a purga de short link (`VacancyCrudController.INACTIVE_STATUSES`) — o link direto
-- da vaga baixada PRECISA continuar vivo (é o único jeito de chegar na página depois de sumir
-- do feed). Reusar um dos dois quebraria essa exigência ou colidiria com um significado que já
-- existe. `DE_BAJA` é um estado próprio, fora de `INACTIVE_STATUSES` (confirmado por leitura —
-- não dispara purga) e fora de toda allow-list pública (`PublicJobsQueryBuilder`,
-- `STATUS_PUBLICAVEL`, `OPEN_JOB_STATUSES`, `ACTIVE_STATUSES` de
-- `FindNearbyVacanciesForWorkerUseCase`) — todas já são allow-list, então um status novo
-- desaparece delas sem precisar tocá-las.
--
-- ── `status_before_baja` ──────────────────────────────────────────────────────
-- Guarda o status que a vaga tinha ANTES de `DE_BAJA`, só para o caminho de reativação do
-- serviço (`patch active:false → true`) devolver a vaga ao estado exato em que estava — hoje
-- esse caminho é bloqueado no schema HTTP (`z.literal(false)`, lex C-a.4: "reabrir não existe"),
-- mas o gatilho em `PatientContractedServiceRepository.update` implementa os dois sentidos
-- (contrato pedido explicitamente) e é testado direto no repositório. Nasce NULL — só o
-- gatilho escreve.
--
-- Mesmo padrão da migration 166 (ADD ao CHECK existente): rename → drop → recria ampliado.
-- Puramente aditivo ao conjunto de valores permitidos — nenhuma linha existente viola o CHECK
-- novo, então nem precisa de NOT VALID (diferente da 475, que RESTRINGIA valores contra
-- histórico não-conforme; aqui é o oposto, e o padrão já em uso na 166 não usa NOT VALID).
--
-- Rollback: DROP COLUMN status_before_baja; recriar o CHECK sem 'DE_BAJA' (falha se alguma
-- linha estiver em DE_BAJA no momento — reverter para o status anterior antes, via
-- status_before_baja).

ALTER TABLE job_postings
  ADD COLUMN IF NOT EXISTS status_before_baja TEXT NULL;

COMMENT ON COLUMN job_postings.status_before_baja IS
  'Status da vaga imediatamente antes de virar DE_BAJA (change baja-vacante-por-servico) — só '
  'para restaurar na reativação do serviço contratado. NULL quando a vaga nunca esteve em '
  'DE_BAJA, ou depois de restaurada. Só o gatilho em PatientContractedServiceRepository.update '
  'escreve aqui.';

ALTER TABLE job_postings
  RENAME CONSTRAINT job_postings_status_check
  TO job_postings_status_check_deprecated_20260928;

ALTER TABLE job_postings
  DROP CONSTRAINT job_postings_status_check_deprecated_20260928;

ALTER TABLE job_postings ADD CONSTRAINT job_postings_status_check
  CHECK (status IN (
    'SEARCHING',
    'SEARCHING_REPLACEMENT',
    'RAPID_RESPONSE',
    'PENDING_ACTIVATION',
    'ACTIVE',
    'ON_HOLD',
    'SUSPENDED',
    'CLOSED',
    'DE_BAJA'
  ));

DO $$ BEGIN RAISE NOTICE 'Migration 483: DE_BAJA adicionado ao CHECK de job_postings.status + status_before_baja'; END $$;
