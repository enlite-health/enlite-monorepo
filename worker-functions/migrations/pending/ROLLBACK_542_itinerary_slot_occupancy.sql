-- ROLLBACK_542_itinerary_slot_occupancy.sql — par de rollback da migration 542 (spec 058 Parte B). Rodar DEPOIS dos ROLLBACK_545…543.
DROP FUNCTION IF EXISTS fn_058_b_slots_over_capacity();
DROP FUNCTION IF EXISTS itinerary_slot_max_occupancy(uuid, date, date, uuid);
