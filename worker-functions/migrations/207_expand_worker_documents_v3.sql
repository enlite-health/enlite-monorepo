ALTER TABLE worker_documents
  ADD COLUMN IF NOT EXISTS apto_psicofisico_url        TEXT,
  ADD COLUMN IF NOT EXISTS analitico_universitario_url TEXT,
  ADD COLUMN IF NOT EXISTS carta_recomendacion_url     TEXT;

COMMENT ON COLUMN worker_documents.apto_psicofisico_url        IS 'Apto psicofísico (AT — opcional)';
COMMENT ON COLUMN worker_documents.analitico_universitario_url IS 'Analítico universitario (AT — opcional)';
COMMENT ON COLUMN worker_documents.carta_recomendacion_url     IS 'Carta de recomendación (Cuidador — opcional)';
