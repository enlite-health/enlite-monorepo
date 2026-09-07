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
 *
 * ⚠️ POR QUE NÃO REUSA os `Field` que já existem nesta pasta (gate `revisao-pr`, critério 2).
 * O grep por FORMA acha três vizinhos com o mesmo esqueleto (`flex flex-col`, rótulo sobre valor):
 *   · `PatientChatIdsCard.tsx:16`        — rótulo `sm/medium/muted`, valor MONOESPAÇADO + `break-all`
 *                                          e fallback i18n próprio ("não vinculado"). É id de chat.
 *   · `ContractedServiceDetailDrawer.tsx:23` — rótulo `xs/secondary`, valor `sm/medium`.
 *   · este                               — rótulo `2xs/primary/CAIXA-ALTA`, valor `sm/medium/muted`.
 * O esqueleto é o mesmo; a TIPOGRAFIA não, e ela não é acidente: os três valores deste (`#180149`
 * no rótulo em caixa-alta, `#73737380` no dado) foram decididos pelo Gabriel em três rodadas de
 * medição, em 06/09. Consolidar num componente só obrigaria a mudar a aparência dos outros dois
 * cartões — que ele não revisou e não pediu. Ficam separados DE PROPÓSITO, e a consolidação é item
 * de lista: quando um deles for redesenhado, ele passa a consumir esta peça.
 *
 * Mesma razão para `DetailRow` (em `DetailRows.tsx`) não reusar o `DetailRow` de
 * `VacancyDetail/VacancyCaseCard.tsx:43` — mesmo nome e mesma forma, mas é OUTRA TELA, fora do
 * pedido; tocá-la aqui seria o escopo elástico que a regra da casa proíbe.
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
       * token novo entra no design system: a hierarquia vem de TAMANHO e PESO, não de cor.
       *
       * O valor é `muted` — `text-gray-700`, que no tema é `rgba(115,115,115,.5)`: exatamente o
       * `#73737380` pedido pelo Gabriel (06/09), e já nomeado no design system, sem cor nova.
       *
       * ⚠️ Isso INVERTE a hierarquia de contraste, e está medido: composto sobre o branco do
       * cartão o valor vira #B9B9B9, 1,96:1 — abaixo do mínimo de 4,5:1 para texto de 14px —,
       * enquanto o rótulo em #180149 tem 18,43:1. O NOME do campo fica 9,4× mais legível que o
       * DADO. Decisão do Gabriel, registrada aqui para quem vier depois não "consertar" sem saber.
       *
       * 🔒 O peso é do VALOR, nunca do rótulo. Com `medium` no rótulo (a primeira versão), a
       * caixa-alta somada ao peso compensava exatamente os 3px a menos e os dois empatavam —
       * "os valores estão parecidos com o título" (Gabriel, 06/09). Invertido: rótulo 11px
       * `normal` em caixa-alta recua para segundo plano, dado 14px `medium` domina. Medido em
       * três variantes antes de escolher; a caixa-alta fica porque é o que faz o rótulo ser
       * escaneável sem precisar de peso, e é o mesmo tratamento do grupo no Diagnóstico.
       */}
      <Text as="span" size="2xs" color="primary" className="uppercase tracking-wide">
        {label}
      </Text>
      <Text as="span" size="sm" weight="medium" color="muted" className="break-words" data-testid={testId}>
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
