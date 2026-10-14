-- 518 — Evento de enquadre (spec 052, Fase 2): `enquadre_events` + `enquadre_event_participants`.
--
-- O QUE É: o evento de enquadre é UMA reunião (Meet) de uma entrevistadora com N prestadores de UMA vaga. A participação liga
-- prestador × vaga ao evento. O RESULTADO do prestador NÃO mora aqui: continua em `application_funnel_stage` (uma dona só);
-- `outcome` na participação é só o carimbo do que foi marcado no encerramento. As colunas de acompanhamento da call
-- (`meet_space_name`, `conference_ended_at`, `import_status`, `import_attempts`) têm os MESMOS nomes e valores da admissão (503)
-- e só a Fase 3 escreve nelas.
--
-- A TRAVA: no máximo UM evento aberto por prestador × vaga = índice único parcial `WHERE released_at IS NULL` (molde 510 e 502).
-- Participação que saiu (encerrada, cancelada ou removida) tem `released_at` + `release_kind` e deixa de ocupar a trava.
-- "Vazio" tem um só significado em cada coluna: `released_at` NULL = ativa; `outcome` NULL = ainda sem resultado.
--
-- POR QUE SEM RLS: molde 510/476 — filhas de `job_postings`, que não tem RLS (271:36, 413:12). SEM FK para `patients`
-- (a régua country-rls-policies exigiria RLS). `country` vem de `job_postings.country` (011:21,48; CHAR(2) 'AR'|'BR') por
-- trigger BEFORE INSERT, no molde da 502 (`fn_ptcrc_country_from_patient`), para o país nunca depender do chamador.
-- GRANT explícito por tabela, sem tocar nos privilégios padrão do schema; o default do banco (269:66-69) concede também DELETE: REVOGADO abaixo
-- (cancelar e tirar convocado são UPDATE de carimbo; só a cascata da vaga apaga).
--
-- Sem BEGIN/COMMIT próprio (o runner envolve cada arquivo). Idempotente (2×).
-- ROLLBACK: migrations/pending/ROLLBACK_518_enquadre_events.sql

CREATE TABLE IF NOT EXISTS enquadre_events (
  id                   UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  job_posting_id       UUID         NOT NULL REFERENCES job_postings(id) ON DELETE CASCADE,
  country              TEXT         NOT NULL,
  host_email           TEXT         NOT NULL,
  host_display_name    TEXT         NOT NULL,
  starts_at            TIMESTAMPTZ  NOT NULL,
  ends_at              TIMESTAMPTZ  NOT NULL,
  event_code           TEXT         NOT NULL,
  calendar_event_id    TEXT         NULL,
  meet_link            TEXT         NULL,
  status               TEXT         NOT NULL DEFAULT 'open',
  created_by_uid       VARCHAR(128) NOT NULL,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT now(),
  closed_by_uid        VARCHAR(128) NULL,
  closed_at            TIMESTAMPTZ  NULL,
  cancelled_by_uid     VARCHAR(128) NULL,
  cancelled_at         TIMESTAMPTZ  NULL,
  meet_space_name      TEXT         NULL,
  conference_ended_at  TIMESTAMPTZ  NULL,
  import_status        TEXT         NULL,
  import_attempts      SMALLINT     NOT NULL DEFAULT 0,
  CONSTRAINT enquadre_events_country_check     CHECK (country IN ('AR', 'BR')),
  CONSTRAINT enquadre_events_code_format       CHECK (event_code ~ '^ENC-[0-9A-Z]{6}$'),
  CONSTRAINT enquadre_events_window_check      CHECK (ends_at > starts_at),
  CONSTRAINT enquadre_events_status_check      CHECK (status IN ('open', 'closed', 'cancelled')),
  CONSTRAINT enquadre_events_closed_pair       CHECK ((status = 'closed') = (closed_at IS NOT NULL)
                                                      AND (closed_at IS NULL) = (closed_by_uid IS NULL)),
  CONSTRAINT enquadre_events_cancelled_pair    CHECK ((status = 'cancelled') = (cancelled_at IS NOT NULL)
                                                      AND (cancelled_at IS NULL) = (cancelled_by_uid IS NULL)),
  CONSTRAINT enquadre_events_import_status_check CHECK (import_status IS NULL OR import_status IN
    ('pending', 'waiting', 'done', 'rejected', 'ambiguous', 'expired', 'blocked', 'no_show')),
  -- alvo da FK composta da participação: garante que a participação e o evento são da MESMA vaga
  CONSTRAINT uq_enquadre_events_id_posting     UNIQUE (id, job_posting_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_enquadre_events_code ON enquadre_events (event_code);
CREATE INDEX IF NOT EXISTS idx_enquadre_events_posting_starts ON enquadre_events (job_posting_id, starts_at DESC);

CREATE OR REPLACE FUNCTION fn_enquadre_events_country_from_posting()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.country IS NULL THEN
    SELECT jp.country INTO NEW.country FROM job_postings jp WHERE jp.id = NEW.job_posting_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_enquadre_events_country ON enquadre_events;
CREATE TRIGGER trg_enquadre_events_country
  BEFORE INSERT ON enquadre_events
  FOR EACH ROW EXECUTE FUNCTION fn_enquadre_events_country_from_posting();

CREATE TABLE IF NOT EXISTS enquadre_event_participants (
  id               UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  event_id         UUID         NOT NULL,
  job_posting_id   UUID         NOT NULL,
  worker_id        UUID         NOT NULL REFERENCES workers(id),
  added_by_uid     VARCHAR(128) NOT NULL,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  released_at      TIMESTAMPTZ  NULL,
  release_kind     TEXT         NULL,
  outcome          TEXT         NULL,
  CONSTRAINT enquadre_participants_event_fk
    FOREIGN KEY (event_id, job_posting_id) REFERENCES enquadre_events (id, job_posting_id) ON DELETE CASCADE,
  CONSTRAINT enquadre_participants_release_kind_check CHECK (release_kind IS NULL OR release_kind IN ('closed', 'cancelled', 'removed')),
  CONSTRAINT enquadre_participants_outcome_check      CHECK (outcome IS NULL OR outcome IN ('selected', 'quick_response', 'rejected', 'returned')),
  CONSTRAINT enquadre_participants_release_pair       CHECK ((released_at IS NULL) = (release_kind IS NULL)),
  CONSTRAINT enquadre_participants_outcome_closed     CHECK ((outcome IS NOT NULL) = (release_kind = 'closed'))
);

-- A TRAVA: um evento aberto por prestador × vaga.
CREATE UNIQUE INDEX IF NOT EXISTS uq_enquadre_participant_um_aberto
  ON enquadre_event_participants (job_posting_id, worker_id)
  WHERE released_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_enquadre_participants_event ON enquadre_event_participants (event_id);

GRANT SELECT, INSERT, UPDATE ON enquadre_events TO app_runtime, app_system;
REVOKE DELETE ON enquadre_events FROM app_runtime, app_system;
GRANT SELECT, INSERT, UPDATE ON enquadre_event_participants TO app_runtime, app_system;
REVOKE DELETE ON enquadre_event_participants FROM app_runtime, app_system;

COMMENT ON TABLE enquadre_events IS
  'Evento de enquadre (spec 052): uma reunião de uma entrevistadora com N prestadores de uma vaga. O resultado do prestador mora em application_funnel_stage, não aqui.';
COMMENT ON COLUMN enquadre_events.event_code IS
  'Código ENC-XXXXXX que vai no título do evento do Calendar e liga a reunião à transcrição (molde ADM- da 503).';
COMMENT ON COLUMN enquadre_events.status IS
  'open | closed | cancelled. closed e cancelled exigem o carimbo (at + by_uid) do respectivo fecho.';
COMMENT ON COLUMN enquadre_events.import_status IS
  'Estado da importação do Tactiq (mesmos 8 valores da 503). Só a Fase 3 escreve. NULL = ainda fora da importação.';
COMMENT ON COLUMN enquadre_event_participants.released_at IS
  'NULL = participação ATIVA (ocupa a trava de um evento aberto por prestador × vaga). Preenchido = saiu; release_kind diz por quê.';
COMMENT ON COLUMN enquadre_event_participants.release_kind IS
  'closed (evento encerrado) | cancelled (evento cancelado) | removed (tirado do evento aberto). NULL ⇔ released_at NULL.';
COMMENT ON COLUMN enquadre_event_participants.outcome IS
  'Carimbo do que foi marcado no encerramento: selected | quick_response | rejected | returned. Só existe em release_kind = closed. O estágio vigente continua em application_funnel_stage.';
