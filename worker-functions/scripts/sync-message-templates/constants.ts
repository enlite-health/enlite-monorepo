/**
 * Slugs referenciados diretamente em código pra ENVIAR mensagens.
 * Se um desses entrar no plano de DELETE, o script aborta — a menos que
 * --allow-hardcoded-delete seja passado.
 *
 * Manter sincronizado com:
 *   - src/modules/notification/application/HandleReminderResponseUseCase.ts
 *   - src/modules/notification/application/BulkDispatchIncompleteWorkersUseCase.ts
 *   - src/modules/notification/application/BulkDispatchTalentumIncompleteUseCase.ts
 *   - src/modules/notification/application/BookSlotFromWhatsAppUseCase.ts
 *   - src/modules/notification/interfaces/controllers/MessagingController.ts
 *   - src/modules/notification/interfaces/controllers/InboundWhatsAppController.ts
 *
 * NÃO incluir slugs que aparecem apenas em queries de leitura de
 * `whatsapp_bulk_dispatch_logs` (RecruitmentHealthController) — esses logs
 * guardam o slug como string solta, não exigem o template em
 * `message_templates`. Exemplo: `vacancy_invited_auto` foi desativado
 * pela migration 178 e substituído por `ar_vacancy_match_*`; só é lido
 * pra estatística histórica.
 */
export const HARDCODED_SLUGS = new Set<string>([
  // Reserva do REQ-09: a migration 293 cria a linha INATIVA e sem content_sid
  // enquanto a Meta não aprova o template da reunión de presentación. Sem sid e
  // sem friendly_name na Twilio, ela cai no plano de DELETE por construção — e
  // apagá-la destrói a configuração que PresentationInviteController escreve.
  'ar_presentacion_invite',
  'vacancy_match',
  'qualified_reprogram_confirm',
  'qualified_worker_response',
  'complete_register_ofc',
  'talentum_incomplete_reminder',
]);
