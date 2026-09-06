import type { ReactNode } from 'react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';

/**
 * Pares rótulo/valor em grade — a peça dos containers ESTREITOS da ficha (Gabriel, 06/09).
 *
 * Por que não é a linha-com-filete do Diagnóstico: aquele cartão ocupa a largura cheia (1376px) e
 * tem poucos atributos curtos e homogêneos. Estes dois vivem lado a lado, com ~660px cada, e
 * carregam oito pares heterogêneos (telefone, data, endereço). Medido ali: o vão entre rótulo e
 * valor ficava em 425px de média (388–466). Numa planilha isso funciona porque se lê a COLUNA de
 * números; aqui se lê a LINHA, e a cada linha o olho tinha de reencontrar o par. Pior, os valores
 * longos (e-mail, domicílio) não cabiam e empilhavam à esquerda: a âncora trocava de lado quatro
 * vezes descendo o cartão. É o que o Gabriel sentiu como "pouco amigável".
 *
 * A correção é PROXIMIDADE, não alinhamento: rótulo em cima do valor (4px de distância), duas
 * colunas, uma âncora só à esquerda. Oito pares cabem em quatro linhas.
 */

/** Um par. `full` ocupa as duas colunas — para valor longo (e-mail, domicílio). */
export function FieldPair({
  label,
  value,
  full = false,
  testId,
}: {
  label: string;
  value: ReactNode;
  full?: boolean;
  testId?: string;
}) {
  return (
    <div className={`flex flex-col min-w-0${full ? ' sm:col-span-2' : ''}`}>
      {/*
       * Rótulo e valor usam a MESMA cor — `primary`, o #180149 do tema (Gabriel, 06/09). Nenhum
       * token novo entra no design system: a hierarquia vem de TAMANHO e CAIXA, não de cor. O
       * rótulo é 11px em caixa-alta com `tracking`; o dado é 14px em caixa normal, e é ele que o
       * olho pousa primeiro. Foi por isso que a cor de rótulo em azul separado saiu de cena — ela
       * exigia estender o atom `Text`, e não é preciso.
       */}
      <Text as="span" size="2xs" weight="medium" color="primary" className="uppercase tracking-wide">
        {label}
      </Text>
      <Text as="span" size="sm" color="primary" className="break-words" data-testid={testId}>
        {value ?? '—'}
      </Text>
    </div>
  );
}

/** A grade. Uma coluna no estreito, duas a partir de `sm`. */
export function FieldPairGrid({ children }: { children: ReactNode }) {
  return <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-6 gap-y-3.5">{children}</div>;
}

/**
 * Título de um grupo dentro do cartão (Gabriel, 06/09: "colocar ele com uma letra um pouco
 * [maior] pois é um título"). Sobe de rótulo em caixa-alta para título de verdade — `level={4}`
 * do atom, que é o degrau abaixo do nome do cartão e acima dos rótulos de campo.
 */
export function FieldGroupTitle({ children }: { children: ReactNode }) {
  return (
    <Heading level={4} as="h4" weight="semibold" color="primary" className="mb-2.5">
      {children}
    </Heading>
  );
}
