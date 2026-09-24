-- ============================================================
-- Migration 472: título de vaga de caso NATIVO passa a "CASO EN{n}-{m}"
--
-- Spec 028 (caso-en-em-todo-lugar), decisão do Gabriel (24/09/2026, D422 —
-- substitui o ponto 6 da D412): D412 tinha adiado o WRITE PATH ("as vagas
-- continuam nascendo CASO {n}-{m}; só os leitores toleram os dois
-- formatos"). D422 reverte esse adiamento: o título de vaga passa a gravar
-- o número FORMATADO — "CASO EN1041-5597" para caso nativo (case_number
-- ≥1000, sequence própria, migration 459), "CASO 828-5597" para caso
-- legado do ClickUp (<1000, congelado em 23/09/2026 — não numera mais,
-- então nunca ganha o prefixo).
--
-- Esta migration reescreve as linhas EXISTENTES para o formato novo (as 7
-- sítios de escrita do título — JobPostingARRepository, VacancyCrudController,
-- CreateJobPostingFromTalentumUseCase, SyncTalentumVacanciesUseCase,
-- GeminiVacancyParserHelpers, ActivateRecruitmentUseCase — já passam a
-- gravar o formato novo a partir deste deploy via `formatCaseTitle`,
-- `caseNumberFormat.ts`).
--
-- SUP-5 (plano da task): reescreve TODAS as linhas com case_number ≥1000 e
-- título no padrão antigo — vivas E APAGADAS (`deleted_at` não entra no
-- WHERE) — para preservar histórico consistente (auditoria, export, o que
-- já foi soft-deleted não deixa de ter sido um caso nativo). Medido em prd
-- (24/09/2026, F0): 2 linhas vivas com case_number ≥1000, ambas "CASO {n}-{m}"
-- sem exceção fora do padrão.
--
-- Backup em coluna `title_before_en` (não em tabela separada) — mesmo
-- padrão de auditabilidade simples usado no domínio; permite o ROLLBACK
-- (`pending/ROLLBACK_472_job_postings_title_caso_en.sql`) restaurar sem
-- depender de backup externo, e permite auditar visualmente quais linhas
-- esta migration tocou (`WHERE title_before_en IS NOT NULL`).
--
-- Idempotente: o `UPDATE` só toca linha com `title_before_en IS NULL` — uma
-- segunda corrida (reboot, re-apply manual) não reprocessa nem duplica o
-- backup. O `ADD COLUMN IF NOT EXISTS` é idempotente por natureza.
--
-- Formato do título alvo: `regexp_replace(title, '^CASO (\d+)', 'CASO EN\1')`
-- — só o PRIMEIRO número após "CASO " no INÍCIO do título ganha o prefixo;
-- o resto do texto (vacancy_number, texto livre depois do hífen) fica
-- intocado. `case_number ≥ 1000` e `title ~ '^CASO \d'` (sem "EN" já
-- presente, então uma segunda corrida acidental sem o filtro
-- title_before_en ainda seria segura — mas o filtro cobre isso de qualquer
-- forma).
-- ============================================================

ALTER TABLE job_postings ADD COLUMN IF NOT EXISTS title_before_en TEXT;

UPDATE job_postings
   SET title_before_en = title,
       title = regexp_replace(title, '^CASO (\d+)', 'CASO EN\1')
 WHERE case_number >= 1000
   AND title ~ '^CASO \d'
   AND title_before_en IS NULL;
