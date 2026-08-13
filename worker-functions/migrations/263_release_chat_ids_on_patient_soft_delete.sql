BEGIN;

-- ================================================================
-- Migration 263: libera patient_chat_ids quando o paciente é SOFT-DELETADO
-- ================================================================
-- Achado em review do PR #205 antes do merge (11/08). O índice único parcial
-- `idx_patient_chat_ids_exclusive_chat` (migration 261) e as leituras
-- (`findLinkedElsewhere`, `countUsage`, `findSharedGroups`) todos filtram
-- `patients.deleted_at IS NULL` — mas NENHUM deles APAGA a linha de
-- `patient_chat_ids` quando o paciente é soft-deletado. Resultado: um chat_id
-- preso a um paciente soft-deleted fica ocupando a vaga NO ÍNDICE PARA SEMPRE
-- (some das LEITURAS, mas o índice único parcial continua vendo a linha) —
-- nunca mais linkável a ninguém, mesmo que a pessoa (e a conversa) tenham
-- sumido do sistema há meses.
--
-- `ON DELETE CASCADE` (261) já cobre o DELETE FÍSICO de paciente. Este trigger
-- cobre o SOFT delete, que é o caminho REAL usado em produção hoje — o único
-- call site atual é `ClickUpPatientWebhookController.handle` (evento
-- `taskDeleted`, "UPDATE patients SET deleted_at = NOW() ..."), mas um trigger
-- no banco garante o invariante independente de QUANTOS call sites existirem
-- no futuro (um endpoint admin de arquivar paciente, um script, etc.) — mesmo
-- espírito de trava dura já usado neste repo (ex.: migration 189, trigger
-- anti-órfã de encuadre).
--
-- A trilha de auditoria de paciente soft-deleted não depende destas linhas: o
-- histórico que a Candela audita é por `patient_id` + `clickup_task_id`, e o
-- paciente continua existindo (soft-delete, não DELETE) — só os vínculos de
-- chat, que são de propósito operacional (achar o grupo certo pra escrever),
-- deixam de fazer sentido para um caso encerrado.
-- ================================================================

CREATE OR REPLACE FUNCTION fn_release_chat_ids_on_patient_soft_delete()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    DELETE FROM patient_chat_ids WHERE patient_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_release_chat_ids_on_patient_soft_delete ON patients;
CREATE TRIGGER trg_release_chat_ids_on_patient_soft_delete
  AFTER UPDATE OF deleted_at ON patients
  FOR EACH ROW
  EXECUTE FUNCTION fn_release_chat_ids_on_patient_soft_delete();

-- ── Limpeza de órfãs JÁ existentes ──────────────────────────────────────────
-- O trigger acima só cobre soft-deletes DAQUI PRA FRENTE. Sem isto, qualquer
-- paciente já soft-deleted ANTES desta migration (a base tinha poucos vínculos
-- reais em 08/08, mas o preço de checar é uma DELETE idempotente) continuaria
-- com o chat_id preso.
DELETE FROM patient_chat_ids
 WHERE patient_id IN (SELECT id FROM patients WHERE deleted_at IS NOT NULL);

COMMIT;
