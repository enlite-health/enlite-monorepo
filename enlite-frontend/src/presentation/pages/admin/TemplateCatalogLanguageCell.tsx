import type { JSX } from 'react';
import { Link } from 'react-router-dom';
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
    return (
      <Link
        to={`/admin/plantillas/registrar?base=${encodeURIComponent(baseName)}&lang=${encodeURIComponent(language)}`}
        data-testid={`tc-criar-${language}-${baseName}`}
        className="inline-flex items-center gap-1 text-turquoise hover:underline"
        // A linha inteira abre o detalhe no clique; sem isto, criar a versão
        // abriria o drawer da OUTRA versão junto — dois destinos num clique só.
        onClick={(e) => e.stopPropagation()}
      >
        <Text as="span" size="xs" color="inherit">＋ {t('admin.templateCatalog.criarVersao')}</Text>
      </Link>
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
      <span className="mt-0.5 block max-w-[13rem] truncate">
        <Text as="span" size="xs" color="secondary">{row.slug}</Text>
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
