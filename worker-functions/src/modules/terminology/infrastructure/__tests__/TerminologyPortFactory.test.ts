/**
 * TerminologyPortFactory — Strategy (spec 016, tabela de padrões GoF): "a implementação da
 * TerminologyPort escolhida por CONFIGURAÇÃO, nunca por `if (fonte === 'icd')` espalhado" (OCP).
 * Único lugar do código que decide QUAL adaptador vive atrás da porta.
 */
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: jest.fn().mockReturnValue({ getPool: jest.fn().mockReturnValue({ query: jest.fn() }) }) },
}));

import { createTerminologyPort } from '../TerminologyPortFactory';
import { IcdCatalogTerminology } from '../IcdCatalogTerminology';
import { UnavailableTerminology } from '../../domain/UnavailableTerminology';

describe('createTerminologyPort (Strategy)', () => {
  it("'postgres' (ou ausente) devolve o adaptador real — é o default de produção", () => {
    expect(createTerminologyPort({ TERMINOLOGY_ADAPTER: 'postgres' })).toBeInstanceOf(IcdCatalogTerminology);
    expect(createTerminologyPort({})).toBeInstanceOf(IcdCatalogTerminology);
  });

  it("'unavailable' devolve o Null Object — usado para simular/forçar falha visível (US-4)", () => {
    expect(createTerminologyPort({ TERMINOLOGY_ADAPTER: 'unavailable' })).toBeInstanceOf(UnavailableTerminology);
  });

  it('valor desconhecido falha VISÍVEL na configuração — nunca cai silenciosamente para um default', () => {
    expect(() => createTerminologyPort({ TERMINOLOGY_ADAPTER: 'algo-que-nao-existe' })).toThrow(
      /TERMINOLOGY_ADAPTER/,
    );
  });
});
