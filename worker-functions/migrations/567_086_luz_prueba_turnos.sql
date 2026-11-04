-- 567 — spec 086 (DF-11): contador de turnos da Luz (prueba) por pessoa e por dia (teto 60/dia, 080 §6.9)
--
-- `agentes.luz_prueba_turnos (uid, dia, turnos)`: UMA linha por pessoa/dia, incrementada por UPSERT atômico no worker-functions
-- (`INSERT … ON CONFLICT DO UPDATE … WHERE turnos < teto`). Só id de pessoa, data e contagem: NENHUM texto de conversa (D514).
-- `dia` é a data de Buenos Aires (o mesmo fuso das semanas de `agentes.*`). Schema `agentes` (D620): nada novo em `public`.
--
-- Diferente das tabelas INSERT-only da 551, esta precisa de UPDATE (o contador sobe e, quando o triage cai, desce 1): grants
-- SELECT/INSERT/UPDATE às roles do app, sem DELETE. RLS no molde da 551 (sistema passa; staff com `app.user_uid` passa).
-- Idempotente (2x). Sem BEGIN/COMMIT próprio (o runner envolve).
-- Rollback: `migrations/pending/ROLLBACK_567_086_luz_prueba_turnos.sql`.

CREATE SCHEMA IF NOT EXISTS agentes;

CREATE TABLE IF NOT EXISTS agentes.luz_prueba_turnos (
  uid    text    NOT NULL CHECK (char_length(uid) BETWEEN 1 AND 128),
  dia    date    NOT NULL,
  turnos integer NOT NULL CHECK (turnos >= 0),
  PRIMARY KEY (uid, dia)
);

COMMENT ON TABLE agentes.luz_prueba_turnos IS
  'Spec 086: turnos da Luz (prueba) por pessoa e dia (BA). Só contagem; sem texto de conversa.';

ALTER TABLE agentes.luz_prueba_turnos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS luz_prueba_turnos_sistema_ou_staff ON agentes.luz_prueba_turnos;
CREATE POLICY luz_prueba_turnos_sistema_ou_staff ON agentes.luz_prueba_turnos FOR ALL USING (
  (NULLIF(current_setting('app.system_context', true), '') IS NOT NULL
   AND pg_has_role(current_user, 'app_system', 'MEMBER'))
  OR NULLIF(current_setting('app.user_uid', true), '') IS NOT NULL
);

DO $$
DECLARE r text;
BEGIN
  -- Mesma lista da 551: app_runtime/app_system (269), enlite_app (prd, DB_USER e dono), enlite_runtime/enlite_system (stg e prd pós-virada).
  FOREACH r IN ARRAY ARRAY['app_runtime','app_system','enlite_app','enlite_runtime','enlite_system'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r) THEN
      EXECUTE format('GRANT USAGE ON SCHEMA agentes TO %I', r);
      EXECUTE format('GRANT SELECT, INSERT, UPDATE ON agentes.luz_prueba_turnos TO %I', r);
      EXECUTE format('REVOKE DELETE, TRUNCATE, REFERENCES, TRIGGER ON agentes.luz_prueba_turnos FROM %I', r);
    END IF;
  END LOOP;
END $$;
