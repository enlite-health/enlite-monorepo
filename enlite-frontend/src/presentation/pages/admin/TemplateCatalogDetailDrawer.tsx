/**
 * O detalhe de uma mensagem do catálogo (spec 010).
 *
 * ⚠️ POR QUE ELE EXISTE: a listagem mostrava as variáveis como chips — e nos 27
 * templates antigos, que são posicionais, isso virava "1 2 3 4 5", números nus
 * que não ensinam nada a quem lê. O Gabriel viu isso na tela de produção em
 * 01/09/2026. As variáveis saíram da lista e vieram para cá, onde há espaço
 * para dizer o que elas SÃO e por que importam.
 *
 * O que a lista responde: "o que existe e em que pé está".
 * O que ESTA tela responde: "o que exatamente essa mensagem diz, e por que ela
 * serve ou não serve".
 *
 * 🔒 O texto exibido é `bodyTwilio` — o que a Meta aprovou. `body` é contrato de
 * envio e divergiu do aprovado em 12 de 27 templates; mostrá-lo já pôs um
 * sentinela na tela como se fosse mensagem.
 */
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { X } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import type { TemplateCatalogRow } from '@infrastructure/http/AdminTemplateCatalogApiService';
// ⚠️ `dataLegivel` mora no módulo de lógica, não aqui: exportar função de um
// arquivo de componente reprova em `react-refresh/only-export-components`, e o
// lint roda com --max-warnings 0. Um aviso derrubou o CI.
import { dataLegivel } from './templateCatalogView';

export interface TemplateCatalogDetailDrawerProps {
  row: TemplateCatalogRow;
  statusLabel: (s: string | null) => string;
  onClose: () => void;
  /**
   * O idioma que ESTA mensagem ainda não tem (`es-AR` | `pt-BR`), ou `null`
   * quando o par está completo.
   *
   * 🔒 A ação de criar a versão que falta mora AQUI, e não na listagem, porque
   * na listagem ela se repetia em 24 das 26 linhas — a mesma chamada para ação,
   * linha após linha, para um estado que nem é defeito (o Brasil não está
   * ligado). A lista reporta; o drawer age.
   */
  faltaIdioma?: string | null;
  /** O nome-base da mensagem, para o link levar o campo já preenchido. */
  baseName?: string;
}

/** Duração da animação de abrir/fechar — a mesma do HelpDrawer. */
const ANIM_MS = 300;

/** Uma linha rótulo→valor. Valor ausente não vira linha vazia: some. */
function Campo({ rotulo, children }: { rotulo: string; children: React.ReactNode }): JSX.Element | null {
  if (children === null || children === undefined || children === '') return null;
  return (
    <div className="border-b border-gray-100 py-2">
      <Text size="xs" color="secondary">{rotulo}</Text>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}

export function TemplateCatalogDetailDrawer({
  row, statusLabel, onClose, faltaIdioma = null, baseName,
}: TemplateCatalogDetailDrawerProps): JSX.Element {
  const { t } = useTranslation();
  /**
   * `show` existe para a animação ACONTECER: montar já com a classe final faz o
   * navegador pintar direto no lugar, sem transição — foi o que aconteceu.
   * Um tick depois da montagem, `show` vira true e o translate anima.
   */
  const [show, setShow] = useState(false);

  useEffect(() => {
    const id = requestAnimationFrame(() => setShow(true));
    return () => cancelAnimationFrame(id);
  }, []);

  /** Fecha animando: espera a transição terminar antes de desmontar. */
  const fechar = (): void => {
    setShow(false);
    setTimeout(onClose, ANIM_MS);
  };

  // Escape fecha — mesma convenção do HelpDrawer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') fechar(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  const posicionais = row.placeholders.filter((p) => /^\d+$/.test(p));
  const nomeadas = row.placeholders.filter((p) => !/^\d+$/.test(p));

  return (
    <>
      <div
        className={`fixed inset-0 z-40 bg-black/50 transition-opacity duration-300 ${show ? 'opacity-100' : 'opacity-0'}`}
        onClick={fechar}
        aria-hidden="true"
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label={row.name}
        data-testid="tc-detalhe"
        className={`fixed right-0 top-0 z-50 flex h-screen w-full max-w-md flex-col overflow-y-auto rounded-bl-[32px] rounded-tl-[32px] bg-white p-6 shadow-2xl transition-transform duration-300 ease-in-out ${
          show ? 'translate-x-0' : 'translate-x-full'
        }`}
      >
        <div className="mb-4 flex items-start justify-between gap-4">
          <div className="min-w-0">
            <Heading level={2}>{row.name}</Heading>
            <Text size="xs" color="secondary">{row.slug}</Text>
          </div>
          <button type="button" onClick={fechar} data-testid="tc-detalhe-fechar" aria-label={t('common.close', 'Cerrar')}>
            <X className="h-5 w-5" />
          </button>
        </div>

        {/* O TEXTO é o que a pessoa veio ver. Vem primeiro. */}
        <div className="mb-4 rounded border border-gray-200 bg-gray-50 p-3" data-testid="tc-detalhe-texto">
          <Text size="sm" color="inherit">
            {row.bodyTwilio || t('admin.templateCatalog.noText')}
          </Text>
        </div>

        <Campo rotulo={t('admin.templateCatalog.metaStatus')}>
          <Text as="span" size="sm" color="inherit">
            <span data-testid="tc-detalhe-status">{statusLabel(row.metaStatus)}</span>
          </Text>
        </Campo>

        <Campo rotulo={t('admin.templateCatalog.reasonLabel')}>
          {row.metaReason ? (
            <Text as="span" size="sm" color="inherit">
              <span data-testid="tc-detalhe-motivo" className="text-[#8E1230]">
                {t(`admin.templateCatalog.reason.${row.metaReason}`, row.metaReason)}
              </span>
            </Text>
          ) : null}
        </Campo>

        {/*
          * 🔒 QUANDO A META NÃO EXPLICA, O CAMPO DIZ ISSO — antes ele SUMIA.
          * `Campo` devolve null com valor vazio, então este bloco desaparecia
          * inteiro e o produto ficava sem nenhum lugar dizendo que a Meta não
          * mandou detalhe. Quem carregava essa informação era o rótulo da
          * LISTA ("Formato inválido — Meta no dio más detalle"), onde ela era
          * ruído: numa varredura interessa O QUE deu errado, não que não há
          * mais o que dizer. Tirar de lá sem dar casa aqui apagaria o dado.
          *
          * E some a inconsistência: os vizinhos deste drawer já preenchem o
          * vazio em vez de esconder — `tc-detalhe-sid` mostra "—",
          * `tc-detalhe-verificado` mostra "nunca".
          */}
        <Campo rotulo={t('admin.templateCatalog.metaDetail')}>
          {row.metaDetail ? (
            <Text as="span" size="sm" color="inherit">
              <span data-testid="tc-detalhe-explicacao">{row.metaDetail}</span>
            </Text>
          ) : (
            <Text as="span" size="sm" color="secondary">
              <span data-testid="tc-detalhe-sem-explicacao">{t('admin.templateCatalog.metaSinDetalle')}</span>
            </Text>
          )}
        </Campo>

        {/* AS VARIÁVEIS — o motivo deste drawer existir. Aqui elas têm rótulo. */}
        <Campo rotulo={t('admin.templateCatalog.variaveis')}>
          {row.placeholders.length === 0 ? (
            <Text as="span" size="sm" color="secondary">
              <span data-testid="tc-detalhe-vars-nenhuma">{t('admin.templateCatalog.semVariaveis')}</span>
            </Text>
          ) : (
            <div data-testid="tc-detalhe-vars">
              <div className="flex flex-wrap gap-1">
                {row.placeholders.map((p) => (
                  <span key={p} className="rounded bg-clinic/10 px-1.5 py-px text-clinic">
                    <Text as="span" size="xs" color="inherit">{`{{${p}}}`}</Text>
                  </span>
                ))}
              </div>
              {/* Sem esta frase, "1 2 3 4 5" não diz nada — que era o problema. */}
              {posicionais.length > 0 && (
                <Text size="xs" color="inherit" className="mt-1 text-[#8E1230]">
                  <span data-testid="tc-detalhe-vars-posicionais">
                    {t('admin.templateCatalog.variaveisPosicionais', { n: posicionais.length })}
                  </span>
                </Text>
              )}
              {nomeadas.length > 0 && posicionais.length === 0 && (
                <Text size="xs" color="secondary" className="mt-1">
                  <span data-testid="tc-detalhe-vars-nomeadas">{t('admin.templateCatalog.variaveisNomeadas')}</span>
                </Text>
              )}
            </div>
          )}
        </Campo>

        <Campo rotulo={t('admin.templateCatalog.usedIn')}>
          <Text as="span" size="sm" color="inherit">
            <span data-testid="tc-detalhe-etapas">
              {row.usedInStages.length === 0
                ? t('admin.templateCatalog.unused')
                : row.usedInStages.map((s) => t(`admin.kanban.columns.${s}`, s)).join(', ')}
            </span>
          </Text>
        </Campo>

        {!row.eligible && (
          <Campo rotulo={t('admin.templateCatalog.porQueNaoServe')}>
            <Text as="span" size="sm" color="inherit">
              <span data-testid="tc-detalhe-inelegivel" className="text-[#8E1230]">
                {t(`admin.templateCatalog.ineligible.${row.ineligibleReason}`, t('admin.templateCatalog.ineligible.generic'))}
              </span>
            </Text>
          </Campo>
        )}

        <Campo rotulo={t('admin.templateCatalog.checkedAt')}>
          <Text as="span" size="sm" color="secondary">
            <span data-testid="tc-detalhe-verificado">
              {dataLegivel(row.metaCheckedAt) ?? t('admin.templateCatalog.never')}
            </span>
          </Text>
        </Campo>

        <Campo rotulo="Content SID">
          <Text as="span" size="xs" color="secondary">
            <span data-testid="tc-detalhe-sid">{row.contentSid ?? '—'}</span>
          </Text>
        </Campo>

        {/* A única ação deste drawer, e ela só existe quando há o que fazer:
            criar a versão do idioma que falta. Some quando o par está completo,
            em vez de ficar desabilitada — botão morto é ruído. */}
        {faltaIdioma !== null && baseName !== undefined && (
          <Link
            to={`/admin/plantillas/registrar?base=${encodeURIComponent(baseName)}&lang=${encodeURIComponent(faltaIdioma)}`}
            data-testid={`tc-detalhe-criar-${faltaIdioma}`}
            className="mt-4 inline-flex items-center gap-1 rounded-pill bg-primary px-3.5 py-1.5 text-white"
          >
            <Text as="span" size="xs" color="inherit">
              ＋ {t(`admin.templateCatalog.criarVersaoEn.${faltaIdioma}`, t('admin.templateCatalog.criarVersao'))}
            </Text>
          </Link>
        )}
      </div>
    </>
  );
}
