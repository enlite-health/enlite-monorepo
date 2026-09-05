import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Text, Checkbox } from '@presentation/components/atoms';
import type { CatalogCategory } from '@infrastructure/http/AdminPermissionsApiService';
import { COLUNAS, type Coluna, type Linha, colunaDe, cellKey, agrupaPorRecurso } from './cellMatrixModel';

interface CellMatrixProps {
  catalog: CatalogCategory[];
  /** As células marcadas AGORA (estado local de edição). */
  selected: ReadonlySet<string>;
  /** As células salvas — a base do diff do rodapé. */
  saved: readonly string[];
  editable: boolean;
  onToggle: (key: string) => void;
}

/**
 * A seção de células: uma MATRIZ recurso × ação, agrupada por categoria.
 *
 * O domínio já a descreve — o comentário de `PermissionCell.ts` diz que a
 * categoria é propriedade do recurso "porque `worker:read` e `worker:delete`
 * moram na mesma linha da matriz". A tela era o único lugar onde essa matriz
 * virava 41 checkboxes soltos, rotulados com a chave crua.
 *
 * Três coisas que a chave crua escondia e a matriz mostra:
 *  - o RÓTULO humano do recurso, e a `description` que o backend já mandava e
 *    a tela descartava (`worker_pii:read` é "el dossier… raza, religión y
 *    orientación sexual", não uma sigla);
 *  - a categoria TRADUZIDA — vinha do banco em português numa tela es-AR;
 *  - o buraco: `—` onde a célula não existe diz que ninguém pode fazer aquilo,
 *    o que uma lista de caixas marcáveis nunca disse.
 *
 * Rótulo sem tradução cai no valor cru em vez de sumir: catálogo é derivado do
 * código e cresce sem passar por aqui.
 */
export function CellMatrix({ catalog, selected, saved, editable, onToggle }: CellMatrixProps): JSX.Element {
  const { t } = useTranslation();

  const categorias = useMemo(() => catalog.map((cat) => ({
    category: cat.category,
    linhas: agrupaPorRecurso(cat.cells),
  })), [catalog]);

  const usadas = useMemo(() => {
    const cols = new Set<Coluna>();
    for (const cat of catalog) for (const c of cat.cells) cols.add(colunaDe(c.action));
    return COLUNAS.filter((c) => cols.has(c));
  }, [catalog]);

  if (catalog.length === 0) {
    return <Text size="sm" color="secondary">{t('admin.access.group.cells.empty')}</Text>;
  }

  return (
    <div className="overflow-x-auto">
      {/* Grupo sem nenhuma célula não pode ficar mudo: numa matriz de `·`, "não
          dá acesso a nada" e "ninguém marcou ainda" desenham igual. */}
      {selected.size === 0 && (
        <Text size="sm" color="secondary" className="pb-2">{t('admin.access.group.noCells')}</Text>
      )}
      <table className="w-full border-collapse" data-testid="cell-matrix">
        <thead>
          <tr>
            <th className="text-left pb-2 pr-3 border-b border-gray-300 min-w-[13rem]">
              <Text as="span" size="xs" weight="medium" color="secondary">
                {t('admin.access.group.cells.about')}
              </Text>
            </th>
            {usadas.map((col) => (
              <th key={col} className="pb-2 px-2 border-b border-gray-300 align-bottom">
                <Text as="span" size="xs" weight="medium" color="secondary">
                  {t(`admin.access.group.cells.action.${col}`)}
                </Text>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {categorias.map(({ category, linhas }) => (
            <FragmentoCategoria
              key={category}
              category={category}
              linhas={linhas}
              colunas={usadas}
              selected={selected}
              saved={saved}
              editable={editable}
              onToggle={onToggle}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function FragmentoCategoria({
  category, linhas, colunas, selected, saved, editable, onToggle,
}: {
  category: string;
  linhas: Linha[];
  colunas: readonly Coluna[];
  selected: ReadonlySet<string>;
  saved: readonly string[];
  editable: boolean;
  onToggle: (key: string) => void;
}): JSX.Element {
  const { t } = useTranslation();
  const salvas = useMemo(() => new Set(saved), [saved]);

  return (
    <>
      <tr>
        <th colSpan={colunas.length + 1} className="text-left pt-4 pb-1">
          {/* Categoria vem do BANCO e chega em português; sem tradução, mostra
              o valor cru — some seria pior que ficar feio. */}
          <Text as="span" size="xs" weight="medium" color="secondary">
            {t(`admin.access.group.cells.category.${category}`, category)}
          </Text>
        </th>
      </tr>
      {linhas.map((linha) => (
        <tr key={linha.resource} className="border-b border-gray-200 last:border-b-0">
          <th scope="row" className="text-left py-1.5 pr-3 font-normal align-top">
            <Text as="span" size="xs" color="primary" className="block">
              {t(`admin.access.group.cells.resource.${linha.resource}`, linha.resource)}
            </Text>
            <Text as="span" size="xs" color="secondary" className="block font-mono">
              {linha.resource}
            </Text>
          </th>
          {colunas.map((col) => {
            const celula = linha.porColuna[col];
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
            // A descrição existe no backend desde sempre e a tela a descartava.
            const titulo = celula.description ?? key;
            return (
              <td key={col} className="text-center py-1.5 px-2">
                {editable ? (
                  <span className="inline-flex justify-center" title={titulo}>
                    <Checkbox
                      id={`cell-${key}`}
                      aria-label={`${key} — ${titulo}`}
                      checked={marcada}
                      onChange={() => onToggle(key)}
                    />
                  </span>
                ) : (
                  <span title={titulo} aria-label={`${key} — ${titulo}`}>
                    <Text as="span" size="xs" color={marcada ? 'primary' : 'secondary'}>
                      {marcada ? '✓' : '·'}
                    </Text>
                  </span>
                )}
                {salvas.has(key) !== marcada && (
                  <span className="sr-only">{t('admin.access.group.cells.changed')}</span>
                )}
              </td>
            );
          })}
        </tr>
      ))}
    </>
  );
}
