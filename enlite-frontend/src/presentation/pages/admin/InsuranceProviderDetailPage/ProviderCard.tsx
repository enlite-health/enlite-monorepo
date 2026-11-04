import type { ReactNode } from 'react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';

interface Props {
  /** `provider-<cartão>-card` — âncora de teste e de rolagem. */
  id: string;
  title: string;
  /** Botões do cabeçalho (Editar / Novo), cada um com a sua célula. */
  actions?: ReactNode;
  children: ReactNode;
}

/** O invólucro de um cartão da obra social — o mesmo desenho dos cartões da ficha do paciente (borda, raio, título e ações no topo). */
export function ProviderCard({ id, title, actions, children }: Props): JSX.Element {
  return (
    <section
      id={id}
      className="bg-white rounded-card border-[1.5px] border-gray-700 p-6 sm:px-8 sm:py-8 flex flex-col gap-4 scroll-mt-4"
      data-testid={id}
    >
      <div className="flex items-center justify-between flex-wrap gap-2">
        <Heading level={1} as="h2" weight="semibold" color="primary">{title}</Heading>
        {actions && <div className="flex items-center gap-3 flex-wrap">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

/** Mensagem de um cartão sem leitura (célula ausente ou 403): fica no lugar do conteúdo, no mesmo desenho. */
export function CardMessage({ testId, tone = 'muted', children }: { testId: string; tone?: 'muted' | 'error'; children: ReactNode }): JSX.Element {
  return (
    <div data-testid={testId} role={tone === 'error' ? 'alert' : 'status'} className="rounded-lg bg-gray-50 border border-slate-300 px-4 py-6 text-center">
      <Text size="sm" color="inherit" className={tone === 'error' ? 'text-red-700' : 'text-slate-700'}>{children}</Text>
    </div>
  );
}
