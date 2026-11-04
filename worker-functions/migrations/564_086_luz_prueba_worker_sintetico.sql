-- 564 — spec 086 (DF-7): a prestadora SINTÉTICA da Luz (prueba) — 1 linha fixa em `workers`
--
-- Quem testa a Luz no app fala COMO esta prestadora; as ferramentas de leitura da Luz (porta `agent:luz`, `worker.byPhone`) a acham pelo
-- telefone. `+5490000000000` não é roteável (nenhuma mensagem real chega a ele). `is_test = true` (migration 224) a marca como teste.
--
-- ── O que a linha TEM e o que NÃO tem (medido em 04/11 no schema local, `\d workers`) ──────────────────────────────────────
-- · `auth_uid` é NOT NULL UNIQUE: recebe um texto fixo que NÃO é uid do Firebase (nenhum login resolve a ele — ninguém entra como ela).
-- · `phone` é TEXTO CLARO (varchar 20, `idx_workers_phone_unique` parcial) e é por ele que `worker.byPhone` busca (`generatePhoneCandidates`
--   cobre `+5490000000000` e `5490000000000`): a migration produz o valor que a busca procura. Sem cifra e sem blind index de telefone.
-- · NOME: `first_name_encrypted`/`last_name_encrypted` são KMS e `name_trgm_bidx` é HMAC com chave do Secret Manager — só a aplicação
--   os produz, SQL não. A linha nasce SEM nome e SEM índice de nome: o rótulo "Prueba Luz PRUEBA" vem do triage (`prestadora.nome`),
--   e a sintética NÃO aparece na busca por nome do painel (DF-8 atendida só em parte; vai para a LISTA da spec).
-- · status = INCOMPLETE_REGISTER (default): não dispara o espelho do Ana Care (que nasce na transição para REGISTERED) nem outbox algum
--   (`trg_talent_search_welcome` só age com data_sources ∋ 'talent_search', que a linha não tem).
--
-- Idempotente: `ON CONFLICT DO NOTHING` (auth_uid, email ou phone já existentes) — a 2ª execução insere 0 linhas.
-- Roda como enlite_app (dono de `workers`); sem BEGIN/COMMIT próprio (o runner envolve).
-- Rollback: `migrations/pending/ROLLBACK_564_086_luz_prueba_worker_sintetico.sql`.

INSERT INTO workers (auth_uid, phone, country, is_test)
VALUES ('prueba-luz-086-sin-firebase', '+5490000000000', 'AR', true)
ON CONFLICT DO NOTHING;
