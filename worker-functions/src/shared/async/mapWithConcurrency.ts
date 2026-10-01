/**
 * Executa `fn` sobre `items` com no máximo `limit` promessas simultâneas, preservando no
 * array de saída a ORDEM DE ENTRADA (indexa pela posição do item, não pela ordem em que
 * a promessa resolveu).
 *
 * Por que existe: listar uma página de mensagens decifra `body_encrypted` via KMS — sem
 * limite, estoura a cota da API; em série, a listagem fica lenta. Pool fixo de workers que
 * consomem um cursor compartilhado, sem depender de lib externa (D-01 da spec 022).
 *
 * Contrato de borda:
 * - `items` vazio → resolve `[]` de imediato, sem chamar `fn` e sem tocar em `limit`.
 * - `limit <= 0` → rejeita com `RangeError` (falhar alto e claro; não tem pool sem workers).
 * - `limit >= items.length` → efetivamente sem limite: todos os workers necessários
 *   disparam de uma vez (o pool nunca cria mais workers do que itens).
 */
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }

  if (limit <= 0) {
    throw new RangeError(`mapWithConcurrency: limit precisa ser > 0 (recebido ${limit})`);
  }

  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await fn(items[currentIndex]);
    }
  }

  const workerCount = Math.min(limit, items.length);
  const workers: Promise<void>[] = [];
  for (let i = 0; i < workerCount; i += 1) {
    workers.push(worker());
  }

  await Promise.all(workers);

  return results;
}
