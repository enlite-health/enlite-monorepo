import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import { Button } from '@presentation/components/atoms/Button';

const COLUMNS = ['interview', 'selected', 'inService', 'rejected'] as const;
type EnquadreColumn = (typeof COLUMNS)[number];

export function EnquadreTerapeuticoCard() {
  const { t } = useTranslation();

  return (
    <div
      className="bg-white rounded-card border-[1.5px] border-gray-700 p-6 sm:px-8 sm:py-10 flex flex-col gap-6"
      data-testid="enquadre-terapeutico-card"
    >
      <Heading level={1} as="h3" weight="semibold" color="primary" className="text-center">
        {t('admin.patients.detail.matchingCard.title')}
      </Heading>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6 border-b border-gray-300 pb-6">
        <div className="flex flex-col items-center gap-1 text-center">
          <Text size="sm" weight="medium" color="muted">
            {t('admin.patients.detail.matchingCard.paymentTerm')}
          </Text>
          <Text size="sm" color="muted">—</Text>
        </div>
        <div className="flex flex-col items-center gap-1 text-center">
          <Text size="sm" weight="medium" color="muted">
            {t('admin.patients.detail.matchingCard.matchingDetails')}
          </Text>
          <Text size="sm" color="muted">—</Text>
        </div>
        <div className="flex flex-col items-center gap-1 text-center">
          <Text size="sm" weight="medium" color="muted">
            {t('admin.patients.detail.matchingCard.capacity')}
          </Text>
          <Text size="sm" color="muted">—</Text>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {COLUMNS.map((col) => (
          <KanbanColumn key={col} column={col} />
        ))}
      </div>

      <Text size="sm" color="muted" className="text-center italic">
        {t('admin.patients.detail.matchingCard.empty')}
      </Text>
    </div>
  );
}

interface KanbanColumnProps {
  column: EnquadreColumn;
}

function KanbanColumn({ column }: KanbanColumnProps) {
  const { t } = useTranslation();
  return (
    <div
      className="bg-gray-100 rounded-lg p-4 flex flex-col gap-3 min-h-[160px]"
      data-testid={`enquadre-column-${column}`}
    >
      <Text size="sm" weight="medium" color="muted">
        {t(`admin.patients.detail.matchingCard.columns.${column}`)}
      </Text>
      <Button variant="outline" size="sm" disabled onClick={() => {}} className="flex items-center gap-1 self-start">
        <Plus className="w-4 h-4" />
        {t('admin.patients.detail.matchingCard.addNew')}
      </Button>
    </div>
  );
}
