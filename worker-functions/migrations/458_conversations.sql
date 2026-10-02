BEGIN;

CREATE TABLE IF NOT EXISTS conversations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id uuid NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT conversations_patient_unique UNIQUE (patient_id)
);

COMMENT ON TABLE conversations IS
  'Spec 022: "canal" = o paciente sobre o qual se conversa. Um por paciente na v1 (arco exclusivo '
  'reservado: worker_id/vacancy_id entrariam como coluna nova + CHECK num_nonnulls, nunca tabela nova).';

GRANT SELECT, INSERT ON conversations TO app_runtime, app_system;

-- RLS de país: segue o paciente (mesmo molde de 413/426 — "linha visível se o paciente-pai for
-- visível", decisão de país mora em `patients`, policy da 411). Achado do gate revisao-pr (Bloco 1):
-- FK para patients sem RLS é exatamente o que o invariante do country-rls-policies.test.ts existe
-- para pegar (patient_conversation é dado de saúde, multi-país).
ALTER TABLE conversations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS conversations_follow_patient ON conversations;
CREATE POLICY conversations_follow_patient ON conversations FOR ALL USING (
  (
    NULLIF(current_setting('app.system_context', true), '') IS NOT NULL
    AND pg_has_role(current_user, 'app_system', 'MEMBER')
  )
  OR EXISTS (SELECT 1 FROM patients p WHERE p.id = conversations.patient_id)
);

COMMIT;
