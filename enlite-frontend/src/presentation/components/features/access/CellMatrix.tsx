import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Text, Checkbox } from '@presentation/components/atoms';
import type { CatalogCategory, PermissionCell } from '@infrastructure/http/AdminPermissionsApiService';
import { type Bloco, type Linha, cellKey, montaBloco } from './cellMatrixModel';

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
 *  - **recurso de uma célula só sai da grade** e vira item nomeado. Numa
 *    matriz ele é uma caixa e N travessões — e os travessões pertencem às
 *    colunas de OUTRO recurso. São 6, e entre eles `worker_pii` (o dossiê),
 *    a célula mais sensível do catálogo, que aparecia como quase-vazio.
 *
 * A `description` que o backend sempre mandou e a tela descartava é o rótulo
 * acessível de toda caixa, e o texto VISÍVEL dos avulsos.
 *
 * Rótulo sem tradução cai no valor cru em vez de sumir: o catálogo é derivado
 * do código e cresce sem passar por aqui.
 */
export function CellMatrix({ catalog, selected, saved, editable, onToggle }: CellMatrixProps): JSX.Element {
  const { t } = useTranslation();
  const blocos = useMemo(
    () => catalog.map((cat) => montaBloco(cat.category, cat.cells)),
    [catalog],
  );

  if (catalog.length === 0) {
    return <Text size="sm" color="secondary">{t('admin.access.group.cells.empty')}</Text>;
  }

  return (
    <div className="space-y-5" data-testid="cell-matrix">
      {selected.size === 0 && (
        // Grupo sem nenhuma célula não pode ficar mudo: numa matriz de `·`,
        // "não dá acesso a nada" e "ninguém marcou ainda" desenham igual.
        <Text size="sm" color="secondary">{t('admin.access.group.noCells')}</Text>
      )}
      {blocos.map((bloco) => (
        <BlocoCategoria
          key={bloco.category}
          bloco={bloco}
          selected={selected}
          saved={saved}
          editable={editable}
          onToggle={onToggle}
        />
      ))}
    </div>
  );
}

interface BlocoProps {
  bloco: Bloco;
  selected: ReadonlySet<string>;
  saved: readonly string[];
  editable: boolean;
  onToggle: (key: string) => void;
}

function BlocoCategoria({ bloco, selected, saved, editable, onToggle }: BlocoProps): JSX.Element {
  const { t } = useTranslation();
  const { category, grade, colunas, avulsos } = bloco;
  const nomeCategoria = t(`admin.access.group.cells.category.${category}`, category);

  return (
    <section aria-label={nomeCategoria}>
      {/* Categoria vem do BANCO e chega em português; sem tradução, mostra o
          valor cru — some seria pior que ficar feio. */}
      <Text as="span" size="xs" weight="medium" color="secondary" className="block pb-1">
        {nomeCategoria}
      </Text>

      {grade.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className="text-left pb-1 pr-3 border-b border-gray-300 min-w-[13rem]">
                  <Text as="span" size="xs" weight="medium" color="secondary">
                    {t('admin.access.group.cells.about')}
                  </Text>
                </th>
                {colunas.map((col) => (
                  <th key={col} className="pb-1 px-2 border-b border-gray-300 align-bottom">
                    <Text as="span" size="xs" weight="medium" color="secondary">
                      {t(`admin.access.group.cells.action.${col}`, col)}
                    </Text>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {grade.map((linha) => (
                <LinhaRecurso
                  key={linha.resource}
                  linha={linha}
                  colunas={colunas}
                  selected={selected}
                  saved={saved}
                  editable={editable}
                  onToggle={onToggle}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {avulsos.length > 0 && (
        <ul className="pt-1" data-testid={`avulsos-${category}`}>
          {avulsos.map((c) => (
            <li key={cellKey(c)}>
              <Avulso
                celula={c}
                marcada={selected.has(cellKey(c))}
                mudou={saved.includes(cellKey(c)) !== selected.has(cellKey(c))}
                editable={editable}
                onToggle={onToggle}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * Recurso de célula única: nome, a frase que o define, e uma caixa. Sem grade
 * e sem travessão — não há segunda ação com que comparar.
 */
function Avulso({
  celula, marcada, mudou, editable, onToggle,
}: {
  celula: PermissionCell;
  marcada: boolean;
  mudou: boolean;
  editable: boolean;
  onToggle: (key: string) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const key = cellKey(celula);
  const nome = t(`admin.access.group.cells.resource.${celula.resource}`, celula.resource);
  const definicao = celula.description ?? key;

  return (
    // Nome à ESQUERDA com a mesma largura da 1ª coluna da grade (`min-w-13rem`)
    // e a marca logo depois: sem isto o avulso põe a caixa na margem e a grade
    // põe na coluna — duas posições no mesmo bloco, que o teste visual pegou.
    <div className="flex items-start gap-3 py-1.5 border-b border-gray-200 last:border-b-0">
      <div className="min-w-0 min-w-[13rem] pr-3">
        <Text as="span" size="xs" color="primary" className="block">{nome}</Text>
        {/* A definição sai do tooltip e fica À VISTA: o avulso não tem vizinho
            com que se comparar, e entre eles está o dossiê do prestador. */}
        <Text as="span" size="xs" color="secondary" className="block">{definicao}</Text>
      </div>
      <div className="pt-0.5">
        {editable ? (
          <Checkbox id={`cell-${key}`} aria-label={`${key} — ${definicao}`} checked={marcada} onChange={() => onToggle(key)} />
        ) : (
          <span aria-label={`${key} — ${definicao}`}>
            <Text as="span" size="xs" color={marcada ? 'primary' : 'secondary'}>{marcada ? '✓' : '·'}</Text>
          </span>
        )}
      </div>
      {mudou && <span className="sr-only">{t('admin.access.group.cells.changed')}</span>}
    </div>
  );
}

function LinhaRecurso({
  linha, colunas, selected, saved, editable, onToggle,
}: {
  linha: Linha;
  colunas: readonly string[];
  selected: ReadonlySet<string>;
  saved: readonly string[];
  editable: boolean;
  onToggle: (key: string) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const salvas = useMemo(() => new Set(saved), [saved]);

  return (
    <tr className="border-b border-gray-200 last:border-b-0">
      <th scope="row" className="text-left py-1.5 pr-3 font-normal align-top">
        <Text as="span" size="xs" color="primary" className="block">
          {t(`admin.access.group.cells.resource.${linha.resource}`, linha.resource)}
        </Text>
        <Text as="span" size="xs" color="secondary" className="block font-mono">{linha.resource}</Text>
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
        const titulo = celula.description ?? key;
        return (
          <td key={col} className="text-center py-1.5 px-2">
            {editable ? (
              <span className="inline-flex justify-center" title={titulo}>
                <Checkbox id={`cell-${key}`} aria-label={`${key} — ${titulo}`} checked={marcada} onChange={() => onToggle(key)} />
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
    </tr>
  );
}
