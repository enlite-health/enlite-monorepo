/** Controle: fora do CI o jest abria 1 worker por nucleo (10 x ~1,7 GB); no CI a config tem de ser a default. */
const CONFIG = '../../../jest.config.js';

function carregar(ci: string | undefined): Record<string, unknown> {
  if (ci === undefined) delete process.env.CI;
  else process.env.CI = ci;
  let cfg: Record<string, unknown> = {};
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    cfg = require(CONFIG);
  });
  return cfg;
}

describe('jest.config.js — teto de memoria', () => {
  const ciOriginal = process.env.CI;
  afterEach(() => {
    if (ciOriginal === undefined) delete process.env.CI;
    else process.env.CI = ciOriginal;
  });

  it('fora do CI limita maxWorkers a 2', () => {
    expect(carregar(undefined).maxWorkers).toBe(2);
  });

  it('no CI nao define maxWorkers (default do jest)', () => {
    expect(carregar('true').maxWorkers).toBeUndefined();
  });

  it('nao define workerIdleMemoryLimit em nenhum dos casos', () => {
    expect(carregar(undefined).workerIdleMemoryLimit).toBeUndefined();
    expect(carregar('true').workerIdleMemoryLimit).toBeUndefined();
  });
});
