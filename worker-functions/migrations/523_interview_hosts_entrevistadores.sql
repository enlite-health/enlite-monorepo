-- 523 — Tela "Entrevistadores" (spec 055): quem atende enquadre e admissão passa a ser configurado pela tela, amarrado a um usuário staff.
--
--   interview_hosts ganha: user_uid (FK users.firebase_uid), does_enquadre / does_admission (fluxos), countries (TEXT[], ≥1, ⊆ {AR,BR}),
--   updated_at / updated_by. A coluna `country` CONTINUA (NOT NULL; sai numa migration posterior, depois que nenhum código a ler): a tela grava
--   country = countries[1] para o que ainda a lê (Tactiq, relatório Chrome).
--
-- Backfill (= comportamento de hoje, ninguém some no deploy do lado dos fluxos):
--   - countries = ARRAY[country]; os dois fluxos true (DEFAULT);
--   - user_uid por lower(email) SÓ quando casa com EXATAMENTE 1 usuário staff ativo. Quem não casa (Ana Joulie, medida em prd em 16/10:
--     0 usuários com esse e-mail) fica com user_uid NULL: a linha NÃO é apagada, mas a leitura de agendamento faz JOIN em users e ela
--     sai do roster até a operação criar o usuário em Usuarios e adicioná-la na tela.
--
-- Também: células interview_host:read e interview_host:update, concedidas SÓ ao Acesso Master (molde 519/522: placeholder ANTES do grant,
-- o sync do catálogo no boot sobrescreve a descrição sem trocar o id; nunca remove grant, nunca cria/move/reativa grupo).
--
-- Idempotente (2×). ROLLBACK: migrations/pending/ROLLBACK_523_interview_hosts_entrevistadores.sql

BEGIN;

ALTER TABLE interview_hosts
  ADD COLUMN IF NOT EXISTS user_uid       TEXT REFERENCES users(firebase_uid),
  ADD COLUMN IF NOT EXISTS does_enquadre  BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS does_admission BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS countries      TEXT[],
  ADD COLUMN IF NOT EXISTS updated_at     TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS updated_by     TEXT;

UPDATE interview_hosts SET countries = ARRAY[country] WHERE countries IS NULL;

UPDATE interview_hosts h
   SET user_uid = u.firebase_uid
  FROM users u
 WHERE h.user_uid IS NULL
   AND lower(u.email) = lower(h.email)
   AND u.account_type = 'staff'
   AND u.is_active = true
   AND (SELECT count(*) FROM users u2
         WHERE lower(u2.email) = lower(h.email) AND u2.account_type = 'staff' AND u2.is_active = true) = 1;

ALTER TABLE interview_hosts ALTER COLUMN countries SET NOT NULL;

ALTER TABLE interview_hosts DROP CONSTRAINT IF EXISTS interview_hosts_countries_check;
ALTER TABLE interview_hosts
  ADD CONSTRAINT interview_hosts_countries_check
  CHECK (cardinality(countries) >= 1 AND countries <@ ARRAY['AR','BR']::text[]);

-- Uma pessoa = uma linha (UNIQUE(email) já existe; este garante o mesmo para o usuário).
CREATE UNIQUE INDEX IF NOT EXISTS uq_interview_hosts_user_uid ON interview_hosts (user_uid) WHERE user_uid IS NOT NULL;

COMMENT ON COLUMN interview_hosts.countries IS 'Países que a pessoa atende (⊆ {AR,BR}, ≥1). Substitui `country` na leitura. Migration 523.';
COMMENT ON COLUMN interview_hosts.user_uid IS 'Usuário staff dono da linha (users.firebase_uid). NULL = sem usuário: fora do roster de agendamento. Migration 523.';

DO $$
DECLARE
  v_master_id CONSTANT UUID := 'a0000000-0000-0000-0000-000000000001';
  v_n INT;
BEGIN
  IF to_regclass('iam.permissions') IS NOT NULL THEN
    INSERT INTO iam.permissions (resource, action, description, category, owner_service, deprecated_at)
    VALUES
      ('interview_host', 'read',
       '[523 placeholder — sincronizado no boot] Ver a tela Entrevistadores (quem atende enquadre e admissão).',
       'Administração', 'worker-functions', NULL),
      ('interview_host', 'update',
       '[523 placeholder — sincronizado no boot] Agregar, editar e quitar entrevistadores de enquadre e admissão.',
       'Administração', 'worker-functions', NULL)
    ON CONFLICT (resource, action) DO NOTHING;
  END IF;

  IF to_regclass('iam.permission_groups') IS NOT NULL AND to_regclass('iam.group_permissions') IS NOT NULL THEN
    INSERT INTO iam.group_permissions (group_id, permission_id)
    SELECT v_master_id, p.id
      FROM iam.permissions p
     WHERE p.resource = 'interview_host' AND p.action IN ('read', 'update')
       AND p.deprecated_at IS NULL
       AND EXISTS (SELECT 1 FROM iam.permission_groups g WHERE g.id = v_master_id)
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_n = ROW_COUNT;
    RAISE NOTICE '[523] grant ao Acesso Master: % célula(s) de interview_host (spec 055)', v_n;
  END IF;
END
$$;

COMMIT;
