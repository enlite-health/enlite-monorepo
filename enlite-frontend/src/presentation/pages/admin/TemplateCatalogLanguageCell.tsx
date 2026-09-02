import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
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
     * 🔒 A AÇÃO VOLTOU PARA A CÉLULA, e a objeção medida em 01/09 continua de pé
     * e resolvida de outro jeito. Ela era: 24 das 26 mensagens não têm versão em
     * português, e a coluna virava uma parede da MESMA chamada para ação, linha
     * após linha — transformando o estado NORMAL (o Brasil não está ligado) em
     * alarme.
     *
     * O desenho de 31/08 pede a ação aqui, e ele está certo sobre o gesto: quem
     * vê a lacuna quer preenchê-la de onde a viu, não abrir outra tela. O que
     * conserta a parede é o PESO, não a ausência: link discreto em vez de botão,
     * sem cor de alerta, sem borda. Ele oferece; não cobra.
     */
    return (
      <Link
        to={`/admin/plantillas/registrar?base=${encodeURIComponent(baseName)}&lang=${encodeURIComponent(language)}`}
        data-testid={`tc-criar-${language}-${baseName}`}
        onClick={(e) => e.stopPropagation()}
        className="inline-block text-clinic"
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
      <span
        data-testid={`tc-status-${row.slug}`}
        className={`inline-flex rounded-pill px-2 py-0.5 ${row.isDraft ? 'bg-gray-300 text-gray-800' : statusTone(row.metaStatus)}`}
      >
        <Text as="span" size="xs" weight="medium" color="inherit">
          {/* Rascunho não é "sin verificar": ele não existe na Twilio nem na
              Meta, então não há o que verificar. Selo próprio, como no desenho. */}
          {row.isDraft ? `○ ${t('admin.templateCatalog.filter.draft')}` : statusLabel(row.metaStatus)}
        </Text>
      </span>
      {/*
        * 🔒 O SLUG VOLTOU, e a duplicação que o tirou daqui não existe mais. Ele
        * saiu em 01/09 porque a coluna "Mensaje" liderava com o identificador e
        * a linha exibia a mesma palavra duas vezes. Agora a primeira coluna
        * lidera com o TEXTO, e o slug DESTA versão é informação nova: `ar_x` e
        * `br_x` são dois Contents diferentes, e é este o número que se cola no
        * suporte da Twilio.
        */}
      {/*
        * 🔒 `break-all`, e não `truncate`. Com a coluna em 17% da largura, o
        * slug de 26 caracteres não cabe numa linha — e sem quebra ele VAZAVA
        * para fora da célula e se sobrepunha ao slug da coluna vizinha
        * (`ar_bienvenida_contratac` + `br_bienvenida_contratacion` impressos um
        * por cima do outro). O `truncate` resolveria o vazamento cortando o
        * FIM, que é justamente onde os dois slugs diferem — quem precisa colar
        * o identificador no suporte da Twilio ficaria sem ele. Quebrar em duas
        * linhas guarda todos os caracteres.
        *
        * Achado na foto do comparador; nenhum dos 991 testes olha sobreposição.
        */}
      <span data-testid={`tc-slug-${row.slug}`} className="mt-0.5 block break-all">
        <Text as="span" size="xs" color="secondary" className="font-mono">{row.slug}</Text>
      </span>

      {row.metaReason && (
        <span data-testid={`tc-reason-${row.slug}`} className="mt-0.5 block max-w-[13rem] line-clamp-2 text-[#8E1230]">
          <Text as="span" size="xs" color="inherit">
            {t(`admin.templateCatalog.reason.${row.metaReason}`, row.metaReason)}
          </Text>
        </span>
      )}
    </button>
  );
}
