/**
 * A lista paginada da aba "Vínculos de área" — filtros, página e busca com espera, num lugar só.
 *
 * Regras que moram aqui (e não na tela):
 *  - busca por nome/e-mail só vai ao servidor com ≥ 3 caracteres (abaixo disso ele devolve 400): com 1-2
 *    a lista segue como está e `searchTooShort` acende a dica;
 *  - mudar filtro/tamanho/busca volta para a página 1; página que ficou além do fim (revogou o último da
 *    página no filtro "só com vínculo") recua para a última;
 *  - resposta que chega fora de ordem é descartada (só a última pergunta vale).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import {
  AREA_PEOPLE_MIN_SEARCH,
  grantTarget,
  type AreaPeoplePage,
  type AreaPeopleTypeFilter,
  type AreaPerson,
} from '@domain/entities/AreaMembership';

export type AreaPeoplePhase = 'loading' | 'ready' | 'error';

const SEARCH_DEBOUNCE_MS = 300;
const DEFAULT_PER_PAGE = 20;

export interface UseAreaPeople {
  search: string;
  /** Tem texto, mas ainda curto demais para o servidor. */
  searchTooShort: boolean;
  /** O termo que de fato foi ao servidor ('' = sem busca). */
  appliedSearch: string;
  type: AreaPeopleTypeFilter;
  onlyWithMembership: boolean;
  page: number;
  perPage: number;
  data: AreaPeoplePage | null;
  /** `loading` só enquanto NÃO há dado nenhum; recarga com dado na tela segue `ready` (`isFetching`). */
  phase: AreaPeoplePhase;
  isFetching: boolean;
  setSearch: (value: string) => void;
  setType: (value: AreaPeopleTypeFilter) => void;
  setOnlyWithMembership: (value: boolean) => void;
  setPerPage: (value: number) => void;
  prevPage: () => void;
  nextPage: () => void;
  reload: () => void;
}

export function useAreaPeople(): UseAreaPeople {
  const [search, setSearchState] = useState('');
  const [debounced, setDebounced] = useState('');
  const [type, setTypeState] = useState<AreaPeopleTypeFilter>('all');
  const [onlyWithMembership, setOnlyState] = useState(false);
  const [page, setPage] = useState(1);
  const [perPage, setPerPageState] = useState(DEFAULT_PER_PAGE);
  const [tick, setTick] = useState(0);
  const [data, setData] = useState<AreaPeoplePage | null>(null);
  const [failed, setFailed] = useState(false);
  const [isFetching, setIsFetching] = useState(true);
  const seq = useRef(0);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(search.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [search]);

  const appliedSearch = debounced.length >= AREA_PEOPLE_MIN_SEARCH ? debounced : '';

  useEffect(() => {
    const mine = ++seq.current;
    setIsFetching(true);
    setFailed(false);
    AdminApiService.listAreaPeople({
      search: appliedSearch || undefined,
      type,
      withMembership: onlyWithMembership ? true : undefined,
      limit: perPage,
      offset: (page - 1) * perPage,
    })
      .then((next) => {
        if (mine !== seq.current) return;
        const pages = Math.max(1, Math.ceil(next.total / perPage));
        if (next.items.length === 0 && next.total > 0 && page > pages) {
          setPage(pages);
          return;
        }
        setData(next);
        setIsFetching(false);
      })
      .catch(() => {
        if (mine !== seq.current) return;
        setData(null);
        setFailed(true);
        setIsFetching(false);
      });
  }, [appliedSearch, type, onlyWithMembership, perPage, page, tick]);

  const setSearch = useCallback((value: string) => {
    setSearchState(value);
    setPage(1);
  }, []);

  return {
    search,
    searchTooShort: search.trim().length > 0 && search.trim().length < AREA_PEOPLE_MIN_SEARCH,
    appliedSearch,
    type,
    onlyWithMembership,
    page,
    perPage,
    data,
    phase: failed ? 'error' : data ? 'ready' : 'loading',
    isFetching,
    setSearch,
    setType: (value) => { setTypeState(value); setPage(1); },
    setOnlyWithMembership: (value) => { setOnlyState(value); setPage(1); },
    setPerPage: (value) => { setPerPageState(value); setPage(1); },
    prevPage: () => setPage((p) => Math.max(1, p - 1)),
    nextPage: () => setPage((p) => p + 1),
    reload: () => setTick((n) => n + 1),
  };
}

/**
 * A pessoa como o servidor a vê AGORA — para o painel mostrar o resultado de uma concessão. Lê pelo
 * `personId` (ou, para quem só tinha login, pelo `uid`: a resposta já traz o `personId` que a concessão
 * criou). NÃO engole erro: quem chama decide mostrar a falha — a pessoa antiga nunca vale como "atual".
 */
export async function fetchFreshAreaPerson(person: AreaPerson): Promise<AreaPerson> {
  const target = grantTarget(person);
  if (!target) throw new Error('pessoa sem personId nem uid');
  const fresh = await AdminApiService.listAreaMembershipsOf(target);
  return {
    ...person,
    personId: fresh.personId,
    memberships: fresh.memberships.map((m) => ({ id: m.id, area: m.area, role: m.role })),
  };
}
