import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import type { TemplateCatalogRow } from '@infrastructure/http/AdminTemplateCatalogApiService';

/**
 * Uma coluna de idioma da listagem por mensagem — o espanhol OU o português.
 *
 * 🔒 CADA LADO CARREGA A PRÓPRIA APROVAÇÃO. Para a Twilio e para a Meta são
 * dois Contents, dois pedidos e dois resultados possíveis: o espanhol pode
 * estar aprovado enquanto o português ainda está em revisão, ou ser recusado
 * sozinho. Por isso o estado é desenhado por coluna e não uma vez por linha —
 * um selo único no par deixaria a tela sem como mostrar o que de fato
 * aconteceu na primeira rejeição de um dos lados.
 *
 * Quando o lado não existe, a célula não fica vazia: ela oferece criar a
 * versão que falta. É o único ponto da tela em que a ausência vira ação.
 *
 * 🔒 O SLUG NÃO APARECE AQUI, e a razão só ficou visível numa foto. A coluna
 * "Mensaje" passou a liderar com o identificador da mensagem (emenda do
 * Gabriel no #277) — decisão tomada quando a tela ainda era uma linha por
 * TEMPLATE e não existia um segundo lugar mostrando o nome. Com as colunas de
 * idioma passou a existir, e a linha exibia a mesma palavra duas vezes:
 *
 *   Mensaje: finalize_signup_direct   |  🇦🇷 [Aprobada] ar_finalize_signup_direct
 *
 * Nas 12 linhas de produção sem marcador de idioma o `base_name` É o slug, e a
 * repetição era literal — a segunda cópia não acrescentava um caractere.
 * Naquelas com prefixo, acrescentava três (`ar_`).
 *
 * O slug continua sendo o que se cola no suporte da Twilio ou da Meta, então
 * não sumiu: está no drawer, e o clique nesta célula abre o drawer DESTA
 * versão. Um clique, em vez de uma palavra repetida em 26 linhas.
 */
export function TemplateCatalogLanguageCell({
  row, language, baseName, statusTone, statusLabel, onOpen,
}: {
  row: TemplateCatalogRow | null;
  language: string;
  baseName: string;
  statusTone: (s: string | null) => string;
  statusLabel: (s: string | null) => string;
  onOpen: (r: TemplateCatalogRow) => void;
}): JSX.Element {
  const { t } = useTranslation();

  if (row === null) {
    /*
     * 🔒 UM TRAÇO MUDO, e não um "＋ Crear versión". Medido: 24 das 26 mensagens
     * de produção não têm versão em português, então a coluna inteira virava
     * uma parede da MESMA chamada para ação repetida linha após linha.
     *
     * E, pior que o ruído: não ter versão brasileira NÃO é defeito hoje. O
     * Brasil não está ligado — cadastrar em pt-BR não liga o Brasil, isso
     * depende do mapa país→remetente e do inbound por número. Pintar 24 linhas
     * como "falta fazer algo aqui" transforma o estado NORMAL em alarme, que é
     * o oposto do que esta tela deveria fazer.
     *
     * Quem quer a informação tem o número no chip "Falta una versión"; quem
     * quer a AÇÃO abre a linha, e o drawer oferece criar a versão que falta.
     * A lista REPORTA; o drawer AGE.
     */
    return (
      <span data-testid={`tc-sem-versao-${language}-${baseName}`}>
        <Text as="span" size="xs" color="secondary">—</Text>
      </span>
    );
  }

  return (
    <button
      type="button"
      data-testid={`tc-lang-${language}-${row.slug}`}
      className="block text-left"
      onClick={(e) => { e.stopPropagation(); onOpen(row); }}
    >
      <span data-testid={`tc-status-${row.slug}`} className={`inline-flex rounded-pill px-2 py-0.5 ${statusTone(row.metaStatus)}`}>
        <Text as="span" size="xs" weight="medium" color="inherit">{statusLabel(row.metaStatus)}</Text>
      </span>
      {row.metaReason && (
        <span data-testid={`tc-reason-${row.slug}`} className="mt-0.5 block max-w-[13rem] truncate text-[#8E1230]">
          <Text as="span" size="xs" color="inherit">
            {t(`admin.templateCatalog.reason.${row.metaReason}`, row.metaReason)}
          </Text>
        </span>
      )}
      {/* Elegibilidade é pergunta SEPARADA do estado na Meta, e por idioma: um
          template pode estar aprovado lá e não servir aqui — é o caso do
          posicional. O espanhol pode servir e o português não. */}
      {!row.eligible && (
        <span data-testid={`tc-ineligible-${row.slug}`} className="mt-0.5 block max-w-[13rem] truncate text-[#8E1230]">
          <Text as="span" size="xs" color="inherit">
            {t(`admin.templateCatalog.ineligible.${row.ineligibleReason}`, t('admin.templateCatalog.ineligible.generic'))}
          </Text>
        </span>
      )}
    </button>
  );
}
