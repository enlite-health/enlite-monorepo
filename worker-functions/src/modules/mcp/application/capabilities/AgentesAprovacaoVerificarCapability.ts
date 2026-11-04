import { z } from 'zod';
import type { AgentesRepository } from '../../infrastructure/AgentesRepository';
import { UUID } from './agentesSchemas';

const ArgsShape = {
  aprovacao_id: UUID,
};

const ArgsSchema = z.object(ArgsShape).strict();

/**
 * AgentesAprovacaoVerificarCapability (agentes.aprovacao.verificar) — READ (spec 078, itens 20/48, §6.11).
 * O propagador só empurra o que um humano ACEITOU: `valida` = o evento existe, é `aceitar` e a atitude dele
 * ainda é a versão mais alta do pedido. Negar/descrever/inexistente/atitude superada => `valida=false`.
 * Devolve `comentario` (o do humano que aprovou com comentário; `null` se aprovou sem) para o Sol aplicar levando-o em conta.
 */
export class AgentesAprovacaoVerificarCapability {
  static readonly NAME = 'agentes.aprovacao.verificar';
  static readonly DESCRIPTION =
    'Check an approval id (the id of the human "aceitar" event): valid only if it is an accept of the latest attitude version of its request. Also returns the approver\'s optional comment (null if none).';
  static readonly INPUT_SHAPE = ArgsShape;

  constructor(private readonly repo: AgentesRepository) {}

  async execute(args: unknown, principalName?: string) {
    if (!principalName) throw new Error('agentes.aprovacao.verificar: principal ausente');
    const input = ArgsSchema.parse(args ?? {});
    return this.repo.verificarAprovacao(principalName, input.aprovacao_id);
  }
}
