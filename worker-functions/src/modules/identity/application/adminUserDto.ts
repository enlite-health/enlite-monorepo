/**
 * O que o painel vê de um usuário interno.
 *
 * 07/09/2026 — `role` saiu do contrato HTTP de propósito: o papel deixou de ser
 * nível de acesso (a célula decide; o painel concede por grupo em `/admin/access`)
 * e não existe mais tela que o mostre ou edite. A coluna `users.role` continua
 * no banco porque ainda distingue staff × prestador e sustenta o fallback
 * `untilEnforced` até o flip em produção — mas isso é assunto do servidor, não
 * do cliente. Projetar aqui, na fronteira da aplicação, garante que nenhuma
 * rota devolva o campo por acidente.
 */
import type { AdminRecord } from '../infrastructure/AdminRepository';

export type AdminUserDto = Omit<AdminRecord, 'role'>;

export function toAdminUserDto(record: AdminRecord): AdminUserDto {
  const { role: _role, ...dto } = record;
  return dto;
}
