-- 543 — Trava A: capacidade da faixa do itinerário (spec 058 Parte B, plan §1 P4; desenho v13 "Trava A", v9 dia de corte).
-- BEFORE INSERT OR UPDATE OF status, slot_id, worker_id, valid_from, valid_to em patient_itinerary_assignment (molde 482:248-249).
-- Passos: (1) status <> 'ACTIVE' sai cedo (encerrar/cancelar nunca é recusado; molde 528:77); (2) acha o serviço da faixa;
-- (3) lock do SERVIÇO antes do lock de prestador (a 482/528 toma o do prestador; o nome trg_058_b_ ordena ANTES de trg_patient_*
-- e o teste 058b-ordem-disparo prova); (4) relê país e providers_needed DEPOIS do lock (statement novo: vê o COMMIT da Trava B
-- concorrente); (5) providers_needed NULL = "não avaliada": NÃO recusa; (6) só julga dias >= fn_operation_date(país): dia passado
-- não é julgado; (7) em UPDATE de ACTIVE na MESMA faixa julga só os dias que a linha antiga não cobria (estender valid_to é
-- julgado; encurtar, encerrar e trocar só o worker_id nunca); reativar CANCELLED→ACTIVE e trocar slot_id julgam a janela inteira;
-- (8) 1 + ocupação máxima > limite → P0001 ITINERARY_SLOT_CAPACITY_EXCEEDED, DETAIL só com números (limit, used = ocupação SEM a linha em julgamento: o cálculo usa p_exclude = NEW.id).
-- SECURITY DEFINER (molde 482:120-127): como o chamador, a RLS esconderia alocações e a trava falharia ABERTA. search_path fixo,
-- nenhum current_user no corpo. Mais: COMMENT de providers_needed (texto do desenho v4) e o ASSERT 12a no fim (a ativação falha
-- se já houver faixa acima do limite; RAISE NOTICE sempre diz quantas faixas foram avaliadas: zero avaliada é dito, não escondido).
-- Idempotente (CREATE OR REPLACE, DROP TRIGGER IF EXISTS). Sem BEGIN/COMMIT. Rollback: migrations/pending/ROLLBACK_543_058b_trava_a_capacidade_da_faixa.sql.
CREATE OR REPLACE FUNCTION fn_058_b_assignment_capacity()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_service uuid;
  v_country text;
  v_limit   integer;
  v_d0      date;
  v_judge   datemultirange;
  v_range   daterange;
  v_used    integer;
BEGIN
  IF NEW.status IS DISTINCT FROM 'ACTIVE' THEN
    RETURN NEW;
  END IF;
  IF NEW.slot_id IS NULL OR NEW.valid_from IS NULL THEN
    RETURN NEW; -- deixa o NOT NULL decidir
  END IF;
  IF NEW.valid_to IS NOT NULL AND NEW.valid_to < NEW.valid_from THEN
    RETURN NEW; -- deixa pia_valid_range decidir
  END IF;

  SELECT s.contracted_service_id INTO v_service FROM patient_itinerary_slot s WHERE s.id = NEW.slot_id;
  IF NOT FOUND THEN
    RETURN NEW; -- deixa a FK de slot_id decidir
  END IF;

  PERFORM pg_advisory_xact_lock(hashtext('itinerary:service:' || v_service::text));

  SELECT pcs.country, pcs.providers_needed INTO v_country, v_limit
    FROM patient_contracted_services pcs WHERE pcs.id = v_service;
  IF v_limit IS NULL THEN
    RETURN NEW; -- capacidade não informada: não recusa
  END IF;

  v_d0 := fn_operation_date(v_country);
  v_judge := datemultirange(daterange(NEW.valid_from, CASE WHEN NEW.valid_to IS NULL THEN NULL ELSE NEW.valid_to + 1 END, '[)'))
           * datemultirange(daterange(v_d0, NULL, '[)'));
  IF TG_OP = 'UPDATE' AND OLD.status = 'ACTIVE' AND OLD.slot_id = NEW.slot_id THEN
    v_judge := v_judge - datemultirange(daterange(OLD.valid_from, CASE WHEN OLD.valid_to IS NULL THEN NULL ELSE OLD.valid_to + 1 END, '[)'));
  END IF;

  FOR v_range IN SELECT r FROM unnest(v_judge) AS r LOOP
    v_used := itinerary_slot_max_occupancy(
      NEW.slot_id, lower(v_range), CASE WHEN upper_inf(v_range) THEN NULL ELSE upper(v_range) - 1 END, NEW.id);
    IF v_used + 1 > v_limit THEN
      RAISE EXCEPTION 'ITINERARY_SLOT_CAPACITY_EXCEEDED' USING ERRCODE = 'P0001', DETAIL = format('limit=%s, used=%s', v_limit, v_used);
    END IF;
  END LOOP;

  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION fn_058_b_assignment_capacity() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_058_b_assignment_capacity ON patient_itinerary_assignment;
CREATE TRIGGER trg_058_b_assignment_capacity
  BEFORE INSERT OR UPDATE OF status, slot_id, worker_id, valid_from, valid_to ON patient_itinerary_assignment
  FOR EACH ROW EXECUTE FUNCTION fn_058_b_assignment_capacity();

COMMENT ON COLUMN patient_contracted_services.providers_needed IS
  'Quantidade de profissionais por faixa. NULL = não informada (leitura → CAPACITY_NOT_EVALUATED; nunca padrão). Vigência = vida do serviço (start_date até ended_at): configuração corrente, sem histórico, porque não há leitor histórico (precedente 510:4-5); mudança vale dali em diante e não retroage. Spec 058.';

-- ASSERT 12a: a ativação da Trava A falha se já houver faixa acima do limite (desenho v13:561; spec §12 B0).
DO $$
DECLARE
  v_avaliadas integer;
  v_acima     integer;
BEGIN
  SELECT count(*) INTO v_avaliadas
    FROM patient_itinerary_slot s
    JOIN patient_contracted_services pcs ON pcs.id = s.contracted_service_id
   WHERE pcs.providers_needed IS NOT NULL;
  SELECT count(*) INTO v_acima FROM fn_058_b_slots_over_capacity();
  RAISE NOTICE 'faixas_avaliadas=%, faixas_acima=%', v_avaliadas, v_acima;
  IF v_acima > 0 THEN
    RAISE EXCEPTION 'TRAVA_A_ATIVACAO_RECUSADA: % faixa(s) com alocações acima de providers_needed (medir com fn_058_b_slots_over_capacity(); decisão do Gabriel)', v_acima
      USING ERRCODE = 'P0001';
  END IF;
END
$$;
