-- 542 — ocupação de uma faixa do itinerário (spec 058 Parte B, plan §1 P4). Duas funções só de leitura, sem efeito colateral:
--  · itinerary_slot_max_occupancy(p_slot, p_from, p_to, p_exclude) = máximo de alocações ACTIVE simultâneas da faixa em
--    [p_from, p_to] (p_to NULL = sem fim), calculado nos pontos {p_from} ∪ {valid_from das outras ACTIVE em (p_from, p_to]};
--    vigência de alocação = valid_from … valid_to INCLUSIVA (valid_to NULL = aberta); p_exclude = a própria linha em julgamento.
--    O substituto de um dia mora em patient_itinerary_absence e NÃO conta.
--  · fn_058_b_slots_over_capacity() = a medição 12a: faixas com limite (providers_needed não nulo) cuja ocupação máxima, do
--    "hoje" do país em diante, passa do limite. Devolve só ids e inteiros (nenhuma pessoa).
-- SECURITY INVOKER de propósito: o chamador vê o que a RLS deixa; as travas (543/544, SECURITY DEFINER) a chamam como dono.
-- Idempotente (CREATE OR REPLACE). Sem BEGIN/COMMIT. Rollback: migrations/pending/ROLLBACK_542_itinerary_slot_occupancy.sql.
CREATE OR REPLACE FUNCTION itinerary_slot_max_occupancy(p_slot uuid, p_from date, p_to date, p_exclude uuid)
RETURNS integer
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  WITH a AS (
    SELECT x.valid_from, x.valid_to
      FROM patient_itinerary_assignment x
     WHERE x.slot_id = p_slot
       AND x.status = 'ACTIVE'
       AND x.id IS DISTINCT FROM p_exclude
       AND x.valid_from <= COALESCE(p_to, 'infinity'::date)
       AND COALESCE(x.valid_to, 'infinity'::date) >= p_from
  ),
  pts AS (
    SELECT p_from AS d
    UNION
    SELECT a.valid_from FROM a WHERE a.valid_from > p_from
  )
  SELECT COALESCE(max(c.n), 0)::int
    FROM (
      SELECT count(*) AS n
        FROM pts
        JOIN a ON a.valid_from <= pts.d AND COALESCE(a.valid_to, 'infinity'::date) >= pts.d
       GROUP BY pts.d
    ) c
$$;

CREATE OR REPLACE FUNCTION fn_058_b_slots_over_capacity()
RETURNS TABLE (service_id uuid, slot_id uuid, providers_needed integer, max_occupancy integer)
LANGUAGE sql
STABLE
SET search_path = pg_catalog, public
AS $$
  SELECT m.service_id, m.slot_id, m.providers_needed, m.max_occupancy
    FROM (
      SELECT s.contracted_service_id AS service_id, s.id AS slot_id, pcs.providers_needed,
             itinerary_slot_max_occupancy(s.id, fn_operation_date(pcs.country), NULL, NULL) AS max_occupancy
        FROM patient_itinerary_slot s
        JOIN patient_contracted_services pcs ON pcs.id = s.contracted_service_id
       WHERE pcs.providers_needed IS NOT NULL
    ) m
   WHERE m.max_occupancy > m.providers_needed
$$;

COMMENT ON FUNCTION itinerary_slot_max_occupancy(uuid, date, date, uuid) IS
  'Máximo de alocações ACTIVE simultâneas da faixa em [p_from, p_to] (valid_to inclusivo, NULL = aberto), sem p_exclude; substituto de um dia não conta. Spec 058 Parte B.';
COMMENT ON FUNCTION fn_058_b_slots_over_capacity() IS
  'Medição 12a: faixas com providers_needed não nulo e ocupação máxima, de hoje em diante, acima do limite. Só ids e inteiros. Spec 058 Parte B.';
