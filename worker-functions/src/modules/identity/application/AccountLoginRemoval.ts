/**
 * Porta única da "conta apagada" (DF-20, design §2.2): todo caminho que apaga a conta no Firebase chama
 * `markDeleted` — o login da pessoa em `iam` fica removido e, se a árvore ficou sem login vivo, os vínculos
 * de área são revogados (`account_deleted`). Sem PII: só uid e uid de ator.
 */
export interface AccountLoginRemoval {
  /** Idempotente: login inexistente ou já removido não é erro. `actorUid` vai para `revoked_by`. */
  markDeleted(uid: string, actorUid: string): Promise<void>;
}
