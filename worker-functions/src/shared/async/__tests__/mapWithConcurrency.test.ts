import { mapWithConcurrency } from '../mapWithConcurrency';

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('mapWithConcurrency', () => {
  it('resolve todos os itens', async () => {
    const items = [1, 2, 3, 4, 5];

    const result = await mapWithConcurrency(items, 2, async (item) => item * 10);

    expect(result).toEqual([10, 20, 30, 40, 50]);
  });

  it('preserva a ordem do array de entrada mesmo quando os itens resolvem fora de ordem', async () => {
    // item 0 demora mais que os demais — se a implementação indexar pela ordem de
    // CONCLUSÃO em vez da ordem de ENTRADA, o item 0 apareceria no fim do array.
    const delays = [50, 10, 5, 0];

    const result = await mapWithConcurrency(delays, 4, async (ms) => {
      await delay(ms);
      return ms;
    });

    expect(result).toEqual([50, 10, 5, 0]);
  });

  it('nunca roda mais que `limit` promessas simultâneas (pico medido)', async () => {
    const items = Array.from({ length: 20 }, (_, i) => i);
    const limit = 5;
    let active = 0;
    let pico = 0;

    await mapWithConcurrency(items, limit, async (item) => {
      active += 1;
      pico = Math.max(pico, active);
      await delay(10);
      active -= 1;
      return item;
    });

    expect(pico).toBeLessThanOrEqual(limit);
    // com 20 itens e limit=5, o pool deve de fato SATURAR o limite (não é só "nunca passou").
    expect(pico).toBe(limit);
  });

  it('propaga o erro de um item sem travar os demais (a promessa retornada rejeita)', async () => {
    const items = [1, 2, 3, 4, 5];
    const concluidos: number[] = [];

    const promise = mapWithConcurrency(items, 2, async (item) => {
      if (item === 3) {
        throw new Error(`falhou no item ${item}`);
      }
      await delay(5);
      concluidos.push(item);
      return item;
    });

    await expect(promise).rejects.toThrow('falhou no item 3');

    // dá um respiro para os workers que já estavam em voo terminarem — nenhum deles
    // deve ficar pendurado (sem timeout do Jest, sem "did not exit" warning).
    await delay(20);
    expect(concluidos.length).toBeGreaterThan(0);
  });

  it('items vazio resolve [] sem chamar fn', async () => {
    const fn = jest.fn(async (item: number) => item);

    const result = await mapWithConcurrency<number, number>([], 5, fn);

    expect(result).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it('limit <= 0 rejeita (contrato: pool de zero/negativo não tem sentido)', async () => {
    await expect(mapWithConcurrency([1, 2], 0, async (item) => item)).rejects.toThrow(RangeError);
    await expect(mapWithConcurrency([1, 2], -1, async (item) => item)).rejects.toThrow(RangeError);
  });

  it('limit maior que items.length roda tudo de uma vez e preserva ordem/valores', async () => {
    const items = ['a', 'b', 'c'];

    const result = await mapWithConcurrency(items, 100, async (item) => item.toUpperCase());

    expect(result).toEqual(['A', 'B', 'C']);
  });
});
