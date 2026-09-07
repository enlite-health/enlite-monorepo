/**
 * mapAnchor — o PASSO 1 do /admin/mapa: escolher a ÂNCORA.
 *
 * A tela responde "quem está perto de quem", e uma proximidade precisa de dois
 * lados. Sem âncora ela mostrava todo mundo em volta do Obelisco — uma lista
 * de gente que não é resposta de nada, e que ainda por cima é leitura em massa
 * de domicílio. Por isso o passo 2 em diante só existe depois daqui: na aba de
 * prestadores a âncora é um PACIENTE, na de pacientes é um PRESTADOR.
 *
 * O seletor é o mesmo `SearchableSelect` de antes (sem portal — lex 02/09, C-1)
 * e continua mascarado para o Clarity: as opções são "nome · bairro" de pessoa.
 */
import { MapPinned } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';
import { SearchableSelect } from '@presentation/components/molecules/SearchableSelect/SearchableSelect';
import { Field } from './mapSidebar';

/** Quem o mapa toma como referência: o centro do raio e o destino das rotas. */
export interface MapAnchor {
  /** Id do PONTO (endereço, no caso de paciente) — casa com o id da lista e do pino. */
  id: string;
  /** Id da PESSOA — é o que abre a ficha (`/admin/patients/:id`). */
  personId: string;
  name: string;
  lat: number;
  lng: number;
}

export interface AnchorOption {
  value: string;
  label: string;
}

/** O que o seletor tem a dizer além das opções — nesta ordem de prioridade. */
export interface AnchorStatus {
  isLoading: boolean;
  error: string | null;
  /** O teto de 500 pontos cortou a lista: há gente que não está aqui. */
  truncated: boolean;
}

/**
 * O seletor da âncora. `onTouch` preserva a busca preguiçosa: a página abre
 * sem NENHUMA request e só vai ao servidor quando alguém toca o seletor.
 *
 * ⚠️ Ele é um PORTÃO, não um filtro a mais: se esta lista falhar ou vier
 * cortada, não existe outro caminho para a tela. Por isso erro, carga e teto
 * são ditos aqui — um seletor mudo e vazio se lê como "não há ninguém", que é
 * a conclusão errada tanto para um 500 quanto para o corte dos 500 pontos.
 */
export function AnchorPicker({
  id, label, placeholder, searchPlaceholder, options, value, onChange, onTouch, status, labels,
  onSearchChange, serverSearchTerm, emptyMessage,
}: {
  id: string;
  label: string;
  placeholder: string;
  searchPlaceholder: string;
  options: AnchorOption[];
  value: string;
  onChange: (v: string) => void;
  onTouch: () => void;
  status: AnchorStatus;
  labels: { loading: string; error: string; truncated: string };
  /**
   * Presente = a busca vai ao SERVIDOR e `options` é a resposta dela. Ausente =
   * o seletor filtra em memória, como antes. Só a âncora de PACIENTE passa
   * isto hoje (o nome do prestador é cifrado — ver `useAnchorCandidates`).
   */
  onSearchChange?: (text: string) => void;
  /** O termo a que `options` já corresponde — ver `SearchableSelect`. */
  serverSearchTerm?: string;
  emptyMessage?: string;
}): JSX.Element {
  const nota = status.error
    ? { testId: 'map-anchor-error', className: 'text-red-600', text: labels.error }
    : status.isLoading
      ? { testId: 'map-anchor-loading', className: 'text-gray-500', text: labels.loading }
      : status.truncated
        ? { testId: 'map-anchor-truncated', className: 'text-amber-700', text: labels.truncated }
        : null;

  return (
    <Field id={id} label={label} group>
      <div data-testid={id} data-clarity-mask="True" onFocusCapture={onTouch} onClick={onTouch}>
        <SearchableSelect
          options={options}
          value={value}
          onChange={onChange}
          placeholder={placeholder}
          searchPlaceholder={searchPlaceholder}
          onSearchChange={onSearchChange}
          serverSearchTerm={serverSearchTerm}
          emptyMessage={emptyMessage}
        />
      </div>
      {/* o `data-testid` vai no DIV, nunca no `Text`: o atom não repassa prop
          desconhecida, e o TypeScript não reclama de atributo com hífen — some
          em silêncio. É o mesmo padrão do `mapSidebar`. */}
      {nota && (
        <div data-testid={nota.testId}>
          <Text as="div" size="xs" color="muted" className={nota.className}>{nota.text}</Text>
        </div>
      )}
    </Field>
  );
}

/**
 * O que ocupa a área do mapa enquanto não há âncora. Um retângulo cinza vazio
 * se lê como falha de carregamento; isto diz o que falta e por quê.
 */
export function AnchorEmptyState({ title, hint, height = 560 }: { title: string; hint: string; height?: number }): JSX.Element {
  return (
    <div
      className="flex flex-col items-center justify-center gap-2 w-full rounded-[10px] border border-dashed border-gray-300 bg-gray-50 px-6 text-center"
      style={{ height }}
      data-testid="map-anchor-empty"
    >
      <MapPinned size={32} className="text-gray-400" />
      <Text as="div" size="sm" weight="semibold" color="secondary">{title}</Text>
      <Text as="div" size="xs" color="muted" className="max-w-[380px]">{hint}</Text>
    </div>
  );
}

