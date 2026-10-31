import {
  ASSISTENTE_CHAT_CELLS,
  CONHECIMENTO_CELLS,
} from '../../identity/permissions/domain/PermissionCell';

/** Porta: células que o ator tem (mesma resolução do `GetMyAuthzUseCase`). Falha = rejeita. */
export type ResolverCelulasDoAtor = (uid: string) => Promise<readonly string[]>;

export interface AlcanceAssistentes {
  gestoras: string[];
  conhecimento: string[];
}

/** `assistente_<slug>:chat` -> `<slug>`; `conhecimento_<gaveta>:read` -> `<gaveta>`. Só parsing do nome. */
function recursoSemPrefixo(celula: string, prefixo: string): string {
  const recurso = celula.split(':')[0];
  return recurso.startsWith(prefixo) ? recurso.slice(prefixo.length) : recurso;
}
const slugDe = (celula: string): string => recursoSemPrefixo(celula, 'assistente_');
const gavetaDe = (celula: string): string => recursoSemPrefixo(celula, 'conhecimento_');

/**
 * O que a PESSOA alcança: constantes do catálogo ∩ células dela, na ordem das constantes.
 * Falha ao resolver as células propaga (o handler devolve 500) — nunca lista vazia.
 */
export class AlcanceAssistentesUseCase {
  constructor(private readonly resolverCelulas: ResolverCelulasDoAtor) {}

  async executar(uid: string): Promise<AlcanceAssistentes> {
    const cells = await this.resolverCelulas(uid);
    const gestoras: string[] = [];
    const conhecimento: string[] = [];
    for (const celula of ASSISTENTE_CHAT_CELLS) if (cells.includes(celula)) gestoras.push(slugDe(celula));
    for (const celulaGaveta of CONHECIMENTO_CELLS) if (cells.includes(celulaGaveta)) conhecimento.push(gavetaDe(celulaGaveta));
    return { gestoras, conhecimento };
  }
}
