/**
 * Códigos de erro de domínio do módulo worker.
 *
 * São códigos estáveis (não mensagens humanas) retornados por use cases via
 * Result.fail. A camada de interface (controllers) traduz cada código para o
 * HTTP status + mensagem localizada apropriada, sem vazar detalhes internos
 * (ex.: violação de constraint do Postgres) para o cliente.
 */
export const WORKER_ERROR_CODES = {
  /**
   * O telefone informado não pode ser utilizado (já pertence a outro worker).
   *
   * Por privacidade NUNCA revelamos ao cliente que o número pertence a outra
   * conta — apenas que não pode ser usado. Ver decisão do produto em
   * SavePersonalInfoUseCase.
   */
  PHONE_NOT_AVAILABLE: 'PHONE_NOT_AVAILABLE',
} as const;

export type WorkerErrorCode = (typeof WORKER_ERROR_CODES)[keyof typeof WORKER_ERROR_CODES];
