-- 495_seed_therapeutic_segments.sql
-- Spec 030 (F1, FR-001): semeia o catálogo `therapeutic_segments` (criado vazio na 430) com os 13
-- rótulos da 1ª coluna da planilha de segmentos do Javier (Ana Care), na ordem do arquivo
-- (`sort_order` 1..13). O rótulo de segmento livre da planilha NÃO entra (DEC-41, hipótese aceita 30/09).
-- Só a 1ª coluna: as colunas 2-3 da planilha ficam fora do repositório (lex C10).
--
-- Idempotente: ON CONFLICT pelo índice parcial de rótulo ativo (430, `uq_therapeutic_segments_label_ativo`)
-- DO NOTHING — não sobrescreve rótulo editado ou desativado pela tela depois do deploy. Roda 2× sem
-- erro. Sem BEGIN/COMMIT (o runner já envolve), sem DROP. `created_by='seed:495'` porque a 430 não
-- tem default para o autor.
--
-- Rollback: DELETE FROM therapeutic_segments WHERE created_by = 'seed:495'
--   (só seguro antes de qualquer `segment_id` referenciar as linhas).

INSERT INTO therapeutic_segments (label, sort_order, created_by, updated_by)
VALUES
  ('AT para Pacientes con Discapacidad Intelectual', 1, 'seed:495', 'seed:495'),
  ('AT para Pacientes con Enfermedades Neurológicas', 2, 'seed:495', 'seed:495'),
  ('AT para Pacientes con Limitaciones Motrices', 3, 'seed:495', 'seed:495'),
  ('AT para Pacientes con TEA', 4, 'seed:495', 'seed:495'),
  ('AT para Pacientes con Trastornos Psiquiátricos', 5, 'seed:495', 'seed:495'),
  ('AT para Personas en Vulnerabilidad Social', 6, 'seed:495', 'seed:495'),
  ('AT para Personas Mayores (Geriatría)', 7, 'seed:495', 'seed:495'),
  ('Cuidado Integral en Discapacidad Intelectual', 8, 'seed:495', 'seed:495'),
  ('Cuidado Integral en Enfermedades Neurológicas', 9, 'seed:495', 'seed:495'),
  ('Cuidado Integral en Patologías Específicas', 10, 'seed:495', 'seed:495'),
  ('Cuidado Integral de Pacientes con TEA', 11, 'seed:495', 'seed:495'),
  ('Cuidado Integral de Personas Mayores (Geriatría)', 12, 'seed:495', 'seed:495'),
  ('Cuidado de Pacientes con Limitaciones Motrices', 13, 'seed:495', 'seed:495')
ON CONFLICT (lower(btrim(label))) WHERE active DO NOTHING;
