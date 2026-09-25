-- ROLLBACK_473_patients_status_alta.sql — par de rollback da migration 473
-- (ALTA: valor novo de patients.status + linhas de transição "→ ALTA/DISCHARGED", D430/D432/D437).
--
-- QUANDO USAR: regressão detectada depois do deploy da 473 em prd — por exemplo, decisão de
-- reverter D430/D432/D437 antes de outro fix mais específico ficar pronto.
--
-- Por que mora em `migrations/pending/`, sem número: `scripts/run-migrations-docker.js` lista
-- `migrations/` com `fs.readdirSync` SEM recursão e aplica tudo `.sql` em ordem numérica — um
-- `474_rollback_*.sql` seria aplicado automaticamente na PRÓXIMA corrida do runner (e2e, boot do
-- Cloud Run, ou `run-migration-prod.sh` batendo em `migrations/` inteira), desfazendo a 473 sem
-- ninguém ter pedido. `migrations/pending/` é o único lugar que o runner ignora (ver
-- `migrations/pending/README.md`) — o arquivo fica escrito, revisado e versionado, mas só roda
-- quando alguém aponta o caminho explicitamente.
--
-- Como rodar (reversão manual e intencional, nunca automática):
--   ./scripts/run-migration-prod.sh worker-functions/migrations/pending/ROLLBACK_473_patients_status_alta.sql
--
-- TRAVA: só roda com 0 pacientes em ALTA — reverter o CHECK/catálogo com paciente já classificado
-- como ALTA deixaria a linha órfã (valor fora do CHECK novo) e quebraria qualquer leitura futura.
DO $$
BEGIN
  IF (SELECT count(*) FROM patients WHERE status = 'ALTA') > 0 THEN
    RAISE EXCEPTION 'ALTA em uso: rollback só da tela';
  END IF;
END $$;

DELETE FROM patient_status_transitions
 WHERE (from_status, to_status) IN (
   ('SOLICITANTE','ALTA'), ('ADMISSION','ALTA'), ('PENDING_ADMISSION','ALTA'),
   ('SEARCHING','ALTA'), ('REPLACEMENT','ALTA'), ('ACTIVE','ALTA'), ('ON_HOLD','ALTA'), ('SUSPENDED','ALTA'),
   ('SOLICITANTE','DISCHARGED'), ('ADMISSION','DISCHARGED'), ('PENDING_ADMISSION','DISCHARGED'),
   ('DISCHARGED','ALTA'), ('ALTA','DISCHARGED')
 );

ALTER TABLE patients DROP CONSTRAINT IF EXISTS patients_status_check;
ALTER TABLE patients
  ADD CONSTRAINT patients_status_check
  CHECK (status IS NULL OR status IN (
    -- v2 (estado clínico do serviço)
    'ACTIVE', 'ON_HOLD', 'SEARCHING', 'REPLACEMENT', 'SUSPENDED', 'DISCHARGED',
    -- funil de admissão (espelhado em admission_status pela 313)
    'SOLICITANTE', 'ADMISSION', 'PENDING_ADMISSION',
    -- legado, até o backfill (314); sai numa migration futura
    'DISCONTINUED'
  ));

COMMENT ON CONSTRAINT patients_status_check ON patients IS
  'PatientStatus v2 (migration 314): ACTIVE, ON_HOLD, SEARCHING, REPLACEMENT, SUSPENDED, DISCHARGED '
  '+ funil (SOLICITANTE, ADMISSION, PENDING_ADMISSION — ver admission_status, 313). DISCONTINUED '
  'é legado tolerado. Transições permitidas: patient_status_transitions (315). '
  'ROLLBACK 473: ALTA removida (catálogo e CHECK voltam ao texto exato da 314).';
