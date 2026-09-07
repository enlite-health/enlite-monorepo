export interface AdminUser {
  firebaseUid: string;
  email: string;
  displayName: string | null;
  department: string | null;
  lastLoginAt: string | null;
  loginCount: number;
  createdAt: string;
}
