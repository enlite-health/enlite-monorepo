-- 301_workers_ana_care_email_alias.sql
-- Marca de que o cadastro no Ana Care nasceu com um ALIAS de e-mail (`+1`) em vez
-- do endereço real do prestador.
--
-- POR QUÊ: o Ana Care exige e-mail único no SISTEMA INTEIRO, mas a nossa chave de
-- API só enxerga a nossa agência. Quando a pessoa já está cadastrada em outra
-- empresa, o POST é recusado (`No es posible usar este correo electrónico`) e o
-- prestador nunca chega lá — não entra em caso e não é alocado. Medido em 18/08/2026:
-- 11 pessoas nessa situação, ~3 a 4 novas por mês, e nenhum caminho de vínculo na
-- API nem no painel deles (verificado por login no admin: a busca por correo responde
-- "Usuario registrado en otra empresa" e não oferece ação nenhuma).
--
-- A saída é criar com um alias (`fulano+1@gmail.com`), que o provedor entrega na
-- MESMA caixa — o contato segue funcionando. Já havia precedente feito à mão na
-- própria base deles (nurse 89691).
--
-- Esta coluna existe para o alias não ficar só do lado do Ana Care: guarda o endereço
-- realmente usado, para a coordenação saber que aquele cadastro precisa de resolução
-- (com o Ana Care ou com o prestador) e para a fila ser CONTÁVEL do nosso lado.
-- NULL = cadastro normal, com o e-mail real.
--
-- Numeração: 301. Esta migration foi escrita em 18/08/2026 como 283 para pular a faixa
-- 268..282, que a `stage` ocupava; ficou parada 13 dias e nesse meio-tempo o `main`
-- consumiu até a 300 — inclusive a própria 283. Renumerada na retomada (01/09/2026).
--
-- Idempotente: IF NOT EXISTS.

BEGIN;

ALTER TABLE workers ADD COLUMN IF NOT EXISTS ana_care_email_alias TEXT;

COMMENT ON COLUMN workers.ana_care_email_alias IS
  'E-mail alternativo (alias +N) usado para criar o cadastro no Ana Care quando o endereço real já pertencia a um profissional de OUTRA empresa na plataforma. NULL = cadastro criado com o e-mail real. Preenchido por AnaCareMirrorProvider; sinaliza à coordenação que o cadastro precisa de resolução com o Ana Care ou com o prestador.';

COMMIT;
