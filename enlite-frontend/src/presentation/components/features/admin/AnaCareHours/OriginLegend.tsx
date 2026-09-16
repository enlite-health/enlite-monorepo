/**
 * Legenda das origens do check-in — ícone (ⓘ) que abre um popover por CLIQUE (não depende de
 * hover) listando as três origens com o badge real (`OriginBadge`) e a frase que explica cada
 * uma. Fecha com clique fora ou Esc. Usado ao lado do título "Origen check-in" da LISTA e ao
 * lado dos chips de origem do resumo do DETALHE — mesmo componente, sem duplicar texto.
 *
 * O popover é renderizado via PORTAL em `document.body`, com posição `fixed` calculada a partir
 * do ícone (`getBoundingClientRect`) — NUNCA `absolute` dentro do container da tabela: o container
 * corta (overflow) o que passa da própria altura, e a tabela não pode virar `overflow-visible`
 * (mudaria o comportamento dela). Se não houver espaço abaixo, abre para cima; nunca sai da tela
 * na horizontal (clamp contra a viewport). Reposiciona ao rolar/redimensionar enquanto aberto.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';
import { Text } from '@presentation/components/atoms/Text';
import { OriginBadge } from './OriginBadge';
import type { CheckInOrigin } from './types';

const ORIGINS: CheckInOrigin[] = ['app', 'web_admin', 'sin_checkin'];

/** Espaço entre o ícone e o popover, e margem mínima contra a borda da viewport. */
const POPOVER_GAP = 8;
const VIEWPORT_PADDING = 8;

interface PopoverPosition {
  top: number;
  left: number;
}

export function OriginLegend({ testIdPrefix }: { testIdPrefix: string }): JSX.Element {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const [position, setPosition] = useState<PopoverPosition | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const updatePosition = useCallback(() => {
    // Conserto de conformidade (cobertura, 15/09): as DUAS chamadas de `updatePosition` só
    // acontecem com `isOpen=true` — a do `useLayoutEffect` roda DEPOIS do commit da div portada
    // (mesmo render que monta `popoverRef`), e a de `handleReposition` só existe enquanto os
    // listeners de scroll/resize estão registrados, que é exatamente o efeito com `if (!isOpen)
    // return` logo abaixo — sua cleanup remove os listeners no MESMO ciclo em que `isOpen` vira
    // `false`, antes de qualquer scroll/resize subsequente poder chamar de volta. `trigger` (botão
    // sempre montado) e `popover` nunca são nulos nesses dois pontos de chamada — o antigo
    // `if (!trigger || !popover) return;` era ramo morto, removido em vez de marcado `v8 ignore`.
    const trigger = triggerRef.current!;
    const popover = popoverRef.current!;

    const triggerRect = trigger.getBoundingClientRect();
    const popoverHeight = popover.offsetHeight;
    const popoverWidth = popover.offsetWidth;

    const spaceBelow = window.innerHeight - triggerRect.bottom;
    const fitsBelow = spaceBelow >= popoverHeight + POPOVER_GAP;
    const fitsAbove = triggerRect.top >= popoverHeight + POPOVER_GAP;
    const openUp = !fitsBelow && fitsAbove;

    const top = openUp ? triggerRect.top - popoverHeight - POPOVER_GAP : triggerRect.bottom + POPOVER_GAP;
    const rawLeft = triggerRect.right - popoverWidth;
    const maxLeft = window.innerWidth - popoverWidth - VIEWPORT_PADDING;
    const left = Math.min(Math.max(rawLeft, VIEWPORT_PADDING), Math.max(maxLeft, VIEWPORT_PADDING));

    setPosition({ top, left });
  }, []);

  // Calcula a posição ANTES do paint (useLayoutEffect) usando a altura real do popover já
  // montado via portal — evita flash na posição errada.
  useLayoutEffect(() => {
    if (!isOpen) {
      setPosition(null);
      return;
    }
    updatePosition();
  }, [isOpen, updatePosition]);

  useEffect(() => {
    if (!isOpen) return;

    function handleClickOutside(e: MouseEvent): void {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (popoverRef.current?.contains(target)) return;
      setIsOpen(false);
    }
    function handleKeyDown(e: KeyboardEvent): void {
      if (e.key === 'Escape') setIsOpen(false);
    }
    function handleReposition(): void {
      updatePosition();
    }

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleKeyDown);
    // capture:true pega scroll de QUALQUER ancestral com overflow (não só window) — a tabela é
    // candidata óbvia a ter scroll próprio.
    window.addEventListener('scroll', handleReposition, { passive: true, capture: true });
    window.addEventListener('resize', handleReposition);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleKeyDown);
      window.removeEventListener('scroll', handleReposition, { capture: true });
      window.removeEventListener('resize', handleReposition);
    };
  }, [isOpen, updatePosition]);

  const descriptionKey = (origin: CheckInOrigin): string =>
    origin === 'app' ? 'descriptionApp' : origin === 'web_admin' ? 'descriptionWebAdmin' : 'descriptionSinCheckin';

  return (
    <div className="relative inline-flex">
      <button
        ref={triggerRef}
        type="button"
        aria-label={t('admin.anacareHours.legend.openAriaLabel')}
        aria-expanded={isOpen}
        aria-controls={`${testIdPrefix}-popover`}
        onClick={() => setIsOpen((v) => !v)}
        className="inline-flex items-center justify-center w-4 h-4 rounded-full text-gray-800 hover:text-primary transition-colors"
        data-testid={`${testIdPrefix}-trigger`}
      >
        <Info className="w-4 h-4" />
      </button>

      {isOpen &&
        createPortal(
          <div
            ref={popoverRef}
            id={`${testIdPrefix}-popover`}
            role="dialog"
            aria-label={t('admin.anacareHours.legend.title')}
            className="fixed z-50 w-72 bg-white border border-gray-600 rounded-xl shadow-lg p-4 flex flex-col gap-3"
            style={{
              top: position?.top ?? 0,
              left: position?.left ?? 0,
              visibility: position ? 'visible' : 'hidden',
            }}
            data-testid={`${testIdPrefix}-popover`}
          >
            <div className="flex items-center justify-between">
              <Text as="span" size="sm" weight="semibold">
                {t('admin.anacareHours.legend.title')}
              </Text>
              <button
                type="button"
                aria-label={t('admin.anacareHours.legend.closeAriaLabel')}
                onClick={() => setIsOpen(false)}
                className="text-gray-800 hover:text-primary"
                data-testid={`${testIdPrefix}-close`}
              >
                ×
              </button>
            </div>
            <div className="flex flex-col gap-2.5">
              {ORIGINS.map((origin) => (
                <div key={origin} className="flex flex-col gap-1" data-testid={`${testIdPrefix}-item-${origin}`}>
                  <OriginBadge origin={origin} />
                  <Text size="xs" color="secondary">
                    {t(`admin.anacareHours.origin.${descriptionKey(origin)}`)}
                  </Text>
                </div>
              ))}
            </div>
          </div>,
          document.body,
        )}
    </div>
  );
}
