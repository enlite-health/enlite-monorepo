import { useEffect, useId, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms';
import { areaKey, writeLastArea } from '@presentation/hooks/useAreaDestination';
import type { AreaEntry } from '@domain/entities/MyAreas';

interface AreaSwitcherProps {
  areas: AreaEntry[];
  /** Área em que a pessoa está agora (`backoffice` dentro do `/admin`). */
  currentArea: string | null;
  /** Uid do login: a "última usada" é por pessoa, não por navegador. */
  uid: string | null;
}

const DOT_CLASS: Record<string, string> = {
  backoffice: 'bg-primary',
  care: 'bg-care',
  learn: 'bg-learn',
};

/** Nome de área/papel desconhecido cai no código cru (nunca lança nem some o item). */
function useLabels() {
  const { t } = useTranslation();
  return {
    t,
    area: (a: string): string => t(`areas.names.${a}`, { defaultValue: a }),
    role: (r: string): string => t(`areas.roles.${r}`, { defaultValue: r }),
  };
}

/**
 * Direção A (F4, T409): desplegável na tira fina dentro do `<main>` do `AdminLayout`. Só aparece com
 * MAIS de uma área navegável (`entryRoute` não nulo); com uma só, não há para onde trocar.
 *
 * EMPILHAMENTO (medido pelo e2e `catalogo-terapeutico-humano`): a tira NÃO é `sticky` e não tem z-index. Os modais da
 * casa são `fixed z-40/z-50` e moram DENTRO do `.page-enter` do <main> (animação de opacity com `both` = contexto de
 * empilhamento); uma tira com z-index próprio fica por cima do conteúdo inteiro desse contexto, modal incluído, e o
 * trigger intercepta o clique no X. Sem z-index, o conteúdo (depois dela no DOM) pinta acima. Só o MENU ABERTO leva
 * z-30, para cobrir o conteúdo enquanto está aberto (clicar fora o fecha antes de qualquer modal abrir).
 * Ao escolher: grava a última área usada (`localStorage`, com try/catch) e navega à `entryRoute`.
 */
export function AreaSwitcher({ areas, currentArea, uid }: AreaSwitcherProps): JSX.Element | null {
  const { t, area: areaLabel, role: roleLabel } = useLabels();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e: MouseEvent): void => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const navigable = areas.filter((a) => a.entryRoute !== null);
  if (navigable.length <= 1) return null;

  const current = areas.find((a) => a.area === currentArea) ?? navigable[0];

  const choose = (item: AreaEntry): void => {
    setOpen(false);
    if (item.entryRoute === null || item.area === current.area) return;
    // `writeLastArea` já tem try/catch: storage bloqueado não pode impedir a troca.
    if (uid) writeLastArea(uid, areaKey(item));
    navigate(item.entryRoute);
  };

  return (
    <div
      className="flex h-12 items-center justify-end gap-2 border-b border-gray-600 bg-white px-6"
      data-testid="area-switcher-strip"
    >
      <Text as="span" size="xs" color="tertiary">
        {t('areas.switcher.label')}
      </Text>
      <div ref={rootRef} className="relative">
        <button
          type="button"
          data-testid="area-switcher-trigger"
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={menuId}
          aria-label={t('areas.switcher.ariaLabel')}
          onClick={() => setOpen((o) => !o)}
          className="inline-flex h-9 max-w-full items-center gap-2 rounded-input border border-gray-600 bg-white px-3 font-lexend text-sm font-medium text-primary"
        >
          <span className={`h-2 w-2 shrink-0 rounded-full ${DOT_CLASS[current.area] ?? 'bg-primary'}`} aria-hidden="true" />
          <span className="truncate">
            {areaLabel(current.area)} · {roleLabel(current.role)}
          </span>
          <span aria-hidden="true">▾</span>
        </button>
        {open && (
          <ul
            id={menuId}
            role="listbox"
            data-testid="area-switcher-menu"
            aria-label={t('areas.switcher.menuTitle')}
            className="absolute right-0 top-full z-30 mt-1 w-64 rounded-input border border-gray-600 bg-white p-1 shadow-medium"
          >
            {areas.map((item) => {
              const enabled = item.entryRoute !== null;
              const selected = item.area === current.area;
              return (
                <li key={`${item.area}:${item.role}`} role="presentation">
                  <button
                    type="button"
                    role="option"
                    aria-selected={selected}
                    aria-disabled={!enabled}
                    disabled={!enabled}
                    data-testid={`area-switcher-option-${item.area}`}
                    onClick={() => choose(item)}
                    className={`flex w-full items-center gap-2 rounded-input px-3 py-2 text-left font-lexend ${
                      selected ? 'bg-gray-100' : 'bg-white'
                    } ${enabled ? 'hover:bg-gray-200' : 'cursor-not-allowed'}`}
                  >
                    <span className={`h-2 w-2 shrink-0 rounded-full ${DOT_CLASS[item.area] ?? 'bg-primary'}`} aria-hidden="true" />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="text-sm font-medium text-primary">{areaLabel(item.area)}</span>
                      <span className="text-xs text-[#374151]">{roleLabel(item.role)}</span>
                    </span>
                    {!enabled && (
                      <span className="rounded-pill bg-[#FFF3CC] px-2 py-0.5 text-xs font-medium text-primary">
                        {t('areas.switcher.comingSoon')}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
