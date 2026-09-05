/**
 * mapResults — o PASSO 3 do /admin/mapa: contagens + lista lateral.
 *
 * Fora da página porque ela não cabia nas 400 linhas depois do passo 1 (a
 * âncora). Na extração as duas listas viraram UMA: antes o `<li>` de prestador
 * e o de paciente eram blocos separados que já renderizavam a mesma coisa
 * (bolinha, nome com link, distância, linha de detalhe) a partir de campos com
 * nomes diferentes. Agora a página monta `ResultRow[]` uma vez e o mapa e a
 * lista leem a MESMA fonte — é o que garante que os dois nunca discordem.
 */
import { Link } from 'react-router-dom';
import type { MouseEvent } from 'react';
import { Text } from '@presentation/components/atoms/Text';
import type { MapPoint } from '@presentation/components/molecules/PointsMap/PointsMap';
import { Searching } from './mapSidebar';

/**
 * Uma linha da lista É um ponto do mapa — o MESMO objeto, não uma cópia dos
 * campos. A página monta `ResultRow[]` uma vez e entrega o mesmo array ao
 * `PointsMap` e a esta lista; assim os dois não têm como discordar.
 *
 * `details` já vem montado por `workerDetails`/`patientDetails`, e já inclui o
 * "sin ubicación" de quem não tem coordenada.
 */
export interface ResultRow extends MapPoint {
  /** Id do PACIENTE, só nas linhas de paciente — difere do id do ponto (que é
   *  o do endereço) e é o que o e2e usa para casar linha × pessoa. */
  patientId?: string;
  /** Obrigatório aqui (no `MapPoint` é opcional): TODA linha da lista abre uma
   *  ficha. Estreitar aqui é o que dispensa um fallback que nunca acontece. */
  href: string;
}

export interface MapCountsState {
  total: number;
  withoutCoordinates: number;
  truncated: boolean;
  shown: number;
  isLoading: boolean;
  error: string | null;
}

/** Clicar no nome abre a ficha — sem também selecionar a linha. */
const stopRowSelect = (e: MouseEvent): void => e.stopPropagation();

export function MapCounts({
  state, radiusKm, labels,
}: {
  state: MapCountsState;
  radiusKm: number;
  labels: {
    loading: string;
    inRadius: (km: number) => string;
    withoutCoordinates: (n: number) => string;
    showingFirst: (shown: number, total: number) => string;
  };
}): JSX.Element {
  return (
    <div className="rounded-md bg-gray-50 border border-gray-200 px-3 py-2" data-testid="map-counts">
      <Text as="div" size="sm" color="primary">
        {state.isLoading ? (
          <span data-testid="map-loading">{labels.loading}</span>
        ) : state.error ? (
          <span className="text-red-600" data-testid="map-error">{state.error}</span>
        ) : (
          <>
            <strong data-testid="map-total">{state.total}</strong>{' '}
            {labels.inRadius(radiusKm)}
            {state.withoutCoordinates > 0 && (
              <span className="text-amber-700" data-testid="map-without-coords">
                {' · '}{labels.withoutCoordinates(state.withoutCoordinates)}
              </span>
            )}
            {/* `total` é o do banco (COUNT(*) OVER()), `shown` é o que o teto de
                500 deixou passar: quando diferem, a tela diz quantos está
                mostrando de quantos existem — nunca finge que o tamanho da
                página é o tamanho do filtro. */}
            {state.truncated && (
              <span className="text-red-600" data-testid="map-truncated">
                {' · '}{labels.showingFirst(state.shown, state.total)}
              </span>
            )}
          </>
        )}
      </Text>
    </div>
  );
}

export function MapResultsList({
  rows, selectedId, hoveredId, onSelect, onHover, isSearching, showEmpty, emptyLabel, searchingLabel,
}: {
  rows: ResultRow[];
  selectedId: string | null;
  hoveredId: string | null;
  onSelect: (id: string) => void;
  onHover: (id: string | null) => void;
  /** Já havia resultado na tela e uma busca nova está em voo. */
  isSearching: boolean;
  /** "Ninguém neste raio" só depois de a busca VOLTAR: na primeira carga a
   *  lista está vazia porque ainda não respondeu, e dizer "nadie" ali é mentira. */
  showEmpty: boolean;
  emptyLabel: string;
  searchingLabel: string;
}): JSX.Element {
  const rowClass = (id: string): string =>
    `px-3 py-2 cursor-pointer ${selectedId === id ? 'bg-blue-50' : hoveredId === id ? 'bg-gray-100' : 'hover:bg-gray-50'}`;

  return (
    /* A lista é a maior massa visual da tela. Enquanto a busca não voltava ela
       ficava IDÊNTICA, e só um texto pequeno virava "Cargando…" — daí a leitura
       de que o clique não tinha feito nada. */
    <div className="relative">
      <ul
        className={`divide-y divide-gray-100 border border-gray-200 rounded-md max-h-[440px] overflow-y-auto ${isSearching ? 'opacity-40' : ''}`}
        data-testid="map-list"
        data-clarity-mask="True"
        onMouseLeave={() => onHover(null)}
      >
        {rows.map((r) => (
          <li
            key={r.id}
            data-testid="map-list-item"
            data-point-id={r.id}
            {...(r.patientId ? { 'data-patient-id': r.patientId } : {})}
            data-has-coords={r.lat !== null}
            className={rowClass(r.id)}
            onMouseEnter={() => onHover(r.id)}
            onClick={() => onSelect(r.id)}
          >
            <div className="flex items-center gap-2">
              <span className="inline-block w-2.5 h-2.5 rounded-full shrink-0" style={{ background: r.color }} />
              <Link to={r.href} className="hover:underline truncate" onClick={stopRowSelect}>
                <Text as="span" size="sm" weight="medium" color="primary">{r.title}</Text>
              </Link>
              {r.distance && <Text as="span" size="xs" color="secondary" className="ml-auto shrink-0">{r.distance}</Text>}
            </div>
            <Text as="div" size="xs" color="secondary" className="truncate">
              {r.details}
            </Text>
          </li>
        ))}
        {showEmpty && (
          <li className="px-3 py-4" data-testid="map-empty">
            <Text size="sm" color="secondary">{emptyLabel}</Text>
          </li>
        )}
      </ul>
      {isSearching && <Searching label={searchingLabel} />}
    </div>
  );
}
