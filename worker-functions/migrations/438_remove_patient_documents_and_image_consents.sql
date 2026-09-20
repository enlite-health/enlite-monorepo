-- 438 — remove por completo "Documentos y consentimiento de imagen" do paciente
-- (fix/018-remover-documentos-consentimento). A feature de FOTO fica; só documento (prova) e
-- consentimento de imagem saem.
--
-- ── Contexto ───────────────────────────────────────────────────────────────────────────────────
-- Mergeada em `stage` pela migration 426 (spec 018, PR-4), NUNCA promovida a `main`/prd. Dado da
-- `stage` é sintético (D263) — sem risco de dado real. Esta migration só roda na `stage`.
--
-- ── O que sai (DROP, nesta ordem — FK antes da tabela que ela referencia) ────────────────────────
--   1. `patient_photos.consent_id` — DROP CONSTRAINT (FK para `patient_image_consents`) e DROP
--      COLUMN. Tem que sair PRIMEIRO: Postgres recusa `DROP TABLE patient_image_consents` enquanto
--      essa FK existir (medido rodando esta migration contra Postgres real — ordem errada tentada
--      antes: "cannot drop table patient_image_consents because other objects depend on it").
--   2. `patient_image_consents` — referenciava `patient_documents` (document_id/revocation_document_id);
--      sem mais nada apontando pra ela depois do passo 1.
--   3. `patient_documents` — sem mais referenciadores (o único era `patient_image_consents`, já
--      apagada no passo 2).
--
-- ── O que FICA (não tocado) ───────────────────────────────────────────────────────────────────
--   `patient_photos` (menos `consent_id`), `patient_photo_orphans` — ver nota sobre `'DOCUMENTS'`
--   abaixo —, bucket `enlite-patient-photos-stg`, rotas `/photo`.
--
-- ── `patient_photo_orphans.bucket` — 'DOCUMENTS' fica como valor MORTO no CHECK ──────────────────
-- O CHECK `bucket IN ('PHOTOS','DOCUMENTS')` (migration 426) NÃO é estreitado aqui. Não há
-- `patient_id`/FK nesta tabela — é fila operacional (só caminho cifrado + motivo) sem vínculo com
-- `patient_documents`, então nenhum DROP acima a afeta estruturalmente. Uma linha antiga com
-- `bucket='DOCUMENTS'` pode sobrar de execução anterior do retry (`PatientPhotoOrphanRetryService`);
-- o código (mesma branch desta migration) já trata esse valor como "sem storage para reprocessar"
-- em vez de lançar — ver `PatientPhotoOrphanRetryService.retryOne`. Apertar o CHECK exigiria
-- primeiro confirmar/limpar linhas `'DOCUMENTS'` residuais na stage; fora do escopo desta remoção
-- de código (achado novo, não o pedido).
--
-- Rollback: NENHUM — os dados de `patient_documents`/`patient_image_consents`/`patient_photos.consent_id`
-- apagados aqui não são recuperáveis (não há cópia). Reverter significaria recriar as tabelas
-- vazias (mesmo DDL da 426) — se algum dia a feature voltar, nasce como migration NOVA, não como
-- reversão desta.

-- 1. `patient_photos.consent_id` — FK explícita primeiro (idempotente), coluna depois. Tem que
--    sair ANTES do DROP TABLE patient_image_consents (passo 2) — ver nota de ordem acima.
ALTER TABLE patient_photos DROP CONSTRAINT IF EXISTS patient_photos_consent_id_fkey;
ALTER TABLE patient_photos DROP COLUMN IF EXISTS consent_id;

-- 2. `patient_image_consents` — referenciava patient_documents; sem mais nada apontando pra ela
--    depois do passo 1.
DROP TABLE IF EXISTS patient_image_consents;

-- 3. `patient_documents` — sem mais referenciadores (o único era patient_image_consents, já apagada).
DROP TABLE IF EXISTS patient_documents;

COMMENT ON TABLE patient_photos IS
  'Foto de perfil do paciente (1 viva por paciente, uq_patient_photos_one). Re-encode sempre JPEG, '
  'sem EXIF/GPS (PatientPhotoProcessor). `consent_id` foi REMOVIDA (migration 438, '
  'fix/018-remover-documentos-consentimento) — documento/consentimento de imagem saíram por completo.';
