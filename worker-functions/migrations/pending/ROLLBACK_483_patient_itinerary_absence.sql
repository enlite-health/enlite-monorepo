-- ROLLBACK_483_patient_itinerary_absence.sql — par de rollback da migration 483
-- (a ausência pontual do titular, a validação e a trava por data; DX-13.1, DX-13.2).
--
-- QUANDO USAR: regressão detectada depois do deploy da 483 — decisão de reverter a ausência e
-- a extensão da trava de sobreposição antes de um fix mais específico ficar pronto.
--
-- Por que mora em `migrations/pending/`, sem número: mesma razão do ROLLBACK_482 —
-- `scripts/run-migrations-docker.js` aplica tudo `.sql` de `migrations/` em ordem numérica;
-- `migrations/pending/` é o único lugar que o runner ignora (ver `migrations/pending/README.md`)
-- — o arquivo fica escrito, revisado e versionado, mas só roda quando alguém aponta o caminho
-- explicitamente.
--
-- Trava de dado: se já existe QUALQUER linha em `patient_itinerary_absence`, o rollback
-- apagaria as ausências registradas — recusa.
--
-- ORDEM: rodar este ANTES do `ROLLBACK_482_patient_itinerary_assembly_and_overlap.sql` — a
-- função `fn_patient_itinerary_assignment_no_overlap()` que este rollback restaura ao corpo
-- literal da 482 é a MESMA que o `ROLLBACK_482` depois apaga.
--
-- Como rodar (reversão manual e intencional, nunca automática):
--   ./scripts/run-migration-prod.sh worker-functions/migrations/pending/ROLLBACK_483_patient_itinerary_absence.sql

DO $$
BEGIN
  IF to_regclass('patient_itinerary_absence') IS NOT NULL THEN
    IF (SELECT count(*) FROM patient_itinerary_absence) > 0 THEN
      RAISE EXCEPTION 'há ausência registrada — o rollback apagaria as ausências (contagem no PR, OK do Gabriel antes)';
    END IF;
  END IF;
END $$;

-- restaura fn_patient_itinerary_assignment_no_overlap() ao corpo LITERAL da 482:128-243 — a
-- única cópia justificada: o rollback tem de ser autossuficiente e devolver a trava
-- exatamente como a Fase 11 a deixou (ela deixa de chamar itinerary_worker_conflict()).
CREATE OR REPLACE FUNCTION fn_patient_itinerary_assignment_no_overlap()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_gap               INT := itinerary_min_gap_minutes();
  v_weekday           SMALLINT;
  v_start_time        TIME;
  v_end_time          TIME;
  v_start_min         INT;
  v_end_min           INT;
  v_service_id        UUID;
  v_address_id        UUID;
  v_c_id               UUID;
  v_c_service_id       UUID;
  v_c_weekday          SMALLINT;
  v_c_start_time       TIME;
  v_c_end_time         TIME;
  v_c_start_min        INT;
  v_c_end_min          INT;
  v_c_address_id        UUID;
  v_same_address        BOOLEAN;
BEGIN
  -- (i) deferências às constraints nativas (ressalva c', DX-11.3): esta trigger
  -- roda BEFORE ROW e é avaliada ANTES do NOT NULL/CHECK/UNIQUE da própria linha —
  -- se lançar exceção aqui sem checar isso, o Postgres nunca chega a avaliar
  -- 23502 (NOT NULL), 23514 (pia_valid_range) ou 23505 (uq_pia_open_pair).
  IF NEW.status IS DISTINCT FROM 'ACTIVE' THEN
    RETURN NEW; -- encerrar/cancelar nunca é barrado pela trava
  END IF;

  IF NEW.slot_id IS NULL OR NEW.worker_id IS NULL OR NEW.valid_from IS NULL THEN
    RETURN NEW; -- deixa o NOT NULL da coluna decidir
  END IF;

  IF NEW.valid_to IS NOT NULL AND NEW.valid_to < NEW.valid_from THEN
    RETURN NEW; -- deixa pia_valid_range decidir
  END IF;

  -- (ii) serializa por prestador: duas alocações concorrentes do mesmo worker se
  -- enfileiram (molde 279:83) — a 2ª só lê depois do COMMIT da 1ª.
  PERFORM pg_advisory_xact_lock(hashtext('itinerary:worker:' || NEW.worker_id::text));

  -- (iii) o slot novo, com o endereço do SERVIÇO (invariante 8 — nunca cópia).
  SELECT s.weekday, s.start_time, s.end_time,
         (extract(epoch FROM s.start_time) / 60)::int,
         (extract(epoch FROM s.end_time) / 60)::int,
         s.contracted_service_id, pcs.address_id
    INTO v_weekday, v_start_time, v_end_time, v_start_min, v_end_min, v_service_id, v_address_id
    FROM patient_itinerary_slot s
    JOIN patient_contracted_services pcs ON pcs.id = s.contracted_service_id
    WHERE s.id = NEW.slot_id;

  IF NOT FOUND THEN
    RETURN NEW; -- deixa a FK de slot_id decidir
  END IF;

  -- (iv) procura UMA alocação conflitante do mesmo prestador.
  SELECT a.id, s2.contracted_service_id, s2.weekday, s2.start_time, s2.end_time,
         (extract(epoch FROM s2.start_time) / 60)::int,
         (extract(epoch FROM s2.end_time) / 60)::int,
         pcs2.address_id
    INTO v_c_id, v_c_service_id, v_c_weekday, v_c_start_time, v_c_end_time,
         v_c_start_min, v_c_end_min, v_c_address_id
    FROM patient_itinerary_assignment a
    JOIN patient_itinerary_slot s2 ON s2.id = a.slot_id
    JOIN patient_contracted_services pcs2 ON pcs2.id = s2.contracted_service_id
    WHERE a.worker_id = NEW.worker_id
      AND a.status = 'ACTIVE'
      AND a.id <> NEW.id
      -- esse par (mesmo slot, os dois sem fim) é do uq_pia_open_pair → 23505 (ressalva c')
      AND NOT (a.slot_id = NEW.slot_id AND a.valid_to IS NULL AND NEW.valid_to IS NULL)
      AND s2.weekday = v_weekday
      -- vigência por INTERVALO DE DATAS — é aqui que a Fase 13 estende
      AND a.valid_from <= COALESCE(NEW.valid_to, 'infinity'::date)
      AND COALESCE(a.valid_to, 'infinity'::date) >= NEW.valid_from
      AND (
        -- mesmo endereço: só não pode SOBREPOR
        (pcs2.address_id IS NOT NULL AND pcs2.address_id = v_address_id
          AND (extract(epoch FROM s2.start_time) / 60)::int < v_end_min
          AND v_start_min < (extract(epoch FROM s2.end_time) / 60)::int)
        OR
        -- endereços diferentes ou algum NULL (conservador: exige folga)
        (NOT (pcs2.address_id IS NOT NULL AND pcs2.address_id = v_address_id)
          AND (extract(epoch FROM s2.start_time) / 60)::int < v_end_min + v_gap
          AND v_start_min < (extract(epoch FROM s2.end_time) / 60)::int + v_gap)
      )
    ORDER BY s2.start_time
    LIMIT 1;

  IF v_c_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_same_address := (v_address_id IS NOT NULL AND v_c_address_id = v_address_id);

  -- (v) 23P01 (exclusion_violation — a classe que um EXCLUDE daria); DETAIL só com
  -- ids de serviço, dia e horário — nenhum nome, nenhum endereço, nada clínico.
  RAISE EXCEPTION 'itinerary_overlap' USING
    ERRCODE = '23P01',
    DETAIL = json_build_object(
      'existingServiceId', v_c_service_id,
      'existingWeekday', v_c_weekday,
      'existingStart', to_char(v_c_start_time, 'HH24:MI'),
      'existingEnd', to_char(v_c_end_time, 'HH24:MI'),
      'requestedServiceId', v_service_id,
      'requestedWeekday', v_weekday,
      'requestedStart', to_char(v_start_time, 'HH24:MI'),
      'requestedEnd', to_char(v_end_time, 'HH24:MI'),
      'sameAddress', v_same_address,
      'minGapMinutes', CASE WHEN v_same_address THEN NULL ELSE v_gap END
    )::text;
END;
$$;

-- os 3 gatilhos desta tabela — guardado por to_regclass: na 2ª rodada do rollback a tabela já
-- não existe (o DROP TABLE abaixo já cascata os triggers dela) e `DROP TRIGGER … ON` uma
-- relação inexistente falharia mesmo com IF EXISTS no nome do trigger.
DO $$
BEGIN
  IF to_regclass('patient_itinerary_absence') IS NOT NULL THEN
    EXECUTE 'DROP TRIGGER IF EXISTS trg_patient_itinerary_absence_1_validate ON patient_itinerary_absence';
    EXECUTE 'DROP TRIGGER IF EXISTS trg_patient_itinerary_absence_2_country ON patient_itinerary_absence';
    EXECUTE 'DROP TRIGGER IF EXISTS trg_patient_itinerary_absence_3_no_overlap ON patient_itinerary_absence';
  END IF;
END $$;

DROP TABLE IF EXISTS patient_itinerary_absence;

DROP FUNCTION IF EXISTS fn_patient_itinerary_absence_validate();
DROP FUNCTION IF EXISTS fn_patient_itinerary_absence_country_from_assignment();
DROP FUNCTION IF EXISTS fn_patient_itinerary_absence_no_overlap();
DROP FUNCTION IF EXISTS itinerary_worker_conflict(
  UUID, SMALLINT, INT, INT, UUID, DATE, DATE, UUID, UUID, UUID
);
