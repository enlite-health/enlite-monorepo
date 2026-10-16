-- ROLLBACK_523_interview_hosts_entrevistadores.sql — par de rollback da migration 523 (spec 055).
-- Mora em `migrations/pending/`; só roda quando alguém aponta o caminho. Tira as células (e os grants, inclusive os dados depois pela
-- operação) e as colunas novas. `country` nunca saiu, então a leitura antiga volta a funcionar. ATENÇÃO: perde-se quem foi marcado
-- só-enquadre / só-admissão e o segundo país de quem atende os dois.
BEGIN;
DELETE FROM iam.group_permissions
 WHERE permission_id IN (SELECT id FROM iam.permissions WHERE resource = 'interview_host' AND action IN ('read', 'update'));
DELETE FROM iam.permissions WHERE resource = 'interview_host' AND action IN ('read', 'update');
DROP INDEX IF EXISTS uq_interview_hosts_user_uid;
ALTER TABLE interview_hosts DROP CONSTRAINT IF EXISTS interview_hosts_countries_check;
ALTER TABLE interview_hosts
  DROP COLUMN IF EXISTS updated_by,
  DROP COLUMN IF EXISTS updated_at,
  DROP COLUMN IF EXISTS countries,
  DROP COLUMN IF EXISTS does_admission,
  DROP COLUMN IF EXISTS does_enquadre,
  DROP COLUMN IF EXISTS user_uid;
COMMIT;
