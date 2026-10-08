import { useCallback, useState } from 'react';

export type SortDirection = 'asc' | 'desc';
export interface TableSort<K extends string> {
  key: K;
  direction: SortDirection;
}

/**
 * Estado de ordenação de uma tabela. Coluna nova -> `desc` (maior para o menor); mesma coluna -> alterna `desc`/`asc`.
 * Nunca há um 3º estado ("sem ordem") depois do primeiro clique. `null` = nada clicado ainda.
 */
export function useTableSort<K extends string>() {
  const [sort, setSort] = useState<TableSort<K> | null>(null);

  const toggle = useCallback((key: K) => {
    setSort((prev) =>
      prev && prev.key === key
        ? { key, direction: prev.direction === 'asc' ? 'desc' : 'asc' }
        : { key, direction: 'desc' },
    );
  }, []);

  return { sort, toggle };
}
