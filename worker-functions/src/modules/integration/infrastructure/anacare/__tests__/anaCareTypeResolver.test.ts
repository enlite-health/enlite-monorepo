/**
 * anaCareTypeResolver.test.ts — unit tests para resolução de tipos via catálogo.
 *
 * Cobre:
 *   - resolve por nome exato do catálogo → retorna ID
 *   - nome não encontrado → retorna undefined (sem inventar ID)
 *   - profissão sem mapeamento → retorna undefined
 *   - erro ao buscar catálogo → retorna undefined (não propaga)
 *   - cache em memória (catálogo só buscado uma vez)
 */

import { AnaCareTypeResolver } from '../anaCareTypeResolver';
import type { IAnaCareApiClient } from '../../../domain/IAnaCareApiClient';

// ─── Mock client factory ──────────────────────────────────────────

function makeClient(nurseTypes = [{ id: 1, name: 'Acompañante Terapéutico' }, { id: 2, name: 'Cuidador (a)' }], hiringTypes = [{ id: 10, name: 'Independiente' }]): IAnaCareApiClient {
  return {
    listNurseTypes: jest.fn().mockResolvedValue({ count: nurseTypes.length, next: null, previous: null, results: nurseTypes }),
    listHiringTypes: jest.fn().mockResolvedValue({ count: hiringTypes.length, next: null, previous: null, results: hiringTypes }),
    listNurses: jest.fn(),
    createNurse: jest.fn(),
    getNurse: jest.fn(),
    updateNurse: jest.fn(),
    bulkUpdateNurses: jest.fn(),
  } as IAnaCareApiClient;
}

// ─── resolveNurseType ─────────────────────────────────────────────

describe('AnaCareTypeResolver.resolveNurseType', () => {
  it('retorna ID quando nome do catálogo bate com mapeamento AT', async () => {
    const client = makeClient([{ id: 7, name: 'Acompañante Terapéutico' }]);
    const resolver = new AnaCareTypeResolver(client);
    const id = await resolver.resolveNurseType('AT');
    expect(id).toBe(7);
  });

  it('retorna ID quando nome do catálogo bate com mapeamento CUIDADOR', async () => {
    const client = makeClient([{ id: 3, name: 'Cuidador (a)' }]);
    const resolver = new AnaCareTypeResolver(client);
    const id = await resolver.resolveNurseType('CUIDADOR');
    expect(id).toBe(3);
  });

  it('retorna undefined quando profissão não tem mapeamento', async () => {
    const client = makeClient();
    const resolver = new AnaCareTypeResolver(client);
    const id = await resolver.resolveNurseType('ENFERMEIRO');
    expect(id).toBeUndefined();
  });

  it('retorna undefined quando nome não encontrado no catálogo (fallback omitir)', async () => {
    // Catálogo com nome diferente do mapeado
    const client = makeClient([{ id: 99, name: 'Outro tipo' }]);
    const resolver = new AnaCareTypeResolver(client);
    const id = await resolver.resolveNurseType('AT');
    expect(id).toBeUndefined();
  });

  it('retorna undefined quando profession null', async () => {
    const client = makeClient();
    const resolver = new AnaCareTypeResolver(client);
    const id = await resolver.resolveNurseType(null);
    expect(id).toBeUndefined();
  });

  it('usa cache — listNurseTypes chamado apenas 1x para 2 calls', async () => {
    const client = makeClient();
    const resolver = new AnaCareTypeResolver(client);
    await resolver.resolveNurseType('AT');
    await resolver.resolveNurseType('CUIDADOR');
    expect(client.listNurseTypes).toHaveBeenCalledTimes(1);
  });

  it('retorna undefined quando API falha (não propaga erro)', async () => {
    const client = makeClient();
    (client.listNurseTypes as jest.Mock).mockRejectedValue(new Error('network error'));
    const resolver = new AnaCareTypeResolver(client);
    const id = await resolver.resolveNurseType('AT');
    expect(id).toBeUndefined();
  });

  it('comparação case-insensitive', async () => {
    const client = makeClient([{ id: 5, name: 'ACOMPAÑANTE TERAPÉUTICO' }]);
    const resolver = new AnaCareTypeResolver(client);
    const id = await resolver.resolveNurseType('AT');
    expect(id).toBe(5);
  });
});

// ─── resolveHiringType ────────────────────────────────────────────

describe('AnaCareTypeResolver.resolveHiringType', () => {
  it('retorna ID quando employmentType mapeado existe no catálogo', async () => {
    const client = makeClient([], [{ id: 10, name: 'Independiente' }]);
    const resolver = new AnaCareTypeResolver(client);
    const id = await resolver.resolveHiringType('MEI');
    expect(id).toBe(10);
  });

  it('retorna undefined quando employmentType não tem mapeamento', async () => {
    const client = makeClient();
    const resolver = new AnaCareTypeResolver(client);
    const id = await resolver.resolveHiringType('CLT');
    expect(id).toBeUndefined();
  });

  it('retorna undefined quando API falha', async () => {
    const client = makeClient();
    (client.listHiringTypes as jest.Mock).mockRejectedValue(new Error('timeout'));
    const resolver = new AnaCareTypeResolver(client);
    const id = await resolver.resolveHiringType('MEI');
    expect(id).toBeUndefined();
  });
});

// ─── resolve (ambos) ─────────────────────────────────────────────

describe('AnaCareTypeResolver.resolve', () => {
  it('retorna ambos os tipos quando encontrados', async () => {
    const client = makeClient(
      [{ id: 1, name: 'Acompañante Terapéutico' }],
      [{ id: 10, name: 'Independiente' }],
    );
    const resolver = new AnaCareTypeResolver(client);
    const result = await resolver.resolve('AT', 'MEI');
    expect(result.tipo_enfermera).toBe(1);
    expect(result.tipo_contratacion).toBe(10);
  });

  it('omite tipo_enfermera quando não resolvido', async () => {
    const client = makeClient([], [{ id: 10, name: 'Independiente' }]);
    const resolver = new AnaCareTypeResolver(client);
    const result = await resolver.resolve('AT', 'MEI');
    expect(result.tipo_enfermera).toBeUndefined();
    expect(result.tipo_contratacion).toBe(10);
  });

  it('retorna objeto vazio quando nenhum tipo resolvido', async () => {
    const client = makeClient([], []);
    const resolver = new AnaCareTypeResolver(client);
    const result = await resolver.resolve(null, null);
    expect(Object.keys(result)).toHaveLength(0);
  });
});
