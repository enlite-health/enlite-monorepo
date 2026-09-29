-- 488 — quadro C (encuadre): `service_team_contact_log`, o registro de CONTATO com o prestador
-- por serviço contratado (aba "Encuadre" conforme Figma, rodada 2, decisão D do brief — modal do
-- prestador; 29/09/2026). Molde: `481_contracted_service_rejections.sql` (RLS/country/sem DELETE)
-- e `484_patient_itinerary_absence.sql` (trilha de autoria).
--
-- ── O que é ────────────────────────────────────────────────────────────────
-- Cada "Guardar" do modal do prestador cria uma linha NOVA (nunca UPDATE — é o histórico
-- "Historial: FECHA, NOTA, RESPUESTA" do Figma, uma linha por evento de contato). `contacted`
-- é a RESPUESTA (Sí/No); `note` é a NOTA (texto livre — Ley 25.326/LGPD: NUNCA vai para log,
-- ver `ServiceTeamContactUseCase.ts`); `event_date` é a FECHA. Não é a mesma tabela de
-- `contracted_service_rejections` (Rechazar/Revertir continuam gravando lá, D432 — este log
-- não decide coluna nenhuma do quadro C, é só o registro do CONTATO).
--
-- ── Por que não a tabela legada `encuadres` ───────────────────────────────────
-- `encuadres` é por CANDIDATURA (worker_job_applications), importada de planilha, sem escrita
-- admin exposta (medido na rodada 1 desta task). Este log é por SERVIÇO (patient_contracted_services),
-- igual ao resto do quadro C — mesma dualidade já documentada em 481.
--
-- ── Sem DELETE, país por trigger, RLS segue o serviço (molde 481) ────────────
-- Idempotente (2×). Sem BEGIN/COMMIT próprio (molde 481/484/480).
-- Rollback: migrations/pending/ROLLBACK_488_service_team_contact_log.sql (recusa se houver linha).

CREATE TABLE IF NOT EXISTS service_team_contact_log (
  id                UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  service_id        UUID         NOT NULL REFERENCES patient_contracted_services(id) ON DELETE CASCADE,
  worker_id         UUID         NOT NULL REFERENCES workers(id),
  contacted         BOOLEAN      NOT NULL,
  event_date        DATE         NOT NULL,
  -- Texto livre (Notas do Figma) — NUNCA sai em log/erro (regra do brief, aplicada no use case).
  note              TEXT         NULL,
  country           TEXT         NULL,  -- etapa 1: trigger abaixo preenche; etapa 2: NOT NULL; etapa 3: CHECK
  created_by        VARCHAR(128) NOT NULL,
  created_at        TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stcl_service_worker ON service_team_contact_log (service_id, worker_id, created_at DESC);

-- ── country: 3 etapas (molde 481/480) ────────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_stcl_country_from_service()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.country IS NULL THEN
    SELECT pcs.country INTO NEW.country FROM patient_contracted_services pcs WHERE pcs.id = NEW.service_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_stcl_country ON service_team_contact_log;
CREATE TRIGGER trg_stcl_country
  BEFORE INSERT ON service_team_contact_log
  FOR EACH ROW EXECUTE FUNCTION fn_stcl_country_from_service();

ALTER TABLE service_team_contact_log ALTER COLUMN country SET NOT NULL;

ALTER TABLE service_team_contact_log DROP CONSTRAINT IF EXISTS stcl_country_check;
ALTER TABLE service_team_contact_log
  ADD CONSTRAINT stcl_country_check CHECK (country IN ('AR', 'BR'));

-- ── RLS: segue o serviço (molde 481) ──────────────────────────────────────────
ALTER TABLE service_team_contact_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS service_team_contact_log_follow_service ON service_team_contact_log;
CREATE POLICY service_team_contact_log_follow_service ON service_team_contact_log FOR ALL USING (
  (
    NULLIF(current_setting('app.system_context', true), '') IS NOT NULL
    AND pg_has_role(current_user, 'app_system', 'MEMBER')
  )
  OR EXISTS (SELECT 1 FROM patient_contracted_services pcs WHERE pcs.id = service_team_contact_log.service_id)
);

-- ── GRANT/REVOKE — sem DELETE, sem UPDATE (append-only: cada "Guardar" é linha nova) ─────────
GRANT SELECT, INSERT ON service_team_contact_log TO app_runtime, app_system;
REVOKE DELETE, UPDATE ON service_team_contact_log FROM app_runtime, app_system;

COMMENT ON TABLE service_team_contact_log IS
  'Quadro C (encuadre): registro de contato com o prestador por serviço contratado — o Historial '
  '(FECHA/NOTA/RESPUESTA) do modal do prestador (Figma, rodada 2). Append-only: cada "Guardar" cria '
  'linha nova, nunca UPDATE. note é texto livre e nunca sai em log. Não decide coluna do quadro C '
  '(Rechazar/Revertir continuam em contracted_service_rejections, D432). Rollback: '
  'migrations/pending/ROLLBACK_488_service_team_contact_log.sql.';
COMMENT ON COLUMN service_team_contact_log.note IS
  'Texto livre (Notas) — NUNCA logar (nem logger.info/error, nem mensagem de erro). Ley 25.326/LGPD.';
COMMENT ON COLUMN service_team_contact_log.country IS
  'Herdado de patient_contracted_services.country por trigger (etapa 1/3). NOT NULL (etapa 2/3) + CHECK AR/BR (etapa 3/3).';
