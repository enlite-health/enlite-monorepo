/**
 * IcdSearchCombobox — busca de diagnóstico no catálogo CID-11 (spec 016 F3). Componente NOSSO,
 * não a ECT da OMS (D257/D259 descartaram a ECT vestida: licença 2.4 proíbe engenharia reversa
 * e ela depende de internals não documentados).
 *
 * 🔴 REQ-21 — só exibe `candidate.title` (a patología). O `uri` circula só como identificador
 * opaco (`onSelect`); nunca aparece no texto, em atributo, `title=`, `aria-label` ou `data-*`.
 *
 * Estados VISÍVEIS e distintos (US-4 + "contagem zero é falha, nunca sucesso"): digitando ·
 * buscando · sem resultado · catálogo indisponível — o último em espanhol e com aparência
 * diferente de "sem resultado" (nunca a mesma caixa cinza para os dois).
 *
 * Cancelamento de busca obsoleta: cada tecla nova aborta o `fetch` anterior (AbortController) E
 * descarta qualquer resposta que ainda chegue de uma busca velha (`requestIdRef`) — a resposta
 * antiga não pode sobrescrever a nova, mesmo se a rede entregar fora de ordem.
 *
 * a11y: `role="combobox"` no input, `listbox`/`option` no dropdown, `aria-activedescendant`
 * aponta pro item destacado, `aria-expanded` reflete o dropdown aberto. Teclado: setas navegam,
 * Enter escolhe o destacado, Esc fecha.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';
import { AdminTerminologyApiService, TerminologyUnavailableError } from '@infrastructure/http/AdminTerminologyApiService';
import type { TerminologyCandidate } from '@domain/entities/Terminology';

export interface IcdSearchComboboxProps {
  id: string;
  onSelect: (candidate: TerminologyCandidate) => void;
  disabled?: boolean;
}

type Phase = 'idle' | 'tooShort' | 'typing' | 'searching' | 'results' | 'empty' | 'unavailable';

const DEBOUNCE_MS = 300;
const MIN_CHARS = 2;
/** SUP-1 (spec 016): filtro padrão de TELA — capítulos 06 (mental) e 08 (neurológico). */
const DEFAULT_CHAPTERS = '06,08';

/**
 * U6 (auditoria UX ux-04b/ux-03d/ux-03e): `F84` (código CIE-10) e `TDAH` (sigla) voltam "sem
 * resultado" — igual a um termo inexistente. A operadora conclui que o sistema não tem o
 * diagnóstico. Esta heurística só decide se um AVISO extra aparece; nunca tenta resolver o
 * código. "Parece código": letra seguida de dígito, ou dígito seguido de letra. "Parece sigla":
 * 2-5 letras MAIÚSCULAS.
 */
function looksLikeCodeOrAcronym(q: string): boolean {
  if (/^[A-Za-z]\d|^\d[A-Za-z]/.test(q)) return true;
  return /^[A-Z]{2,5}$/.test(q);
}

export function IcdSearchCombobox({ id, onSelect, disabled = false }: IcdSearchComboboxProps): JSX.Element {
  const { t } = useTranslation();
  const ta = (k: string, opts?: Record<string, unknown>) =>
    t(`admin.patients.editDrawer.diagnosisAssignment.${k}`, opts);

  const [query, setQuery] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [options, setOptions] = useState<TerminologyCandidate[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [isOpen, setIsOpen] = useState(false);
  const [allChapters, setAllChapters] = useState(false);
  /** U1: quantos resultados a MAIS existem fora do filtro padrão — `null` = não avisar. */
  const [outsideCount, setOutsideCount] = useState<number | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const requestIdRef = useRef(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const listboxId = `${id}-listbox`;

  const runSearch = useCallback((q: string, chapters?: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    const requestId = ++requestIdRef.current;
    setPhase('searching');
    setOutsideCount(null);

    AdminTerminologyApiService.search(q, { chapters, signal: controller.signal })
      .then((candidates) => {
        if (requestIdRef.current !== requestId) return; // resposta obsoleta — descartada
        setOptions(candidates);
        setPhase(candidates.length === 0 ? 'empty' : 'results');
        setIsOpen(true);
        setActiveIndex(-1);

        // U1: filtro padrão ativo E já achou algo — confere em UMA chamada extra (sem filtro)
        // se há MAIS resultados escondidos, pra avisar em vez de deixar a operadora achar que a
        // lista mostrada é tudo o que existe. Sem filtro (`chapters` undefined) não há o que
        // esconder — não dispara a checagem.
        if (chapters && candidates.length > 0) {
          AdminTerminologyApiService.search(q, { signal: controller.signal })
            .then((allCandidates) => {
              if (requestIdRef.current !== requestId) return; // obsoleta — descartada
              const extra = allCandidates.length - candidates.length;
              setOutsideCount(extra > 0 ? extra : null);
            })
            .catch(() => {
              if (requestIdRef.current !== requestId) return;
              setOutsideCount(null);
            });
        }
      })
      .catch((err: unknown) => {
        // `abortRef.current?.abort()` só é chamado ao disparar uma busca NOVA ou ao cair abaixo
        // do mínimo — os dois já incrementam `requestIdRef`. Logo todo abort (deliberado, nosso)
        // já cai como obsoleto aqui — não existe "abortado E ainda o mais recente" para tratar.
        if (requestIdRef.current !== requestId) return; // obsoleta (rejeitada OU abortada) — descartada
        setOptions([]);
        setPhase(err instanceof TerminologyUnavailableError ? 'unavailable' : 'empty');
        setIsOpen(true);
      });
  }, []);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    const q = query.trim();
    if (q.length === 0) {
      abortRef.current?.abort();
      requestIdRef.current++;
      setOptions([]);
      setOutsideCount(null);
      setIsOpen(false);
      setPhase('idle');
      return;
    }
    // U5: abaixo do mínimo, mas com pelo menos 1 caractere — não é mais silêncio (era idêntico
    // ao estado vazio); diz o piso em vez de deixar a operadora achar que nada está acontecendo.
    if (q.length < MIN_CHARS) {
      abortRef.current?.abort();
      requestIdRef.current++;
      setOptions([]);
      setOutsideCount(null);
      setIsOpen(false);
      setPhase('tooShort');
      return;
    }
    setPhase('typing');
    debounceRef.current = setTimeout(() => {
      runSearch(q, allChapters ? undefined : DEFAULT_CHAPTERS);
    }, DEBOUNCE_MS);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, allChapters, runSearch]);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  function handleSelect(candidate: TerminologyCandidate): void {
    onSelect(candidate);
    setQuery('');
    setOptions([]);
    setIsOpen(false);
    setActiveIndex(-1);
    setPhase('idle');
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>): void {
    if (!isOpen || options.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((i) => Math.min(i + 1, options.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && activeIndex >= 0) {
      e.preventDefault();
      handleSelect(options[activeIndex]);
    } else if (e.key === 'Escape') {
      // U2 (auditoria UX passo 10): sem isto o Esc vaza pro listener do drawer (documento) e
      // derruba a tela inteira — a operadora só queria fechar a LISTA. `stopPropagation` numa
      // SyntheticEvent do React também para o evento NATIVO (não bubbleia até `document`).
      e.stopPropagation();
      setIsOpen(false);
    }
  }

  const codeOrAcronymHint = phase === 'empty' && looksLikeCodeOrAcronym(query.trim());

  const statusText =
    phase === 'tooShort' ? ta('tooShortHint')
    : phase === 'typing' ? ta('typing')
    : phase === 'searching' ? ta('searching')
    : phase === 'empty' ? ta('noResults', { query: query.trim() })
    : phase === 'unavailable' ? ta('unavailable')
    : null;

  return (
    <div ref={containerRef} className="flex flex-col gap-1.5">
      <div className="relative">
        <div className="absolute inset-y-0 left-3 flex items-center pointer-events-none">
          <Search className="w-4 h-4 text-slate-400" />
        </div>
        <input
          id={id}
          type="text"
          role="combobox"
          disabled={disabled}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={ta('searchPlaceholder')}
          autoComplete="off"
          aria-expanded={isOpen}
          aria-controls={listboxId}
          aria-haspopup="listbox"
          aria-activedescendant={activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined}
          className="w-full pl-9 pr-3 py-2 rounded-lg border border-slate-200 focus:outline-none focus:border-primary text-sm transition-colors disabled:bg-slate-50 disabled:cursor-not-allowed"
          data-testid={`${id}-input`}
        />
        {phase === 'searching' && (
          <div className="absolute inset-y-0 right-3 flex items-center pointer-events-none">
            <div
              className="w-4 h-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin"
              data-testid={`${id}-spinner`}
            />
          </div>
        )}
      </div>

      {statusText && (
        <Text
          as="span"
          size="xs"
          color="muted"
          role={phase === 'unavailable' ? 'alert' : 'status'}
          className={phase === 'unavailable' ? '!text-red-600' : undefined}
          data-testid={`${id}-status`}
        >
          {statusText}
        </Text>
      )}

      {codeOrAcronymHint && (
        <Text as="span" size="xs" color="muted" data-testid={`${id}-code-hint`}>
          {ta('codeOrAcronymHint')}
        </Text>
      )}

      {isOpen && phase === 'results' && outsideCount !== null && (
        <Text as="span" size="xs" color="primary" data-testid={`${id}-outside-notice`}>
          {ta('outsideFilterNotice', { count: outsideCount })}
        </Text>
      )}

      {isOpen && phase === 'results' && (
        <ul
          id={listboxId}
          role="listbox"
          className="border border-slate-200 rounded-lg shadow-sm max-h-64 overflow-y-auto bg-white"
          data-testid={`${id}-listbox`}
        >
          {options.map((candidate, idx) => (
            <li
              key={candidate.uri}
              id={`${id}-option-${idx}`}
              role="option"
              aria-selected={idx === activeIndex}
              onMouseEnter={() => setActiveIndex(idx)}
              onClick={() => handleSelect(candidate)}
              className={`px-3 py-2 cursor-pointer transition-colors ${idx === activeIndex ? 'bg-primary/10' : 'hover:bg-slate-50'}`}
              data-testid={`${id}-option-${idx}`}
            >
              <Text as="span" size="sm">{candidate.title}</Text>
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        onClick={() => setAllChapters((v) => !v)}
        className="self-start"
        data-testid={`${id}-toggle-chapters`}
      >
        <Text as="span" size="xs" color="primary" className="underline">
          {allChapters ? ta('restrictChapters') : ta('expandChapters')}
        </Text>
      </button>
    </div>
  );
}
