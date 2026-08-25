/**
 * A definição da célula é requisito da F2 (condição C2 do veredito do `lex`),
 * não documentação: quem marca a caixa na tela precisa saber o que está dando.
 *
 * Este arquivo guarda a CLASSE, não as quatro instâncias de hoje: qualquer
 * célula dos três níveis de prestador entra na lista obrigatória, então
 * acrescentar `worker_contact:write` amanhã sem escrever o que ela protege
 * reprova AQUI, e não numa revisão que alguém pode não fazer.
 */

import { CELL_DESCRIPTION, RESOURCE_CATEGORY, cellKey } from '../PermissionCell';

/** Os níveis que a F2 define — a fronteira que a regra cobre. */
const RECURSOS_DE_PRESTADOR = ['worker', 'worker_contact', 'worker_pii'];

describe('CELL_DESCRIPTION — a célula diz o que protege', () => {
  it('as quatro células da F2 têm definição escrita e não-vazia', () => {
    for (const chave of ['worker:read', 'worker_contact:read', 'worker_pii:read', 'worker:disable']) {
      expect(CELL_DESCRIPTION[chave]?.trim().length ?? 0).toBeGreaterThan(40);
    }
  });

  it('`worker_contact` é recurso conhecido e mora em Trabalhadores', () => {
    expect(RESOURCE_CATEGORY.worker_contact).toBe('Trabalhadores');
  });

  it('a definição de worker_pii NOMEIA o que a torna sensível — e não fala de CPF', () => {
    const d = CELL_DESCRIPTION[cellKey('worker_pii', 'read')].toLowerCase();
    for (const termo of ['raça', 'religião', 'orientação sexual', 'dni']) {
      expect(d).toContain(termo);
    }
    // O seed da 206 dizia "CPF, endereço" — documento brasileiro, no país errado.
    expect(d).not.toContain('cpf');
  });

  it('contato e dossiê são coisas DIFERENTES, não graus do mesmo acesso', () => {
    const contato = CELL_DESCRIPTION['worker_contact:read'].toLowerCase();
    const dossie = CELL_DESCRIPTION['worker_pii:read'].toLowerCase();
    // telefone é do contato e NÃO do dossiê; raça é do dossiê e NÃO do contato
    expect(contato).toContain('telefone');
    expect(dossie).not.toContain('telefone');
    expect(dossie).toContain('raça');
    expect(contato).not.toContain('raça');
  });

  it('a baixa diz que cobre as DUAS direções — o nome sozinho engana', () => {
    const d = CELL_DESCRIPTION['worker:disable'].toLowerCase();
    expect(d).toContain('reverter');
  });

  it('nenhum recurso de prestador fica sem definição — a regra é da CLASSE', () => {
    const semDefinicao = RECURSOS_DE_PRESTADOR.filter(
      (r) => !Object.keys(CELL_DESCRIPTION).some((k) => k.startsWith(`${r}:`)),
    );
    expect(semDefinicao).toEqual([]);
  });
});
