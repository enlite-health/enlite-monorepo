-- 527 — patient_itinerary_slot vira DONO do horário do serviço (spec 056 §4.1 opção A, §4.2 (a); D514, D517).
-- Turno = início + duração (1..1440 min); fim não é gravado. Vigência `valid` [) por dia local; mudar o horário =
-- fechar a faixa antiga e abrir a nova na mesma transação. Trava: EXCLUDE por serviço × minutos da semana × vigência.
-- `pcs.schedule` deixa de ser escrito e de ser lido (a coluna sai no PR seguinte, spec §2); a leitura vira
-- `horario_do_servico(service_id, data)`. Idempotente (2×). Sem BEGIN/COMMIT próprio.
-- Rollback: migrations/pending/ROLLBACK_527_patient_itinerary_slot_vigencia_duracao.sql (rodar DEPOIS do ROLLBACK_528).

-- o ADD COLUMN … STORED reescreve a tabela (ACCESS EXCLUSIVE): teto de espera, local à transação do runner (molde 511)
SELECT set_config('lock_timeout', '10s', true);

-- ── funções de minuto da semana (IMMUTABLE: entram na coluna gerada) ─────────────
CREATE OR REPLACE FUNCTION itinerary_week_range(p_start_abs integer, p_len integer)
RETURNS int4multirange
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  -- [ini, ini+len) na semana circular [0,10080): se passa do fim do sábado, vira 2 pedaços na MESMA linha.
  SELECT CASE
           WHEN s.ini + p_len <= 10080 THEN int4multirange(int4range(s.ini, s.ini + p_len, '[)'))
           ELSE int4multirange(int4range(s.ini, 10080, '[)'), int4range(0, s.ini + p_len - 10080, '[)'))
         END
    FROM (SELECT ((p_start_abs % 10080) + 10080) % 10080 AS ini) AS s
$$;

CREATE OR REPLACE FUNCTION itinerary_slot_week_minutes(p_weekday smallint, p_start time, p_duration integer)
RETURNS int4multirange
LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
AS $$
  SELECT itinerary_week_range(
           p_weekday * 1440 + EXTRACT(HOUR FROM p_start)::int * 60 + EXTRACT(MINUTE FROM p_start)::int,
           p_duration)
$$;

-- ── (1) colunas novas, anuláveis enquanto o backfill corre ─────────────────────
ALTER TABLE patient_itinerary_slot ADD COLUMN IF NOT EXISTS duration_minutes integer NULL;
ALTER TABLE patient_itinerary_slot ADD COLUMN IF NOT EXISTS valid daterange NULL;

-- ── (2) backfill das linhas existentes (só a stage tem linhas) ─────────────────
-- Ativa: [updated_at, ) — updated_at = created_at, salvo reativação (o ON CONFLICT do sync é o ÚNICO UPDATE de
--   slot ativo, PatientItinerarySlotSync.ts:94-96); assim a faixa reativada não colide com a irmã que a substituiu.
-- Inativa: [created_at, updated_at) [INFERÊNCIA da spec §8: updated_at ≈ quando desativou]; mesmo dia → 'empty'.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.columns
              WHERE table_schema = 'public' AND table_name = 'patient_itinerary_slot' AND column_name = 'end_time') THEN
    EXECUTE $sql$
      UPDATE patient_itinerary_slot
         SET duration_minutes = (EXTRACT(EPOCH FROM (end_time - start_time)) / 60)::int
       WHERE duration_minutes IS NULL
    $sql$;
    EXECUTE $sql$
      UPDATE patient_itinerary_slot s
         SET valid = CASE
                       WHEN s.active THEN daterange((s.updated_at AT TIME ZONE tz.name)::date, NULL, '[)')
                       ELSE daterange((s.created_at AT TIME ZONE tz.name)::date,
                                      (s.updated_at AT TIME ZONE tz.name)::date, '[)')
                     END
        FROM (VALUES ('AR', 'America/Argentina/Buenos_Aires'), ('BR', 'America/Sao_Paulo')) AS tz(country, name)
       WHERE tz.country = s.country AND s.valid IS NULL
    $sql$;
  END IF;
END $$;

-- ── (3) obrigatoriedade e faixas de valor ──────────────────────────────────────
ALTER TABLE patient_itinerary_slot ALTER COLUMN duration_minutes SET NOT NULL;
ALTER TABLE patient_itinerary_slot ALTER COLUMN valid SET NOT NULL;
ALTER TABLE patient_itinerary_slot DROP CONSTRAINT IF EXISTS pis_duration_range;
ALTER TABLE patient_itinerary_slot ADD CONSTRAINT pis_duration_range CHECK (duration_minutes BETWEEN 1 AND 1440);
ALTER TABLE patient_itinerary_slot DROP CONSTRAINT IF EXISTS pis_valid_com_inicio;
ALTER TABLE patient_itinerary_slot ADD CONSTRAINT pis_valid_com_inicio CHECK (NOT lower_inf(valid));

-- ── (4) o que dependia de end_time/active sai ANTES do DROP COLUMN ─────────────
DROP TRIGGER IF EXISTS trg_patient_itinerary_slot_key_immutable ON patient_itinerary_slot;
ALTER TABLE patient_itinerary_slot DROP CONSTRAINT IF EXISTS pis_service_slot_uq;
ALTER TABLE patient_itinerary_slot DROP CONSTRAINT IF EXISTS pis_time_order;

-- ── (5) colunas que viraram derivado ───────────────────────────────────────────
ALTER TABLE patient_itinerary_slot DROP COLUMN IF EXISTS end_time;
ALTER TABLE patient_itinerary_slot DROP COLUMN IF EXISTS active;

-- ── (6) minutos da semana (gerada, só da própria linha) ────────────────────────
ALTER TABLE patient_itinerary_slot
  ADD COLUMN IF NOT EXISTS week_minutes int4multirange
  GENERATED ALWAYS AS (itinerary_slot_week_minutes(weekday, start_time, duration_minutes)) STORED;

-- ── (7) serviço que só tem o JSONB vira faixas (prd inteira; na stage, os sem slot) ─
-- Vigência desde a criação do serviço: não há histórico anterior (R5). Ver ⚑B (§12).
-- end <= start segue a regra do §1.4 (prd mediu 0 faixas assim em pcs, checklist:373). DISTINCT tira a duplicata exata.
INSERT INTO patient_itinerary_slot (contracted_service_id, weekday, start_time, duration_minutes, valid, created_by, updated_by)
SELECT DISTINCT
       pcs.id,
       (e->>'dayOfWeek')::smallint,
       (e->>'startTime')::time,
       CASE WHEN (e->>'endTime')::time > (e->>'startTime')::time
            THEN (EXTRACT(EPOCH FROM ((e->>'endTime')::time - (e->>'startTime')::time)) / 60)::int
            ELSE 1440 - (EXTRACT(EPOCH FROM (e->>'startTime')::time) / 60)::int
                      + (EXTRACT(EPOCH FROM (e->>'endTime')::time) / 60)::int
       END,
       daterange((pcs.created_at AT TIME ZONE CASE pcs.country WHEN 'BR' THEN 'America/Sao_Paulo'
                                                 ELSE 'America/Argentina/Buenos_Aires' END)::date, NULL, '[)'),
       'migration:527',
       'migration:527'
  FROM patient_contracted_services pcs
  CROSS JOIN LATERAL jsonb_array_elements(pcs.schedule) AS e
 WHERE jsonb_typeof(pcs.schedule) = 'array'
   AND NOT EXISTS (SELECT 1 FROM patient_itinerary_slot s WHERE s.contracted_service_id = pcs.id);

-- ── (8) a trava: nenhuma faixa do mesmo serviço sobrepõe outra na mesma vigência ─
-- Falha (e a migration inteira desfaz) se o backfill acima produziu sobreposição — por isso a Fase 0 conta antes (P0.6/P0.7).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'pis_sem_sobreposicao') THEN
    ALTER TABLE patient_itinerary_slot ADD CONSTRAINT pis_sem_sobreposicao
      EXCLUDE USING gist (contracted_service_id WITH =, week_minutes WITH &&, valid WITH &&);
  END IF;
END $$;

-- ── (9) chave imutável; a vigência só fecha ────────────────────────────────────
CREATE OR REPLACE FUNCTION fn_patient_itinerary_slot_key_immutable()
RETURNS TRIGGER AS $$
BEGIN
  IF (NEW.contracted_service_id, NEW.weekday, NEW.start_time, NEW.duration_minutes)
     IS DISTINCT FROM (OLD.contracted_service_id, OLD.weekday, OLD.start_time, OLD.duration_minutes) THEN
    RAISE EXCEPTION 'pis_chave_imutavel' USING ERRCODE = '23514';
  END IF;
  IF NEW.valid IS DISTINCT FROM OLD.valid THEN
    -- só uma faixa ABERTA pode mudar de vigência…
    IF isempty(OLD.valid) OR NOT upper_inf(OLD.valid) THEN
      RAISE EXCEPTION 'pis_vigencia_ja_fechada' USING ERRCODE = '23514';
    END IF;
    -- …e só para fechada com o MESMO início (ou vazia, quando fecha no dia em que nasceu).
    IF NOT (isempty(NEW.valid) OR (lower(NEW.valid) = lower(OLD.valid) AND NOT upper_inf(NEW.valid))) THEN
      RAISE EXCEPTION 'pis_vigencia_so_fecha' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_patient_itinerary_slot_key_immutable ON patient_itinerary_slot;
CREATE TRIGGER trg_patient_itinerary_slot_key_immutable
  BEFORE UPDATE OF contracted_service_id, weekday, start_time, duration_minutes, valid ON patient_itinerary_slot
  FOR EACH ROW EXECUTE FUNCTION fn_patient_itinerary_slot_key_immutable();

-- ── (10) a leitura do horário do serviço (substitui pcs.schedule) ──────────────
-- SECURITY INVOKER: a RLS do slot (segue o serviço → paciente) vale, como valia o LEFT JOIN pcs_eff.
-- Nenhuma faixa vigente → NULL ("sem horário", o mesmo significado de pcs.schedule NULL).
CREATE OR REPLACE FUNCTION horario_do_servico(p_service_id uuid, p_on date)
RETURNS jsonb
LANGUAGE sql STABLE PARALLEL SAFE
AS $$
  SELECT jsonb_agg(
           jsonb_build_object(
             'dayOfWeek', s.weekday,
             'startTime', to_char(s.start_time, 'HH24:MI'),
             'endTime', to_char(s.start_time + make_interval(mins => s.duration_minutes), 'HH24:MI'),
             'durationMinutes', s.duration_minutes)
           ORDER BY s.weekday, s.start_time)
    FROM patient_itinerary_slot s
   WHERE s.contracted_service_id = p_service_id
     AND s.valid @> p_on
$$;

COMMENT ON TABLE patient_itinerary_slot IS
  'DONO do horário do serviço contratado (spec 056, D517 opção A): faixa semanal recorrente = (weekday 0=domingo, '
  'start_time, duration_minutes 1..1440) com vigência `valid`. O fim é início + duração (turno noturno e 24 h numa '
  'linha). Mudar o horário = fechar a faixa (valid upper = hoje) e abrir outra, na mesma transação. Trava: '
  'pis_sem_sobreposicao. pcs.schedule NÃO é lido nem escrito; a leitura é horario_do_servico(service_id, data). '
  'Rollback: migrations/pending/ROLLBACK_527_patient_itinerary_slot_vigencia_duracao.sql.';
COMMENT ON COLUMN patient_itinerary_slot.duration_minutes IS
  'Duração do turno em minutos (1..1440). Na tela, Fin <= Inicio = dia seguinte; 1440 = "Todo el día". O fim nunca é gravado.';
COMMENT ON COLUMN patient_itinerary_slot.valid IS
  'Vigência [) por dia local do país. Sem fim = vigente. VAZIA = faixa anulada no mesmo dia em que nasceu (nunca vigente). '
  'Só fecha (trg_patient_itinerary_slot_key_immutable).';
COMMENT ON COLUMN patient_itinerary_slot.week_minutes IS
  'Gerada: minutos da semana ocupados (0 = domingo 00:00, 10080 = fim do sábado); sábado→domingo = 2 pedaços. Só para as travas.';
COMMENT ON FUNCTION horario_do_servico(uuid, date) IS
  'Horário do serviço em p_on, no formato do antigo pcs.schedule + durationMinutes: [{dayOfWeek,startTime,endTime,durationMinutes}]. '
  'endTime é DERIVADO (início + duração; endTime <= startTime = dia seguinte; igual = 24 h). NULL = sem faixa vigente.';
