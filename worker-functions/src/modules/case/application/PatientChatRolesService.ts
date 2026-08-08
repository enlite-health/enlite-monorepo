import {
  PatientChatRolesRepository,
  type CreateChatRoleInput,
  type UpdateChatRoleInput,
  type SharedGroupConflict,
} from '../infrastructure/PatientChatRolesRepository';
import type { PatientChatRoleSpec } from '../domain/PatientChatRole';

/** O papel pedido não existe no catálogo. */
export class ChatRoleNotFoundError extends Error {
  constructor(public readonly code: string) {
    super(`Chat role not found: ${code}`);
    this.name = 'ChatRoleNotFoundError';
  }
}

/** Já existe papel com este código. */
export class ChatRoleAlreadyExistsError extends Error {
  constructor(public readonly code: string) {
    super(`Chat role already exists: ${code}`);
    this.name = 'ChatRoleAlreadyExistsError';
  }
}

/**
 * O papel está em uso — desativar ou apagar foi RECUSADO.
 *
 * Carrega a contagem porque "não dá" sem número não ajuda ninguém a decidir: a
 * pessoa precisa saber se são 2 pacientes ou 200 antes de ir mexer.
 */
export class ChatRoleInUseError extends Error {
  constructor(
    public readonly code: string,
    public readonly patientCount: number,
    public readonly operation: 'deactivate' | 'delete',
  ) {
    super(`Chat role ${code} is used by ${patientCount} patient(s); ${operation} refused`);
    this.name = 'ChatRoleInUseError';
  }
}

/**
 * Virar o papel de COMPARTILHADO para EXCLUSIVO foi RECUSADO: já existe grupo
 * repetido entre pacientes, e passar a exclusivo tornaria esse dado ilegal.
 */
export class ChatRoleExclusivityConflictError extends Error {
  constructor(
    public readonly code: string,
    public readonly conflicts: SharedGroupConflict[],
  ) {
    const patients = conflicts.reduce((sum, c) => sum + c.patientCount, 0);
    super(
      `Cannot make ${code} exclusive: ${conflicts.length} group(s) are shared by ${patients} patients`,
    );
    this.name = 'ChatRoleExclusivityConflictError';
  }
}

/**
 * PatientChatRolesService — o CRUD do catálogo de papéis, com as duas travas que
 * não podem ser silenciosas.
 *
 * TRAVA 1 — compartilhado → exclusivo com dado conflitante.
 *   Se dois pacientes já dividem um grupo naquele papel, virar para exclusivo
 *   torna o dado existente inválido. Recusamos ANTES, com a contagem. Deixar
 *   bater no índice único devolveria `23505` sem explicação nenhuma; e
 *   "resolver" apagando um dos vínculos seria o software escolhendo qual
 *   paciente perde a conversa — não é decisão de software.
 *
 * TRAVA 2 — desativar/apagar papel em uso.
 *   Recusado, com quantos pacientes usam. Nada de cascata: os vínculos são a
 *   chave de join da auditoria da Candela, e apagá-los junto com uma linha de
 *   catálogo seria perder dado operacional por um clique de configuração.
 *
 * Nota de política: papel ativo→inativo é bloqueado se estiver em uso; mas
 * inativo→ativo é sempre livre (reabilitar não pode quebrar nada).
 */
export class PatientChatRolesService {
  private readonly repo: PatientChatRolesRepository;

  constructor(repo?: PatientChatRolesRepository) {
    this.repo = repo ?? new PatientChatRolesRepository();
  }

  listAll(): Promise<PatientChatRoleSpec[]> {
    return this.repo.listAll();
  }

  listActive(): Promise<PatientChatRoleSpec[]> {
    return this.repo.listActive();
  }

  async create(input: CreateChatRoleInput): Promise<PatientChatRoleSpec> {
    const existing = await this.repo.findByCode(input.code);
    if (existing) throw new ChatRoleAlreadyExistsError(input.code);
    return this.repo.create(input);
  }

  async update(code: string, input: UpdateChatRoleInput): Promise<PatientChatRoleSpec> {
    const current = await this.repo.findByCode(code);
    if (!current) throw new ChatRoleNotFoundError(code);

    // TRAVA 1 — compartilhado → exclusivo
    if (input.isExclusive === true && !current.isExclusive) {
      const conflicts = await this.repo.findSharedGroups(code);
      if (conflicts.length > 0) throw new ChatRoleExclusivityConflictError(code, conflicts);
    }

    // TRAVA 2 — desativar papel em uso
    if (input.isActive === false && current.isActive) {
      const patientCount = await this.repo.countUsage(code);
      if (patientCount > 0) throw new ChatRoleInUseError(code, patientCount, 'deactivate');
    }

    const updated = await this.repo.update(code, input);
    if (!updated) throw new ChatRoleNotFoundError(code);
    return updated;
  }

  async delete(code: string): Promise<void> {
    const current = await this.repo.findByCode(code);
    if (!current) throw new ChatRoleNotFoundError(code);

    const patientCount = await this.repo.countUsage(code);
    if (patientCount > 0) throw new ChatRoleInUseError(code, patientCount, 'delete');

    const deleted = await this.repo.delete(code);
    if (!deleted) throw new ChatRoleNotFoundError(code);
  }

  /** Quantos pacientes usam cada papel — a tela mostra junto, para a pessoa saber o peso antes de mexer. */
  async usageByRole(): Promise<Record<string, number>> {
    const roles = await this.repo.listAll();
    const entries = await Promise.all(
      roles.map(async r => [r.code, await this.repo.countUsage(r.code)] as const),
    );
    return Object.fromEntries(entries);
  }
}
