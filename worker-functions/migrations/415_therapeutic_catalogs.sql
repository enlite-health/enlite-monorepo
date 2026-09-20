-- 415 — Catálogos do Projeto Terapêutico (spec 017, D299 itens 2 e 3; lex 08/09 C18/C19)
--
-- Três listas que o operador escolhe no projeto terapêutico e que a coordenação MANTÉM pelo
-- backoffice (uma tela e uma célula por catálogo — decisão do Gabriel, 08/09):
--   · therapeutic_specific_objectives — "Objetivos Específicos" (seção VI do documento)
--   · therapeutic_activities          — "Rutina y Actividades" (seção VII)
--   · pathology_types                 — "Tipo de patología (segmento)" — a máscara do Ana Care
--                                       (`2026-08-26a#DEC-09`); o rótulo "ICHOM" NÃO existe aqui
--                                       nem na tela (D299.2: a lista é adaptação local, e o ICHOM
--                                       exige licença de uso).
--
-- ── Por que tabela e não enum no código ──────────────────────────────────────
-- Mesmo motivo dos papéis de grupo (262) e dos tipos de dispositivo (307): a operação muda a
-- lista toda semana; enum = migration + deploy a cada mudança. O projeto terapêutico grava o
-- SNAPSHOT do texto escolhido (416), então renomear uma opção aqui não reescreve versão antiga.
--
-- ── Sem `country`, sem PHI (lex C18) ─────────────────────────────────────────
-- As três tabelas são GLOBAIS (AR e BR veem a mesma lista) e por desenho não carregam dado de
-- titular. A guarda contra texto pessoal digitado no rótulo é do servidor
-- (`containsLikelyPersonalData`, molde do `reason` de concessão de país) + o teto abaixo. Até a
-- guarda existir no código, as três ficam FORA do `enlite_mcp_ro` (create-mcp-ro-role.sql).
--
-- ── Baixa é `active=false` + `deactivated_at`, nunca DELETE ──────────────────
-- Versões antigas do projeto apontam para o id (e guardam o texto). O CHECK abaixo é o mesmo
-- molde `device_types_retired_coerente` (307).
--
-- Rollback: DROP TABLE das três — nascem nesta árvore; o seed é o do documento de referência.

DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY['therapeutic_specific_objectives', 'therapeutic_activities', 'pathology_types'] LOOP
    EXECUTE format($sql$
      CREATE TABLE IF NOT EXISTS %I (
        id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
        label          TEXT         NOT NULL,
        sort_order     INT          NOT NULL DEFAULT 0,
        active         BOOLEAN      NOT NULL DEFAULT true,
        deactivated_at TIMESTAMPTZ  NULL,
        created_by     VARCHAR(128) NOT NULL DEFAULT 'seed:415',
        updated_by     VARCHAR(128) NOT NULL DEFAULT 'seed:415',
        created_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        updated_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
        CONSTRAINT %I CHECK (length(btrim(label)) BETWEEN 1 AND 200),
        CONSTRAINT %I CHECK ((active AND deactivated_at IS NULL) OR (NOT active AND deactivated_at IS NOT NULL))
      )$sql$, t, t || '_label_len', t || '_active_coerente');
    -- Rótulo único entre os ATIVOS (case-insensitive): desativar e recriar com o mesmo texto é permitido.
    EXECUTE format('CREATE UNIQUE INDEX IF NOT EXISTS %I ON %I (lower(btrim(label))) WHERE active', 'uq_' || t || '_label_ativo', t);
    EXECUTE format('CREATE INDEX IF NOT EXISTS %I ON %I (active, sort_order)', 'idx_' || t || '_ordem', t);
  END LOOP;
END
$$;

COMMENT ON TABLE therapeutic_specific_objectives IS
  'Catálogo global (sem país, sem PHI) dos objetivos específicos do projeto terapêutico (spec 017). '
  'Baixa = active=false + deactivated_at, nunca DELETE: versões antigas apontam para o id. Rótulo passa '
  'pela guarda de dado pessoal no servidor (lex C18).';
COMMENT ON TABLE therapeutic_activities IS
  'Catálogo global (sem país, sem PHI) da rotina e atividades do projeto terapêutico (spec 017). Mesmas regras.';
COMMENT ON TABLE pathology_types IS
  'Catálogo global do "Tipo de patología (segmento)" do projeto terapêutico — a máscara do Ana Care '
  '(2026-08-26a#DEC-09). Adaptação local; NÃO é a lista do ICHOM e não leva esse rótulo (D299.2).';

-- ── Seed: seções VI e VII do documento de referência (texto genérico de cuidado, sem dado de
--    titular) e as 8 opções do Figma. Idempotente pelo índice único de rótulo ativo. ──────────
INSERT INTO therapeutic_specific_objectives (label, sort_order) VALUES
  ('Favorecer la prevención de escaras y otras complicaciones derivadas de la inmovilidad mediante cambios posturales, higiene y cuidados corporales adecuados.', 10),
  ('Estimular la participación del paciente en actividades cotidianas y recreativas que promuevan mayor conexión con el entorno.', 20),
  ('Promover salidas terapéuticas y momentos de socialización acordes a sus posibilidades físicas y médicas.', 30),
  ('Favorecer la correcta alimentación e hidratación, reduciendo riesgos asociados a la deglución y acompañando las indicaciones médicas y fonoaudiológicas.', 40),
  ('Incentivar el uso de la silla de ruedas y la permanencia fuera de la cama siempre que las condiciones físicas lo permitan.', 50),
  ('Brindar estimulación cognitiva y sensorial diaria para evitar el aislamiento y favorecer el registro del entorno.', 60),
  ('Acompañar y reforzar la continuidad de los tratamientos interdisciplinarios indicados (kinesiología, terapia ocupacional y fonoaudiología).', 70),
  ('Promover espacios de escucha, contención emocional y acompañamiento afectivo para favorecer el bienestar subjetivo del paciente.', 80)
ON CONFLICT DO NOTHING;

INSERT INTO therapeutic_activities (label, sort_order) VALUES
  ('Realizar cambios posturales frecuentes.', 10),
  ('Acompañar en la higiene y cuidado corporal diario.', 20),
  ('Supervisar alimentación e hidratación según indicaciones profesionales.', 30),
  ('Estimular conversación y orientación temporoespacial.', 40),
  ('Proponer actividades recreativas simples (música, lectura, fotografías, juegos cognitivos).', 50),
  ('Favorecer momentos fuera de la cama en silla de ruedas.', 60),
  ('Acompañar en salidas breves al exterior o espacios abiertos.', 70),
  ('Promover estimulación sensorial y cognitiva diaria.', 80),
  ('Facilitar participación en rutinas cotidianas.', 90),
  ('Acompañar durante ejercicios indicados por kinesiólogo/TO.', 100),
  ('Observar y registrar cambios físicos, emocionales o conductuales.', 110),
  ('Favorecer la interacción social y el contacto con familiares.', 120),
  ('Mantener un entorno seguro, ordenado y estimulante.', 130)
ON CONFLICT DO NOTHING;

INSERT INTO pathology_types (label, sort_order) VALUES
  ('TDAH', 10),
  ('Trastorno del Espectro Autista', 20),
  ('Adicción', 30),
  ('Trastorno alimentario', 40),
  ('Depresión y ansiedad', 50),
  ('Depresión - Ansiedad / Pediátrica', 60),
  ('Trastornos de personalidad', 70),
  ('Trastornos psicóticos', 80)
ON CONFLICT DO NOTHING;
