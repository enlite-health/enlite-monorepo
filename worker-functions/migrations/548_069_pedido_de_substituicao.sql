-- 548 — spec 069: o PEDIDO de substituição (cabeçalho), o vínculo ausência/registro → pedido, a montagem única do
-- conflito do substituto (gatilho e pré-visão) e as tabelas da rotina diária (execução e alerta).
--
-- Um dono por conceito (modelar-dado):
--   · "pedido" = patient_itinerary_substitution_request. Tipo, período, nº de turnos, quem entra e "Sin cubrir" são
--     DERIVADOS (nunca colunas). "Desfeito" tem UM dono: undone_at/undone_by do cabeçalho (o desfazer não grava linha no registro).
--   · motivo e pessoa que sai moram no cabeçalho; o registro de trocas (494) os repete só por FK COMPOSTA — o banco recusa divergência.
--   · a montagem dos argumentos do conflito mora em itinerary_slot_worker_conflict (UMA vez), chamada pelo gatilho da
--     ausência e pela pré-visão (sem 2ª montagem que possa divergir).
--
-- Idempotente (2×): IF NOT EXISTS / DROP … IF EXISTS / CREATE OR REPLACE. Sem BEGIN/COMMIT próprio (molde 484/494).
-- Rollback: migrations/pending/ROLLBACK_548_069_pedido_de_substituicao.sql (recusa se houver pedido gravado).
-- Aplicação em prd: só pelo boot do deploy da main (o runner registra em schema_migrations).

-- ── 2.1 patient_itinerary_substitution_request (o cabeçalho do pedido) ────────────────────────────────
CREATE TABLE IF NOT EXISTS patient_itinerary_substitution_request (
  id                    UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  contracted_service_id UUID         NOT NULL REFERENCES patient_contracted_services(id) ON DELETE CASCADE,
  outgoing_worker_id    UUID         NOT NULL REFERENCES workers(id),
  reason_code           TEXT         NOT NULL REFERENCES service_exit_reasons(code),
  country               TEXT         NULL,  -- etapa 1: trigger do serviço; etapa 2: NOT NULL; etapa 3: CHECK AR/BR
  created_by            VARCHAR(128) NOT NULL,
  created_at            TIMESTAMPTZ  NOT NULL DEFAULT now(),
  undone_at             TIMESTAMPTZ  NULL,
  undone_by             VARCHAR(128) NULL,
  CONSTRAINT pisr_undo_pair CHECK ((undone_at IS NULL) = (undone_by IS NULL)),
  -- alvo da FK composta do registro de trocas (motivo e pessoa do log = os do cabeçalho, por construção)
  CONSTRAINT uq_pisr_key UNIQUE (id, contracted_service_id, reason_code, outgoing_worker_id)
);

CREATE INDEX IF NOT EXISTS idx_pisr_service ON patient_itinerary_substitution_request (contracted_service_id, created_at DESC);

-- country: 3 etapas (molde 494)
CREATE OR REPLACE FUNCTION fn_pisr_country_from_service()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.country IS NULL THEN
    SELECT pcs.country INTO NEW.country FROM patient_contracted_services pcs WHERE pcs.id = NEW.contracted_service_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_pisr_0_country ON patient_itinerary_substitution_request;
CREATE TRIGGER trg_pisr_0_country
  BEFORE INSERT ON patient_itinerary_substitution_request
  FOR EACH ROW EXECUTE FUNCTION fn_pisr_country_from_service();

ALTER TABLE patient_itinerary_substitution_request ALTER COLUMN country SET NOT NULL;
ALTER TABLE patient_itinerary_substitution_request DROP CONSTRAINT IF EXISTS pisr_country_check;
ALTER TABLE patient_itinerary_substitution_request
  ADD CONSTRAINT pisr_country_check CHECK (country IN ('AR', 'BR'));

-- só undone_at/undone_by podem mudar, e só de NULL para valor (molde fn_ptcr_carimbo_unico, 502)
CREATE OR REPLACE FUNCTION fn_pisr_imutavel()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.contracted_service_id IS DISTINCT FROM OLD.contracted_service_id
     OR NEW.outgoing_worker_id IS DISTINCT FROM OLD.outgoing_worker_id
     OR NEW.reason_code IS DISTINCT FROM OLD.reason_code
     OR NEW.country IS DISTINCT FROM OLD.country
     OR NEW.created_by IS DISTINCT FROM OLD.created_by
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'pisr_imutavel: o cabeçalho do pedido só aceita undone_at/undone_by' USING ERRCODE = '55000';
  END IF;
  IF OLD.undone_at IS NOT NULL
     AND (NEW.undone_at IS DISTINCT FROM OLD.undone_at OR NEW.undone_by IS DISTINCT FROM OLD.undone_by) THEN
    RAISE EXCEPTION 'pisr_desfeito_nao_reabre: pedido desfeito não se reabre nem se reescreve' USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_pisr_1_imutavel ON patient_itinerary_substitution_request;
CREATE TRIGGER trg_pisr_1_imutavel
  BEFORE UPDATE ON patient_itinerary_substitution_request
  FOR EACH ROW EXECUTE FUNCTION fn_pisr_imutavel();

-- desfazer: recusa se ainda houver ausência viva do pedido de hoje em diante (dia de operação do país, 541).
-- DEFINER: o gatilho tem de ver as ausências do pedido sem depender da RLS de quem chama.
CREATE OR REPLACE FUNCTION fn_pisr_desfazer()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
BEGIN
  IF NEW.undone_at IS NOT NULL AND OLD.undone_at IS NULL THEN
    IF EXISTS (
      SELECT 1 FROM patient_itinerary_absence ab
       WHERE ab.request_id = NEW.id
         AND ab.cancelled_at IS NULL
         AND ab.on_date >= fn_operation_date(NEW.country)
    ) THEN
      RAISE EXCEPTION 'pisr_desfazer_com_turno_aberto' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION fn_pisr_desfazer() FROM PUBLIC;

-- (a função referencia patient_itinerary_absence.request_id, criada em 2.2; o gatilho só é anexado depois dela)

ALTER TABLE patient_itinerary_substitution_request ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS patient_itinerary_substitution_request_follow_service ON patient_itinerary_substitution_request;
CREATE POLICY patient_itinerary_substitution_request_follow_service ON patient_itinerary_substitution_request FOR ALL USING (
  (
    NULLIF(current_setting('app.system_context', true), '') IS NOT NULL
    AND pg_has_role(current_user, 'app_system', 'MEMBER')
  )
  OR EXISTS (SELECT 1 FROM patient_contracted_services pcs WHERE pcs.id = patient_itinerary_substitution_request.contracted_service_id)
);

GRANT SELECT, INSERT, UPDATE ON patient_itinerary_substitution_request TO app_runtime, app_system;
REVOKE DELETE ON patient_itinerary_substitution_request FROM app_runtime, app_system;

COMMENT ON TABLE patient_itinerary_substitution_request IS
  'Pedido de substituição (spec 069): agrupador das ausências/trocas de um mesmo pedido do operador. Tipo, período, nº de turnos, '
  'quem entra e "Sin cubrir" são DERIVADOS, nunca colunas. Sem texto livre. Rollback: migrations/pending/ROLLBACK_548_069_pedido_de_substituicao.sql.';
COMMENT ON COLUMN patient_itinerary_substitution_request.undone_at IS
  'NULL = pedido vigente (não desfeito pelo operador). Único sentido; único dono de "desfeito" (cancelled_at da ausência não conta).';
COMMENT ON COLUMN patient_itinerary_substitution_request.country IS
  'Herdado de patient_contracted_services.country por trigger (etapa 1/3). NOT NULL (etapa 2/3) + CHECK AR/BR (etapa 3/3).';

-- ── 2.2 patient_itinerary_absence.request_id ─────────────────────────────────────────────────────────
ALTER TABLE patient_itinerary_absence ADD COLUMN IF NOT EXISTS request_id UUID NULL
  REFERENCES patient_itinerary_substitution_request(id);
CREATE INDEX IF NOT EXISTS idx_piab_request ON patient_itinerary_absence (request_id) WHERE request_id IS NOT NULL;

DROP TRIGGER IF EXISTS trg_pisr_2_desfazer ON patient_itinerary_substitution_request;
CREATE TRIGGER trg_pisr_2_desfazer
  BEFORE UPDATE OF undone_at ON patient_itinerary_substitution_request
  FOR EACH ROW EXECUTE FUNCTION fn_pisr_desfazer();

-- INSERT exige pedido (P3) existente, não desfeito, do MESMO serviço e do MESMO titular da alocação; UPDATE não muda o pedido.
-- Não altera a função da 484: gatilho NOVO. O "gate parcial" do cancelamento (484) segue valendo (request_id não muda).
CREATE OR REPLACE FUNCTION fn_patient_itinerary_absence_request()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  v_service_id UUID; v_worker_id UUID;
  r_service_id UUID; r_worker_id UUID; r_undone TIMESTAMPTZ;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW.request_id IS DISTINCT FROM OLD.request_id THEN
      RAISE EXCEPTION 'piab_request_imutavel' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.request_id IS NULL THEN
    RAISE EXCEPTION 'piab_request_obrigatorio' USING ERRCODE = '23514';
  END IF;

  SELECT r.contracted_service_id, r.outgoing_worker_id, r.undone_at
    INTO r_service_id, r_worker_id, r_undone
    FROM patient_itinerary_substitution_request r WHERE r.id = NEW.request_id;
  IF NOT FOUND THEN RETURN NEW; END IF; -- deixa a FK de request_id decidir (23503)
  IF r_undone IS NOT NULL THEN
    RAISE EXCEPTION 'piab_pedido_desfeito' USING ERRCODE = '23514';
  END IF;

  SELECT s.contracted_service_id, a.worker_id INTO v_service_id, v_worker_id
    FROM patient_itinerary_assignment a JOIN patient_itinerary_slot s ON s.id = a.slot_id
   WHERE a.id = NEW.assignment_id;
  IF NOT FOUND THEN RETURN NEW; END IF; -- deixa a FK de assignment_id decidir

  IF v_service_id IS DISTINCT FROM r_service_id THEN
    RAISE EXCEPTION 'piab_pedido_de_outro_servico' USING ERRCODE = '23514';
  END IF;
  IF v_worker_id IS DISTINCT FROM r_worker_id THEN
    RAISE EXCEPTION 'piab_pedido_de_outro_titular' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION fn_patient_itinerary_absence_request() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_patient_itinerary_absence_4_request ON patient_itinerary_absence;
CREATE TRIGGER trg_patient_itinerary_absence_4_request
  BEFORE INSERT OR UPDATE ON patient_itinerary_absence
  FOR EACH ROW EXECUTE FUNCTION fn_patient_itinerary_absence_request();

COMMENT ON COLUMN patient_itinerary_absence.request_id IS
  'NULL = ausência gravada antes da migration 548 (sem pedido). Desde a 548 o INSERT exige pedido (trg_patient_itinerary_absence_4_request).';

-- ── 2.3 patient_itinerary_change_log.request_id ──────────────────────────────────────────────────────
ALTER TABLE patient_itinerary_change_log ADD COLUMN IF NOT EXISTS request_id UUID NULL;

ALTER TABLE patient_itinerary_change_log DROP CONSTRAINT IF EXISTS picl_request_fk;
ALTER TABLE patient_itinerary_change_log ADD CONSTRAINT picl_request_fk
  FOREIGN KEY (request_id, contracted_service_id, reason_code, outgoing_worker_id)
  REFERENCES patient_itinerary_substitution_request (id, contracted_service_id, reason_code, outgoing_worker_id);  -- MATCH SIMPLE

ALTER TABLE patient_itinerary_change_log DROP CONSTRAINT IF EXISTS picl_request_by_kind;
ALTER TABLE patient_itinerary_change_log ADD CONSTRAINT picl_request_by_kind
  CHECK (request_id IS NULL OR kind IN ('ABSENCE','REPLACE','REMOVE','SUBSTITUTE_CANCELLED'));

-- kind = ABSENCE exige pedido e que a ausência citada seja DO MESMO pedido (fecha o "dois caminhos para o mesmo vínculo").
-- AFTER INSERT: roda depois de CHECK e FK, então os erros estruturais (23503/23514 dos CHECKs) mantêm o código de sempre.
CREATE OR REPLACE FUNCTION fn_picl_request()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  v_request UUID;
BEGIN
  IF NEW.kind = 'ABSENCE' THEN
    IF NEW.request_id IS NULL THEN
      RAISE EXCEPTION 'picl_absence_sem_pedido' USING ERRCODE = '23514';
    END IF;
    SELECT ab.request_id INTO v_request FROM patient_itinerary_absence ab WHERE ab.id = NEW.absence_id;
    IF NOT FOUND OR v_request IS DISTINCT FROM NEW.request_id THEN
      RAISE EXCEPTION 'picl_pedido_diverge_da_ausencia' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION fn_picl_request() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_picl_request ON patient_itinerary_change_log;
CREATE TRIGGER trg_picl_request
  AFTER INSERT ON patient_itinerary_change_log
  FOR EACH ROW EXECUTE FUNCTION fn_picl_request();

COMMENT ON COLUMN patient_itinerary_change_log.request_id IS
  'NULL = o registro não nasceu de um pedido (gravado antes da 548, ou troca por faixa na aba "Horario fijo": REMOVE do "Quitar", ENTRY_CANCELLED). Um sentido: "sem pedido".';

-- ── 2.4 Conflito do substituto: UMA montagem de argumentos (gatilho e pré-visão) ─────────────────────
CREATE OR REPLACE FUNCTION itinerary_slot_worker_conflict(
  p_worker UUID, p_slot UUID, p_from DATE, p_to DATE, p_ignore_absence UUID)
RETURNS TABLE (service_id UUID, weekday SMALLINT, start_time TIME, duration_minutes INTEGER, address_id UUID, same_address BOOLEAN)
LANGUAGE sql STABLE SECURITY INVOKER SET search_path = pg_catalog, public AS $$
  SELECT c.service_id, c.weekday, c.start_time, c.duration_minutes, c.address_id,
         (c.address_id IS NOT NULL AND c.address_id = pcs.address_id)
    FROM patient_itinerary_slot s
    JOIN patient_contracted_services pcs ON pcs.id = s.contracted_service_id
    CROSS JOIN LATERAL itinerary_worker_conflict(p_worker, s.week_minutes, pcs.address_id, p_from, p_to, NULL, p_ignore_absence, NULL) c
   WHERE s.id = p_slot
$$;
REVOKE ALL ON FUNCTION itinerary_slot_worker_conflict(UUID, UUID, DATE, DATE, UUID) FROM PUBLIC;

-- o gatilho da ausência (528) recriado: MESMO nome, MESMO gatilho, MESMO DETAIL de 10 chaves; só a montagem passa a ser a de cima
CREATE OR REPLACE FUNCTION fn_patient_itinerary_absence_no_overlap()
RETURNS TRIGGER LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public
AS $$
DECLARE
  v_gap INT := itinerary_min_gap_minutes();
  v_slot_id UUID; v_weekday SMALLINT; v_start_time TIME; v_duration INT;
  v_service_id UUID;
  v_c_service_id UUID; v_c_weekday SMALLINT; v_c_start_time TIME; v_c_duration INT; v_c_address_id UUID;
  v_same_address BOOLEAN;
BEGIN
  IF NEW.substitute_worker_id IS NULL OR NEW.cancelled_at IS NOT NULL THEN RETURN NEW; END IF;
  PERFORM pg_advisory_xact_lock(hashtext('itinerary:worker:' || NEW.substitute_worker_id::text));
  SELECT s.id, s.weekday, s.start_time, s.duration_minutes, s.contracted_service_id
    INTO v_slot_id, v_weekday, v_start_time, v_duration, v_service_id
    FROM patient_itinerary_assignment a
    JOIN patient_itinerary_slot s ON s.id = a.slot_id
   WHERE a.id = NEW.assignment_id;
  IF NOT FOUND THEN RETURN NEW; END IF;
  SELECT * INTO v_c_service_id, v_c_weekday, v_c_start_time, v_c_duration, v_c_address_id, v_same_address
    FROM itinerary_slot_worker_conflict(NEW.substitute_worker_id, v_slot_id, NEW.on_date, NEW.on_date, NEW.id);
  IF NOT FOUND THEN RETURN NEW; END IF;
  RAISE EXCEPTION 'itinerary_overlap' USING
    ERRCODE = '23P01',
    DETAIL = json_build_object(
      'existingServiceId', v_c_service_id,
      'existingWeekday', v_c_weekday,
      'existingStart', to_char(v_c_start_time, 'HH24:MI'),
      'existingEnd', to_char(v_c_start_time + make_interval(mins => v_c_duration), 'HH24:MI'),
      'requestedServiceId', v_service_id,
      'requestedWeekday', v_weekday,
      'requestedStart', to_char(v_start_time, 'HH24:MI'),
      'requestedEnd', to_char(v_start_time + make_interval(mins => v_duration), 'HH24:MI'),
      'sameAddress', v_same_address,
      'minGapMinutes', CASE WHEN v_same_address THEN NULL ELSE v_gap END
    )::text;
END;
$$;
REVOKE ALL ON FUNCTION fn_patient_itinerary_absence_no_overlap() FROM PUBLIC;

-- a pré-visão: DEFINER, devolve só horário e "mesmo endereço" — nenhum id de serviço/paciente alheio.
-- Gate de ator por GUC (dentro); gate de role pela ACL (REVOKE PUBLIC + GRANT), nunca current_user.
CREATE OR REPLACE FUNCTION itinerary_substitute_conflict_preview(
  p_worker UUID, p_slot UUID, p_from DATE, p_to DATE, p_ignore_absence UUID)
RETURNS TABLE (weekday SMALLINT, start_time TIME, duration_minutes INTEGER, same_address BOOLEAN)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = pg_catalog, public AS $$
  SELECT c.weekday, c.start_time, c.duration_minutes, c.same_address
    FROM itinerary_slot_worker_conflict(p_worker, p_slot, p_from, p_to, p_ignore_absence) c
   WHERE NULLIF(current_setting('app.user_uid', true), '') IS NOT NULL
$$;
REVOKE ALL ON FUNCTION itinerary_substitute_conflict_preview(UUID, UUID, DATE, DATE, UUID) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION itinerary_substitute_conflict_preview(UUID, UUID, DATE, DATE, UUID) TO app_runtime;

COMMENT ON FUNCTION itinerary_substitute_conflict_preview(UUID, UUID, DATE, DATE, UUID) IS
  'Pré-visão do conflito do substituto (spec 069): mesma montagem do gatilho da ausência (itinerary_slot_worker_conflict). '
  'Devolve só dia/hora/duração e "mesmo endereço"; sem GUC de ator devolve 0 linhas. O caso de uso lê o slot sob RLS ANTES de chamar.';

-- ── 2.5 Rotina diária: execução do dia e despacho do alerta ──────────────────────────────────────────
CREATE TABLE IF NOT EXISTS itinerary_daily_run (
  country        TEXT         NOT NULL CHECK (country IN ('AR','BR')),
  operation_date DATE         NOT NULL,
  started_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  finished_at    TIMESTAMPTZ  NULL,
  failures       INTEGER      NULL CHECK (failures >= 0),
  PRIMARY KEY (country, operation_date),
  CONSTRAINT idr_finish_pair CHECK ((finished_at IS NULL) = (failures IS NULL))
);

-- o alvo da FK composta do despacho (notificação = referência, não cópia); aditivo em tabela do módulo 461
CREATE UNIQUE INDEX IF NOT EXISTS uq_notifications_event_recipient ON notifications (event_id, recipient_uid);

INSERT INTO notification_types (code, description) VALUES
  ('ITINERARY_UNCOVERED_SHIFTS', 'Aviso diário: turnos sin cubrir nos próximos 7 dias (agregado por destinatário)')
ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS itinerary_uncovered_alert_dispatch (
  operation_date   DATE         NOT NULL,
  recipient_uid    VARCHAR(128) NOT NULL,
  event_id         UUID         NOT NULL,
  email_status     TEXT         NOT NULL CHECK (email_status IN ('PENDING','SENT','FAILED','SKIPPED_TEST','SKIPPED_NO_KEY','NO_ADDRESS')),
  email_error_code TEXT         NULL,
  created_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ  NOT NULL DEFAULT now(),
  PRIMARY KEY (operation_date, recipient_uid),
  CONSTRAINT iuad_error_pair CHECK ((email_status = 'FAILED') = (email_error_code IS NOT NULL)),
  CONSTRAINT iuad_notification_fk FOREIGN KEY (event_id, recipient_uid) REFERENCES notifications (event_id, recipient_uid)
);

-- tabelas de job (molde anacare_sync_run, 443: country sem RLS): escrita só app_system; app_runtime só LÊ (regra runtime-role-privilegios)
REVOKE ALL ON itinerary_daily_run FROM PUBLIC, app_runtime;
REVOKE ALL ON itinerary_uncovered_alert_dispatch FROM PUBLIC, app_runtime;
GRANT SELECT, INSERT, UPDATE ON itinerary_daily_run TO app_system;
GRANT SELECT, INSERT, UPDATE ON itinerary_uncovered_alert_dispatch TO app_system;
GRANT SELECT ON itinerary_daily_run TO app_runtime;
GRANT SELECT ON itinerary_uncovered_alert_dispatch TO app_runtime;

COMMENT ON TABLE itinerary_daily_run IS
  'O fato "a rotina diária do itinerário rodou para o país no dia" (spec 069). finished_at NULL = não terminou (em curso ou caiu; o alarme usa prazo). '
  'Sem contagem de estados movidos (isso tem dono em patient_status_history). Sem PII.';
COMMENT ON TABLE itinerary_uncovered_alert_dispatch IS
  'O envio do alerta diário de turnos sin cubrir a um destinatário (spec 069). A notificação in-app é REFERÊNCIA (FK composta), não cópia; '
  'email_status é o único dono do resultado do e-mail; a PK (dia, destinatário) dá a idempotência. Sem PII além do uid.';
