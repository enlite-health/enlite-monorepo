-- 544 — Trava B: providers_needed do serviço (spec 058 Parte B, plan §1 P4; desenho v13 "Trava B", v9).
-- BEFORE UPDATE OF providers_needed em patient_contracted_services, WHEN (OLD.providers_needed IS DISTINCT FROM NEW.providers_needed):
-- o formulário do serviço reenvia o mesmo valor em todo PATCH (ContractedServiceFormRow.tsx:195,209); o WHEN torna o reenvio inofensivo.
-- Lock do SERVIÇO (a mesma chave da Trava A: 'itinerary:service:' || id). número → NULL = PROVIDERS_NEEDED_CANNOT_CLEAR;
-- NEW < ocupação máxima de fn_operation_date(NEW.country) em diante (maior das faixas do serviço) = PROVIDERS_NEEDED_BELOW_OCCUPANCY
-- (inclui NULL → número abaixo da ocupação). Ambos P0001, DETAIL só com números. A Trava B toma o lock de LINHA do pcs (o UPDATE) e
-- depois o advisory do serviço; a Trava A toma o advisory e NÃO a linha do pcs: sem ciclo (o teste A × B prova).
-- SECURITY DEFINER pelo mesmo motivo da 543. Idempotente. Sem BEGIN/COMMIT.
-- Rollback: migrations/pending/ROLLBACK_544_058b_trava_b_providers_needed.sql.
CREATE OR REPLACE FUNCTION fn_058_b_pcs_providers_needed()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_ocupacao integer;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtext('itinerary:service:' || NEW.id::text));

  IF OLD.providers_needed IS NOT NULL AND NEW.providers_needed IS NULL THEN
    RAISE EXCEPTION 'PROVIDERS_NEEDED_CANNOT_CLEAR' USING ERRCODE = 'P0001';
  END IF;

  IF NEW.providers_needed IS NOT NULL THEN
    SELECT COALESCE(max(itinerary_slot_max_occupancy(s.id, fn_operation_date(NEW.country), NULL, NULL)), 0)
      INTO v_ocupacao
      FROM patient_itinerary_slot s
     WHERE s.contracted_service_id = NEW.id;
    IF NEW.providers_needed < v_ocupacao THEN
      RAISE EXCEPTION 'PROVIDERS_NEEDED_BELOW_OCCUPANCY' USING ERRCODE = 'P0001', DETAIL = format('limit=%s, used=%s', NEW.providers_needed, v_ocupacao);
    END IF;
  END IF;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION fn_058_b_pcs_providers_needed() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_058_b_pcs_providers_needed ON patient_contracted_services;
CREATE TRIGGER trg_058_b_pcs_providers_needed
  BEFORE UPDATE OF providers_needed ON patient_contracted_services
  FOR EACH ROW WHEN (OLD.providers_needed IS DISTINCT FROM NEW.providers_needed)
  EXECUTE FUNCTION fn_058_b_pcs_providers_needed();
