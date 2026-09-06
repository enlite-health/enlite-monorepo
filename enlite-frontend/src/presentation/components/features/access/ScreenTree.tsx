import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CatalogCategory } from '@infrastructure/http/AdminPermissionsApiService';
import { Text } from '@presentation/components/atoms/Text';
import type { Linha } from './cellMatrixModel';
import { BlocoCategoria } from './CellMatrix';
import { CellHelpDrawer } from './CellHelpDrawer';
import { montaBlocosPorTela } from './screenTreeModel';

interface ScreenTreeProps {
  catalog: CatalogCategory[];
  selected: ReadonlySet<string>;
  saved: readonly string[];
  editable: boolean;
  onToggle: (key: string) => void;
}

/**
 * A seção de células por TELA → CONTAINER → ações (D286). Substitui a `CellMatrix` no detalhe
 * do grupo; reusa o bloco/linha dela (trava "mexer ⇒ ver", ajuda, acessibilidade) — muda só o
 * agrupamento, que agora é o das telas do painel, e a nota "também em" nas células
 * compartilhadas. O bloco final "Outras células" recolhe o que nenhuma tela lista.
 */
export function ScreenTree({ catalog, selected, saved, editable, onToggle }: ScreenTreeProps): JSX.Element {
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
  if (catalog.length === 0) {
    return <Text size="sm" color="secondary">{t('admin.access.group.cells.empty')}</Text>;
  }
  return (
    <div className="space-y-5" data-testid="screen-tree">
      {blocos.map((bloco) => (
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
