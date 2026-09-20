/**
 * scheduleOpportunisticOrphanRetry — achado da revisão do PR-4 (item 3): prova que (a) dispara
 * `retryOnce` com um limite pequeno, (b) NUNCA lança mesmo se o retry falhar, e (c) NUNCA lança
 * mesmo com o default de produção (`new PatientPhotoOrphanRetryService()`, sem storage configurado).
 */
jest.mock('@shared/database/DatabaseConnection', () => ({
  DatabaseConnection: { getInstance: () => ({ getPool: () => ({ query: jest.fn(async () => ({ rows: [] })) }) }) },
}));

import { scheduleOpportunisticOrphanRetry } from '../scheduleOpportunisticOrphanRetry';

// Aguarda o próximo tick — a função é fire-and-forget (não devolve a Promise do retry).
const flush = () => new Promise((resolve) => setImmediate(resolve));

describe('scheduleOpportunisticOrphanRetry (spec 018, PR-4, item 3 da revisão)', () => {
  it('dispara retryOnce(3) no serviço passado — pequeno e best-effort', () => {
    const retryOnce = jest.fn(async () => ({ attempted: 0, cleared: 0, stillFailing: 0 }));
    scheduleOpportunisticOrphanRetry({ retryOnce } as never);
    expect(retryOnce).toHaveBeenCalledWith(3);
  });

  it('NÃO lança (nem devolve promise rejeitada visível) quando o retry falha — só loga', async () => {
    const retryOnce = jest.fn(async () => { throw new Error('db down'); });
    expect(() => scheduleOpportunisticOrphanRetry({ retryOnce } as never)).not.toThrow();
    await flush();
    expect(retryOnce).toHaveBeenCalled();
  });

  it('constrói pelo DEFAULT do parâmetro (caminho de produção) sem lançar, mesmo sem storage configurado', async () => {
    expect(() => scheduleOpportunisticOrphanRetry()).not.toThrow();
    await flush();
  });
});
