-- 510 — A trava de horário da admissão vale só para reunião ATIVA (spec 050, F8, R-39).
--
--   283: UNIQUE(host_email, slot_start)                       uq_admission_appointments_host_slot
--   510: UNIQUE(host_email, slot_start) WHERE status='booked' uq_admission_appointments_host_slot_booked
--
-- Por quê: com o índice cheio, uma reunião `cancelled` (ou `completed`/`no_show`) segurava o horário da responsável para sempre —
-- cancelar e reagendar no mesmo horário dava 409. Duas reuniões ATIVAS da mesma responsável no mesmo horário seguem impossíveis.
--
-- Ordem (sem janela sem trava): 1) cria o parcial  2) só então remove o cheio. Criar o parcial nunca falha por dado: ele é mais
-- fraco que o cheio (todo conjunto que respeita o cheio respeita o parcial). Nome novo de propósito — dois índices não
-- podem ter o mesmo nome, e criar antes de remover exige nomes distintos.
--
-- Quem lê o nome: ninguém no código (a distinção "colisão de código × de horário" olha só o índice do CÓDIGO ADM,
-- `uq_admission_appointments_code`; qualquer outra unique_violation é horário). O e2e do roster lê o nome e foi atualizado.
--
-- Sem BEGIN/COMMIT próprio: o runner já cuida da atomicidade/registro (a 509 abriu transação própria e isso gera aviso no boot).
-- Idempotente (2×): CREATE ... IF NOT EXISTS + DROP ... IF EXISTS.
-- VOLTA: reverter só o código mantém o índice parcial (seguro). Recriar o cheio exige a consulta de colisões = 0 (ver PR).

CREATE UNIQUE INDEX IF NOT EXISTS uq_admission_appointments_host_slot_booked
  ON admission_appointments (host_email, slot_start)
  WHERE status = 'booked';

DROP INDEX IF EXISTS uq_admission_appointments_host_slot;
