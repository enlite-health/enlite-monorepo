/**
 * useCorridor — busca o corredor de UM par prestador×paciente, sob demanda.
 *
 * "Sob demanda" é a regra, não uma otimização: a rota devolve a relação entre
 * duas pessoas, e o backend limita 60 chamadas por minuto por staff justamente
 * para ela não virar varredura. Buscar o corredor de todos os pinos ao abrir a
 * tela seria exatamente a enumeração que o limite existe para impedir — então
 * só o pino ABERTO consulta.
 *
 * O cache é por par e vive na sessão: reabrir o mesmo balão não gasta chamada.
 *
 * ⚖️ ATENÇÃO — o que mora neste `Map` MUDOU em 06/09. Até então eram só paradas
 * e linhas (infraestrutura pública). Com o traçado, ele passa a guardar a
 * POLILINHA porta a porta, cujos vértices das pontas são os dois domicílios.
 * Por isso, condição do parecer do `lex`:
 *   - o cache é `Map` em MEMÓRIA e morre com a aba. Nunca `localStorage`,
 *     `sessionStorage` nem IndexedDB — persistir aqui seria criar, no disco da
 *     recrutadora, um índice de onde as pessoas moram;
 *   - a polilinha não pode entrar em log nem em atributo do DOM (ver
 *     `CorridorPanel` e `useRouteOverlay`).
 */
import { useEffect, useState } from 'react';
import {
  AdminMapApiService,
  type CorridorRequest,
  type CorridorResponse,
} from '@infrastructure/http/AdminMapApiService';

export interface CorridorState {
  data: CorridorResponse | null;
  isLoading: boolean;
  error: string | null;
}

const cache = new Map<string, CorridorResponse>();

/** Só para o teste poder começar do zero — a tela nunca chama isto. */
export function __clearCorridorCache(): void {
  cache.clear();
}

const keyOf = (r: CorridorRequest): string => `${r.country}|${r.workerId}|${r.patientAddressId}`;

export function useCorridor(request: CorridorRequest | null): CorridorState {
  const key = request ? keyOf(request) : null;
  const [state, setState] = useState<CorridorState>({ data: null, isLoading: false, error: null });

  useEffect(() => {
    if (!request || !key) {
      setState({ data: null, isLoading: false, error: null });
      return undefined;
    }
    const cached = cache.get(key);
    if (cached) {
      setState({ data: cached, isLoading: false, error: null });
      return undefined;
    }

    let cancelled = false;
    setState({ data: null, isLoading: true, error: null });
    AdminMapApiService.getCorridor(request)
      .then((data) => {
        cache.set(key, data);
        if (!cancelled) setState({ data, isLoading: false, error: null });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setState({ data: null, isLoading: false, error: err instanceof Error ? err.message : 'Failed to load corridor' });
      });
    return () => { cancelled = true; };
    // `key` é o par por VALOR; `request` muda de identidade a cada render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return state;
}

/**
 * Monta o par a consultar. Quem VIAJA é sempre o prestador, então o lado de
 * origem muda com a aba: na de prestadores a âncora é o paciente e o pino é o
 * prestador; na de pacientes é o contrário. Devolve `null` — e o hook não
 * consulta — quando falta âncora, falta seleção, ou o ponto aberto não tem
 * coordenada.
 */
export function corridorPairFor(
  kind: 'workers' | 'patients',
  country: 'AR' | 'BR',
  anchorId: string | null,
  selected: { id: string; lat: number | null } | null | undefined,
): CorridorRequest | null {
  if (!anchorId || !selected || selected.lat === null) return null;
  return kind === 'workers'
    ? { country, workerId: selected.id, patientAddressId: anchorId }
    : { country, workerId: anchorId, patientAddressId: selected.id };
}
