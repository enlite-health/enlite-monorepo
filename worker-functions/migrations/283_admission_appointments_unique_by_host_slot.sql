BEGIN;

-- ================================================================
-- Migration 283: trava anti-corrida da admissão volta a ser POR ATENDENTE
-- ================================================================
-- Change `agenda-admissao-atendentes` (D6). Desfaz a troca feita pela 256.
--
--   252: UNIQUE(host_email, slot_start)  — uma atendente, um horário
--   256: UNIQUE(country,   slot_start)   — uma entrevista por horário/país
--   283: UNIQUE(host_email, slot_start)  — volta a ser por atendente
--
-- Por quê: a 256 nasceu quando a disponibilidade passou a ser a agenda do PAÍS
-- (capacidade 1, sem roster). Com o roster de volta, duas atendentes livres no
-- mesmo horário DEVEM poder atender duas entrevistas simultâneas — e a trava
-- por país impede exatamente isso. O que não pode é a MESMA atendente receber
-- dois compromissos no mesmo horário; é isso que a chave por atendente garante.
--
-- Compatível com os dois modos, por isso não precisa ser revertida no rollback
-- da flag `ADMISSION_HOST_ROSTER_ENABLED`:
--   · flag OFF (modo atual): `host_email` guarda o id da agenda do país, que é
--     1:1 com o país — logo UNIQUE(host_email, slot_start) tem exatamente o
--     mesmo efeito prático que a trava da 256 que ela substitui.
--   · flag ON: `host_email` guarda o e-mail da atendente atribuída.
--
-- Pré-condição VERIFICADA em produção (19/08, não inferida) antes de aplicar:
--   SELECT count(*) - count(DISTINCT (host_email, slot_start)) FROM admission_appointments;
--   → 0 duplicatas em 7 linhas; host_email NULL = 0; 2 host_emails distintos
--     (as duas agendas de país). A chave nova é criável sem conflito.
--
-- Idempotente: DROP INDEX IF EXISTS + CREATE UNIQUE INDEX IF NOT EXISTS.
-- Molde: migrations 252 / 256.
-- ================================================================

-- Trava por país (256) sai: ela é o que impede duas atendentes no mesmo horário.
DROP INDEX IF EXISTS uq_admission_appointments_country_slot;

-- Trava por atendente (252) volta: uma atendente nunca tem 2 no mesmo start.
CREATE UNIQUE INDEX IF NOT EXISTS uq_admission_appointments_host_slot
  ON admission_appointments (host_email, slot_start);

COMMENT ON TABLE admission_appointments IS
  'A booked admission-interview slot: patient + host + time + Meet/calendar refs. UNIQUE(host_email, slot_start) é a trava anti-corrida do nosso lado (defense-in-depth junto com o re-check ao vivo da agenda). host_email = e-mail da atendente atribuída quando ADMISSION_HOST_ROSTER_ENABLED=true; id da agenda do país quando false. host_display_name é SEMPRE o nome genérico da equipe — é o que o paciente vê, e a identidade da atendente nunca é exposta a ele. Migrations 252/256/283.';

COMMIT;
