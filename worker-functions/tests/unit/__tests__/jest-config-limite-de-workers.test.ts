/** Controle: sem teto, o jest abre 1 worker por nucleo (10 x ~1,7 GB) e derruba a maquina. */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const config = require('../../../jest.config.js');

describe('jest.config.js — teto de memoria', () => {
  it('limita maxWorkers a no maximo 4', () => {
    expect(typeof config.maxWorkers).toBe('number');
    expect(config.maxWorkers).toBeGreaterThan(0);
    expect(config.maxWorkers).toBeLessThanOrEqual(4);
  });

  it('define workerIdleMemoryLimit', () => {
    expect(config.workerIdleMemoryLimit).toBeDefined();
  });
});
