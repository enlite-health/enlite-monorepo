/**
 * /admin/plantillas/:slug — o detalhe de uma mensagem (spec 010, Tela 4).
 *
 * 🔒 POR QUE PÁGINA E NÃO DRAWER. O desenho de 31/08 pede uma rota própria, e a
 * razão aparece no conteúdo: esta tela existe para o momento em que a Meta
 * recusou. Quem chega aqui vai LER — o histórico, a prosa da Meta, a
 * recomendação de conserto — e depois AGIR ("duplicar y corregir"). Um drawer de
 * 448px empilha isso numa coluna estreita, não tem endereço para colar num
 * chamado, e some ao clicar fora no meio da leitura.
 *
 * ⚠️ NÃO HÁ ENDPOINT DE DETALHE, e não inventei um. A página lê o mesmo
 * `GET /api/admin/template-catalog` da lista e escolhe a linha pelo slug. Custa
 * uma resposta maior e ganha uma garantia que um endpoint novo não daria de
 * graça: lista e detalhe NUNCA divergem, porque são o mesmo dado. Se um dia o
 * catálogo passar de algumas dezenas de linhas, aí sim vale um endpoint — e a
 * conta muda por medição, não por gosto.
 *
 * O rascunho é buscado à parte: é ele que carrega "borrador creado" e "enviada
 * a Meta", os dois marcos que o catálogo não tem como saber.
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AdminTemplateCatalogApiService, type TemplateCatalogRow } from '@infrastructure/http/AdminTemplateCatalogApiService';
import { AdminTemplateDraftsApiService, type TemplateDraft } from '@infrastructure/http/AdminTemplateDraftsApiService';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { PageContainer } from '@presentation/components/atoms/PageContainer';
// 🔒 Os MESMOS tokens do `<Button>`: estas três ações são navegação (`<Link>`
// e `<a>`), não `<button>`, e enquanto foram estilizadas à mão derivaram —
// uma com `px-4 py-2.5`, o texto ora em 14px ora em 12px.
import { buttonClasses } from '@presentation/components/atoms/Button';
import { TemplateCatalogTimeline } from './TemplateCatalogTimeline';
import { TemplateCatalogDetailFields } from './TemplateCatalogDetailFields';
import { TemplateCatalogDraftActions, TemplateCatalogDraftEstado } from './TemplateCatalogDraftActions';
import { construirLinhaDoTempo, urlNoTwilio } from './templateCatalogHistorico';
import { agruparEmPares, idiomaQueFalta } from './templateCatalogPairs';
import { statusTone } from './templateCatalogView';

/** As ações que a tela EXPLICA no card — a maquete lista duas. */
const ACOES = ['duplicar', 'archivar'] as const;

export function TemplateCatalogDetailPage(): JSX.Element {
  const { t } = useTranslation();
  const { slug = '' } = useParams<{ slug: string }>();
  const [rows, setRows] = useState<TemplateCatalogRow[] | null>(null);
  const [drafts, setDrafts] = useState<TemplateDraft[]>([]);
  const [erro, setErro] = useState<string | null>(null);

  /**
   * ⚠️ Sem `t` nas dependências — mesma armadilha do catálogo: `t` não tem
   * referência estável, entra no `useCallback`, o efeito redispara e vira laço
   * infinito no caminho de erro. O estado guarda a mensagem crua.
   */
  const carregar = useCallback(async () => {
    try {
      setErro(null);
      const cat = await AdminTemplateCatalogApiService.getTemplateCatalog();
      setRows(cat.templates);
      /*
       * O rascunho é OPCIONAL para esta tela: 26 das 28 mensagens de produção
       * nasceram no Console da Twilio e não têm nenhum. Falhar a página inteira
       * porque a lista de rascunhos não veio esconderia o que o catálogo já
       * respondeu — por isso o catch é separado e silencioso aqui.
       */
      try {
        const d = await AdminTemplateDraftsApiService.listDrafts();
        setDrafts(d.drafts);
      } catch {
        setDrafts([]);
      }
    } catch (e: unknown) {
      setErro(e instanceof Error ? e.message : String(e));
      setRows([]);
    }
  }, []);

  useEffect(() => { void carregar(); }, [carregar]);

  const row = useMemo(() => (rows ?? []).find((r) => r.slug === slug) ?? null, [rows, slug]);
  const rascunho = useMemo(() => drafts.find((d) => d.slug === slug) ?? null, [drafts, slug]);
  const eventos = useMemo(() => (row ? construirLinhaDoTempo(row, rascunho) : []), [row, rascunho]);
  /** O idioma que falta no PAR desta mensagem — a mesma conta da listagem. */
  const faltaIdioma = useMemo(() => {
    if (!row) return null;
    const par = agruparEmPares(rows ?? []).find((p) => p.baseName === row.baseName);
    return par ? idiomaQueFalta(par) : null;
  }, [rows, row]);

  const voltar = (
    <Link to="/admin/plantillas" data-testid="tcd-voltar" className="mb-2 inline-block">
      <Text size="xs" color="secondary">← {t('admin.templateCatalog.voltarCatalogo')}</Text>
    </Link>
  );

  if (rows === null) {
    return <PageContainer>{voltar}<Text size="sm" color="secondary"><span data-testid="tcd-carregando">{t('admin.templateCatalog.carregando')}</span></Text></PageContainer>;
  }

  if (erro !== null) {
    return (
      <PageContainer>
        {voltar}
        <div data-testid="tcd-erro" className="rounded-lg border border-red-200 bg-red-50 px-4 py-2">
          <Text size="sm" color="inherit" className="text-red-700">{t('admin.templateCatalog.error')}</Text>
          {erro && <Text size="xs" color="inherit" className="mt-0.5 block text-red-700/80">{erro}</Text>}
        </div>
      </PageContainer>
    );
  }

  if (row === null) {
    /*
     * 🔒 "Não existe" é resposta, não erro. O slug pode ter sido digitado à mão,
     * ou a mensagem pode ter saído do catálogo desde que o link foi colado — o
     * sync APAGA de `message_templates` o que não está mais na Twilio. Dizer
     * "não encontramos" com o slug na frente é o que permite a alguém entender
     * o que houve; um 500 genérico não permitiria.
     */
    return (
      <PageContainer>
        {voltar}
        <div data-testid="tcd-nao-encontrada" className="rounded-card border border-gray-300 px-4 py-8 text-center">
          <Text size="sm" color="secondary">{t('admin.templateCatalog.naoEncontrada', { slug })}</Text>
        </div>
      </PageContainer>
    );
  }

  const twilio = urlNoTwilio(row.contentSid);
  const idioma = row.language
    ? t(`admin.templateDrafts.idioma.${row.language}`, row.language)
    : t('admin.templateCatalog.idiomaNaoRegistradoCurto');

  return (
    <PageContainer>
      {voltar}

      {/* CABEÇALHO — o TEXTO é o título, e isso é a decisão central da tela.
          Nas 27 linhas de produção `name` é idêntico ao `slug`, então intitular
          pelo nome mostraria `ar_finalize_signup_luz`, que não diz a ninguém o
          que a mensagem faz. O identificador vai para a linha de baixo, em
          monoespaçada, junto do idioma e da categoria. */}
      {/* 🔒 GRID `1fr auto`, e não `flex-wrap`. Com wrap, o título longo tomava
          a linha inteira e empurrava o selo de estado para BAIXO e à ESQUERDA —
          onde ele lê como mais um dado do cabeçalho, e não como o veredito da
          Meta sobre a mensagem. O desenho o põe no canto superior direito, e é
          de lá que ele se lê de relance. Só empilha abaixo de `sm`. */}
      <div className="mb-5 grid grid-cols-1 items-start gap-3 sm:grid-cols-[1fr_auto] sm:gap-5">
        <div className="min-w-0">
          <Heading level={1} size="compact">
            <span data-testid="tc-detalhe-texto">
              {row.bodyTwilio ? `«${row.bodyTwilio}»` : t('admin.templateCatalog.noText')}
            </span>
          </Heading>
          <Text size="2xs" color="secondary" className="font-mono">
            {row.slug} · {idioma} · {row.category ?? '—'}
          </Text>
        </div>
        <span
          data-testid="tc-detalhe-selo"
          className={`shrink-0 justify-self-start rounded-pill px-[13px] py-[5px] text-[11.5px] font-medium leading-[1.5] sm:justify-self-end ${statusTone(row.metaStatus)}`}
        >
          <Text as="span" size="xs" weight="medium" color="inherit">
            <span data-testid="tc-detalhe-status">
              {row.metaStatus === null
                ? t('admin.templateCatalog.neverChecked')
                : t(`admin.templateCatalog.status.${row.metaStatus}`, row.metaStatus)}
            </span>
          </Text>
        </span>
      </div>

      <div className="grid gap-7 lg:grid-cols-[1.15fr_0.85fr]">
        <TemplateCatalogTimeline eventos={eventos} row={row} />

        <div className="flex flex-col gap-3.5">
          {/* 🔒 EM QUE PÉ ESTÁ O RASCUNHO — a tira abre a coluna, quando há um.
              O estado mudou de tela em 01/09: vivia num bloco "Borradores
              guardados" no pé do compositor, que a maquete não tem. Aqui ele
              vem ANTES da explicação e dos botões, que é a ordem em que a
              maquete manda ler a coluna: onde estou, o que dá para fazer, e o
              que clicar. */}
          {rascunho !== null && <TemplateCatalogDraftEstado rascunho={rascunho} />}

          {/* O QUE DÁ PARA FAZER — texto explicativo, não botão. "Archivar" não
              tem API para linha viva de `message_templates`, e um botão que não
              faz nada seria pior que a frase que explica o que a palavra
              significa. Só vira botão o que realmente executa. */}
          {/* Escala declarada, não herdada — os 16px/24px do body faziam a caixa
              de linha de cada item ficar maior que a do `.check` da maquete. */}
          <div
            className="rounded-[14px] border border-gray-300 bg-white px-4 py-4 text-[14px] leading-[1.5] text-primary"
            data-testid="tc-detalhe-que-fazer"
          >
            <Text size="xs" weight="semibold" color="primary" className="mb-2.5 block">
              {t('admin.templateCatalog.queFazer.titulo')}
            </Text>
            <ul className="m-0 flex list-none flex-col gap-2 p-0">
              {ACOES.map((a) => (
                <li key={a} className="flex items-start gap-2.5 text-[12px] leading-[1.45] text-primary">
                  <span aria-hidden="true" className="mt-0.5 flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-turquoise/35 text-[#0B5C4E]">
                    <Text as="span" size="xs" color="inherit">→</Text>
                  </span>
                  <div>
                    <Text size="xs" weight="medium" color="primary">{t(`admin.templateCatalog.queFazer.${a}.titulo`)}</Text>
                    <Text size="xs" color="secondary">{t(`admin.templateCatalog.queFazer.${a}.detalhe`)}</Text>
                  </div>
                </li>
              ))}
            </ul>
            <Text size="xs" color="secondary" className="mt-3 block border-t border-gray-300 pt-2.5">
              {row.metaDetail
                ? t('admin.templateCatalog.queFazer.metaExplicou')
                : t('admin.templateCatalog.queFazer.metaNaoExplicou')}
            </Text>
          </div>

          {/* As ações do rascunho, quando há um: enviar/editar, ou duplicar
              depois que a Meta já respondeu — e arquivar em qualquer caso. */}
          {rascunho !== null && (
            <TemplateCatalogDraftActions rascunho={rascunho} onMudou={() => void carregar()} />
          )}

          {/* Levar o texto para um rascunho novo — é o que "duplicar y corregir"
              significa na prática, já que um Content submetido não se edita. */}
          {/* ⚠️ SOME QUANDO HÁ RASCUNHO, para não haver dois "duplicar" na mesma
              coluna significando coisas diferentes: este abre um rascunho NOVO
              com o texto da Twilio; o do bloco acima chama `duplicateDraft`, que
              clona a linha do banco com versão e autoria. Dois botões com o
              mesmo nome e efeitos distintos é pior que um só. */}
          {rascunho === null && (
            <Link
              to={`/admin/plantillas/registrar?base=${encodeURIComponent(row.baseName)}&lang=${encodeURIComponent(row.language ?? 'es-AR')}&body=${encodeURIComponent(row.bodyTwilio ?? '')}`}
              data-testid="tc-detalhe-duplicar"
              className={buttonClasses({ size: 'compact', fullWidth: true })}
            >
              {t('admin.templateCatalog.duplicarCorrigir')}
            </Link>
          )}

          {/* Some sem `contentSid`: link que leva a erro faz quem clica achar que
              o sistema quebrou, quando o fato é que esta mensagem nunca chegou
              à Twilio — e isso já está dito no campo Content SID. */}
          {twilio && (
            <a
              href={twilio} target="_blank" rel="noopener noreferrer"
              data-testid="tc-detalhe-twilio"
              className={`${buttonClasses({ size: 'compact', variant: 'outline', fullWidth: true })} bg-white`}
            >
              {t('admin.templateCatalog.verEnTwilio')} ↗
            </a>
          )}

          {/* A ação que o drawer trouxe: criar a versão do idioma que falta. Só
              aparece quando falta — botão morto é ruído. */}
          {faltaIdioma !== null && (
            <Link
              to={`/admin/plantillas/registrar?base=${encodeURIComponent(row.baseName)}&lang=${encodeURIComponent(faltaIdioma)}`}
              data-testid={`tc-detalhe-criar-${faltaIdioma}`}
              className={`${buttonClasses({ size: 'compact', variant: 'outline', fullWidth: true })} bg-white`}
            >
              ＋ {t(`admin.templateCatalog.criarVersaoEn.${faltaIdioma}`, t('admin.templateCatalog.criarVersao'))}
            </Link>
          )}
        </div>
      </div>

      {/*
        * 🔒 OS CAMPOS TÉCNICOS SAEM DA COLUNA E VÃO PARA BAIXO DAS DUAS.
        * Empilhados à direita, eles esticavam só aquela coluna: a linha do tempo
        * terminava na metade da tela e sobrava um metro de branco à esquerda,
        * enquanto a direita seguia rolando. As duas colunas do desenho terminam
        * juntas — a composição É a leitura, primeiro o que aconteceu e o que
        * fazer, e só depois o detalhe de quem vai abrir chamado.
        */}
      <div className="mt-7">
        <TemplateCatalogDetailFields row={row} />
      </div>
    </PageContainer>
  );
}
