export interface User {
  id: string;
  email: string;
  name: string;
  roles: string[];
  createdAt: Date;
  updatedAt: Date;
  /**
   * Foto da conta, lida da SESSÃO do Firebase no navegador (nada vai ao backend nem a tabela nenhuma): prefere o
   * `photoURL` do provider `google.com` em `providerData`, com fallback para `user.photoURL`. Ausente = iniciais.
   */
  photoUrl?: string | null;
  /** `providerId`s ligados à conta (`providerData`): `google.com`, `password`… Ausente (sessão simulada de E2E) = nenhum. */
  authProviders?: string[];
}

/** Pura: o nome e a foto desta conta vêm do Google? (provider `google.com` ligado à conta). */
export function isGoogleAccount(user: Pick<User, 'authProviders'> | null | undefined): boolean {
  return user?.authProviders?.includes('google.com') ?? false;
}

export interface UserPermissions {
  canRead: boolean;
  canWrite: boolean;
  canDelete: boolean;
  canManage: boolean;
}
