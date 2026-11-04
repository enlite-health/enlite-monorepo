import { Fragment, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@presentation/components/atoms/Button';
import { Text } from '@presentation/components/atoms/Text';

/**
 * CountryChips — a multi-seleção de países como botões (o país É o botão: marcado = fundo cheio + "✓").
 *
 * Extraído de `access/GroupDetailPage.tsx` (Accesos y permisos) para a tela Entrevistadores reusar o MESMO desenho (spec 055).
 * O nome sai por EXTENSO do dicionário `countries.<UF>` que o app já tem.
 *
 *  - `readOnly`: o país vira TEXTO (sem botão) — quem só lê precisa consultar o alcance sem ver botão que não pode apertar.
 *  - `renderChip`: deixa quem chama trocar o botão (a tela de grupos injeta o `ActionButton`, que some sem a célula de escrita).
 */
export type CountryChipsSize = 'xs' | 'sm';

export interface CountryChipRenderArgs {
  country: string;
  label: string;
  on: boolean;
  size: CountryChipsSize;
  onToggle: () => void;
}

interface CountryChipsProps {
  /** Países oferecidos, na ordem em que aparecem. */
  countries: readonly string[];
  selected: readonly string[];
  /** Chamado com o país clicado e o estado NOVO (`true` = passou a marcado). */
  onToggle?: (country: string, next: boolean) => void;
  readOnly?: boolean;
  size?: CountryChipsSize;
  renderChip?: (args: CountryChipRenderArgs) => ReactNode;
  children?: ReactNode;
}

export function CountryChips({
  countries,
  selected,
  onToggle,
  readOnly = false,
  size = 'xs',
  renderChip,
  children,
}: CountryChipsProps): JSX.Element {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap gap-3 items-center">
      {countries.map((c) => {
        const on = selected.includes(c);
        const label = t(`countries.${c}`, c);
        if (readOnly) {
          return (
            <span key={c} className="px-3 py-1 rounded border border-gray-300">
              <Text as="span" size="sm" weight={on ? 'semibold' : 'normal'} color={on ? 'primary' : 'secondary'}>
                {label}{on ? ' ✓' : ''}
              </Text>
            </span>
          );
        }
        const toggle = () => onToggle?.(c, !on);
        if (renderChip) return <Fragment key={c}>{renderChip({ country: c, label, on, size, onToggle: toggle })}</Fragment>;
        return (
          <Button key={c} type="button" size={size} variant={on ? 'primary' : 'outline'} aria-pressed={on} onClick={toggle}>
            {label}{on ? ' ✓' : ''}
          </Button>
        );
      })}
      {children}
    </div>
  );
}
