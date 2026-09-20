/**
 * src/modules/identity/permissions/domain/PermissionError.ts
 *
 * Vocabulário de FALHA do módulo. Existe para que a borda HTTP (grupo 4) e os
 * testes falem de "grupo de sistema" / "último gestor" sem depender de string de
 * mensagem do Postgres nem de `error.code` do driver.
 *
 * A AUTORIDADE das invariantes é o banco (funções SECURITY DEFINER da mig 279):
 * é lá que a checagem roda dentro da transação, com lock, imune a corrida entre
 * instâncias. O domínio repete algumas validações baratas ANTES de ir ao banco
 * só para dar mensagem melhor e evitar ida de rede — nunca como substituto.
 */

/**
 * Códigos estáveis. A borda mapeia para HTTP (grupo 4); o teste afirma o código,
 * não a frase.
 */
export type PermissionErrorCode =
  /** Ator sem `permission_management:write`/`:read`, ou sem ator no contexto. */
  | 'forbidden'
  /** Grupo inexistente, arquivado, ou de outro tenant (indistinguíveis — spec). */
  | 'not_found'
  /** Nome de grupo já usado no tenant. */
  | 'duplicate_name'
  /** Grupo semeado pelo sistema: não renomeia, não arquiva. */
  | 'system_group'
  /** Célula fora do catálogo ou descontinuada. */
  | 'invalid_cell'
  /** Operação exige motivo (concessão de país, override de feature). */
  | 'reason_required'
  /** Deixaria zero gestores com `permission_management:write`. */
  | 'last_manager'
  /** Tentativa de remover uma das 5 contas fixas do Acesso Master (B-1, mig 451). */
  | 'fixed_account'
  /** Chave de feature fora de `screen:|options:|component:<slug>`. */
  | 'invalid_feature_key'
  /** `config` da feature fora do schema do tipo (lex C10). */
  | 'invalid_feature_config'
  /** País fora das jurisdições suportadas. */
  | 'invalid_country'
  /** Nome/descrição inválidos. */
  | 'invalid_input';

export class PermissionError extends Error {
  constructor(
    readonly code: PermissionErrorCode,
    message: string,
    readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'PermissionError';
  }
}

export function isPermissionError(err: unknown): err is PermissionError {
  return err instanceof PermissionError;
}

/** Erro de driver `pg` com o que interessa para o mapeamento. */
interface PgLikeError {
  code?: string;
  message?: string;
  constraint?: string;
}

function asPgError(err: unknown): PgLikeError | null {
  if (typeof err !== 'object' || err === null) return null;
  const e = err as PgLikeError;
  return typeof e.code === 'string' ? e : null;
}

/**
 * Traduz a exceção das funções da mig 279 para o vocabulário do módulo.
 *
 * Os SQLSTATE são os que as funções levantam de propósito (42501 sem célula,
 * P0002 grupo inexistente, 23502 sem motivo, 23503 célula fora do catálogo,
 * 23514 CHECK — grupo de sistema, anti-lockout OU conta fixa do Master). Só o
 * 23514 precisa olhar a mensagem, porque os três casos compartilham o SQLSTATE
 * de violação de CHECK; cada marca (`anti-lockout`, `conta fixa`) é escrita pela
 * própria migration que a levanta (410/279 e 451).
 *
 * Erro desconhecido volta como está: engolir SQLSTATE inesperado viraria "403
 * sem motivo" na tela e um incidente invisível no log.
 */
export function toPermissionError(err: unknown): unknown {
  const pg = asPgError(err);
  if (!pg) return err;
  const message = pg.message ?? '';
  switch (pg.code) {
    case '42501':
      return new PermissionError('forbidden', message, err);
    case 'P0002':
      return new PermissionError('not_found', message, err);
    case '23502':
      return new PermissionError('reason_required', message, err);
    case '23503':
      return new PermissionError('invalid_cell', message, err);
    case '23505':
      return new PermissionError('duplicate_name', message, err);
    case '23514':
      if (message.includes('anti-lockout')) return new PermissionError('last_manager', message, err);
      // B-1 (mig 451): marca própria — nunca "anti-lockout" — para não sair como last_manager.
      if (message.includes('conta fixa')) return new PermissionError('fixed_account', message, err);
      // CHECK de TABELA (traz `constraint`) ≠ RAISE das funções (não traz):
      // formato de `feature_key`/`country` da 277 cai aqui, e chamar isso de
      // "grupo de sistema" mandaria a tela mostrar o motivo errado.
      if (pg.constraint) {
        return pg.constraint.includes('feature_key')
          ? new PermissionError('invalid_feature_key', message, err)
          : new PermissionError('invalid_input', message, err);
      }
      return new PermissionError('system_group', message, err);
    default:
      return err;
  }
}
