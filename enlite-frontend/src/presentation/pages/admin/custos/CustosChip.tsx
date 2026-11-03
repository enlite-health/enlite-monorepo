/**
 * CustosChip — selo do painel de custos (UI-6: nenhum átomo do DS serve; `Badge` é tipado por `StepStatus` e usa glifos).
 * Só classes padrão do Tailwind (sem hex). Cada par fundo/texto foi medido ≥ 7:1 (teste `CustosChip.test.tsx`): cor nunca é o
 * único sinal — o selo sempre traz texto. As cores do mockup são referência, não contrato.
 */
import type { ReactNode } from 'react';
import { Text } from '@presentation/components/atoms/Text';
import { CHIP_TONES, type ChipTone } from './custosChipTones';

interface CustosChipProps {
  tone: ChipTone;
  children: ReactNode;
  'data-testid'?: string;
}

export function CustosChip({ tone, children, ...rest }: CustosChipProps): JSX.Element {
  const { bg, fg, extra } = CHIP_TONES[tone];
  return (
    <Text
      as="span"
      size="xs"
      weight="medium"
      color="inherit"
      title={typeof children === 'string' ? children : undefined}
      data-single-line="selo"
      className={`inline-flex h-6 max-w-full flex-none items-center truncate whitespace-nowrap rounded-full px-2.5 ${bg} ${fg} ${extra ?? ''}`}
      {...rest}
    >
      {children}
    </Text>
  );
}
