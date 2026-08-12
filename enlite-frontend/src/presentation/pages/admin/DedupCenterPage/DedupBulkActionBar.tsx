/**
 * DedupBulkActionBar
 *
 * Action bar shown when one or more rows are selected in DedupGroupList.
 * Appears above the table when selection.size > 0.
 */

import { useTranslation } from 'react-i18next';
import { Trash2, X } from 'lucide-react';
import { Button } from '@presentation/components/atoms/Button';
import { Text } from '@presentation/components/atoms/Text';

interface DedupBulkActionBarProps {
  selectedCount: number;
  onDismissSelected: () => void;
  onClearSelection: () => void;
  isLoading?: boolean;
}

export function DedupBulkActionBar({
  selectedCount,
  onDismissSelected,
  onClearSelection,
  isLoading = false,
}: DedupBulkActionBarProps) {
  const { t } = useTranslation();

  if (selectedCount === 0) return null;

  return (
    <div
      className="flex items-center justify-between bg-primary/5 border border-primary/20 rounded-xl px-4 py-3 mb-4"
      data-testid="dedup-bulk-bar"
    >
      <Text as="span" size="sm" weight="medium" color="primary">
        {t('admin.dedup.bulkBar.selected', {
          count: selectedCount,
          defaultValue: `{{count}} seleccionado${selectedCount !== 1 ? 's' : ''}`,
        })}
      </Text>

      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={onDismissSelected}
          disabled={isLoading}
          aria-label={t('admin.dedup.bulkBar.dismissAriaLabel', 'Descartar seleccionados')}
        >
          <Trash2 className="w-4 h-4 mr-1" />
          {t('admin.dedup.bulkBar.dismiss', 'Descartar')}
        </Button>

        <Button
          variant="ghost"
          size="sm"
          onClick={onClearSelection}
          aria-label={t('admin.dedup.bulkBar.clearAriaLabel', 'Limpiar selección')}
        >
          <X className="w-4 h-4" />
        </Button>
      </div>
    </div>
  );
}
