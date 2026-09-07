/**
 * useAnchorCandidates — quem pode virar ÂNCORA do mapa, e como se acha essa pessoa.
 *
 * O seletor da âncora é um PORTÃO: sem escolher alguém nele, a tela inteira não
 * busca nada. Até 07/09/2026 ele tinha uma única fonte — um raio FIXO de 50 km
 * a partir do centro do país — e a caixa de texto filtrava em MEMÓRIA o que
 * aquela chamada tivesse trazido. Quem morava fora do raio não estava na lista,
 * e digitar o nome respondia "Sin resultados", que se lê como "essa pessoa não
 * existe". Medido em produção nesse dia: 63 endereços de paciente fora dos
 * 50 km, 39 deles ATIVOS — Mar del Plata (381 km), Balcarce (360 km), Córdoba,
 * Mendoza, Neuquén, Bahía Blanca, Ushuaia.
 *
 * A troca: digitou ≥ 2 caracteres, o ESCOPO da busca deixa de ser geográfico e
 * passa a ser o nome — o servidor procura no país inteiro. Apagou o texto,
 * volta o raio de 50 km, que continua sendo a lista boa para "quem está por
 * perto" quando não se procura ninguém em particular.
 *
 * ⚠️ ASSIMETRIA DELIBERADA. Só a âncora de PACIENTE busca por nome. A de
 * PRESTADOR continua só com o raio, porque o nome do prestador é cifrado no
 * banco (`first_name_encrypted`) e a busca dele passa por índice cego de
 * trigramas — outro caminho, outro trabalho. Está reportado, não esquecido.
 */
import { useMemo, useState } from 'react';
import { usePatientsMapPoints, useWorkersMapPoints } from '@hooks/admin/useMapPoints';
import type {
  MapCountry, PatientsMapFilters, WorkersMapFilters,
} from '@infrastructure/http/AdminMapApiService';
import { ANCHOR_PICKER_RADIUS_KM, DEFAULT_CENTER_BY_COUNTRY, placeLabel } from './mapPageConfig';
import type { AnchorOption, AnchorStatus } from './mapAnchor';

/**
 * Mínimo para a busca sair do cliente. Uma letra devolveria quase a base
 * inteira — e aí o "escopo" que o servidor exige não seria escopo nenhum. O
 * backend recusa com 400 abaixo disto; aqui a gente simplesmente não pergunta.
 */
export const ANCHOR_SEARCH_MIN_CHARS = 2;

export type AnchorKind = 'workers' | 'patients';

/** Um candidato já COM coordenada — sem ela não dá para centrar o mapa. */
export interface AnchorCandidate {
  id: string;
  addressId?: string | null;
  name: string;
  lat: number;
  lng: number;
  city: string | null;
  neighborhood: string | null;
}

/** O id do PONTO: um paciente é um por endereço; um prestador é ele mesmo. */
export const pointIdOf = (p: { id: string; addressId?: string | null }): string => p.addressId ?? p.id;

export const anchorLabel = (p: { name: string; city: string | null; neighborhood: string | null }): string => {
  const place = placeLabel(p);
  return place ? `${p.name} · ${place}` : p.name;
};

const located = <P extends { lat: number | null; lng: number | null }>(
  p: P,
): p is P & { lat: number; lng: number } => p.lat !== null && p.lng !== null;

export interface AnchorCandidatesResult {
  candidates: AnchorCandidate[];
  options: AnchorOption[];
  status: AnchorStatus;
  /** O que o seletor devolve a cada tecla (já com debounce do componente). */
  onSearchChange: (text: string) => void;
  /** true quando a lista veio de uma busca por nome, não do raio de 50 km. */
  isSearching: boolean;
  /** O termo digitado, cru — para a tela decidir a mensagem de lista vazia. */
  searchText: string;
}

export function useAnchorCandidates({
  kind, country, touchedPatients, touchedWorkers,
}: {
  kind: AnchorKind;
  country: MapCountry;
  touchedPatients: boolean;
  touchedWorkers: boolean;
}): AnchorCandidatesResult {
  const [searchText, setSearchText] = useState('');
  const term = searchText.trim();
  const isSearching = term.length >= ANCHOR_SEARCH_MIN_CHARS;

  /**
   * Buscar por nome e recortar por raio ao mesmo tempo traria de volta o bug:
   * o nome só valeria dentro dos 50 km. Por isso o escopo é UM ou OUTRO — e
   * `search` sozinho já satisfaz a exigência de escopo do servidor.
   */
  const patientScope = useMemo<PatientsMapFilters>(() => (isSearching
    ? { country, search: term }
    : { country, center: DEFAULT_CENTER_BY_COUNTRY[country], radius_km: ANCHOR_PICKER_RADIUS_KM }
  ), [country, isSearching, term]);

  /** Prestador: sem busca por nome (ver a assimetria no topo do arquivo). */
  const workerScope = useMemo<WorkersMapFilters>(() => (
    { country, center: DEFAULT_CENTER_BY_COUNTRY[country], radius_km: ANCHOR_PICKER_RADIUS_KM }
  ), [country]);

  const patientPicker = usePatientsMapPoints(patientScope, kind === 'workers' && touchedPatients);
  const workerPicker = useWorkersMapPoints(workerScope, kind === 'patients' && touchedWorkers);

  const source = kind === 'workers' ? patientPicker : workerPicker;

  const candidates = useMemo<AnchorCandidate[]>(
    () => source.points.filter(located),
    [source.points],
  );

  const options = useMemo<AnchorOption[]>(
    () => candidates.map((p) => ({ value: pointIdOf(p), label: anchorLabel(p) })),
    [candidates],
  );

  return {
    candidates,
    options,
    status: { isLoading: source.isLoading, error: source.error, truncated: source.truncated },
    onSearchChange: setSearchText,
    isSearching,
    searchText,
  };
}
