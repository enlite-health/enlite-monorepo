/**
 * Os campos de detalhe de uma mensagem — variáveis, uso, elegibilidade, SID.
 *
 * 🔒 POR QUE ELES CONTINUAM EXISTINDO, mesmo não estando na maquete da Tela 4.
 * Eles nasceram de um defeito visto na tela de produção em 01/09: a listagem
 * mostrava as variáveis como chips e, nos 27 templates antigos (posicionais),
 * isso virava "1 2 3 4 5" — números nus que não ensinam nada. As variáveis
 * saíram da lista e ganharam casa aqui, onde há espaço para dizer o que elas
 * SÃO. A maquete foi desenhada antes disso e não as previu; apagá-las para bater
 * com o desenho devolveria o defeito ao lugar de onde ele foi tirado.
 *
 * Ficam em LARGURA TOTAL, abaixo das duas colunas. Empilhados na coluna da
 * direita eles esticavam só aquela metade: a linha do tempo terminava no meio da
 * tela e sobrava um metro de branco à esquerda enquanto a direita seguia
 * rolando. As duas colunas do desenho terminam juntas, e a composição É a
 * leitura — primeiro o que aconteceu e o que fazer, depois o detalhe técnico de
 * quem vai abrir chamado.
 */
import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import type { TemplateCatalogRow } from '@infrastructure/http/AdminTemplateCatalogApiService';
import { dataLegivel } from './templateCatalogView';

/**
 * Uma célula rótulo→valor. Valor ausente não vira célula vazia: some.
 *
 * ⚠️ Divisória VERTICAL, não horizontal: em largura total os campos ficam lado a
 * lado, e a linha de baixo que separava itens empilhados viraria um risco
 * atravessando a tela.
 */
function Campo({ rotulo, children }: { rotulo: string; children: React.ReactNode }): JSX.Element | null {
  if (children === null || children === undefined || children === '') return null;
  return (
    <div className="min-w-0 border-gray-300 sm:border-l sm:pl-4 sm:first:border-l-0 sm:first:pl-0">
      <Text size="xs" color="secondary">{rotulo}</Text>
      <div className="mt-0.5">{children}</div>
    </div>
  );
}

export function TemplateCatalogDetailFields({ row }: { row: TemplateCatalogRow }): JSX.Element {
  const { t } = useTranslation();
  const posicionais = row.placeholders.filter((p) => /^\d+$/.test(p));
  const nomeadas = row.placeholders.filter((p) => !/^\d+$/.test(p));

  return (
    <div
      className="grid grid-cols-1 gap-4 rounded-card border border-gray-300 px-4 py-4 sm:grid-cols-2 lg:grid-cols-5"
      data-testid="tc-detalhe-campos"
    >
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
    </div>
  );
}
