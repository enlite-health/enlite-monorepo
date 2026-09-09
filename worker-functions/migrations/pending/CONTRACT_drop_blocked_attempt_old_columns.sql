-- CONTRACT_drop_blocked_attempt_old_columns.sql
--
-- FASE 2 de 2 do rename honesto (ver 332). Metade CONTRACT de um expand/contract.
--
-- 🔒 NÃO RODAR JUNTO COM A 332. Esta migration só é segura depois que o deploy do
-- código que escreve APENAS as colunas novas estiver 100% no ar — nenhuma revisão
-- velha do Cloud Run servindo tráfego. Rodar antes derruba o INSERT de quem tenta
-- se candidatar.
--
-- Ordem: 332 → deploy → (conferir revisão única no Cloud Run) → esta.
-- Como liberar: ver `migrations/pending/README.md` (mover para `migrations/` com o
-- próximo número livre; o nome aqui não tem número de propósito).
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
--
-- 🔒 POR QUE CADA PASSO É RE-EXECUTÁVEL (e por que isso não é zelo, é obrigação)
-- `scripts/run-migration-prod.sh` roda o psql e NÃO escreve em `schema_migrations`
-- (conferido: o script termina no `psql --file`). Então, assim que este arquivo for
-- movido para `migrations/`, o runner do CMD do Dockerfile o vê como não-aplicado e
-- o RE-EXECUTA no próximo boot. Uma versão não-idempotente aqui explodiria no
-- `UPDATE` contra a coluna que ela mesma acabou de dropar — e, com o runner agora
-- falhando fechado (`exit != 0`), isso deixa de ser barulho e vira NENHUMA
-- INSTÂNCIA SUBINDO. O guard de existência abaixo é o que separa as duas coisas.

BEGIN;

-- 🔒 PRIMEIRO a checagem de AMBIGUIDADE — e ela tem de vir ANTES do backfill,
-- senão nunca dispara (o backfill iguala as duas colunas e apaga a evidência).
--
-- O caso: durante a janela, a revisão VELHA e a NOVA escrevem colunas diferentes.
-- A velha grava `blocked_reason` e não toca em `blocked_reason_at_attempt`; a nova
-- faz o inverso. Nenhuma das duas deixa marca de QUEM escreveu por último — não há
-- timestamp por coluna. Então, se as duas estiverem preenchidas e DIFERENTES, a
-- pergunta "qual é o motivo da última tentativa?" não tem resposta no banco.
--
-- `COALESCE` em qualquer das duas ordens seria um CHUTE com cara de conserto: uma
-- ordem descarta o que a revisão velha acabou de gravar, a outra descarta o que a
-- nova gravou. As duas erram calado, dentro do COMMIT, e o DROP logo abaixo apaga a
-- outra metade — a evidência de que houve escolha some junto.
--
-- Abortar não perde nada: as duas colunas continuam de pé e um humano decide.
-- É o caso "vazio ambíguo apaga dado" (D167) na sua forma mais cara — aqui nem
-- vazio é: são dois valores válidos e incomparáveis.
--
-- Divergência esperada: ZERO. Exige uma tentativa REPETIDA do mesmo par
-- (worker, vaga) dentro dos poucos minutos do rolling deploy, com o motivo tendo
-- mudado nesse intervalo. A checagem custa um seq scan em ~1.700 linhas.
DO $$
DECLARE v_ambiguas INT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'worker_blocked_applications'
       AND column_name = 'blocked_reason'
  ) THEN
    RETURN; -- já contraída; nada a comparar (re-execução do runner no boot)
  END IF;

  EXECUTE $sql$
    SELECT COUNT(*) FROM worker_blocked_applications
     WHERE (blocked_reason IS NOT NULL
            AND blocked_reason_at_attempt IS NOT NULL
            AND blocked_reason IS DISTINCT FROM blocked_reason_at_attempt)
        OR (missing_fields IS NOT NULL
            AND missing_fields_at_attempt IS NOT NULL
            AND missing_fields IS DISTINCT FROM missing_fields_at_attempt)
  $sql$ INTO v_ambiguas;

  IF v_ambiguas > 0 THEN
    RAISE EXCEPTION
      'ABORTADO: % linha(s) com a coluna antiga e a nova preenchidas e DIFERENTES. '
      'Isso só acontece se as duas revisões gravaram a mesma linha durante a janela, '
      'e o banco não guarda quem escreveu por último — escolher uma seria chute. '
      'Compare blocked_reason x blocked_reason_at_attempt (e missing_fields) nessas '
      'linhas, decida na mão, iguale as duas colunas e rode de novo.', v_ambiguas;
  END IF;
END $$;

-- Fecha a janela: linhas que a revisão velha gravou entre a 332 e o fim do deploy
-- ficaram com a coluna nova nula. Sem isto, o histórico perde essas tentativas.
--
-- O guard é por EXISTÊNCIA das colunas antigas, não por contagem: na segunda
-- execução elas já não existem, e o `EXECUTE` nem chega a ser planejado.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'worker_blocked_applications'
       AND column_name = 'blocked_reason'
  ) THEN
    EXECUTE $sql$
      UPDATE worker_blocked_applications
         SET blocked_reason_at_attempt = COALESCE(blocked_reason_at_attempt, blocked_reason),
             missing_fields_at_attempt = COALESCE(missing_fields_at_attempt, missing_fields)
       WHERE blocked_reason_at_attempt IS NULL
          OR missing_fields_at_attempt IS NULL
    $sql$;
  END IF;
END $$;

-- Trava de segurança — e agora ela é ALCANÇÁVEL.
--
-- ⚠️ Correção de uma premissa errada que esta própria migration afirmava: dizia que
-- "sobrar linha sem valor é impossível porque `blocked_reason` é NOT NULL desde a
-- 209". A 332 **deste mesmo PR** derruba esse NOT NULL (ela precisa: o código novo
-- escreve só as colunas `*_at_attempt`). Ou seja, durante a janela o banco ACEITA
-- tentativa sem motivo nenhum, e o COALESCE não tem de onde recuperar.
--
-- Se isso acontecer, dropar as colunas antigas apagaria a única pista do que era
-- aquela linha. Melhor abortar e alguém olhar.
DO $$
DECLARE v_pendentes INT;
BEGIN
  SELECT COUNT(*) INTO v_pendentes
    FROM worker_blocked_applications
   WHERE blocked_reason_at_attempt IS NULL;
  IF v_pendentes > 0 THEN
    RAISE EXCEPTION
      'ABORTADO: % linha(s) sem blocked_reason_at_attempt e sem blocked_reason para recuperar. '
      'Dropar agora apagaria a única pista do que era essa tentativa. '
      'Investigue essas linhas antes de liberar esta migration.', v_pendentes;
  END IF;
END $$;

-- O índice morre junto: ele existia para servir `WHERE blocked_reason = ...`, que
-- é justamente a consulta que não deve mais existir. Deixá-lo seria manter o
-- convite de pé apontando para uma coluna que já não responde a pergunta certa.
DROP INDEX IF EXISTS idx_wba_blocked_reason;

ALTER TABLE worker_blocked_applications
  DROP COLUMN IF EXISTS blocked_reason,
  DROP COLUMN IF EXISTS missing_fields;

-- Agora os invariantes da coluna antiga cabem, e TODOS entram: NOT NULL nas duas
-- (a 209 exigia isso desde sempre) e o DEFAULT que a 332 deliberadamente adiou
-- para não estragar o backfill da janela.
UPDATE worker_blocked_applications
   SET missing_fields_at_attempt = '[]'::jsonb
 WHERE missing_fields_at_attempt IS NULL;

ALTER TABLE worker_blocked_applications
  ALTER COLUMN blocked_reason_at_attempt SET NOT NULL,
  ALTER COLUMN missing_fields_at_attempt SET NOT NULL,
  ALTER COLUMN missing_fields_at_attempt SET DEFAULT '[]'::jsonb;

COMMIT;
