/**
 * Portas do módulo `inapp-notification` (Spec 022, Bloco 4).
 *
 * `ActorPatientConversationAccessChecker` isola `GetNotificationsUseCase` da forma concreta do
 * `PermissionClient` de `@modules/identity/permissions` — a application layer testa contra esta
 * interface mínima (mock trivial), a composição real (`PermissionClientActorAccessChecker`,
 * infrastructure) é quem sabe de tenant/`iam.group_permissions`.
 *
 * D-13, revisado no gate fecho B5 (21/09, `contracts/openapi-notifications.md`): o
 * `patientDisplayName` de uma notificação só aparece se o DESTINATÁRIO (quem chama
 * `GET /api/admin/notifications`) tem `patient_conversation:read` — não é sobre o ator que
 * gerou o evento. Sem a célula, a UI mostra "um paciente" (nunca o nome). O nome do parâmetro
 * (`canReadPatientConversation(uid)`) é genérico; quem decide QUAL uid é o call site
 * (`GetNotificationsUseCase`, hoje passa `recipientUid`).
 */
export interface ActorPatientConversationAccessChecker {
  canReadPatientConversation(actorUid: string): Promise<boolean>;
}
