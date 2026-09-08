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
import { useEffect, useMemo, useRef, useState } from 'react';
import { usePatientsMapPoints, useWorkersMapPoints } from '@hooks/admin/useMapPoints';
import { useContainerAccess } from '@presentation/hooks/useCellAccess';
import type {
  MapCountry, PatientsMapFilters, WorkersMapFilters,
} from '@infrastructure/http/AdminMapApiService';
import { ANCHOR_PICKER_RADIUS_KM, DEFAULT_CENTER_BY_COUNTRY, placeLabel } from './mapPageConfig';
import type { AnchorOption, AnchorStatus } from './mapAnchor';

/**
 * Mínimo para a busca sair do cliente. TEM DE BATER com o `min()` do schema no
 * servidor (`AdminPatientsMapController`), que é quem recusa com 400.
 *
 * São 3, e o número é medido: com 2, termos legítimos varriam a base — 'an'
 * devolvia 38% dos domicílios do país, 'ar' 35%. Com 3 o pior caso cai para
 * 16%, e o teto do escopo por nome corta o resto. Parecer do `lex` de
 * 07/09/2026, condição C-B.
 */
export const ANCHOR_SEARCH_MIN_CHARS = 3;

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
  /**
   * O termo a que `options` JÁ corresponde — vazio enquanto a lista é a de
   * repouso. Difere de `searchText` durante o debounce e o voo da request; é
   * essa diferença que diz ao seletor quando a lista na mão é de outra
   * pergunta e o filtro local ainda precisa valer.
   */
  appliedTerm: string;
  /**
   * Quantos a API achou e a tela NÃO pode plotar (sem coordenada). Achar
   * alguém por nome e mostrar "Sin resultados" porque falta geocódigo é a
   * mesma conclusão errada que esta busca existe para matar.
   */
  withoutCoordinates: number;
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
  /**
   * Buscar paciente por NOME é leitura de identidade: sem `patient_identity:read` a rota
   * responde 403 (gate do sync main→stage, 08/09 — o nome vem `NOME_REDIGIDO`, e filtrar por ele
   * seria um oráculo). Sem a célula, o que se digita filtra só a lista local do raio.
   * Mesmo freio de enforcement dos containers (D268): com o engine OFF, busca como sempre.
   */
  const { visible: podeBuscarPorNome } = useContainerAccess('patient_identity');
  const isSearching = podeBuscarPorNome && term.length >= ANCHOR_SEARCH_MIN_CHARS;

  /**
   * Trocar de aba abandona o termo. O `key` no seletor remonta o FILHO e limpa
   * a caixa, mas o texto mora AQUI, na página, que não remonta — então voltar
   * para a aba anterior religava o escopo por nome e disparava uma busca que
   * ninguém pediu, com a caixa visivelmente vazia.
   */
  useEffect(() => { setSearchText(''); }, [kind]);

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

  /**
   * O termo cuja RESPOSTA está em `options`. Só avança quando a carga termina;
   * durante o voo continua valendo o anterior — que é exatamente a informação
   * que o seletor precisa para não desligar o filtro local cedo demais.
   * Ref mutado no render: é cache idempotente, e o valor tem de estar certo já
   * no primeiro paint depois da resposta.
   */
  const aplicado = useRef('');
  if (!source.isLoading) aplicado.current = isSearching ? term : '';

  return {
    candidates,
    options,
    status: { isLoading: source.isLoading, error: source.error, truncated: source.truncated },
    onSearchChange: setSearchText,
    isSearching,
    searchText,
    appliedTerm: aplicado.current,
    withoutCoordinates: source.withoutCoordinates,
  };
}
