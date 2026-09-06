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
 *
 * V1 (rodada 2) — o aviso condicional "Hay N resultados en otras categorías" (que exigia uma 2ª
 * requisição, sem filtro, só para contar) virou RUÍDO: medido contra o catálogo real, ele
 * disparava em praticamente toda busca (39/9 em "esquizofrenia", 50/50 em "autismo", 6/50 em
 * "diabetes") — uma operadora aprende a ignorar um aviso onipresente em um dia, e falha
 * exatamente onde importa. Trocado por um ESTADO PERMANENTE: um controle sempre visível (mesmo
 * antes de digitar) dizendo onde a busca está acontecendo, com duas opções fixas — não há mais
 * heurística de similaridade para calibrar, nem 2ª chamada de rede.
 *
 * Visual (05/09, pedido do Gabriel — "inputs enormes, assimétricos, textos claros demais"): a caixa
 * é `inputWrapperClasses({ size: 'compact' })` com ícone e spinner como irmãos flex do `<input>`
 * interno (`INPUT_INNER_CLASSES`) — o MESMO molde dos selects do drawer (48px, Lexend, borda 1,5px,
 * raio 10px) e do `InputWithIcon`, sem `!important` de padding. Antes era um `<input>` à mão de
 * 38px em outra fonte e outra borda, o único diferente da tela. Texto de apoio em `secondary`
 * (#737373, 4,7:1), não `muted`:
 * `muted` é cinza a 50% de opacidade (~2:1) e reprova a AA — e aqui é onde a operadora lê se a
 * busca falhou ou se não há resultado.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Search } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';
import { inputWrapperClasses, INPUT_INNER_CLASSES, INPUT_SIZE_CONFIG } from '@presentation/components/atoms/Input/inputClasses';
import { AdminTerminologyApiService, TerminologyUnavailableError, TerminologyMinQueryLengthError } from '@infrastructure/http/AdminTerminologyApiService';
import type { TerminologyCandidate } from '@domain/entities/Terminology';

export interface IcdSearchComboboxProps {
  id: string;
  onSelect: (candidate: TerminologyCandidate) => void;
  disabled?: boolean;
  /** id do elemento que nomeia o campo (o título da seção "Patología") — o input não tem `<label>` próprio. */
  ariaLabelledBy?: string;
}

/**
 * F1 — `failed` NÃO é `empty`. "Não achei no catálogo" (200 com lista vazia) e "não consegui
 * perguntar" (500, 401 de token vencido, API fora do ar, resposta não-JSON) eram a MESMA caixa
 * cinza: a operadora lia "Nenhum resultado para X", concluía que o diagnóstico não existe no
 * sistema, não escolhia nada, e o paciente ficava sem diagnóstico estruturado — exatamente o
 * "cair em texto livre silencioso" que a US-4 proíbe. A régua já estava escrita no client
 * (`AdminTerminologyApiService`): "erro de rede não é lista vazia".
 */
type Phase = 'idle' | 'tooShort' | 'typing' | 'searching' | 'results' | 'empty' | 'unavailable' | 'failed';

const DEBOUNCE_MS = 300;
/**
 * F7 — piso OTIMISTA, não a verdade. A verdade é do backend, que a DIZ no corpo do 400
 * (`details.minQueryLength`); este número só evita a requisição óbvia antes da primeira resposta.
 * Quando a API discorda, ela ganha: o componente adota o piso dela e não volta a perguntar abaixo
 * dele. Guardar o número dos dois lados era o defeito — hoje concordam e voltam a divergir no dia
 * em que alguém mudar um só.
 */
const OPTIMISTIC_MIN_CHARS = 2;
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

export function IcdSearchCombobox({ id, onSelect, disabled = false, ariaLabelledBy }: IcdSearchComboboxProps): JSX.Element {
  const { t } = useTranslation();
  const ta = (k: string, opts?: Record<string, unknown>) =>
    t(`admin.patients.editDrawer.diagnosisAssignment.${k}`, opts);

  const [query, setQuery] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [options, setOptions] = useState<TerminologyCandidate[]>([]);
  const [activeIndex, setActiveIndex] = useState(-1);
  const [isOpen, setIsOpen] = useState(false);
  /** V1: estado do escopo de busca — persiste enquanto o drawer estiver aberto (não reseta a cada tecla). */
  const [allChapters, setAllChapters] = useState(false);
  /** F7: piso VIVO — nasce otimista e passa a valer o que a API respondeu (nunca um literal daqui). */
  const [minChars, setMinChars] = useState(OPTIMISTIC_MIN_CHARS);

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

    AdminTerminologyApiService.search(q, { chapters, signal: controller.signal })
      .then((candidates) => {
        if (requestIdRef.current !== requestId) return; // resposta obsoleta — descartada
        setOptions(candidates);
        setPhase(candidates.length === 0 ? 'empty' : 'results');
        setIsOpen(true);
        setActiveIndex(-1);
      })
      .catch((err: unknown) => {
        // `abortRef.current?.abort()` só é chamado ao disparar uma busca NOVA ou ao cair abaixo
        // do mínimo — os dois já incrementam `requestIdRef`. Logo todo abort (deliberado, nosso)
        // já cai como obsoleto aqui — não existe "abortado E ainda o mais recente" para tratar.
        if (requestIdRef.current !== requestId) return; // obsoleta (rejeitada OU abortada) — descartada
        setOptions([]);
        // F7: a API recusou por tamanho e DISSE o piso dela — adotamos o número e voltamos ao
        // estado "faltam caracteres" (nem falha, nem "não há"): a operadora sabe o que fazer.
        if (err instanceof TerminologyMinQueryLengthError) {
          setMinChars(err.minQueryLength);
          setPhase('tooShort');
          setIsOpen(false);
          return;
        }
        // F1: `empty` está RESERVADO para a resposta 200 com `candidates: []`. Toda falha vira
        // um estado de FALHA visível — `unavailable` quando o catálogo se declarou fora (503),
        // `failed` para o resto (500, 401, rede, corpo não-JSON). Nunca "sem resultado".
        setPhase(err instanceof TerminologyUnavailableError ? 'unavailable' : 'failed');
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
      setIsOpen(false);
      setPhase('idle');
      return;
    }
    // U5: abaixo do mínimo, mas com pelo menos 1 caractere — não é mais silêncio (era idêntico
    // ao estado vazio); diz o piso em vez de deixar a operadora achar que nada está acontecendo.
    if (q.length < minChars) {
      abortRef.current?.abort();
      requestIdRef.current++;
      setOptions([]);
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
  }, [query, allChapters, minChars, runSearch]);

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
  /** F1: os dois estados de FALHA reusam a MESMA forma do 503 — `role="alert"` e texto vermelho. */
  const isFailurePhase = phase === 'unavailable' || phase === 'failed';

  const statusText =
    phase === 'tooShort' ? ta('tooShortHint', { min: minChars })
    : phase === 'typing' ? ta('typing')
    : phase === 'searching' ? ta('searching')
    : phase === 'empty' ? ta('noResults', { query: query.trim() })
    : phase === 'unavailable' ? ta('unavailable')
    : phase === 'failed' ? ta('searchFailed')
    : null;

  return (
    <div ref={containerRef} className="flex flex-col gap-1.5">
      <div className={`${inputWrapperClasses({ size: 'compact', disabled })} gap-2`}>
        {/* A lupa é um <label for> do input: clicar nela foca o campo (era o comportamento do ícone
            sobreposto com pointer-events-none; como irmão flex, sem isto ela engolia o clique). */}
        <label htmlFor={id} className="flex items-center shrink-0 cursor-text" aria-hidden="true">
          <Search className="w-4 h-4 text-gray-800" />
        </label>
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
          aria-labelledby={ariaLabelledBy}
          aria-expanded={isOpen}
          aria-controls={listboxId}
          aria-haspopup="listbox"
          aria-activedescendant={activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined}
          className={`${INPUT_INNER_CLASSES} ${INPUT_SIZE_CONFIG.compact.fontSize} ${INPUT_SIZE_CONFIG.compact.lineHeight}`}
          data-testid={`${id}-input`}
        />
        {/* Slot do spinner SEMPRE reservado (16px): montar/desmontar o irmão flex fazia o input
            encolher 24px a cada busca e o cursor pular no meio da digitação. */}
        <span className="w-4 h-4 shrink-0 flex items-center justify-center" aria-hidden="true">
          {phase === 'searching' && (
            <span
              className="block w-4 h-4 border-2 border-primary/30 border-t-primary rounded-full animate-spin"
              data-testid={`${id}-spinner`}
            />
          )}
        </span>
      </div>

      {/* V1 (rodada 2): ESTADO permanente, sempre visível — não é um aviso condicional. Diz onde
          a busca está acontecendo e permite trocar, sem depender de nenhuma heurística de
          similaridade (que já deu falso positivo em "autismo"/"depresion"). */}
      <div
        role="radiogroup"
        aria-label={ta('searchScopeLabel')}
        className="flex items-center gap-1.5"
        data-testid={`${id}-scope`}
      >
        <Text as="span" size="xs" color="secondary">
          {ta('searchScopeLabel')}
        </Text>
        <button
          type="button"
          role="radio"
          aria-checked={!allChapters}
          onClick={() => setAllChapters(false)}
          className={`px-2.5 py-0.5 rounded-full border transition-colors ${!allChapters ? 'border-primary bg-primary/10' : 'border-gray-600 hover:border-gray-800'}`}
          data-testid={`${id}-scope-usual`}
        >
          <Text as="span" size="xs" weight={!allChapters ? 'medium' : 'normal'} color={!allChapters ? 'primary' : 'secondary'}>
            {ta('searchScopeUsual')}
          </Text>
        </button>
        <button
          type="button"
          role="radio"
          aria-checked={allChapters}
          onClick={() => setAllChapters(true)}
          className={`px-2.5 py-0.5 rounded-full border transition-colors ${allChapters ? 'border-primary bg-primary/10' : 'border-gray-600 hover:border-gray-800'}`}
          data-testid={`${id}-scope-all`}
        >
          <Text as="span" size="xs" weight={allChapters ? 'medium' : 'normal'} color={allChapters ? 'primary' : 'secondary'}>
            {ta('searchScopeAll')}
          </Text>
        </button>
      </div>

      {/* 🔴 O controle de escopo diz ONDE ela busca, mas não que a resposta pode estar FORA.
          Medido: no escopo habitual, `diabetes` devolve "Neuropatía autonómica por diabetes
          mellitus" — plausível e ERRADO, porque "Diabetes mellitus tipo 2" é capítulo 05 e fica
          fora. Ela clica no primeiro e grava diagnóstico errado, sem nenhum sinal.
          Convite PERMANENTE (não condicional): a versão anterior era um aviso com contagem, e ele
          disparava em praticamente toda busca — vira ruído e ela aprende a ignorar em um dia.
          Texto fixo não tem heurística para calibrar nem falso positivo, e aponta para o controle
          que está logo acima. Só aparece depois de uma busca sem escolha, para não poluir o vazio. */}
      {!allChapters && query.trim().length >= minChars && (
        <Text size="xs" color="secondary" data-testid={`${id}-widen-hint`}>
          {ta('widenScopeHint')}
        </Text>
      )}

      {statusText && (
        <Text
          as="span"
          size="xs"
          color="secondary"
          role={isFailurePhase ? 'alert' : 'status'}
          className={isFailurePhase ? '!text-red-600' : undefined}
          data-testid={`${id}-status`}
        >
          {statusText}
        </Text>
      )}

      {codeOrAcronymHint && (
        <Text as="span" size="xs" color="secondary" data-testid={`${id}-code-hint`}>
          {ta('codeOrAcronymHint')}
        </Text>
      )}

      {isOpen && phase === 'results' && (
        <ul
          id={listboxId}
          role="listbox"
          className="border-[1.5px] border-gray-600 rounded-[10px] shadow-sm max-h-64 overflow-y-auto overscroll-contain bg-white"
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
              className={`px-4 py-2.5 cursor-pointer transition-colors ${idx === activeIndex ? 'bg-primary/10' : 'hover:bg-slate-50'}`}
              data-testid={`${id}-option-${idx}`}
            >
              <Text as="span" size="sm" color="tertiary">{candidate.title}</Text>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
