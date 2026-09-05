-- 412 — o motivo da concessão de país deixa de ser obrigatório
--
-- Decisão do Gabriel (05/09/2026): "não faz sentido o Motivo do país. Ninguém
-- faz um grupo e coloca motivo por ser apenas de um país ou dos dois."
--
-- Ele tem razão sobre o instrumento: um campo obrigatório que ninguém consegue
-- preencher com conteúdo real colhe "ok" e "." — e uma coluna que sempre tem a
-- mesma coisa PARECE trilha sem ser. O que a trilha precisa responder é QUEM
-- concedeu, QUANDO e ATÉ QUANDO, e isso já está em `granted_by`, `created_at` e
-- `revoked_at`.
--
-- Parecer do `lex` (05/09): CONDICIONADO. As condições que tocam SQL estão aqui;
-- as documentais estão no runbook e no registro de operações, no mesmo commit.
--
--   C1 — estritamente aditiva: só `DROP NOT NULL`. É PROIBIDO `DROP COLUMN` e é
--        PROIBIDO `UPDATE ... SET reason = NULL` nas linhas existentes: o que já
--        foi escrito continua escrito, e a contagem de linhas com motivo tem de
--        ser a mesma antes e depois. [LGPD art. 37; retenção de 6 anos da mig 280]
--   C2 — a coluna sozinha NÃO basta. `iam.grant_country` levanta 23502 por conta
--        própria (mig 279:215-217); sem trocar a função, o botão dá erro em
--        runtime e a mudança fica pela metade — e meia-trava faz o operador
--        contornar.
--
-- Idempotente e re-rodável: `DROP NOT NULL` em coluna já nullable é no-op, e a
-- função vai por `CREATE OR REPLACE`.

BEGIN;

-- ── C1 ────────────────────────────────────────────────────────────────────────
ALTER TABLE iam.group_country_scopes ALTER COLUMN reason DROP NOT NULL;

COMMENT ON COLUMN iam.group_country_scopes.reason IS
  'Justificativa da concessão — OPCIONAL desde a mig 412. A trilha de quem/quando/até-quando é granted_by + created_at + revoked_at; a finalidade da classe está declarada no registro-operacoes (OP de group_country_scopes). Linhas antigas mantêm o texto que tinham.';

-- ── C2 ────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION iam.grant_country(p_group_id UUID, p_country VARCHAR, p_reason TEXT)
RETURNS UUID
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = pg_catalog, iam, public
AS $$
DECLARE
  v_g iam.permission_groups%ROWTYPE;
  v_actor VARCHAR;
  v_id UUID;
BEGIN
  SELECT * INTO v_g FROM iam.permission_groups WHERE id = p_group_id AND archived_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE = 'P0002', MESSAGE = '[iam] grupo inexistente ou arquivado'; END IF;
  v_actor := iam._require_manager(v_g.tenant_id);
  -- O 23502 de "concessão de país exige motivo" sai daqui (mig 412). O que NÃO
  -- sai é o resto do guarda: grupo vivo, ator gestor, e a idempotência abaixo.
  -- Motivo em branco vira NULL para não gravar string vazia, que é um terceiro
  -- estado sem significado ("não escreveu" e "escreveu nada" seriam distintos).
  SELECT id INTO v_id FROM iam.group_country_scopes
   WHERE group_id = p_group_id AND country = p_country AND revoked_at IS NULL;
  IF FOUND THEN RETURN v_id; END IF;
  INSERT INTO iam.group_country_scopes (group_id, country, granted_by, reason)
  VALUES (p_group_id, p_country, v_actor, NULLIF(btrim(coalesce(p_reason, '')), ''))
  RETURNING id INTO v_id;
  RETURN v_id;
END;
$$;

COMMIT;
