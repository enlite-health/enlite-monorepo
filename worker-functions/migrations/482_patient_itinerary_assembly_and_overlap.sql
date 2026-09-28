-- 482 — o montado (log), a folga e a trava de sobreposição do itinerário do paciente
-- (cadeia-paciente-vacante-itinerario, Fase 11; DX-11.2, DX-11.3; D433 invariantes 4/5/8,
-- D434).
--
-- ── O montado é LOG, não flag em `patients` ──────────────────────────────────
-- `patients` é a tabela mais larga e mais disputada do sistema. "Está montado" =
-- existe linha em `patient_itinerary_assembly` (com autoria e hora); marcar de novo
-- grava linha nova — nunca reescreve a anterior. Sem DELETE, sem UPDATE (log
-- append-only; o GRANT abaixo só dá SELECT/INSERT).
--
-- ── Por que gatilho e não restrição de exclusão por índice gist ──────────────
-- A stage não tem a extensão de btree para gist instalada (medido no Passo 0,
-- passo-0.md:185-196) — instalar extensão em produção é decisão à parte, fora
-- do escopo desta fase. E a folga depende do endereço: ela só se aplica ENTRE
-- ENDEREÇOS DIFERENTES (`endereço_a <> endereço_b`); no MESMO endereço as
-- faixas só não podem se sobrepor. Uma restrição de exclusão por índice não
-- expressa essa condição — precisaria de dois predicados distintos, um deles
-- dependente de uma junção (o endereço vem de `patient_contracted_services`,
-- não da própria linha). Um gatilho `BEFORE INSERT OR UPDATE` +
-- `pg_advisory_xact_lock` (padrão já em uso, 279:83) resolve os dois casos com
-- uma função só.
--
-- ── Extensível pela Fase 13 ───────────────────────────────────────────────────
-- O filtro de vigência da trava já é por INTERVALO DE DATAS (`valid_from`/`valid_to`
-- das duas linhas, não só "está ativo agora") — a substituição datada da Fase 13
-- entra como mais um conjunto de intervalos no MESMO gatilho, não pede uma 2ª trava.
--
-- ── A folga mora num lugar só ─────────────────────────────────────────────────
-- `itinerary_min_gap_minutes()` é a ÚNICA definição da folga mínima entre endereços
-- diferentes. O TypeScript nunca guarda esse número — o 409 da aplicação lê o
-- `DETAIL` que a própria trava monta (`minGapMinutes`). Mudar a folga é mudar só
-- esta função.
--
-- ── A chave do slot fica imutável depois de nascer ────────────────────────────
-- A trava de sobreposição roda na ALOCAÇÃO; um `UPDATE` do horário do slot por baixo
-- de uma alocação viva contornaria a trava sem passar por ela. Hoje nada faz esse
-- UPDATE (`syncItinerarySlots` só insere/reativa/desativa, nunca muda a chave de um
-- slot existente) — a trava da chave não muda comportamento vivo; ela fecha a porta
-- para sempre.
--
-- Idempotente (2×): `IF NOT EXISTS` / `DROP … IF EXISTS` / `CREATE OR REPLACE` antes
-- de cada objeto. Sem `BEGIN/COMMIT` próprio (molde 481/480/476).
--
-- Rollback: `migrations/pending/ROLLBACK_482_patient_itinerary_assembly_and_overlap.sql`
-- (trava de dado: recusa se houver linha no montado; rodar ANTES do
-- `ROLLBACK_480_patient_itinerary.sql` — os dois triggers novos moram nas tabelas da 480).

-- ── patient_itinerary_assembly (o "montado") ──────────────────────────────────
CREATE TABLE IF NOT EXISTS patient_itinerary_assembly (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  patient_id   UUID         NOT NULL REFERENCES patients(id) ON DELETE CASCADE,
  assembled_at TIMESTAMPTZ  NOT NULL DEFAULT now(),
  assembled_by VARCHAR(128) NOT NULL,
  country      TEXT         NULL,  -- etapa 1: trigger abaixo preenche; etapa 2: NOT NULL; etapa 3: CHECK
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_pi_assembly_patient ON patient_itinerary_assembly (patient_id, assembled_at DESC);

-- ── country: 3 etapas (molde 480:112-155) ────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_patient_itinerary_assembly_country_from_patient()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.country IS NULL THEN
    SELECT p.country INTO NEW.country FROM patients p WHERE p.id = NEW.patient_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_patient_itinerary_assembly_country ON patient_itinerary_assembly;
CREATE TRIGGER trg_patient_itinerary_assembly_country
  BEFORE INSERT ON patient_itinerary_assembly
  FOR EACH ROW EXECUTE FUNCTION fn_patient_itinerary_assembly_country_from_patient();

-- Etapa 2: NOT NULL só depois do trigger existir (a tabela nasce vazia nesta árvore).
ALTER TABLE patient_itinerary_assembly ALTER COLUMN country SET NOT NULL;

-- Etapa 3: CHECK do país.
ALTER TABLE patient_itinerary_assembly DROP CONSTRAINT IF EXISTS pia_asm_country_check;
ALTER TABLE patient_itinerary_assembly
  ADD CONSTRAINT pia_asm_country_check CHECK (country IN ('AR', 'BR'));

-- ── RLS: segue o paciente (molde 480:204-213) ─────────────────────────────────
ALTER TABLE patient_itinerary_assembly ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS patient_itinerary_assembly_follow_patient ON patient_itinerary_assembly;
CREATE POLICY patient_itinerary_assembly_follow_patient ON patient_itinerary_assembly FOR ALL USING (
  (
    NULLIF(current_setting('app.system_context', true), '') IS NOT NULL
    AND pg_has_role(current_user, 'app_system', 'MEMBER')
  )
  OR EXISTS (SELECT 1 FROM patients p WHERE p.id = patient_itinerary_assembly.patient_id)
);

-- ── GRANT/REVOKE — log append-only: só SELECT/INSERT para o app ─────────────
GRANT SELECT, INSERT ON patient_itinerary_assembly TO app_runtime, app_system;
REVOKE UPDATE, DELETE ON patient_itinerary_assembly FROM app_runtime, app_system;

COMMENT ON TABLE patient_itinerary_assembly IS
  'O itinerário marcado como montado (Fase 11, DX-11.2; D433 invariantes 4/5/8, D434). LOG, não '
  'flag em patients: marcar de novo grava linha nova, nunca reescreve a anterior. Sem DELETE, sem '
  'UPDATE (só SELECT/INSERT para o app). Rollback: '
  'migrations/pending/ROLLBACK_482_patient_itinerary_assembly_and_overlap.sql (rodar ANTES do '
  'ROLLBACK_480_patient_itinerary.sql).';
COMMENT ON COLUMN patient_itinerary_assembly.country IS
  'Herdado de patients.country por trigger (etapa 1/3). NOT NULL (etapa 2/3) + CHECK AR/BR (etapa 3/3).';

-- ── itinerary_min_gap_minutes(): a ÚNICA definição da folga ───────────────────
CREATE OR REPLACE FUNCTION itinerary_min_gap_minutes()
RETURNS integer
LANGUAGE sql
IMMUTABLE PARALLEL SAFE
AS $$ SELECT 60 $$;

COMMENT ON FUNCTION itinerary_min_gap_minutes() IS
  'Folga mínima entre endereços diferentes, D434. Mudar a folga é mudar só esta função — nenhuma '
  'outra parte do sistema guarda esse número.';

-- ── fn_patient_itinerary_assignment_no_overlap(): a trava ─────────────────────
-- SECURITY DEFINER: a trava vale "em qualquer serviço de QUALQUER paciente". Rodando
-- como o chamador (app_runtime, sob a RLS da 480), a policy
-- `patient_itinerary_assignment_follow_slot` esconderia a alocação do mesmo
-- prestador num paciente de outro país e a trava falharia ABERTA. Como dono da
-- tabela (não-FORCE), a função vê tudo; ela nunca devolve linha ao chamador, só NEW
-- ou o erro. `search_path` fixo, nenhum `current_user`/`pg_has_role` no corpo
-- (memória security-definer-current-user-e-o-dono); `REVOKE ALL … FROM PUBLIC`
-- abaixo é higiene (função de trigger não é chamável direto).
CREATE OR REPLACE FUNCTION fn_patient_itinerary_assignment_no_overlap()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_gap               INT := itinerary_min_gap_minutes();
  v_weekday           SMALLINT;
  v_start_time        TIME;
  v_end_time          TIME;
  v_start_min         INT;
  v_end_min           INT;
  v_service_id        UUID;
  v_address_id        UUID;
  v_c_id               UUID;
  v_c_service_id       UUID;
  v_c_weekday          SMALLINT;
  v_c_start_time       TIME;
  v_c_end_time         TIME;
  v_c_start_min        INT;
  v_c_end_min          INT;
  v_c_address_id        UUID;
  v_same_address        BOOLEAN;
BEGIN
  -- (i) deferências às constraints nativas (ressalva c', DX-11.3): esta trigger
  -- roda BEFORE ROW e é avaliada ANTES do NOT NULL/CHECK/UNIQUE da própria linha —
  -- se lançar exceção aqui sem checar isso, o Postgres nunca chega a avaliar
  -- 23502 (NOT NULL), 23514 (pia_valid_range) ou 23505 (uq_pia_open_pair).
  IF NEW.status IS DISTINCT FROM 'ACTIVE' THEN
    RETURN NEW; -- encerrar/cancelar nunca é barrado pela trava
  END IF;

  IF NEW.slot_id IS NULL OR NEW.worker_id IS NULL OR NEW.valid_from IS NULL THEN
    RETURN NEW; -- deixa o NOT NULL da coluna decidir
  END IF;

  IF NEW.valid_to IS NOT NULL AND NEW.valid_to < NEW.valid_from THEN
    RETURN NEW; -- deixa pia_valid_range decidir
  END IF;

  -- (ii) serializa por prestador: duas alocações concorrentes do mesmo worker se
  -- enfileiram (molde 279:83) — a 2ª só lê depois do COMMIT da 1ª.
  PERFORM pg_advisory_xact_lock(hashtext('itinerary:worker:' || NEW.worker_id::text));

  -- (iii) o slot novo, com o endereço do SERVIÇO (invariante 8 — nunca cópia).
  SELECT s.weekday, s.start_time, s.end_time,
         (extract(epoch FROM s.start_time) / 60)::int,
         (extract(epoch FROM s.end_time) / 60)::int,
         s.contracted_service_id, pcs.address_id
    INTO v_weekday, v_start_time, v_end_time, v_start_min, v_end_min, v_service_id, v_address_id
    FROM patient_itinerary_slot s
    JOIN patient_contracted_services pcs ON pcs.id = s.contracted_service_id
    WHERE s.id = NEW.slot_id;

  IF NOT FOUND THEN
    RETURN NEW; -- deixa a FK de slot_id decidir
  END IF;

  -- (iv) procura UMA alocação conflitante do mesmo prestador.
  SELECT a.id, s2.contracted_service_id, s2.weekday, s2.start_time, s2.end_time,
         (extract(epoch FROM s2.start_time) / 60)::int,
         (extract(epoch FROM s2.end_time) / 60)::int,
         pcs2.address_id
    INTO v_c_id, v_c_service_id, v_c_weekday, v_c_start_time, v_c_end_time,
         v_c_start_min, v_c_end_min, v_c_address_id
    FROM patient_itinerary_assignment a
    JOIN patient_itinerary_slot s2 ON s2.id = a.slot_id
    JOIN patient_contracted_services pcs2 ON pcs2.id = s2.contracted_service_id
    WHERE a.worker_id = NEW.worker_id
      AND a.status = 'ACTIVE'
      AND a.id <> NEW.id
      -- esse par (mesmo slot, os dois sem fim) é do uq_pia_open_pair → 23505 (ressalva c')
      AND NOT (a.slot_id = NEW.slot_id AND a.valid_to IS NULL AND NEW.valid_to IS NULL)
      AND s2.weekday = v_weekday
      -- vigência por INTERVALO DE DATAS — é aqui que a Fase 13 estende
      AND a.valid_from <= COALESCE(NEW.valid_to, 'infinity'::date)
      AND COALESCE(a.valid_to, 'infinity'::date) >= NEW.valid_from
      AND (
        -- mesmo endereço: só não pode SOBREPOR
        (pcs2.address_id IS NOT NULL AND pcs2.address_id = v_address_id
          AND (extract(epoch FROM s2.start_time) / 60)::int < v_end_min
          AND v_start_min < (extract(epoch FROM s2.end_time) / 60)::int)
        OR
        -- endereços diferentes ou algum NULL (conservador: exige folga)
        (NOT (pcs2.address_id IS NOT NULL AND pcs2.address_id = v_address_id)
          AND (extract(epoch FROM s2.start_time) / 60)::int < v_end_min + v_gap
          AND v_start_min < (extract(epoch FROM s2.end_time) / 60)::int + v_gap)
      )
    ORDER BY s2.start_time
    LIMIT 1;

  IF v_c_id IS NULL THEN
    RETURN NEW;
  END IF;

  v_same_address := (v_address_id IS NOT NULL AND v_c_address_id = v_address_id);

  -- (v) 23P01 (exclusion_violation — a classe que um EXCLUDE daria); DETAIL só com
  -- ids de serviço, dia e horário — nenhum nome, nenhum endereço, nada clínico.
  RAISE EXCEPTION 'itinerary_overlap' USING
    ERRCODE = '23P01',
    DETAIL = json_build_object(
      'existingServiceId', v_c_service_id,
      'existingWeekday', v_c_weekday,
      'existingStart', to_char(v_c_start_time, 'HH24:MI'),
      'existingEnd', to_char(v_c_end_time, 'HH24:MI'),
      'requestedServiceId', v_service_id,
      'requestedWeekday', v_weekday,
      'requestedStart', to_char(v_start_time, 'HH24:MI'),
      'requestedEnd', to_char(v_end_time, 'HH24:MI'),
      'sameAddress', v_same_address,
      'minGapMinutes', CASE WHEN v_same_address THEN NULL ELSE v_gap END
    )::text;
END;
$$;

REVOKE ALL ON FUNCTION fn_patient_itinerary_assignment_no_overlap() FROM PUBLIC;

DROP TRIGGER IF EXISTS trg_patient_itinerary_assignment_no_overlap ON patient_itinerary_assignment;
CREATE TRIGGER trg_patient_itinerary_assignment_no_overlap
  BEFORE INSERT OR UPDATE OF status, slot_id, worker_id, valid_from, valid_to ON patient_itinerary_assignment
  FOR EACH ROW EXECUTE FUNCTION fn_patient_itinerary_assignment_no_overlap();

-- ── fn_patient_itinerary_slot_key_immutable(): a chave do slot não muda depois de nascer ──
CREATE OR REPLACE FUNCTION fn_patient_itinerary_slot_key_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF (NEW.contracted_service_id, NEW.weekday, NEW.start_time, NEW.end_time)
     IS DISTINCT FROM (OLD.contracted_service_id, OLD.weekday, OLD.start_time, OLD.end_time) THEN
    RAISE EXCEPTION 'pis_chave_imutavel' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_patient_itinerary_slot_key_immutable ON patient_itinerary_slot;
CREATE TRIGGER trg_patient_itinerary_slot_key_immutable
  BEFORE UPDATE OF contracted_service_id, weekday, start_time, end_time ON patient_itinerary_slot
  FOR EACH ROW EXECUTE FUNCTION fn_patient_itinerary_slot_key_immutable();
