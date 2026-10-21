-- ROLLBACK_541_fn_operation_date.sql — par de rollback da migration 541 (spec 058 Parte B). Rodar DEPOIS dos ROLLBACK_545…542 (as travas a usam).
DROP FUNCTION IF EXISTS fn_operation_date(text, timestamptz);
