-- 285_actor_class_external_third_party.sql
--
-- ⚠️ TODO NOME É QUALIFICADO COM `iam.`, E ISSO NÃO É ESTILO. A migration 274
-- moveu estas tabelas para o schema `iam` E DEIXOU VIEWS DE COMPATIBILIDADE em
-- `public` com os mesmos nomes. Sem qualificar, `ALTER TABLE permission_groups`
-- resolve para a VIEW e falha — foi o que quebrou o e2e na primeira tentativa.
--
-- POR QUÊ (C9 do veredito do `lex`): o Diego já anunciou plano de saúde no
-- sistema (`2026-07-27a#PEND-03`). No dia em que um terceiro receber acesso ao
-- painel, dar a ele um grupo comum entrega o dossiê do prestador — e cessão a
-- terceiro NÃO é acesso interno: é outro regime (25.326 art. 11.1; LGPD art. 11
-- §4/§5). A classe do ator nasce ANTES do primeiro grupo externo existir,
-- porque depois já é tarde: o grupo estaria criado e concedido.
--
-- ⚠️ POR QUE NO BANCO, e não numa lista no código: a C9 diz **invariante por
-- teste, não por convenção**. Teste guarda o código de hoje; um `INSERT` manual
-- num runbook, um script de migração de dados ou a própria tela do painel
-- passariam por cima dele. O trigger vale para toda escrita, venha de onde vier
-- — inclusive de mim com o psql aberto às duas da manhã.
--
-- O que a classe NÃO faz: não substitui célula. Um grupo externo continua
-- precisando das células que tiver; a classe só remove do cardápio o que nunca
-- pode ser concedido a terceiro.

ALTER TABLE iam.permission_groups
  ADD COLUMN IF NOT EXISTS actor_class VARCHAR(32) NOT NULL DEFAULT 'INTERNAL';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'permission_groups_actor_class_ck'
  ) THEN
    ALTER TABLE iam.permission_groups
      ADD CONSTRAINT permission_groups_actor_class_ck
      CHECK (actor_class IN ('INTERNAL', 'EXTERNAL_THIRD_PARTY'));
  END IF;
END
$$;

COMMENT ON COLUMN iam.permission_groups.actor_class IS
  'INTERNAL = colaborador da Enlite. EXTERNAL_THIRD_PARTY = terceiro (plano de '
  'saúde, parceiro): cessão de dado, regime do art. 11.1 da 25.326 e art. 11 '
  'da LGPD. Default INTERNAL porque todo grupo de hoje é interno — e um default '
  'EXTERNAL faria grupo novo nascer sem poder receber célula, quebrando o painel.';

-- ── As células que terceiro NUNCA recebe ────────────────────────────────────
CREATE OR REPLACE FUNCTION iam.celulas_vedadas_a_terceiro()
RETURNS TEXT[] LANGUAGE sql IMMUTABLE
SET search_path = pg_catalog
AS $$ SELECT ARRAY[
  'worker_pii:read',       -- dossiê: DNI, nascimento, endereço, raça, religião, orientação
  'worker:export',         -- massa: tira o cadastro do perímetro num arquivo
  'worker_document:read',  -- os documentos em si
  'patient:read',          -- paciente é dado de saúde por referência
  'patient:write',
  'patient:delete'
] $$;

REVOKE ALL ON FUNCTION iam.celulas_vedadas_a_terceiro() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    GRANT EXECUTE ON FUNCTION iam.celulas_vedadas_a_terceiro() TO app_runtime, app_system;
  END IF;
END
$$;

-- ── O invariante, nas DUAS direções ─────────────────────────────────────────
-- Direção 1: conceder célula vedada a um grupo que JÁ é externo.
-- Direção 2: tornar externo um grupo que JÁ tem célula vedada.
-- Guardar só a direção 1 deixaria a porta aberta pela 2 — que é justamente o
-- caminho que alguém tomaria para "aproveitar um grupo que já existe".

CREATE OR REPLACE FUNCTION iam.trg_veda_celula_a_terceiro()
RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = pg_catalog, iam, public
AS $$
DECLARE
  v_classe TEXT;
  v_celula TEXT;
BEGIN
  SELECT g.actor_class INTO v_classe
    FROM iam.permission_groups g WHERE g.id = NEW.group_id;

  IF v_classe IS DISTINCT FROM 'EXTERNAL_THIRD_PARTY' THEN
    RETURN NEW;
  END IF;

  SELECT p.resource || ':' || p.action INTO v_celula
    FROM iam.permissions p WHERE p.id = NEW.permission_id;

  IF v_celula = ANY (iam.celulas_vedadas_a_terceiro()) THEN
    RAISE EXCEPTION
      'celula % nao pode ser concedida a grupo EXTERNAL_THIRD_PARTY (C9: cessao a terceiro e outro regime)',
      v_celula
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS veda_celula_a_terceiro ON iam.group_permissions;
CREATE TRIGGER veda_celula_a_terceiro
  BEFORE INSERT OR UPDATE ON iam.group_permissions
  FOR EACH ROW EXECUTE FUNCTION iam.trg_veda_celula_a_terceiro();

CREATE OR REPLACE FUNCTION iam.trg_veda_virar_externo()
RETURNS TRIGGER LANGUAGE plpgsql
SET search_path = pg_catalog, iam, public
AS $$
DECLARE
  v_celula TEXT;
BEGIN
  IF NEW.actor_class IS NOT DISTINCT FROM OLD.actor_class
     OR NEW.actor_class <> 'EXTERNAL_THIRD_PARTY' THEN
    RETURN NEW;
  END IF;

  SELECT p.resource || ':' || p.action INTO v_celula
    FROM iam.group_permissions gp
    JOIN iam.permissions p ON p.id = gp.permission_id
   WHERE gp.group_id = NEW.id
     AND p.resource || ':' || p.action = ANY (iam.celulas_vedadas_a_terceiro())
   LIMIT 1;

  IF v_celula IS NOT NULL THEN
    RAISE EXCEPTION
      'grupo nao pode virar EXTERNAL_THIRD_PARTY: ja tem a celula vedada % (C9)',
      v_celula
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS veda_virar_externo ON iam.permission_groups;
CREATE TRIGGER veda_virar_externo
  BEFORE UPDATE ON iam.permission_groups
  FOR EACH ROW EXECUTE FUNCTION iam.trg_veda_virar_externo();
