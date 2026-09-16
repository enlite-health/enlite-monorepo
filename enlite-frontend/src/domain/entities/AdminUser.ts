import { EnliteRole } from './EnliteRole';

export interface AdminUser {
  firebaseUid: string;
  email: string;
  displayName: string | null;
  role: EnliteRole;
  department: string | null;
  lastLoginAt: string | null;
  loginCount: number;
  createdAt: string;
  /** Gate provisório da tela de horas do Ana Care no `main` (sem ABAC — allowlist de e-mail). */
  canAccessAnaCareHours?: boolean;
}
