import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { AdminTemplateCatalogApiService, type TemplateCatalogRow } from '@infrastructure/http/AdminTemplateCatalogApiService';
import { Heading } from '@presentation/components/atoms/Heading';
import { Button } from '@presentation/components/atoms/Button';
import { Text } from '@presentation/components/atoms/Text';
import { PageContainer } from '@presentation/components/atoms/PageContainer';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@presentation/components/atoms/Table';
import { countByGroup, grupoDaLinha, lastCheckedAt, relativeFrom, statusTone } from './templateCatalogView';
import { ES, PT, agruparEmPares, faltaUmaVersao, filtrarPares, versaoPrincipal, type CatalogFilter } from './templateCatalogPairs';
import { TemplateCatalogLanguageCell } from './TemplateCatalogLanguageCell';
import { TemplateCatalogFilters } from './TemplateCatalogFilters';

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
  const { t, i18n } = useTranslation();
  const [rows, setRows] = useState<TemplateCatalogRow[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [filter, setFilter] = useState<CatalogFilter>('all');
  /**
   * O instante da carga, congelado. Não é `new Date()` no render: assim a idade
   * mostrada não muda a cada re-render, e o teste visual é determinístico.
   */
  /**
   * 🔒 O DETALHE VIROU ROTA (`/admin/plantillas/:slug`), e com isso saiu daqui
   * um estado inteiro. Não é só estética do desenho: enquanto era drawer, o
   * detalhe não tinha endereço — não dava para colar num chamado da Twilio nem
   * voltar a ele pelo histórico do navegador, e clicar fora no meio da leitura
   * o fechava. A lista agora só NAVEGA; quem monta o detalhe é a página.
   */
  const navigate = useNavigate();
  const abrir = (slug: string) => navigate(`/admin/plantillas/${encodeURIComponent(slug)}`);
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
  /**
   * Uma linha por MENSAGEM. O par vem do `baseName`, que é coluna do banco —
   * ver `templateCatalogPairs.ts` e a migration 300 para por que não dá para
   * derivá-lo do slug.
   */
  const pares = useMemo(() => agruparEmPares(rows ?? []), [rows]);
  const shown = useMemo(() => filtrarPares(pares, filter, grupoDaLinha), [pares, filter]);
  /**
   * ⚠️ Conta MENSAGENS, não templates — unidade diferente da dos filtros de
   * estado, que continuam contando templates. Somar os dois daria um total
   * que não existe, e por isso o rótulo deste filtro diz "mensagens".
   */
  const faltamVersao = useMemo(() => faltaUmaVersao(pares).length, [pares]);
  const syncAge = useMemo(() => {
    const iso = lastCheckedAt(rows ?? []);
    return iso && loadedAt ? relativeFrom(iso, loadedAt) : null;
  }, [rows, loadedAt]);

  /** Rótulo do estado. Estado que não conhecemos aparece CRU — nunca traduzido para "desconhecido". */
  const statusLabel = (s: string | null) =>
    s === null ? t('admin.templateCatalog.neverChecked') : t(`admin.templateCatalog.status.${s}`, s);

  return (
    <PageContainer>
      {/* ⚠️ O botão existe porque a tela de criar mora em OUTRA rota e em outro
          item de menu, e não havia link nenhum entre as duas: quem abria
          "Plantillas" via só uma lista e concluía, com razão, que não dava para
          adicionar mensagem. O Gabriel bateu nisso em 01/09/2026. Duas telas
          para um conceito só precisam, no mínimo, se enxergar. */}
      <div className="mb-4 flex items-start justify-between gap-4">
        <div className="min-w-0">
          <Heading level={1}>{t('admin.templateCatalog.title')}</Heading>
          <Text size="sm" color="secondary">{t('admin.templateCatalog.subtitle')}</Text>
        </div>
        <Link to="/admin/plantillas/registrar" data-testid="tc-nova-mensagem" className="shrink-0">
          <Button size="compact">{t('admin.templateCatalog.novaMensagem')}</Button>
        </Link>
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
        <TemplateCatalogFilters
          filter={filter} counts={counts} faltamVersao={faltamVersao}
          syncAge={syncAge} onFilter={setFilter}
        />
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
        <Table
          data-testid="tc-table"
          /*
           * 🔒 `table-fixed` — sem ele as larguras em % NÃO VALEM. Com o layout
           * automático o navegador dimensiona pela maior célula, a coluna
           * "Mensaje" cresce com o texto (que chega a 942 caracteres em
           * produção), e "Se usa en" é empurrada para FORA do contêiner: a
           * coluna que existe para proteger quem for tirar uma mensagem do ar
           * some sem nada indicando que sumiu. Medido na foto de 01/09.
           * O `truncate` também só funciona com largura fixada.
           */
          className="table-fixed"
        >
          <TableHeader>
            {/* 🔒 LARGURAS EXPLÍCITAS, as do desenho (39/17/17/20/7%). Sem
                elas o navegador dimensionava pela coluna mais larga: a coluna
                "Mensaje" crescia com o texto, empurrava "Se usa en" para fora
                do contêiner e a tabela passava a rolar na horizontal — a
                coluna que existe para PROTEGER quem for tirar uma mensagem do
                ar ficava invisível sem nada indicando isso. */}
            <TableHead className="w-[39%]">{t('admin.templateCatalog.message')}</TableHead>
            {/* Duas colunas de idioma lado a lado: a MESMA mensagem em duas
                versões. Antes de 01/09 cada versão era uma linha, e
                `admission_confirmation_es` e `_pt` apareciam como duas coisas
                sem relação nenhuma. */}
            <TableHead className="w-[17%]">🇦🇷 {t('admin.templateCatalog.espanol')}</TableHead>
            <TableHead className="w-[17%]">🇧🇷 {t('admin.templateCatalog.portugues')}</TableHead>
            <TableHead className="w-[20%]">{t('admin.templateCatalog.usedIn')}</TableHead>
            {/* 🔒 A COLUNA "Última verificación" SAIU. A idade do dado já está
                na faixa de filtros ("Sincronizado con Twilio hace 4 min"), e
                ela vale para a lista INTEIRA — o sync roda de uma vez. Uma
                coluna repetindo a mesma data em todas as linhas gastava 20% da
                largura para não distinguir linha nenhuma. Quem quer a data de
                UMA mensagem abre o detalhe, onde ela é sobre aquela linha. */}
            <TableHead unwrapped className="w-[7%]"><span className="sr-only">{t('admin.templateCatalog.acoes')}</span></TableHead>
          </TableHeader>
          <TableBody>
            {shown.map((par) => {
              // Uma versão representa a mensagem onde a tela precisa de UMA:
              // texto da lista, data da verificação, detalhe que abre no clique.
              const principal = versaoPrincipal(par, i18n.language);
              const texto = approvedTextOneLine(principal);
              /*
               * As variáveis do PAR, sem repetir: as duas versões da mesma
               * mensagem usam as mesmas, e listá-las duas vezes encheria a
               * linha com a informação repetida.
               */
              const variaveis = [...new Set([par.es, par.pt, ...par.semIdioma]
                .flatMap((r) => r?.placeholders ?? []))];
              /* Inelegível se QUALQUER versão for: a pergunta é sobre a mensagem. */
              const inelegivel = [par.es, par.pt, ...par.semIdioma]
                .find((r) => r !== null && !r.eligible)?.ineligibleReason ?? null;
              /* Rascunho: nenhuma versão existe fora daqui ainda. */
              const ehRascunho = [par.es, par.pt, ...par.semIdioma]
                .filter((r) => r !== null).every((r) => r!.isDraft);
              return (
                <TableRow
                  key={par.baseName}
                  data-testid={`tc-row-${par.baseName}`}
                  onClick={() => abrir(principal.slug)}
                >
                  <TableCell unwrapped>
                    {/* Altura mínima + reticências: os corpos vão de 16 a 942
                        caracteres em produção, e altura que dependa do texto
                        deixa a tabela irregular. */}
                    <div className="flex min-h-9 flex-col justify-center py-1">
                      {/* 🔒 O TEXTO LIDERA. Nas 27 linhas de produção
                          `message_templates.name` é idêntico ao `slug`, então
                          ler `ar_finalize_signup_luz` não diz a ninguém o que
                          vai sair. O identificador continua na linha de baixo,
                          onde serve a quem for abrir chamado — e não disputa a
                          leitura com a única coisa que responde "que mensagem é
                          esta". Inversão pedida pelo desenho de 31/08. */}
                      <span className="min-w-0 truncate">
                        {ehRascunho && texto === null ? (
                          <Text as="span" size="sm" color="secondary" className="italic">
                            {t('admin.templateCatalog.rascunhoSemTexto')}
                          </Text>
                        ) : (
                          <Text as="span" size="sm" color="primary">
                            {texto ? `«${texto}»` : t('admin.templateCatalog.noText')}
                          </Text>
                        )}
                      </span>
                      <span className="flex min-w-0 flex-wrap items-center gap-1 truncate">
                        <Text as="span" size="xs" color="secondary" className="font-mono">
                          {par.baseName}
                        </Text>
                        {/* As variáveis voltaram para a linha COMO CHIPS, e a
                            objeção de 01/09 continua respeitada: o que virava
                            "1 2 3 4 5" era o número nu. O chip mostra
                            `{{1}}`, que se lê como marcador de posição, e a
                            explicação do que isso custa segue no detalhe. */}
                        {variaveis.length > 0 && (
                          <span data-testid={`tc-vars-${par.baseName}`} className="flex flex-wrap gap-1">
                            {variaveis.map((v) => (
                              <span key={v} className="rounded bg-[#F1EEF8] px-1.5 text-clinic">
                                <Text as="span" size="xs" color="inherit" className="font-mono">{`{{${v}}}`}</Text>
                              </span>
                            ))}
                          </span>
                        )}
                      </span>
                      {/* 🔒 A FLAG DE INELEGIBILIDADE MUDOU DE COLUNA. Ela vivia
                          na célula do idioma, onde o texto longo quebrava em
                          três linhas e inflava a altura de toda a linha. Aqui
                          ela é uma frase curta sob a mensagem, como no desenho —
                          e a pergunta que responde ("esta MENSAGEM serve para
                          etapa?") é sobre a mensagem, não sobre o idioma. */}
                      {inelegivel && (
                        /* 🔒 `line-clamp-2`, NUNCA `truncate`. Medido: as
                           frases têm 58 e 70 caracteres e o `truncate`
                           (nowrap + reticências) as cortava no meio da
                           palavra. Duas linhas cabem; meia palavra não
                           informa. */
                        <span data-testid={`tc-ineligible-${par.baseName}`} className="line-clamp-2 min-w-0 text-[#8E1230]">
                          <Text as="span" size="xs" color="inherit">
                            {t('admin.templateCatalog.etapasCurto')}: {t(`admin.templateCatalog.ineligible.${inelegivel}`, t('admin.templateCatalog.ineligible.generic'))}
                          </Text>
                        </span>
                      )}
                      {par.semIdioma.length > 0 && (
                        <span data-testid={`tc-sem-idioma-${par.baseName}`} className="min-w-0 truncate text-[#7A5200]">
                          <Text as="span" size="xs" color="inherit">
                            {t('admin.templateCatalog.idiomaNaoRegistrado', { slugs: par.semIdioma.map((r) => r.slug).join(', ') })}
                          </Text>
                        </span>
                      )}
                    </div>
                  </TableCell>
                  <TableCell unwrapped>
                    <TemplateCatalogLanguageCell
                      row={par.es} language={ES} baseName={par.baseName}
                      statusTone={statusTone} statusLabel={statusLabel}
                      onOpen={(r) => abrir(r.slug)}
                    />
                  </TableCell>
                  <TableCell unwrapped>
                    <TemplateCatalogLanguageCell
                      row={par.pt} language={PT} baseName={par.baseName}
                      statusTone={statusTone} statusLabel={statusLabel}
                      onOpen={(r) => abrir(r.slug)}
                    />
                  </TableCell>
                  <TableCell unwrapped className="whitespace-nowrap">
                    {/* "Usado em" é a união dos dois idiomas: apagar a mensagem
                        desliga os dois lados, então quem decide precisa ver
                        tudo que ela alimenta. */}
                    {(() => {
                      const etapas = [...new Set([par.es, par.pt, ...par.semIdioma].flatMap((r) => r?.usedInStages ?? []))].sort();
                      return etapas.length === 0 ? (
                        <Text size="xs" color="secondary">{t('admin.templateCatalog.unused')}</Text>
                      ) : (
                        <span data-testid={`tc-used-${par.baseName}`} className="inline-flex flex-wrap gap-1">
                          {etapas.map((st) => (
                            <span key={st} className="rounded-pill bg-turquoise/20 px-2 py-0.5">
                              <Text as="span" size="xs" color="primary">{t(`admin.kanban.columns.${st}`, st)}</Text>
                            </span>
                          ))}
                        </span>
                      );
                    })()}
                  </TableCell>
                  <TableCell unwrapped align="right">
                    {/*
                      * 🔒 O "⋯" NÃO É DECORAÇÃO E NÃO É UM MENU FALSO. A maquete
                      * o desenha como afordância de "há mais aqui"; um menu
                      * suspenso com itens que ainda não executam nada seria
                      * teatro — e teatro numa tela que existe para acabar com
                      * afirmação sem lastro. Ele leva ao detalhe, que é onde as
                      * ações realmente moram (duplicar, criar versão, Twilio).
                      */}
                    <span data-testid={`tc-mais-${par.baseName}`} aria-hidden="true" className="px-2 text-gray-800">
                      <Text as="span" size="sm" color="inherit">⋯</Text>
                    </span>
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
