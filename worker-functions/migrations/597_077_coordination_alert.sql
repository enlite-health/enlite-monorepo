-- 597 — spec 077, emenda "presença sem furo" §5.3 (F6): o ALERTA À COORDENAÇÃO (turno sem saída 4 h depois do fim; entrada recusada sem
-- entrada aceita) e a sua entrega por destinatário/canal.
--
-- Um dono por conceito (modelar-dado):
--   · "alerta emitido para o turno" = coordination_alert. A UNIQUE (kind, occurrence_id) é a idempotência POR TURNO: a 2ª execução do
--     detector (Scheduler de 15 em 15 min) não duplica. NADA derivado é gravado: presença e fim do turno têm dono fora (attendance / itinerário).
--   · "o resultado da entrega a um destinatário num canal" = coordination_alert_delivery (PK alert/destinatário/canal). In-app é
--     REFERÊNCIA ao evento de notificação (`notification_event_id`), não cópia; e-mail guarda só o status e um código curto de erro.
-- Sem PII além do uid do destinatário (staff). `occurrence_id` é o uuid v5 do turno (só id).
--
-- Escrita só `app_system`; `app_runtime` só LÊ (molde 548: tabela de job, regra runtime-role-privilegios).
-- Idempotente (2×). ROLLBACK: migrations/pending/ROLLBACK_597_077_coordination_alert.sql

BEGIN;

INSERT INTO notification_types (code, description) VALUES
  ('PRESENCE_OPEN_4H', 'Aviso à coordenação: um turno segue sem saída registrada 4 h depois do fim previsto (só ids e horários)'),
  ('CHECK_IN_REFUSED_NO_ENTRY', 'Aviso à coordenação: a entrada num turno foi recusada e não há entrada aceita 60 min depois da 1ª recusa (só ids e horários)')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS coordination_alert (
  alert_id      UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          TEXT         NOT NULL CHECK (kind IN ('PRESENCE_OPEN_4H', 'CHECK_IN_REFUSED_NO_ENTRY')),
  occurrence_id UUID         NOT NULL,
  detected_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT coordination_alert_kind_occurrence_uq UNIQUE (kind, occurrence_id)
);

CREATE TABLE IF NOT EXISTS coordination_alert_delivery (
  alert_id              UUID         NOT NULL REFERENCES coordination_alert (alert_id),
  recipient_uid         VARCHAR(128) NOT NULL,
  channel               TEXT         NOT NULL CHECK (channel IN ('IN_APP', 'EMAIL')),
  status                TEXT         NOT NULL CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'FAILED', 'SKIPPED_TEST', 'SKIPPED_NO_KEY', 'NO_ADDRESS')),
  error_code            TEXT         NULL,
  notification_event_id UUID         NULL REFERENCES notification_events (id),
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (alert_id, recipient_uid, channel),
  CONSTRAINT coordination_alert_delivery_error_pair CHECK ((status = 'FAILED') = (error_code IS NOT NULL)),
  CONSTRAINT coordination_alert_delivery_in_app_event CHECK ((channel = 'IN_APP') = (notification_event_id IS NOT NULL))
);

REVOKE ALL ON coordination_alert FROM PUBLIC, app_runtime;
REVOKE ALL ON coordination_alert_delivery FROM PUBLIC, app_runtime;
GRANT SELECT, INSERT ON coordination_alert TO app_system;
GRANT SELECT, INSERT, UPDATE ON coordination_alert_delivery TO app_system;
GRANT SELECT ON coordination_alert TO app_runtime;
GRANT SELECT ON coordination_alert_delivery TO app_runtime;

COMMENT ON TABLE coordination_alert IS
  'O fato "a coordenação foi avisada deste turno por esta regra" (emenda 077 §5.3). UNIQUE (kind, occurrence_id) = idempotência por turno. Sem PII.';
COMMENT ON TABLE coordination_alert_delivery IS
  'A entrega do alerta a um destinatário num canal (IN_APP referencia o evento de notificação; EMAIL guarda status e código curto de erro). '
  'SENDING = reivindicado por UMA execução (molde 549). Sem PII além do uid.';

COMMIT;
