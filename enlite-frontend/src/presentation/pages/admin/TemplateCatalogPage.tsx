import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AdminTemplateCatalogApiService, type TemplateCatalogRow } from '@infrastructure/http/AdminTemplateCatalogApiService';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { PageContainer } from '@presentation/components/atoms/PageContainer';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@presentation/components/atoms/Table';
import { FILTER_ORDER, countByGroup, filterByGroup, lastCheckedAt, relativeFrom, type FilterKey } from './templateCatalogView';

/**
 * /admin/plantillas — o catálogo de mensagens (spec 010, F1).
 *
 * O que esta tela É: o lugar onde se vê quais mensagens existem e em que pé
 * está a autorização da Meta. Substitui `docs/SPRINT_WHATSAPP_TEMPLATES_AR.md`,
 * escrito à mão em 19/05/2026 e errado desde então.
 *
 * O que esta tela NÃO é: onde se decide em que etapa cada mensagem é usada —
 * isso é /admin/mensajes-por-etapa. A coluna "usado em" aqui é LEITURA, e existe
 * por um motivo específico: este é o único lugar onde alguém tiraria uma
 * mensagem de circulação, e sem ver onde ela está pendurada isso desliga um
 * aviso em produção sem nada ficar vermelho.
 *
 * F1 é espelho: não há escrita. Criar e submeter é F2, depende do `lex`.
 *
 * 🔒 A identidade da linha é o TEXTO, não o slug. Nas 27 linhas de produção
 * `message_templates.name` é idêntico ao `slug` — o sync grava o `friendly_name`
 * da Twilio nos dois — então ler `ar_finalize_signup_luz` não diz a ninguém o
 * que a mensagem faz. Mesma decisão já tomada no seletor por etapa.
 */

/** Só é chamado com data presente; ISO inválido vira "Invalid Date" na tela (visível, não mascarado). */
function formatWhen(iso: string): string {
  return new Date(iso).toLocaleString('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

/**
 * Cor do estado. Os estados de DESLIGAMENTO (a Meta tirou do ar algo que estava
 * funcionando) têm peso visual próprio: não são "pendente", são incidente.
 */
function statusTone(status: string | null): string {
  switch (status) {
    case 'APPROVED': return 'bg-turquoise/25 text-[#0B5C4E]';
    case 'PENDING': case 'IN_APPEAL': return 'bg-wait/30 text-[#7A5200]';
    case 'REJECTED': return 'bg-pink-cancel/25 text-[#8E1230]';
    case 'PAUSED': case 'DISABLED': case 'LIMIT_EXCEEDED': return 'bg-coordination/20 text-[#8E1230]';
    default: return 'bg-gray-300 text-gray-800';
  }
}

/**
 * Uma linha só, com o texto APROVADO como ele é. Sem texto, devolve null.
 *
 * ⚠️ NÃO é o `summaryOf` de `stageMessagePreview.ts`, e o nome diferente é
 * deliberado — duas funções com o mesmo nome e comportamentos diferentes já
 * custaram caro aqui (a segunda `maskEmail`, D229).
 *
 * Aquele substitui os slots posicionais por valores de exemplo, e para isso
 * precisa de `body` (os nomes das variáveis, na ordem). Este catálogo NÃO
 * recebe `body` da API, de propósito: `body` é contrato de envio e divergiu do
 * texto aprovado em 12 de 27 templates (mig. 295) — exibi-lo já pôs um
 * sentinela na tela como se fosse mensagem.
 *
 * Consequência aceita: aqui o `{{1}}` aparece cru. Numa lista de catálogo isso
 * é honesto — a pergunta é "que template é este", não "o que a cuidadora lê",
 * que é a pergunta do seletor por etapa.
 */
function approvedTextOneLine(row: TemplateCatalogRow): string | null {
  const t = row.bodyTwilio?.replace(/\s+/g, ' ').trim();
  return t ? t : null;
}

export function TemplateCatalogPage(): JSX.Element {
  const { t } = useTranslation();
  const [rows, setRows] = useState<TemplateCatalogRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<FilterKey>('all');
  /**
   * O instante da carga, congelado. Não é `new Date()` no render: assim a idade
   * mostrada não muda a cada re-render, e o teste visual é determinístico.
   */
  const [loadedAt, setLoadedAt] = useState<Date | null>(null);

  /**
   * ⚠️ Sem `t` nas dependências, e isso não é detalhe.
   *
   * `t` do react-i18next não tem referência estável entre renders. Com ele aqui,
   * cada render cria um `load` novo, o `useEffect` reage à mudança e chama a API
   * de novo — que muda o estado, que renderiza, que cria outro `load`. Laço
   * infinito, e ele aparece justamente no caminho de ERRO, onde o estado muda
   * mais. O teste de falha de carga pegou isso.
   *
   * Por isso o estado guarda a mensagem CRUA e a tradução acontece no render:
   * texto traduzido dentro do estado é o que arrastava `t` para cá.
   */
  const load = useCallback(async () => {
    try {
      setLoadError(null);
      const data = await AdminTemplateCatalogApiService.getTemplateCatalog();
      setRows(data.templates);
      setLoadedAt(new Date());
    } catch (err: unknown) {
      setLoadError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const counts = useMemo(() => countByGroup(rows ?? []), [rows]);
  const shown = useMemo(() => filterByGroup(rows ?? [], filter), [rows, filter]);
  const syncAge = useMemo(() => {
    const iso = lastCheckedAt(rows ?? []);
    return iso && loadedAt ? relativeFrom(iso, loadedAt) : null;
  }, [rows, loadedAt]);

  /** Rótulo do estado. Estado que não conhecemos aparece CRU — nunca traduzido para "desconhecido". */
  const statusLabel = (s: string | null) =>
    s === null ? t('admin.templateCatalog.neverChecked') : t(`admin.templateCatalog.status.${s}`, s);

  return (
    <PageContainer>
      <div className="mb-4">
        <Heading level={1}>{t('admin.templateCatalog.title')}</Heading>
        <Text size="sm" color="secondary">{t('admin.templateCatalog.subtitle')}</Text>
        <Text size="xs" color="secondary">{t('admin.templateCatalog.readOnlyHint')}</Text>
      </div>

      {/* Guarda por `!== null`, não por truthiness: um erro cuja mensagem é
          string vazia é erro do mesmo jeito, e com `&&` a tela não mostrava
          nada — sucesso aparente. Vazio cai no texto traduzido. */}
      {loadError !== null && (
        <div data-testid="tc-load-error" className="mb-3 rounded-lg px-4 py-2 bg-red-50 border border-red-200">
          {/* Mesma regra da recusa da Meta: primeiro o texto que a pessoa
              entende, e o detalhe técnico ao lado para quem for pedir ajuda.
              A mensagem crua do backend vem em inglês e a tela é em espanhol. */}
          <Text size="sm" color="inherit" className="text-red-700">{t('admin.templateCatalog.error')}</Text>
          {loadError && (
            <Text size="xs" color="inherit" className="mt-0.5 block text-red-700/80">{loadError}</Text>
          )}
        </div>
      )}

      {rows !== null && rows.length > 0 && (
        <div className="mb-4 flex flex-wrap items-center gap-2 border-b border-gray-300 pb-4" data-testid="tc-filters">
          {FILTER_ORDER.map((key) => (
            <button
              key={key}
              type="button"
              data-testid={`tc-filter-${key}`}
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
              className={`inline-flex items-center gap-2 rounded-pill border px-3.5 py-1.5 ${
                filter === key ? 'border-primary bg-primary text-white' : 'border-gray-300 bg-white text-gray-800'
              }`}
            >
              <Text as="span" size="xs" color="inherit">{t(`admin.templateCatalog.filter.${key}`)}</Text>
              <Text as="span" size="xs" weight="semibold" color="inherit">{counts[key]}</Text>
            </button>
          ))}
          {/* A idade do dado fica ao lado dos filtros, não escondida numa coluna:
              um catálogo verificado há três dias diz coisa diferente de um
              verificado há três minutos, e isso vale para a lista inteira. */}
          {syncAge && (
            <span className="ml-auto" data-testid="tc-sync-age">
              <Text as="span" size="xs" color="secondary">
                {t(`admin.templateCatalog.syncAge.${syncAge.unidade}`, { count: syncAge.valor })}
              </Text>
            </span>
          )}
        </div>
      )}

      {rows !== null && rows.length === 0 && loadError === null && (
        <div data-testid="tc-empty" className="rounded-card border border-gray-300 px-4 py-8 text-center">
          <Text size="sm" color="secondary">{t('admin.templateCatalog.empty')}</Text>
        </div>
      )}

      {rows !== null && rows.length > 0 && shown.length === 0 && (
        <div data-testid="tc-filter-empty" className="rounded-card border border-gray-300 px-4 py-8 text-center">
          <Text size="sm" color="secondary">{t('admin.templateCatalog.filterEmpty')}</Text>
        </div>
      )}

      {rows !== null && shown.length > 0 && (
        <Table data-testid="tc-table">
          <TableHeader>
            <TableHead>{t('admin.templateCatalog.message')}</TableHead>
            <TableHead>{t('admin.templateCatalog.metaStatus')}</TableHead>
            <TableHead>{t('admin.templateCatalog.usedIn')}</TableHead>
            <TableHead>{t('admin.templateCatalog.checkedAt')}</TableHead>
          </TableHeader>
          <TableBody>
            {shown.map((r) => {
              const summary = approvedTextOneLine(r);
              return (
                <TableRow key={r.slug} clickable={false} data-testid={`tc-row-${r.slug}`}>
                  <TableCell unwrapped className="w-full max-w-0">
                    {/* Altura fixa + reticências: os corpos vão de 16 a 942 caracteres
                        em produção, e altura que dependa do texto deixa a tabela irregular. */}
                    <div className="flex min-h-9 flex-col justify-center py-1">
                      <span className="min-w-0 truncate">
                        <Text as="span" size="sm" color={summary ? 'primary' : 'secondary'}>
                          {summary ? `«${summary}»` : t('admin.templateCatalog.noText')}
                        </Text>
                      </span>
                      <span className="min-w-0 truncate">
                        <Text as="span" size="xs" color="secondary">{r.slug}</Text>
                      </span>
                      {/* As variáveis que a mensagem exige. Sem isto, "usa dados
                          que o sistema não completa" não diz QUAIS. */}
                      {r.placeholders.length > 0 && (
                        <span className="mt-0.5 flex flex-wrap gap-1" data-testid={`tc-vars-${r.slug}`}>
                          {r.placeholders.map((p) => (
                            <span key={p} className="rounded bg-clinic/10 px-1.5 py-px text-clinic">
                              <Text as="span" size="xs" color="inherit">{p}</Text>
                            </span>
                          ))}
                        </span>
                      )}
                      {/* Elegibilidade é pergunta SEPARADA do estado na Meta: um
                          template pode estar aprovado lá e não servir aqui. */}
                      {!r.eligible && (
                        <span data-testid={`tc-ineligible-${r.slug}`} className="min-w-0 truncate text-[#8E1230]">
                          <Text as="span" size="xs" color="inherit">
                            {t(`admin.templateCatalog.ineligible.${r.ineligibleReason}`, t('admin.templateCatalog.ineligible.generic'))}
                          </Text>
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell unwrapped>
                    <span data-testid={`tc-status-${r.slug}`} className={`inline-flex rounded-pill px-2 py-0.5 ${statusTone(r.metaStatus)}`}>
                      <Text as="span" size="xs" weight="medium" color="inherit">{statusLabel(r.metaStatus)}</Text>
                    </span>
                    {r.metaReason && (
                      <span data-testid={`tc-reason-${r.slug}`} className="mt-0.5 block truncate text-[#8E1230]">
                        <Text as="span" size="xs" color="inherit">
                          {t(`admin.templateCatalog.reason.${r.metaReason}`, r.metaReason)}
                        </Text>
                      </span>
                    )}
                    {/* A explicação em PROSA da Meta. Era buscada, gravada e
                        devolvida pela API — e não aparecia na tela. O código
                        seco (`INVALID_FORMAT`) é justamente o que a doc da
                        Twilio diz chegar "without explaining details"; ir
                        buscar na Meta só valeu a pena por causa DESTE campo. */}
                    {r.metaDetail && (
                      <span data-testid={`tc-detail-${r.slug}`} className="mt-0.5 block text-[#8E1230]">
                        <Text as="span" size="xs" color="inherit">
                          {t('admin.templateCatalog.metaDetail')}: {r.metaDetail}
                        </Text>
                      </span>
                    )}
                  </TableCell>
                  <TableCell unwrapped className="whitespace-nowrap">
                    {r.usedInStages.length === 0 ? (
                      <Text size="xs" color="secondary">{t('admin.templateCatalog.unused')}</Text>
                    ) : (
                      <span data-testid={`tc-used-${r.slug}`} className="inline-flex flex-wrap gap-1">
                        {r.usedInStages.map((s) => (
                          <span key={s} className="rounded-pill bg-turquoise/20 px-2 py-0.5">
                            <Text as="span" size="xs" color="primary">{t(`admin.kanban.columns.${s}`, s)}</Text>
                          </span>
                        ))}
                      </span>
                    )}
                  </TableCell>
                  <TableCell unwrapped className="whitespace-nowrap">
                    <Text size="xs" color="secondary">
                      {r.metaCheckedAt ? formatWhen(r.metaCheckedAt) : t('admin.templateCatalog.never')}
                    </Text>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}
    </PageContainer>
  );
}
