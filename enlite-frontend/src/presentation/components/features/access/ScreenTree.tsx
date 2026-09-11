import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CatalogCategory } from '@infrastructure/http/AdminPermissionsApiService';
import { Text } from '@presentation/components/atoms/Text';
import type { Linha } from './cellMatrixModel';
import { BlocoCategoria } from './CellMatrix';
import { CellHelpDrawer } from './CellHelpDrawer';
import { filtraBlocosPorTexto, montaBlocosPorTela } from './screenTreeModel';

interface ScreenTreeProps {
  catalog: CatalogCategory[];
  selected: ReadonlySet<string>;
  saved: readonly string[];
  editable: boolean;
  onToggle: (key: string) => void;
  /**
   * Texto da busca (US-21, FR-720) — SÓ filtra o que a grade DESENHA. O `Set` de `selected` que a
   * página guarda não é tocado aqui: uma célula marcada fora do filtro continua marcada quando a
   * busca limpa, e o PUT de `cellsSave` manda o `Set` inteiro, filtro ou não.
   */
  query?: string;
}

/**
 * A seção de células por TELA → CONTAINER → ações (D286). Substitui a `CellMatrix` no detalhe
 * do grupo; reusa o bloco/linha dela (trava "mexer ⇒ ver", ajuda, acessibilidade) — muda só o
 * agrupamento, que agora é o das telas do painel, e a nota "também em" nas células
 * compartilhadas. O bloco final "Outras células" recolhe o que nenhuma tela lista.
 */
export function ScreenTree({ catalog, selected, saved, editable, onToggle, query = '' }: ScreenTreeProps): JSX.Element {
  const { t } = useTranslation();
  const [ajuda, setAjuda] = useState<{ linha: Linha; acoes: string[] } | null>(null);
  const blocos = useMemo(
    () => montaBlocosPorTela(catalog, {
      tela: (id) => t(`admin.access.screens.${id}.label`, id),
      container: (sid, cid) => t(`admin.access.screens.${sid}.containers.${cid}`, cid),
      recurso: (r) => t(`admin.access.group.cells.resource.${r}`, r),
      tambemEm: (telas) => t('admin.access.group.cells.alsoIn', { telas: telas.join(', ') }),
      outras: t('admin.access.group.cells.otherCells'),
    }),
    [catalog, t],
  );
  const blocosFiltrados = useMemo(() => filtraBlocosPorTexto(blocos, query), [blocos, query]);
  if (catalog.length === 0) {
    return <Text size="sm" color="secondary">{t('admin.access.group.cells.empty')}</Text>;
  }
  if (blocosFiltrados.length === 0) {
    return <Text size="sm" color="secondary" data-testid="screen-tree-no-results">{t('admin.access.group.cells.noSearchResults')}</Text>;
  }
  return (
    <div className="space-y-5" data-testid="screen-tree">
      {blocosFiltrados.map((bloco) => (
        <BlocoCategoria
          key={bloco.category}
          bloco={bloco}
          selected={selected}
          saved={saved}
          editable={editable}
          onToggle={onToggle}
          onAjuda={setAjuda}
          arvore
        />
      ))}
      <CellHelpDrawer
        resource={ajuda?.linha.resource ?? null}
        rotulo={ajuda?.linha.rotulo ?? ''}
        acoes={ajuda?.acoes ?? []}
        onClose={() => setAjuda(null)}
      />
    </div>
  );
}
