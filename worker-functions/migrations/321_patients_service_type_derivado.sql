-- 321 — `patients.service_type[]` vira DERIVADO de `patient_contracted_services` QUANDO ela existir
-- (spec 013, bloco C — FR-C1; decisão 3 do Gabriel 03/09: "derivação por horas fica declarada")
--
-- ── A regra, e por que ela não é "sempre derivado" ──────────────────────────
-- `patients.service_type[]` (139) continua sendo escrito pelo espelho ClickUp — COMPAT — enquanto
-- o paciente não tiver nenhum `patient_contracted_service` ATIVO (é o caso de TODO paciente hoje;
-- a tabela nasce vazia). No instante em que o primeiro serviço é declarado, o array passa a ser a
-- UNIÃO dos `service_code` dos serviços ATIVOS, e o espelho ClickUp PARA de escrever a coluna
-- para aquele paciente — é a mesma classe de bug da migration 310/F64 (trigger recalcula, o
-- repositório escreve incondicional por cima, o repositório GANHA por ser o último a escrever) e
-- a mesma correção: os DOIS lados mudam juntos. Ver `PatientClinicalRepository.ts` (guarda por
-- `EXISTS`, no mesmo commit desta migration) — sem essa metade, esta migration sozinha regride
-- no primeiro webhook seguinte.
--
-- ── Por que o gatilho NÃO zera o array quando o último serviço é desativado ─
-- Não redigimos para `NULL`: o trigger simplesmente NÃO recalcula quando não há linha ativa. O
-- valor fica CONGELADO no último derivado (visível, auditável — molde 310, "congelar é ruim mas é
-- visível; apagar em silêncio não era") até o próximo sync do ClickUp, que volta a escrever
-- (a guarda do repositório libera assim que `EXISTS` volta a `false`).
--
-- Rollback: DROP TRIGGER/FUNCTION — o array simplesmente para de ser recalculado; a guarda do
-- repositório (código, não migration) precisa reverter no mesmo commit ou o campo fica congelado
-- para sempre num paciente que já teve serviço.

CREATE OR REPLACE FUNCTION fn_sync_patient_service_type_escalar()
RETURNS TRIGGER AS $$
DECLARE
  alvo UUID;
  novo TEXT[];
BEGIN
  alvo := COALESCE(NEW.patient_id, OLD.patient_id);

  SELECT array_agg(x.service_code ORDER BY x.sort_order, x.service_code) INTO novo
    FROM (
      SELECT DISTINCT pcs.service_code, st.sort_order
        FROM patient_contracted_services pcs
        JOIN service_types st ON st.code = pcs.service_code
       WHERE pcs.patient_id = alvo AND pcs.active
    ) x;

  -- Nenhum serviço ativo: NÃO recalcula (congela o último valor; a guarda do repositório
  -- devolve o campo ao espelho ClickUp no próximo sync — ver comentário acima).
  IF novo IS NULL THEN
    RETURN NULL;
  END IF;

  UPDATE patients p
     SET service_type = novo,
         updated_at = NOW()
   WHERE p.id = alvo
     AND p.service_type IS DISTINCT FROM novo;  -- evita N updates por N linhas do conjunto

  RETURN NULL;  -- AFTER trigger: valor de retorno ignorado.
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_sync_patient_service_type_escalar ON patient_contracted_services;

-- FOR EACH ROW (não STATEMENT): o padrão de escrita aqui é linha a linha (POST/PATCH por
-- serviço), diferente do DELETE+INSERT em massa de patient_device_types — mas o trigger é
-- idempotente e barato o bastante (1 SELECT + 1 UPDATE guardado por IS DISTINCT FROM) para não
-- precisar da otimização de statement-level.
CREATE TRIGGER trg_sync_patient_service_type_escalar
  AFTER INSERT OR DELETE OR UPDATE OF active, service_code ON patient_contracted_services
  FOR EACH ROW
  EXECUTE FUNCTION fn_sync_patient_service_type_escalar();

COMMENT ON FUNCTION fn_sync_patient_service_type_escalar() IS
  'Recalcula patients.service_type[] a partir da união dos service_code ATIVOS em '
  'patient_contracted_services (migration 321, spec 013 FR-C1). Só recalcula quando existe ao '
  'menos 1 serviço ativo — com zero, o campo fica congelado e a guarda em '
  'PatientClinicalRepository.upsert devolve a escrita ao espelho ClickUp. Desempate: sort_order '
  'do catálogo (service_types), depois code — mesmo molde de fn_sync_patient_device_type_escalar '
  '(migration 310).';
