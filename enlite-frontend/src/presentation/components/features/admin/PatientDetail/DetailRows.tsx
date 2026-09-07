import type { ReactNode } from 'react';
import { Text } from '@presentation/components/atoms/Text';

/**
 * Linha rótulo/valor com filete embaixo — a peça dos containers de LARGURA CHEIA da ficha
 * (Gabriel, 06/09). Para os cartões estreitos do topo a peça é outra: `FieldPairs`.
 *
 * O formato antigo era `"Rótulo: valor"` numa linha só: o par terminava onde o valor terminava e o
 * resto virava ar — em monitor largo, ~70% dela. Aqui o valor é ancorado à DIREITA e o filete
 * atravessa a largura toda, então o espaço entre os dois vira alinhamento, não sobra. É o que faz
 * o cartão aguentar qualquer largura, inclusive antes de a página ganhar um teto.
 *
 * Por que NÃO serve em container estreito (~660px): ali o vão entre rótulo e valor mede 425px de
 * média, os valores longos não cabem e empilham, e a âncora troca de lado a cada linha. Medido —
 * ver o comentário do `FieldPairs`.
 *
 * Mora aqui, na pasta da feature, e não em `atoms/`: por enquanto só a ficha do paciente usa. Vira
 * atom quando uma segunda tela precisar — promover cedo é criar API pública para um caso só.
 */
export function DetailRow({
  label,
  children,
  testId,
}: {
  label: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div className="flex items-baseline justify-between gap-5 py-2.5 border-b border-gray-600" data-testid={testId}>
      <Text as="span" size="sm" color="secondary" className="shrink-0">
        {label}
      </Text>
      <div className="flex flex-wrap items-center justify-end gap-1.5 text-right">{children}</div>
    </div>
  );
}

/** Contêiner das linhas — só o filete de cima; cada linha traz o seu de baixo. */
export function DetailRows({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div className="flex flex-col border-t border-gray-600" data-testid={testId}>
      {children}
    </div>
  );
}
