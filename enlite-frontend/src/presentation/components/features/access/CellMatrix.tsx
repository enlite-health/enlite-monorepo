import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Text, Checkbox, Heading } from '@presentation/components/atoms';
import type { CatalogCategory } from '@infrastructure/http/AdminPermissionsApiService';
import { CellHelpDrawer } from './CellHelpDrawer';
import { type Bloco, type Linha, ACAO_BASE, cellKey, exigemLeitura, leituraTravada, montaBlocos } from './cellMatrixModel';

interface CellMatrixProps {
  catalog: CatalogCategory[];
  /** As células marcadas AGORA (estado local de edição). */
  selected: ReadonlySet<string>;
  /** As células salvas — a base do "mudou e não salvou". */
  saved: readonly string[];
  editable: boolean;
  onToggle: (key: string) => void;
}

/**
 * A seção de células: uma matriz recurso × ação POR CATEGORIA.
 *
 * O domínio já a descrevia — o comentário de `PermissionCell.ts` diz que a
 * categoria é propriedade do recurso "porque `worker:read` e `worker:delete`
 * moram na mesma linha da matriz". A tela era o único lugar onde essa matriz
 * virava 41 checkboxes soltos, rotulados com a chave crua.
 *
 * Duas podas, medidas (parecer do CTO, 04/09):
 *  - **colunas por CATEGORIA**, não do catálogo inteiro: as 8 ações globais
 *    davam 22×8 = 176 posições com 129 travessões (73% de buraco), porque
 *    `validate`, `send` e `disable` têm UMA célula cada e `export` tem duas;
 *
 * TODO recurso é linha, inclusive o de uma célula: tirá-lo da grade (#296)
 * baixava o travessão de 24 para 10 mas custava o CABEÇALHO — a caixa solta não
 * dizia se era "Ver" — e punha dois alinhamentos no mesmo bloco. Revertido com
 * a tela na mão.
 *
 * A `description` que o backend sempre mandou e a tela descartava é o rótulo
 * acessível de toda caixa, e o texto VISÍVEL dos avulsos.
 *
 * Rótulo sem tradução cai no valor cru em vez de sumir: o catálogo é derivado
 * do código e cresce sem passar por aqui.
 */
export function CellMatrix({ catalog, selected, saved, editable, onToggle }: CellMatrixProps): JSX.Element {
  const { t } = useTranslation();
  // Qual recurso está com a ajuda aberta. Mora aqui, e não em cada linha, para
  // só existir UM painel na tela.
  const [ajuda, setAjuda] = useState<{ linha: Linha; acoes: string[] } | null>(null);
  // Quem ordena é o modelo, e ele ordena pelo texto VISÍVEL — por isso o
  // resolvedor de rótulo desce daqui em vez de cada linha traduzir a sua.
  const blocos = useMemo(
    () => montaBlocos(catalog, {
      categoria: (c) => t(`admin.access.group.cells.category.${c}`, c),
      recurso: (r) => t(`admin.access.group.cells.resource.${r}`, r),
    }),
    [catalog, t],
  );

  if (catalog.length === 0) {
    return <Text size="sm" color="secondary">{t('admin.access.group.cells.empty')}</Text>;
  }

  return (
    <div className="space-y-5" data-testid="cell-matrix">
      {/* O "Sin células." que morava aqui virou o contador do cabeçalho da
          seção (`contaSelecionadas`): ele responde a mesma ambiguidade — numa
          matriz de `·`, "não dá acesso a nada" e "ninguém marcou ainda"
          desenham igual — e responde para TODO valor, não só para zero. */}
      {blocos.map((bloco) => (
        <BlocoCategoria
          key={bloco.category}
          bloco={bloco}
          selected={selected}
          saved={saved}
          editable={editable}
          onToggle={onToggle}
          onAjuda={setAjuda}
        />
      ))}
      {/* Um painel só na tela, e ele recebe a LINHA — não um id para procurar
          de novo. Guardar só o nome do recurso obrigava a varrer os blocos atrás
          dele, com ramos de "não achei" que nunca aconteceriam. */}
      <CellHelpDrawer
        resource={ajuda?.linha.resource ?? null}
        rotulo={ajuda?.linha.rotulo ?? ''}
        acoes={ajuda?.acoes ?? []}
        onClose={() => setAjuda(null)}
      />
    </div>
  );
}

export interface BlocoProps {
  bloco: Bloco;
  /**
   * D286 — modo ÁRVORE (painel por tela): o rótulo do bloco é o TÍTULO (a tela) e as linhas
   * (containers) ficam recuadas embaixo dele, como um parágrafo. Na matriz por categoria o
   * rótulo continua sendo a legenda miúda de sempre.
   */
  arvore?: boolean;
  selected: ReadonlySet<string>;
  saved: readonly string[];
  editable: boolean;
  onToggle: (key: string) => void;
  onAjuda: (ajuda: { linha: Linha; acoes: string[] }) => void;
}

export function BlocoCategoria({ bloco, selected, saved, editable, onToggle, onAjuda, arvore = false }: BlocoProps): JSX.Element {
  const { t } = useTranslation();
  const { rotulo, grade, colunas } = bloco;

  return (
    <section aria-label={rotulo} className={arvore ? 'pt-2' : undefined}>
      {/* Categoria vem do BANCO e chega em português; sem tradução, mostra o
          valor cru — some seria pior que ficar feio. */}
      {/* Modo árvore: 18px (nível 3 da escala) — Gabriel pediu 20 e corrigiu para 18 (06/09). */}
      {arvore ? (
        <Heading level={3} as="h4" weight="semibold" color="primary" className="pb-1">
          {rotulo}
        </Heading>
      ) : (
        <Text as="span" size="xs" weight="medium" color="secondary" className="block pb-1">
          {rotulo}
        </Text>
      )}

      <div className="overflow-x-auto">
          <table className="w-full border-collapse table-fixed">
            <thead>
              <tr>
                <th className={`text-left pb-1 pr-3 border-b border-gray-300 w-[22rem] ${arvore ? 'pl-6' : ''}`}>
                  <Text as="span" size="xs" weight="medium" color="secondary">
                    {t('admin.access.group.cells.about')}
                  </Text>
                </th>
                {colunas.map((col) => (
                  <th key={col} className="pb-1 px-2 border-b border-gray-300 align-bottom w-32">
                    <Text as="span" size="xs" weight="medium" color="secondary">
                      {t(`admin.access.group.cells.action.${col}`, col)}
                    </Text>
                  </th>
                ))}
                {/* A coluna de SOBRA. Sem ela a régua do cabeçalho parava na
                    última ação — e como cada categoria tem um número de ações,
                    cada bloco fechava num x diferente. Ela não tem largura: no
                    `table-fixed` é ela que come o que sobrar, então a linha vai
                    até a borda e todos os blocos terminam no mesmo lugar. */}
                <td aria-hidden="true" className="border-b border-gray-300" />
              </tr>
            </thead>
            <tbody>
              {grade.map((linha) => (
                <LinhaRecurso
                  key={linha.resource}
                  linha={linha}
                  idPrefix={bloco.category}
                  recuada={arvore}
                  colunas={colunas}
                  selected={selected}
                  saved={saved}
                  editable={editable}
                  onToggle={onToggle}
                  onAjuda={onAjuda}
                />
              ))}
            </tbody>
          </table>
      </div>

    </section>
  );
}

function LinhaRecurso({
  linha, idPrefix, recuada = false, colunas, selected, saved, editable, onToggle, onAjuda,
}: {
  linha: Linha;
  /** D286: a MESMA célula aparece em mais de um bloco (tela); o `id` do DOM precisa do bloco. */
  idPrefix: string;
  /** Modo árvore: a linha (container) fica recuada sob o título da tela. */
  recuada?: boolean;
  colunas: readonly string[];
  selected: ReadonlySet<string>;
  saved: readonly string[];
  editable: boolean;
  onToggle: (key: string) => void;
  onAjuda: (ajuda: { linha: Linha; acoes: string[] }) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const salvas = useMemo(() => new Set(saved), [saved]);
  // Quem exige `Ver` nesta linha — a lista some assim que a última ação forte
  // é desmarcada, e é ela que dá NOME à trava.
  const exigentes = exigemLeitura(linha, selected);
  const travada = leituraTravada(linha, selected);

  return (
    <tr className="border-b border-gray-200 last:border-b-0">
      <th scope="row" className={`text-left py-1.5 pr-3 font-normal align-top ${recuada ? 'pl-6' : ''}`}>
        <span className="flex items-center gap-1.5">
          <Text as="span" size="xs" color="primary">{linha.rotulo}</Text>
          {/* O "?" fica colado no rótulo do RECURSO, não em cada caixa: a
              pergunta de quem concede é sobre a permissão inteira, não sobre
              uma coluna. */}
          <button
            type="button"
            onClick={() => onAjuda({ linha, acoes: colunas.filter((c) => linha.porAcao[c]) })}
            aria-label={`${linha.rotulo} — ${t('admin.access.group.cells.help.open')}`}
            className="shrink-0 w-4 h-4 rounded-full border border-gray-400 text-gray-500 leading-none hover:border-primary hover:text-primary focus:outline-none focus:ring-2 focus:ring-primary"
          >
            <Text as="span" size="xs" color="inherit">?</Text>
          </button>
        </span>
        <Text as="span" size="xs" color="secondary" className="block font-mono">{linha.resource}</Text>
        {/* D286: a MESMA célula em outra tela — marcar aqui marca lá. */}
        {linha.nota && <Text as="span" size="xs" color="secondary" className="block italic">{linha.nota}</Text>}
      </th>
      {colunas.map((col) => {
        const celula = linha.porAcao[col];
        if (!celula) {
          return (
            // `Text` só repassa `title` — `aria-label` nele é silenciosamente
            // descartado, e o travessão ficaria mudo no leitor de tela.
            <td key={col} className="text-center py-1.5 px-2" aria-label={t('admin.access.group.cells.na')}>
              <Text as="span" size="xs" color="secondary">—</Text>
            </td>
          );
        }
        const key = cellKey(celula);
        const marcada = selected.has(key);
        // O rótulo acessível vem do texto CURADO, não da `description` do
        // catálogo. Condição do parecer do `lex` (05/09): escrever ajuda certa
        // no "?" e deixar o tooltip mentindo é pior que hoje — o leitor de tela
        // ouve o errado. Hoje ele ouve "CPF" numa tela de DNI. A `description`
        // fica como último recurso, para célula que ainda não tem texto.
        // `t(chave, '')` devolve o default quando a chave não existe — é assim
        // que se pergunta "há texto curado?" sem um segundo dicionário.
        const curado = t(`admin.access.group.cells.help.resource.${linha.resource}.action.${col}`, '');
        const titulo = curado !== '' ? curado : (celula.description ?? key);
        // A trava só existe na coluna `Ver`, e só enquanto houver ação forte
        // marcada. Caixa que não responde ao clique é ambígua por natureza
        // (NN/g): esta diz QUEM a trava, no `title` e no rótulo acessível.
        const estaTravada = col === ACAO_BASE && travada;
        const porQue = estaTravada
          ? t('admin.access.group.cells.lockedBy', {
            acoes: exigentes.map((a) => t(`admin.access.group.cells.action.${a}`, a)).join(', '),
          })
          : null;
        return (
          <td key={col} className="text-center py-1.5 px-2">
            {editable ? (
              <span
                className={`inline-flex justify-center ${estaTravada ? 'opacity-60 cursor-not-allowed' : ''}`}
                title={porQue ?? titulo}
              >
                <Checkbox
                  id={`cell-${idPrefix}-${key}`}
                  aria-label={porQue ? `${key} — ${titulo} — ${porQue}` : `${key} — ${titulo}`}
                  checked={marcada}
                  disabled={estaTravada}
                  onChange={() => onToggle(key)}
                />
              </span>
            ) : (
              <span title={titulo} aria-label={`${key} — ${titulo}`}>
                <Text as="span" size="xs" color={marcada ? 'primary' : 'secondary'}>{marcada ? '✓' : '·'}</Text>
              </span>
            )}
            {salvas.has(key) !== marcada && (
              <span className="sr-only">{t('admin.access.group.cells.changed')}</span>
            )}
          </td>
        );
      })}
      {/* O par da coluna de sobra do cabeçalho: sem esta célula a régua da linha
          também parava na última ação. */}
      <td aria-hidden="true" />
    </tr>
  );
}
