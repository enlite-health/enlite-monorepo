-- ============================================================
-- Migration 179: Desativa template qualified_worker
--
-- Contexto: O template `qualified_worker` (HXd554209761d15f38fbd8c39012066cb4)
-- foi adicionado em 2026-05-20 pela sincronização com Twilio (script
-- scripts/sync-message-templates-twilio.ts). É um template de convite à
-- entrevista com psicóloga com 4 placeholders: 3 horários disponíveis +
-- número do caso.
--
-- Por que desativar: não existe código de disparo automatizado pra esse
-- template ainda. O fluxo de envio manual (SendMessageModal) usa
-- `buildVariables(candidate, vacancy)` que só fornece {name, role, location} —
-- não cobre `slot_1, slot_2, slot_3, case_number`. Se ficasse no dropdown,
-- operador escolheria e mandaria mensagem com slots vazios.
--
-- Reativar quando: alguém implementar a UI de agendamento com psicóloga
-- ou o uso case automatizado correspondente.
--
-- Idempotente — UPDATE com WHERE slug específico.
-- ============================================================

UPDATE message_templates
SET is_active = false,
    updated_at = NOW()
WHERE slug = 'qualified_worker';
