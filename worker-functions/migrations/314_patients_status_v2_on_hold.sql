-- 314 — `patients.status` v2: seis estados clínicos + motivo de espera (spec 012, US-B7)
--
-- Decisão 2 do Gabriel (03/09/2026) — `#DEC-06/07`, `#PEND-10`:
--   ACTIVE · ON_HOLD (en espera) · SEARCHING (búsqueda) · REPLACEMENT (reemplazo) · SUSPENDED ·
--   DISCHARGED (baja)
-- `ON_HOLD` exige motivo: SCHOOL | INSURER | OTHER (+ texto livre `on_hold_note`).
--
-- ── O CHECK ─────────────────────────────────────────────────────────────────
-- Recriado com os seis + os LEGADOS que ainda têm leitor: SOLICITANTE/ADMISSION/PENDING_ADMISSION
-- (o funil, ver 313) e DISCONTINUED (só até o backfill abaixo — fica no CHECK para que um deploy
-- com código antigo ainda no ar não estoure 23514 no meio; sai numa migration futura).
-- Padrão das 143/147/251: DROP + ADD com o mesmo nome, `status IS NULL OR ...` preservado.
--
-- ── DISCONTINUED → DISCHARGED ───────────────────────────────────────────────
-- O v2 não distingue "desistiu" (Baja) de "recebeu alta" (Alta): os dois são DISCHARGED (baja).
-- O UPDATE dispara o trigger da 254 → `patient_status_history` ganha a linha com
-- `change_source = 'migration-314'` (SET LOCAL: o runner roda cada arquivo em BEGIN/COMMIT).
--
-- ── `on_hold_note`: pacote D211.2 inteiro (lex C7.1) ────────────────────────
-- É a terceira instância da classe `additional_comments`/`emergency_instructions`: texto livre
-- onde se escreve POR QUE o cuidado parou — previsivelmente clínico. Portanto:
--   (a) ponto único de autorização no servidor (patientClinicalAccess.ts) — leitura E escrita;
--   (b) trilha de leitura SEM valor (`patient_clinical.read`);
--   (c) `data-clarity-mask` na tela;
--   (d) FORA da lista positiva do `enlite_mcp_ro` (create-mcp-ro-role.sql — coluna nova em
--       `patients` nasce invisível: a lista é positiva) E em `RESTRICTED_CLINICAL_COLUMNS`
--       (ReadonlyDbQueryService.ts);
--   (e) nenhuma segunda cópia — vive em `patients`, some com `deleted_at`; NUNCA vai para
--       `patient_status_history` (lex C7.3: trilha append-only viraria arquivo clínico paralelo);
--   (f) teto no SERVIDOR: 2000 (CHECK abaixo + schema zod).
--
-- Rollback: recriar o CHECK anterior (251); `DROP COLUMN on_hold_reason, on_hold_note`.

BEGIN;

SET LOCAL app.change_source = 'migration-314';

ALTER TABLE patients DROP CONSTRAINT IF EXISTS patients_status_check;
ALTER TABLE patients
  ADD CONSTRAINT patients_status_check
  CHECK (status IS NULL OR status IN (
    -- v2 (estado clínico do serviço)
    'ACTIVE', 'ON_HOLD', 'SEARCHING', 'REPLACEMENT', 'SUSPENDED', 'DISCHARGED',
    -- funil de admissão (espelhado em admission_status pela 313)
    'SOLICITANTE', 'ADMISSION', 'PENDING_ADMISSION',
    -- legado, até o backfill abaixo; sai numa migration futura
    'DISCONTINUED'
  ));

COMMENT ON CONSTRAINT patients_status_check ON patients IS
  'PatientStatus v2 (migration 314): ACTIVE, ON_HOLD, SEARCHING, REPLACEMENT, SUSPENDED, DISCHARGED '
  '+ funil (SOLICITANTE, ADMISSION, PENDING_ADMISSION — ver admission_status, 313). DISCONTINUED '
  'é legado tolerado (backfill → DISCHARGED nesta migration). Transições permitidas: '
  'patient_status_transitions (315).';

UPDATE patients
   SET status = 'DISCHARGED', updated_at = NOW()
 WHERE status = 'DISCONTINUED';

ALTER TABLE patients
  ADD COLUMN IF NOT EXISTS on_hold_reason TEXT NULL,
  ADD COLUMN IF NOT EXISTS on_hold_note   TEXT NULL;

ALTER TABLE patients DROP CONSTRAINT IF EXISTS patients_on_hold_reason_check;
ALTER TABLE patients
  ADD CONSTRAINT patients_on_hold_reason_check
  CHECK (on_hold_reason IS NULL OR on_hold_reason IN ('SCHOOL', 'INSURER', 'OTHER'));

-- Teto estrutural (f): o schema zod é a primeira linha, o banco é a que não depende de deploy.
ALTER TABLE patients DROP CONSTRAINT IF EXISTS patients_on_hold_note_len;
ALTER TABLE patients
  ADD CONSTRAINT patients_on_hold_note_len
  CHECK (on_hold_note IS NULL OR length(on_hold_note) <= 2000);

COMMENT ON COLUMN patients.on_hold_reason IS
  'Motivo da espera (ON_HOLD): SCHOOL | INSURER | OTHER. Obrigatório quando status = ON_HOLD '
  '(validado em PatientService.moveStatus); limpo ao sair de ON_HOLD. Migration 314.';
COMMENT ON COLUMN patients.on_hold_note IS
  'Texto livre do motivo da espera — TEXTO CLÍNICO RESTRITO (lex C7.1, pacote D211.2): ponto único '
  'de autorização (patient_clinical:read), trilha sem valor, máscara Clarity, FORA do enlite_mcp_ro '
  'e de RESTRICTED_CLINICAL_COLUMNS, NUNCA copiado para patient_status_history, teto 2000. '
  'Some com deleted_at. Migration 314.';

COMMIT;
