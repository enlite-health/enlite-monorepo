BEGIN;

-- ================================================================
-- CONTRACT da migration 261 — derruba as colunas fixas da 260
-- ================================================================
-- ⚠️ NÃO RODAR JUNTO COM A 261.
--
-- Esta é a segunda metade do expand/contract. A 261 criou `patient_chat_ids` e
-- fez o código passar a ler/escrever nela; as colunas abaixo ficaram no banco
-- SEM USO. Enquanto uma revisão anterior do `worker-functions` ainda servir
-- tráfego, ela vai continuar rodando o `SELECT family_chat_id, providers_chat_id`
-- do detalhe do paciente — caminho quente, para TODO paciente. Derrubar a coluna
-- antes disso é 500 em produção, não erro de teste.
--
-- PRÉ-REQUISITOS (conferir, não presumir):
--   1. a migration 261 aplicada em produção;
--   2. o deploy do `worker-functions` que a acompanha 100% do tráfego
--      (`gcloud run revisions list --service worker-functions`), estável;
--   3. `SELECT COUNT(*) FROM patient_chat_ids;` com o número esperado de
--      vínculos — se estiver zerado e o `patients.family_chat_id` não, PARE:
--      a migration de dados da 261 não rodou.
--
-- COMO LIBERAR: ver `migrations/pending/README.md` (mover para `migrations/`
-- com o próximo número livre da sequência).
--
-- REVERSÃO: `ALTER TABLE patients ADD COLUMN family_chat_id VARCHAR(64)` traz a
-- coluna de volta VAZIA. O dado vivo está em `patient_chat_ids` — repopular é
-- um INSERT ... SELECT invertido do bloco de dados da 261. Por isso o contract
-- só roda depois que ninguém mais lê as colunas.
-- ================================================================

-- Conferência dura: se ainda houver vínculo nas colunas antigas que NÃO está na
-- tabela nova, aborta. Melhor falhar aqui do que perder o dado calado.
DO $$
DECLARE
  orfaos INTEGER;
BEGIN
  SELECT COUNT(*) INTO orfaos
    FROM patients p
   WHERE p.deleted_at IS NULL
     AND (
       (p.family_chat_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM patient_chat_ids c
           WHERE c.patient_id = p.id AND c.chat_id = p.family_chat_id))
       OR
       (p.providers_chat_id IS NOT NULL AND NOT EXISTS (
          SELECT 1 FROM patient_chat_ids c
           WHERE c.patient_id = p.id AND c.chat_id = p.providers_chat_id))
     );

  IF orfaos > 0 THEN
    RAISE EXCEPTION
      'CONTRACT abortado: % paciente(s) com chat_id nas colunas antigas que não existe em patient_chat_ids. Rode a migration de dados da 261 antes.',
      orfaos;
  END IF;
END $$;

DROP INDEX IF EXISTS idx_patients_family_chat_id_unique;
DROP INDEX IF EXISTS idx_patients_providers_chat_id_unique;

ALTER TABLE patients DROP CONSTRAINT IF EXISTS patients_family_chat_id_is_group;
ALTER TABLE patients DROP CONSTRAINT IF EXISTS patients_providers_chat_id_is_group;
ALTER TABLE patients DROP CONSTRAINT IF EXISTS patients_chat_ids_distinct;

ALTER TABLE patients DROP COLUMN IF EXISTS family_chat_id;
ALTER TABLE patients DROP COLUMN IF EXISTS providers_chat_id;

COMMIT;
