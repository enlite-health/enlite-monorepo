/**
 * Portas do módulo `inapp-notification` (Spec 022, Bloco 4).
 *
 * `ActorPatientConversationAccessChecker` isola `GetNotificationsUseCase` da forma concreta do
 * `PermissionClient` de `@modules/identity/permissions` — a application layer testa contra esta
 * interface mínima (mock trivial), a composição real (`PermissionClientActorAccessChecker`,
 * infrastructure) é quem sabe de tenant/`iam.group_permissions`.
 *
 * D-13 (`contracts/openapi-notifications.md`): o `patientDisplayName` de uma notificação só
 * aparece se o ATOR do evento (quem mencionou/respondeu) AINDA tem `patient_conversation:read` —
 * não é sobre o destinatário da notificação, é sobre quem a GEROU. Se o ator perdeu a célula
 * depois do evento, a UI mostra "um paciente" (nunca o nome).
 */
export interface ActorPatientConversationAccessChecker {
  canReadPatientConversation(actorUid: string): Promise<boolean>;
}
