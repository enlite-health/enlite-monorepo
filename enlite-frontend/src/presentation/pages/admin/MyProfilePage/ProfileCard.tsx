/**
 * ProfileCard — o cartão de uma seção da página Perfil. Mesma moldura do cartão da antiga `TactiqLinkPage`
 * (`bg-white rounded-card`, contorno gray-700 — a borda visível do tema — de 1,5px), feito com `ring-inset` (box-shadow) e
 * NÃO com `border`: a borda de 1,5px é arredondada pelo navegador conforme o DPR e deslocaria 1px o alinhamento com a régua
 * de `profileLayout.ts`. Título da seção em `Heading` nível 2. Local desta pasta: só o Perfil tem esta composição título + descrição + corpo.
 */
import type { JSX, ReactNode } from 'react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';

interface ProfileCardProps {
  title: string;
  description?: string;
  testId: string;
  /** Classes extras do `<section>` (ex.: `xl:col-span-2` para largura total na grade da página). */
  className?: string;
  children: ReactNode;
}

export function ProfileCard({ title, description, testId, className = '', children }: ProfileCardProps): JSX.Element {
  const headingId = `${testId}-title`;
  return (
    <section
      aria-labelledby={headingId}
      className={`bg-white rounded-card ring-[1.5px] ring-inset ring-gray-700 p-6 sm:p-8 flex flex-col gap-5 ${className}`}
      data-testid={testId}
    >
      <div className="flex flex-col gap-1">
        <Heading level={2} weight="semibold" color="primary" id={headingId}>{title}</Heading>
        {description && <Text color="inherit" size="sm" className="text-slate-600">{description}</Text>}
      </div>
      {children}
    </section>
  );
}
