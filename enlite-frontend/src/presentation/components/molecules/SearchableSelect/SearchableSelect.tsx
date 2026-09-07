import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ChevronDown } from 'lucide-react';

export interface SearchableSelectOption {
  value: string;
  label: string;
}

interface SearchableSelectProps {
  options: SearchableSelectOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  label?: string;
  searchPlaceholder?: string;
  disabled?: boolean;
  /** `compact` casa com o `Select` compact das linhas de filtro (h-10). */
  inputSize?: 'default' | 'compact';
  /** Vai para o botão que abre a lista — é o que o e2e clica. */
  'data-testid'?: string;
  /**
   * BUSCA NO SERVIDOR. Quando presente, o componente PARA de filtrar em
   * memória: `options` passa a ser "o que o servidor respondeu para o último
   * termo", e o texto digitado é devolvido aqui (com debounce) para o pai
   * buscar. Sem esta prop nada muda — o filtro local continua o padrão.
   *
   * Existe porque filtrar em memória só acha quem já foi carregado: no mapa,
   * a lista vinha de um raio fixo de 50 km e quem morava fora dele lia
   * "Sin resultados", que é a conclusão errada.
   */
  onSearchChange?: (text: string) => void;
  /** Espera entre a última tecla e a busca. Só vale com `onSearchChange`. */
  searchDebounceMs?: number;
  /**
   * O termo a que `options` JÁ corresponde — o que o servidor respondeu, não o
   * que está sendo digitado. String vazia = as opções são da lista de repouso
   * (o escopo sem busca).
   *
   * É o que fecha a janela cega entre a tecla e a resposta: enquanto o texto
   * digitado não for este termo, `options` é de OUTRA pergunta, e o único
   * filtro honesto é o local. Sem isto, no instante em que o texto atinge o
   * mínimo o filtro local desligava e a lista inteira reaparecia sem filtro
   * por um debounce + RTT — clicável. Só vale com `onSearchChange`.
   */
  serverSearchTerm?: string;
  /** O que dizer quando a lista está vazia (ex.: "Escribí al menos 2 letras"). */
  emptyMessage?: string;
}

function normalizeText(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

export function SearchableSelect({
  options,
  value,
  onChange,
  placeholder,
  label,
  searchPlaceholder,
  disabled = false,
  inputSize = 'default',
  'data-testid': testId,
  onSearchChange,
  searchDebounceMs = 300,
  serverSearchTerm = '',
  emptyMessage,
}: SearchableSelectProps): JSX.Element {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [searchText, setSearchText] = useState('');
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const allPlaceholder = placeholder ?? t('common.all', 'Todos');
  const searchPh = searchPlaceholder ?? t('common.search', 'Buscar...');

  const selectedOption = options.find((o) => o.value === value);
  /**
   * 🔒 O RÓTULO SOBREVIVE À LISTA (achado do gate no PR #320).
   *
   * Com busca no servidor, escolher um item TROCA a lista: `handleSelect` limpa
   * o texto, o pai volta ao escopo anterior e o item escolhido some de
   * `options` — então `selectedOption` vira `undefined` e o botão voltava ao
   * placeholder cinza 300 ms depois de escolher, como se nada tivesse sido
   * selecionado. Guardar o rótulo já visto resolve sem obrigar o pai a manter
   * na lista um item que não pertence mais ao escopo dela.
   *
   * É cache idempotente, por isso alimentado no render e não num efeito: no
   * primeiro paint depois da troca de lista o rótulo já tem de estar certo.
   */
  const rotulosVistos = useRef(new Map<string, string>());
  for (const o of options) rotulosVistos.current.set(o.value, o.label);
  const rotuloLembrado = rotulosVistos.current.get(value);
  /**
   * 🔒 A COR ANDA COM O TEXTO (2ª passada do gate). O cache fazia o nome
   * aparecer, mas a classe continuava derivando de `selectedOption` — que é
   * `undefined` exatamente no caso para o qual o cache existe. Resultado: o
   * paciente escolhido em cinza-de-placeholder, que se lê como "nada
   * selecionado, com um nome escrito por cima". Régua de FORMA (só
   * `textContent`) não mede substância.
   */
  const temSelecao = selectedOption !== undefined || rotuloLembrado !== undefined;
  const displayLabel = selectedOption?.label ?? rotuloLembrado ?? allPlaceholder;

  // Com busca no servidor, `options` JÁ é o resultado do termo: filtrar de novo
  // aqui esconderia linha que o servidor achou e o cliente não sabe casar
  // (acento, "Reyna Alaburda, Ana Paula" contra nome e sobrenome separados).
  const serverSearch = onSearchChange !== undefined;
  /**
   * ⚠️ `options` corresponde a ESTE termo? Só quando a resposta do servidor
   * para ele já chegou. Em qualquer outro instante — texto curto demais para
   * buscar, debounce correndo, request em voo — a lista na mão é de outra
   * pergunta, e filtrar em memória é o único comportamento honesto.
   */
  const servidorRespondePorEsteTermo = serverSearch && searchText.trim() === serverSearchTerm;
  const filteredOptions = searchText && !servidorRespondePorEsteTermo
    ? options.filter((o) =>
        normalizeText(o.label).includes(normalizeText(searchText))
      )
    : options;

  /**
   * O callback vive num ref, e NÃO nas dependências do efeito: um pai que
   * recria a função a cada render dispararia uma busca por render em vez de
   * uma por termo — foi assim que o autocomplete do Places chegou a uma
   * chamada por tecla. Aqui o efeito depende só do texto e do debounce.
   */
  const onSearchRef = useRef(onSearchChange);
  useEffect(() => {
    onSearchRef.current = onSearchChange;
  });

  useEffect(() => {
    if (!serverSearch) return undefined;
    const id = setTimeout(() => onSearchRef.current?.(searchText), searchDebounceMs);
    return () => clearTimeout(id);
  }, [searchText, serverSearch, searchDebounceMs]);

  function handleOpen(): void {
    if (disabled) return;
    setIsOpen(true);
    setSearchText('');
    setTimeout(() => searchRef.current?.focus(), 0);
  }

  function handleSelect(optionValue: string): void {
    onChange(optionValue);
    setIsOpen(false);
    /**
     * No modo servidor o texto FICA. Limpá-lo aqui disparava, 300 ms depois de
     * escolher, uma busca nova de até 500 domicílios — com trilha de leitura
     * em massa — só para repovoar um dropdown que já estava fechado. Quem
     * limpa é `handleOpen`, quando a lista volta a ser olhada.
     */
    if (!serverSearch) setSearchText('');
  }

  useEffect(() => {
    function handleClickOutside(e: MouseEvent): void {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setSearchText('');
      }
    }
    if (isOpen) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  return (
    <div className="flex flex-col gap-1 w-full" ref={containerRef}>
      {label && (
        <span className="font-lexend font-semibold text-[#737373] text-base">
          {label}
        </span>
      )}
      <div className="relative">
        <button
          type="button"
          onClick={handleOpen}
          disabled={disabled}
          className={`w-full ${inputSize === 'compact' ? 'h-10 px-3' : 'h-12 px-4'} rounded-[10px] border-[1.5px] border-[#D9D9D9] bg-white font-lexend font-medium text-[#374151] text-sm flex items-center justify-between gap-2 focus:outline-none focus:border-[#180149] transition-colors disabled:opacity-50 disabled:cursor-not-allowed`}
          aria-haspopup="listbox"
          aria-expanded={isOpen}
          data-testid={testId}
        >
          <span className={temSelecao ? 'text-[#374151]' : 'text-[#B3B3B3]'}>
            {displayLabel}
          </span>
          <ChevronDown
            className={`w-4 h-4 text-[#737373] flex-shrink-0 transition-transform ${isOpen ? 'rotate-180' : ''}`}
          />
        </button>

        {isOpen && (
          <div className="absolute z-20 mt-1 w-full bg-white border border-[#D9D9D9] rounded-lg shadow-lg max-h-60 overflow-auto">
            <div className="sticky top-0 bg-white border-b border-[#D9D9D9]">
              <input
                ref={searchRef}
                type="text"
                value={searchText}
                onChange={(e) => setSearchText(e.target.value)}
                placeholder={searchPh}
                className="w-full px-3 py-2 text-sm font-lexend outline-none text-[#374151] placeholder:text-[#B3B3B3]"
              />
            </div>
            <ul role="listbox">
              <li
                role="option"
                aria-selected={value === ''}
                onClick={() => handleSelect('')}
                className={`px-3 py-2 cursor-pointer text-sm font-lexend ${
                  value === ''
                    ? 'bg-[#F3E8FF] text-[#6B21A8]'
                    : 'hover:bg-[#F3E8FF] text-[#374151]'
                }`}
              >
                {allPlaceholder}
              </li>
              {filteredOptions.map((option) => (
                <li
                  key={option.value}
                  role="option"
                  aria-selected={option.value === value}
                  onClick={() => handleSelect(option.value)}
                  className={`px-3 py-2 cursor-pointer text-sm font-lexend ${
                    option.value === value
                      ? 'bg-[#F3E8FF] text-[#6B21A8]'
                      : 'hover:bg-[#F3E8FF] text-[#374151]'
                  }`}
                >
                  {option.label}
                </li>
              ))}
              {filteredOptions.length === 0 && (
                <li className="px-3 py-2 text-sm font-lexend text-[#B3B3B3]" data-testid="searchable-select-empty">
                  {emptyMessage ?? t('common.noResults', 'Sin resultados')}
                </li>
              )}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}
