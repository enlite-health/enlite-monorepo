BEGIN;

CREATE TABLE IF NOT EXISTS notification_types (
  code text PRIMARY KEY,
  description text NOT NULL
);

INSERT INTO notification_types (code, description) VALUES
  ('CONVERSATION_MENTIONED', 'Alguém mencionou o destinatário numa mensagem de conversa de paciente'),
  ('CONVERSATION_REPLIED', 'Alguém respondeu numa thread de conversa de paciente da qual o destinatário participa')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS notification_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type_code text NOT NULL REFERENCES notification_types(code),
  actor_uid varchar(128) NOT NULL,
  patient_id uuid NULL REFERENCES patients(id) ON DELETE SET NULL,
  conversation_id uuid NULL REFERENCES conversations(id) ON DELETE SET NULL,
  message_id uuid NULL REFERENCES conversation_messages(id) ON DELETE SET NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN notification_events.payload IS
  'Metadado só-ids. PROIBIDO corpo de mensagem, nome de anexo ou qualquer texto livre do paciente.';

CREATE TABLE IF NOT EXISTS notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id uuid NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE,
  recipient_uid varchar(128) NOT NULL,
  seen_at timestamptz NULL,
  read_at timestamptz NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_notifications_recipient_unread ON notifications (recipient_uid, read_at);
CREATE INDEX IF NOT EXISTS idx_notifications_recipient_created ON notifications (recipient_uid, created_at DESC);

GRANT SELECT ON notification_types TO app_runtime, app_system;
GRANT SELECT, INSERT ON notification_events TO app_runtime, app_system;
GRANT SELECT, INSERT, UPDATE (seen_at, read_at) ON notifications TO app_runtime, app_system;

-- RLS: notification_events tem FK DIRETA e NULLABLE para `patients` — pega no invariante do
-- country-rls-policies.test.ts. Mesmo molde follow_patient (413/426); `patient_id IS NULL` cobre o
-- caso (hoje inexistente, mas o schema permite) de notificação sem paciente associado, que não tem
-- país a filtrar.
ALTER TABLE notification_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notification_events_follow_patient ON notification_events;
CREATE POLICY notification_events_follow_patient ON notification_events FOR ALL USING (
  (
    NULLIF(current_setting('app.system_context', true), '') IS NOT NULL
    AND pg_has_role(current_user, 'app_system', 'MEMBER')
  )
  OR notification_events.patient_id IS NULL
  OR EXISTS (SELECT 1 FROM patients p WHERE p.id = notification_events.patient_id)
);

-- RLS: `notifications` NÃO tem FK direta para `patients` (só para `notification_events`) — fora do
-- invariante do e2e, mas fecho da classe (achados.md, gate revisao-pr): destinatário/timestamp de
-- notificação é metadado ligado a paciente. Mesmo molde "follow the immediate parent" — o EXISTS
-- aponta para `notification_events` (tabela-pai imediata), cuja própria RLS já decide o país (por
-- `patient_id` OU `patient_id IS NULL`, acima). Sem esta policy, `SELECT * FROM notifications` direto
-- vazaria destinatário/timestamp de notificação cross-país para app_runtime.
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS notifications_follow_patient ON notifications;
CREATE POLICY notifications_follow_patient ON notifications FOR ALL USING (
  (
    NULLIF(current_setting('app.system_context', true), '') IS NOT NULL
    AND pg_has_role(current_user, 'app_system', 'MEMBER')
  )
  OR EXISTS (SELECT 1 FROM notification_events e WHERE e.id = notifications.event_id)
);

COMMIT;
