-- 293: Convite à "reunión de presentación" (REQ-09 / REQ-20 da planning 26/08).
--
-- A reunião de apresentação é RECORRENTE e global por país ("eterna", um a um — Marcel, REQ-20):
-- link + rótulo do horário vivem numa config por país, não na vaga (meet_link_1..3 é da entrevista
-- de encuadre). O staff clica na tarjeta ou na lista de prestadores; o convite entra na
-- messaging_outbox com um template UTILITY escolhido pelo admin; a resposta cai na Luz pelo
-- espelho já existente. Tudo nasce DESLIGADO.
--
-- O template da Meta ainda não existe (29/08: 27 aprovados, nenhum de presentación). Fica um
-- placeholder INATIVO sem content_sid: o sync:twilio-templates liga quando aprovar.

CREATE TABLE IF NOT EXISTS presentation_invite_settings (
  country         CHAR(2)      NOT NULL PRIMARY KEY,
  template_slug   VARCHAR(100) REFERENCES message_templates(slug) ON DELETE SET NULL,
  meet_link       TEXT,
  schedule_label  VARCHAR(200),
  enabled         BOOLEAN      NOT NULL DEFAULT false,
  updated_by      VARCHAR(255),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS presentation_invite_settings_audit (
  id             BIGSERIAL PRIMARY KEY,
  country        CHAR(2)      NOT NULL,
  template_slug  VARCHAR(100),
  meet_link      TEXT,
  schedule_label VARCHAR(200),
  enabled        BOOLEAN      NOT NULL,
  actor_uid      VARCHAR(255),
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Trilha de cada clique: enfileirado OU pulado com motivo contável. Autoria = quem clicou.
-- attended_at fica NULL até existir fonte de presença (REQ-17 ainda é mailing manual, DEC-13).
CREATE TABLE IF NOT EXISTS presentation_invite_log (
  id             BIGSERIAL PRIMARY KEY,
  worker_id      UUID         REFERENCES workers(id) ON DELETE SET NULL,
  job_posting_id UUID         REFERENCES job_postings(id) ON DELETE SET NULL,
  actor_uid      VARCHAR(255) NOT NULL,
  source         VARCHAR(20)  NOT NULL CHECK (source IN ('kanban', 'workers_list')),
  template_slug  VARCHAR(100),
  outbox_id      UUID,
  status         VARCHAR(10)  NOT NULL CHECK (status IN ('queued', 'skipped')),
  skip_reason    VARCHAR(40)  CHECK (skip_reason IS NULL OR skip_reason IN (
                   'DISABLED_CONFIG', 'NO_TEMPLATE', 'TEMPLATE_INACTIVE', 'TEMPLATE_NOT_ALLOWED', 'NO_MEET_LINK',
                   'WORKER_NOT_FOUND', 'COUNTRY_BLOCKED', 'COUNTRY_MISMATCH', 'SIN_VINCULO', 'WORKER_DISABLED', 'OPT_OUT', 'ALREADY_INVITED')),
  country        CHAR(2)      NOT NULL,
  attended_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_presentation_invite_log_worker ON presentation_invite_log (worker_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_presentation_invite_log_created ON presentation_invite_log (created_at DESC);

-- Retenção: 180 d (mesma régua da trilha por etapa). NUNCA toca messaging_opt_out (lex C7 / D94).
CREATE OR REPLACE FUNCTION archive_old_presentation_invite_logs(retention_days INT DEFAULT 180)
RETURNS INT AS $$
DECLARE deleted INT;
BEGIN
  DELETE FROM presentation_invite_log WHERE created_at < NOW() - (retention_days || ' days')::INTERVAL;
  GET DIAGNOSTICS deleted = ROW_COUNT;
  RETURN deleted;
END;
$$ LANGUAGE plpgsql;

INSERT INTO presentation_invite_settings (country, enabled) VALUES ('AR', false)
ON CONFLICT (country) DO NOTHING;

-- Placeholder do template (INATIVO, sem content_sid): o OutboxProcessor recusa até a Meta aprovar.
INSERT INTO message_templates (slug, name, body, category, is_active, created_at, updated_at)
VALUES ('ar_presentacion_invite', 'Invitación a reunión de presentación (placeholder)',
        'Hola {{worker_name}}, te invitamos a la reunión de presentación de EnLite. {{schedule_label}} Link: {{meet_link}}. Si no querés recibir más mensajes, respondé BAJA.',
        'UTILITY', false, NOW(), NOW())
ON CONFLICT (slug) DO NOTHING;
