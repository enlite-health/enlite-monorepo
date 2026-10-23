import { forwardRef, useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Text } from '../Text/Text';
import { inputWrapperClasses, type InputSize } from '../Input/inputClasses';
import { normalizeText } from '@presentation/utils/normalizeText';

export interface ComboboxOption {
  value: string;
  label: string;
  disabled?: boolean;
  /** Texto extra que a busca casa e a tela não exibe (ex.: CNPJ, sigla). */
  searchText?: string;
  /** Marca à direita do rótulo na lista (ex.: estado do prestador). A busca continua só pelo `label`/`searchText`. */
  adornment?: ReactNode;
}

/**
 * Fonte única da regra "quando há campo de busca": com menos opções que isto
 * (Sí/No, 2 países) não há o que filtrar. A regra mora no componente, não numa
 * lista de campos — ninguém "esquece de ligar" a busca (spec 070, D-2).
 */
export const SEARCH_MIN_OPTIONS = 3;

type Common = {
  options: ComboboxOption[];
  id?: string;
  name?: string;
  placeholder?: string;
  disabled?: boolean;
  inputSize?: InputSize;
  error?: string;
  className?: string;
  'data-testid'?: string;
  /**
   * Mascara o campo no session replay (Clarity). Vale no gatilho E no painel aberto: o painel
   * (busca + opções) mostra os mesmos rótulos, então não pode escapar do mascaramento.
   */
  'data-clarity-mask'?: 'True';
  onBlur?: () => void;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  searchPlaceholder?: string;
  noResultsLabel?: string;
  /**
   * BUSCA NO SERVIDOR (portada do seletor antigo). Quando presente, o filtro
   * local só vale enquanto `options` NÃO é a resposta do termo digitado; o texto
   * é devolvido aqui com debounce para o pai buscar.
   */
  onSearchChange?: (text: string) => void;
  /** Espera entre a última tecla e a busca. Só vale com `onSearchChange`. */
  searchDebounceMs?: number;
  /**
   * O termo a que `options` JÁ corresponde (o que o servidor respondeu, não o
   * que está sendo digitado). `''` = lista de repouso. Só vale com `onSearchChange`.
   */
  serverSearchTerm?: string;
  /** O que dizer quando a lista está vazia (ex.: "Escribí al menos 2 letras"). */
  emptyMessage?: string;
};

export type ComboboxProps = Common &
  (
    | {
        multiple?: false;
        value: string;
        onChange: (value: string) => void;
        /** 1ª linha que volta o valor a `''` (o placeholder selecionável do seletor antigo). */
        clearLabel?: string;
      }
    | { multiple: true; value: string[]; onChange: (values: string[]) => void }
  );

const PANEL_CLASSES =
  'absolute z-50 w-full bg-white border border-[#D9D9D9] rounded-[10px] shadow-lg py-1';
const SCROLL_CLASSES = 'overflow-y-auto max-h-60';
/** Altura que o painel pode ocupar (busca + lista de 15rem + respiro): abaixo disso no rodapé da tela, ele abre para CIMA. */
const PANEL_ROOM_PX = 320;

export const Combobox = forwardRef<HTMLButtonElement, ComboboxProps>(function Combobox(props, ref) {
  const {
    options,
    id,
    name,
    placeholder,
    disabled = false,
    inputSize = 'default',
    error,
    className = '',
    'data-testid': testId,
    'data-clarity-mask': clarityMask,
    onBlur,
    'aria-label': ariaLabel,
    'aria-labelledby': ariaLabelledBy,
    searchPlaceholder,
    noResultsLabel,
    onSearchChange,
    searchDebounceMs = 300,
    serverSearchTerm = '',
    emptyMessage,
  } = props;
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [dropUp, setDropUp] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listboxId = useId();
  // Sem id nem data-testid não há base: o atributo some (nunca `undefined-search`).
  const testIdBase = id ?? testId;
  const searchTestId = testIdBase ? `${testIdBase}-search` : undefined;
  const noResultsTestId = testIdBase ? `${testIdBase}-no-results` : undefined;

  const setTriggerRef = useCallback(
    (node: HTMLButtonElement | null) => {
      triggerRef.current = node;
      if (typeof ref === 'function') ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );

  const searchable = options.length >= SEARCH_MIN_OPTIONS;

  const serverSearch = onSearchChange !== undefined;
  const showSearch = searchable || serverSearch;

  const close = useCallback((refocus = false, keepQuery = false) => {
    setOpen(false);
    if (!keepQuery) setQuery('');
    if (refocus) triggerRef.current?.focus();
  }, []);

  /** Abrir é o momento em que o texto da busca é limpo (no modo servidor, escolher NÃO limpa). */
  const openPanel = useCallback(() => {
    setQuery('');
    setOpen(true);
  }, []);

  const toggleOpen = useCallback(() => {
    if (open) close();
    else openPanel();
  }, [open, close, openPanel]);

  // Gatilho no pé da janela (ex.: rodapé da sidebar): sem espaço embaixo e com mais espaço em cima, o painel abre para cima.
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return;
    const { top, bottom } = triggerRef.current.getBoundingClientRect();
    const below = window.innerHeight - bottom;
    setDropUp(below < PANEL_ROOM_PX && top > below);
  }, [open]);

  useEffect(() => {
    if (open && showSearch) searchRef.current?.focus();
  }, [open, showSearch]);

  /**
   * O callback vive num ref, e NÃO nas dependências do efeito: um pai que recria
   * a função a cada render dispararia uma busca por render em vez de uma por
   * termo (foi assim que o autocomplete do Places chegou a uma chamada por tecla).
   */
  const onSearchRef = useRef(onSearchChange);
  useEffect(() => {
    onSearchRef.current = onSearchChange;
  });

  useEffect(() => {
    if (!serverSearch) return undefined;
    const timer = setTimeout(() => onSearchRef.current?.(query), searchDebounceMs);
    return () => clearTimeout(timer);
  }, [query, serverSearch, searchDebounceMs]);

  /**
   * 🔒 O RÓTULO SOBREVIVE À LISTA. Com busca no servidor, escolher um item TROCA
   * a lista e o escolhido some de `options`; sem este cache o gatilho voltava ao
   * placeholder logo depois de escolher. Cache idempotente,
   * alimentado no render: no 1º paint depois da troca o rótulo já tem de estar certo.
   */
  const rotulosVistos = useRef(new Map<string, string>());
  for (const o of options) rotulosVistos.current.set(o.value, o.label);
  const labelOf = (v: string): string | undefined => rotulosVistos.current.get(v);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        close();
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open, close]);

  const select = useCallback(
    (optValue: string) => {
      if (props.multiple) {
        const { value, onChange } = props;
        onChange(value.includes(optValue) ? value.filter((v) => v !== optValue) : [...value, optValue]);
      } else {
        props.onChange(optValue);
        // modo servidor: o texto FICA. Limpá-lo aqui dispararia uma busca nova com o
        // dropdown já fechado; quem limpa é `openPanel`.
        close(true, serverSearch);
      }
    },
    [props, close, serverSearch],
  );

  const optionButtons = (): HTMLButtonElement[] =>
    Array.from(
      (containerRef.current as HTMLDivElement).querySelectorAll<HTMLButtonElement>('[role="option"] button'),
    );

  const handleTriggerKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      toggleOpen();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) openPanel();
      else (searchRef.current ?? optionButtons()[0])?.focus();
    } else if (e.key === 'Escape') {
      close();
    } else if (e.key === 'Tab') {
      close();
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && !disabled) {
      e.preventDefault();
      if (showSearch) setQuery(open ? query + e.key : e.key);
      setOpen(true);
    }
  };

  const handleOptionKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, optValue: string) => {
    const buttons = optionButtons();
    const idx = buttons.indexOf(e.currentTarget);
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      select(optValue);
    } else if (e.key === 'Escape') {
      e.stopPropagation();
      close(true);
    } else if (e.key === 'Tab') {
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      buttons[Math.min(idx + 1, buttons.length - 1)]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (idx > 0) buttons[idx - 1].focus();
      else searchRef.current?.focus();
    } else if (e.key === 'Home') {
      e.preventDefault();
      buttons[0]?.focus();
    } else if (e.key === 'End') {
      e.preventDefault();
      buttons[buttons.length - 1]?.focus();
    }
  };

  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close(true);
    } else if (e.key === 'Tab') {
      close();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      optionButtons()[0]?.focus();
    } else if (e.key === 'Enter') {
      e.preventDefault();
    }
  };

  const needle = normalizeText(query.trim());
  /**
   * ⚠️ `options` corresponde a ESTE termo? Só quando a resposta do servidor para
   * ele já chegou. Em qualquer outro instante (debounce correndo, request em voo)
   * a lista na mão é de outra pergunta e filtrar em memória é o único
   * comportamento honesto — senão a lista inteira reaparece sem filtro.
   */
  const servidorRespondePorEsteTermo = serverSearch && query.trim() === serverSearchTerm;
  const visible = needle && !servidorRespondePorEsteTermo
    ? options.filter((o) => normalizeText(`${o.label} ${o.searchText ?? ''}`).includes(needle))
    : options;

  const clearLabel = props.multiple ? undefined : props.clearLabel;
  const showClearRow = clearLabel !== undefined && !needle;

  // Valor que nunca esteve em lista nenhuma (no modo servidor é um id interno) NÃO
  // é exibido cru: conta como vazio e o gatilho mostra o placeholder. No multi,
  // só os valores conhecidos entram na contagem.
  const knownLabels = (props.multiple ? props.value : props.value === '' ? [] : [props.value])
    .map(labelOf)
    .filter((l): l is string => l !== undefined);
  const buttonLabel =
    knownLabels.length === 0
      ? placeholder
      : knownLabels.length === 1
        ? knownLabels[0]
        : t('common.multiSelect.selectedCount', { count: knownLabels.length });

  const wrapperClasses = inputWrapperClasses({ size: inputSize, error: !!error, disabled });

  const renderRow = (opt: ComboboxOption) => {
    const checked = props.multiple ? props.value.includes(opt.value) : props.value === opt.value;
    return (
      <li key={opt.value} role="option" aria-selected={checked} data-value={opt.value}>
        <button
          type="button"
          disabled={opt.disabled}
          onKeyDown={(e) => handleOptionKeyDown(e, opt.value)}
          onClick={() => select(opt.value)}
          className={[
            'w-full flex items-center gap-2 px-4 py-2 hover:bg-gray-50 transition-colors text-left',
            !props.multiple && checked ? 'bg-gray-50' : '',
          ]
            .filter(Boolean)
            .join(' ')}
        >
          {props.multiple && (
            <input
              type="checkbox"
              readOnly
              checked={checked}
              tabIndex={-1}
              className="pointer-events-none accent-primary w-4 h-4 shrink-0"
            />
          )}
          {opt.adornment ? (
            <span className="flex flex-1 items-center justify-between gap-3">
              <Text as="span" size="sm" weight="medium" color="secondary" className="truncate">
                {opt.label}
              </Text>
              {opt.adornment}
            </span>
          ) : (
            <Text as="span" size="sm" weight="medium" color="secondary">
              {opt.label}
            </Text>
          )}
        </button>
      </li>
    );
  };

  const list = (cls: string) => (
    <ul
      id={listboxId}
      role="listbox"
      aria-multiselectable={props.multiple ? 'true' : undefined}
      className={cls}
    >
      {showClearRow && renderRow({ value: '', label: clearLabel })}
      {visible.map(renderRow)}
    </ul>
  );

  return (
    <div ref={containerRef} className={['relative w-full', className].filter(Boolean).join(' ')}>
      <button
        ref={setTriggerRef}
        type="button"
        id={id}
        name={name}
        data-testid={testId}
        data-clarity-mask={clarityMask}
        role="combobox"
        disabled={disabled}
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listboxId : undefined}
        aria-invalid={error ? true : undefined}
        aria-label={ariaLabel}
        aria-labelledby={ariaLabelledBy}
        onKeyDown={handleTriggerKeyDown}
        onClick={toggleOpen}
        onBlur={onBlur}
        className={[
          wrapperClasses,
          'flex items-center justify-between cursor-pointer select-none text-left',
          disabled ? 'cursor-not-allowed border-dashed' : '',
        ]
          .filter(Boolean)
          .join(' ')}
      >
        <Text
          as="span"
          size="sm"
          weight="medium"
          color={knownLabels.length > 0 ? 'secondary' : 'muted'}
          className="truncate"
        >
          {buttonLabel ?? ''}
        </Text>
        <ChevronDown
          size={20}
          className={[
            'shrink-0 transition-transform ml-2',
            disabled ? 'text-[#D9D9D9]' : 'text-[#737373]',
            open ? 'rotate-180' : '',
          ].join(' ')}
        />
      </button>

      {error && (
        <Text as="p" size="xs" color="inherit" className="text-red-500 mt-1">
          {error}
        </Text>
      )}

      {open && (
        <div className={`${PANEL_CLASSES} ${dropUp ? 'bottom-full mb-1' : 'mt-1'} flex flex-col`} data-clarity-mask={clarityMask}>
          {showSearch && (
            <input
              ref={searchRef}
              type="text"
              data-testid={searchTestId}
              aria-label={t('common.multiSelect.searchAriaLabel')}
              placeholder={searchPlaceholder ?? t('common.multiSelect.searchPlaceholder')}
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={handleSearchKeyDown}
              className="mx-2 mb-1 px-3 py-2 text-sm border border-[#D9D9D9] rounded-[8px] outline-none focus:border-primary"
            />
          )}
          {(showClearRow || visible.length > 0) && list(SCROLL_CLASSES)}
          {visible.length === 0 && (
            <Text as="p" size="sm" color="muted" className="px-4 py-2" data-testid={noResultsTestId}>
              {emptyMessage ?? noResultsLabel ?? t('common.multiSelect.noResults')}
            </Text>
          )}
        </div>
      )}
    </div>
  );
});
