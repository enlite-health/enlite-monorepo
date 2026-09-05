-- 304_drop_transit_stops.sql
-- Remove `transit_stops`, criada pela 303 e nunca usada.
--
-- POR QUÊ: a 303 nasceu para um desenho que foi DESCARTADO no mesmo dia. A rota
-- de transporte público passou a ser calculada pelo Google Directions, porta a
-- porta (decisão do Gabriel, 05/09 — ver `.claude/docs/autorizacao-google-directions.md`),
-- e a tabela de paradas deixou de ter qualquer leitor.
--
-- Ela chegou a ser criada em produção pelo deploy do PR #300, mas NUNCA foi
-- carregada: ficou vazia e sem consulta. Então isto não é deprecação de algo em
-- uso — é remover uma tabela que nunca teve dado nem chamador, que é
-- exatamente o lixo que a regra "migrações são aditivas" existe para evitar
-- acumular.
--
-- A 303 fica no repositório de propósito: ela foi aplicada em produção e está
-- registrada em `schema_migrations`. Apagar o arquivo esconderia um passo que
-- de fato aconteceu; o par 303→304 conta a história certa.
--
-- Idempotente: IF EXISTS.

BEGIN;

DROP TABLE IF EXISTS transit_stops;

COMMIT;
