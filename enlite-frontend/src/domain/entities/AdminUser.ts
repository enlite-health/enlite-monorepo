export interface AdminUser {
  firebaseUid: string;
  email: string;
  displayName: string | null;
  department: string | null;
  lastLoginAt: string | null;
  loginCount: number;
  createdAt: string;
  /** Gate provisório da tela de horas do Ana Care no `main` (sem ABAC — allowlist de e-mail). */
  canAccessAnaCareHours?: boolean;
  /** Só vem `agent` no diretório de um grupo de classe `AGENT` (spec 078, M2); staff não traz o campo. */
  accountType?: 'agent';
}
