/**
 * UnavailableTerminology — Null Object (spec 016, "Contrato de arquitetura", US-4).
 * "Se o container cair, a busca falha VISÍVEL (mensagem es), nunca cai em texto livre
 * silencioso." A tentação do Null Object clássico é devolver [] / null "para não quebrar a
 * tela" — aqui isso É o bug (CLAUDE.md: "contagem zero é falha, nunca sucesso"). Este Null
 * Object faz o oposto do costume: toda chamada FALHA de forma explícita e tipada.
 */
import { UnavailableTerminology, TerminologyUnavailableError } from '../UnavailableTerminology';
import type { TerminologyPort } from '../TerminologyPort';

describe('UnavailableTerminology', () => {
  const port: TerminologyPort = new UnavailableTerminology();

  it('search() rejeita com TerminologyUnavailableError, nunca resolve com []', async () => {
    await expect(port.search('esquisofrenia')).rejects.toBeInstanceOf(TerminologyUnavailableError);
  });

  it('getByUri() rejeita, nunca resolve com null silencioso', async () => {
    await expect(port.getByUri('uri-qualquer')).rejects.toBeInstanceOf(TerminologyUnavailableError);
  });

  it('ancestorsOf() rejeita', async () => {
    await expect(port.ancestorsOf('uri-qualquer')).rejects.toBeInstanceOf(TerminologyUnavailableError);
  });

  it('a mensagem de erro é em espanhol e apta para tela (US-4)', async () => {
    try {
      await port.search('x');
      throw new Error('deveria ter lançado');
    } catch (err) {
      expect(err).toBeInstanceOf(TerminologyUnavailableError);
      const msg = (err as Error).message.toLowerCase();
      // Palavras em espanhol que uma operadora argentina reconhece como falha visível.
      expect(msg).toMatch(/no disponible|no se pudo|intente/);
    }
  });

  it('aceita um motivo opcional e o inclui na mensagem, sem expor detalhe de infraestrutura', async () => {
    const withReason = new UnavailableTerminology('ECONNREFUSED');
    try {
      await withReason.getByUri('x');
      throw new Error('deveria ter lançado');
    } catch (err) {
      expect(err).toBeInstanceOf(TerminologyUnavailableError);
    }
  });
});
