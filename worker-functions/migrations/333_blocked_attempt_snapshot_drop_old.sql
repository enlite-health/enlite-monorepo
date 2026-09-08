-- 333_blocked_attempt_snapshot_drop_old.sql
--
-- FASE 2 de 2 do rename honesto (ver 332).
--
-- 🔒 NÃO RODAR JUNTO COM A 332. Esta migration só é segura depois que o deploy do
-- código que escreve APENAS as colunas novas estiver 100% no ar — nenhuma revisão
-- velha do Cloud Run servindo tráfego. Rodar antes derruba o INSERT de quem tenta
-- se candidatar.
--
-- Ordem: 332 → deploy → (conferir revisão única no Cloud Run) → 333.
--
-- O QUE ESTA MIGRATION COMPRA
-- Depois dela, `WHERE b.blocked_reason = '...'` deixa de devolver resposta errada
-- e passa a devolver ERRO. É o conserto da CAUSA, não da instância: o nome no
-- presente era o convite, e o índice era a facilidade. Some com os dois.
--
-- ⚠️ Esta é a única migration desta dupla que NÃO é aditiva. A regra da casa é
-- "nunca dropar coluna sem deprecação" — a deprecação é a 332 + o deploy entre as
-- duas. O dado não se perde: foi copiado para `*_at_attempt` e o backfill abaixo
-- fecha a janela.

BEGIN;

-- Fecha a janela: linhas que a revisão velha gravou entre a 332 e o fim do deploy
-- ficaram com a coluna nova nula. Sem isto, o histórico perde essas tentativas.
UPDATE worker_blocked_applications
   SET blocked_reason_at_attempt = COALESCE(blocked_reason_at_attempt, blocked_reason),
       missing_fields_at_attempt = COALESCE(missing_fields_at_attempt, missing_fields)
 WHERE blocked_reason_at_attempt IS NULL
    OR missing_fields_at_attempt IS NULL;

-- Trava de segurança: se ainda houver linha sem o valor novo, aborta em vez de
-- dropar. Contagem zero aqui é o único caso em que o zero significa "pode seguir"
-- — e por isso ele é medido, não presumido.
DO $$
DECLARE v_pendentes INT;
BEGIN
  SELECT COUNT(*) INTO v_pendentes
    FROM worker_blocked_applications
   WHERE blocked_reason_at_attempt IS NULL;
  IF v_pendentes > 0 THEN
    RAISE EXCEPTION 'ABORTADO: % linha(s) sem blocked_reason_at_attempt. Rode a 332 antes.', v_pendentes;
  END IF;
END $$;

-- O índice morre junto: ele existia para servir `WHERE blocked_reason = ...`, que
-- é justamente a consulta que não deve mais existir. Deixá-lo seria manter o
-- convite de pé apontando para uma coluna que já não responde a pergunta certa.
DROP INDEX IF EXISTS idx_wba_blocked_reason;

ALTER TABLE worker_blocked_applications
  DROP COLUMN IF EXISTS blocked_reason,
  DROP COLUMN IF EXISTS missing_fields;

-- Agora o NOT NULL cabe: toda linha tem valor, e toda escrita nova preenche.
ALTER TABLE worker_blocked_applications
  ALTER COLUMN blocked_reason_at_attempt SET NOT NULL;

COMMIT;
