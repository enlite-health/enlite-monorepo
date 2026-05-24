import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import { Heading } from '@presentation/components/atoms/Heading';
import { Button } from '@presentation/components/atoms/Button';

interface RejectionReasonSelectProps {
  onSubmit: (category: string) => void;
  onCancel: () => void;
}

const REJECTION_OPTIONS = [
  'DISTANCE',
  'SCHEDULE_INCOMPATIBLE',
  'INSUFFICIENT_EXPERIENCE',
  'SALARY_EXPECTATION',
  'WORKER_DECLINED',
  'OVERQUALIFIED',
  'DEPENDENCY_MISMATCH',
  'TALENTUM_NOT_QUALIFIED',
  'OTHER',
] as const;

export function RejectionReasonSelect({ onSubmit, onCancel }: RejectionReasonSelectProps) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState('');

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" data-testid="rejection-modal">
      <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-xl">
        <Heading level={3} className="text-[#180149] mb-4">
          {t('admin.kanban.rejectionModal.title')}
        </Heading>

        <div className="flex flex-col gap-2 mb-6">
          {REJECTION_OPTIONS.map((value) => (
            <label
              key={value}
              data-testid={`rejection-option-${value.toLowerCase().replace(/_/g, '-')}`}
              className={`flex items-center gap-3 px-3 py-2.5 rounded-xl border cursor-pointer transition-colors ${
                selected === value
                  ? 'border-purple-500 bg-purple-50'
                  : 'border-slate-200 hover:border-slate-300'
              }`}
            >
              <input
                type="radio"
                name="rejection"
                value={value}
                checked={selected === value}
                onChange={(e) => setSelected(e.target.value)}
                className="accent-purple-600"
              />
              <Text as="span" size="sm" weight="medium" className="text-[#180149]">
                {t(`admin.kanban.rejectionOptions.${value}`)}
              </Text>
            </label>
          ))}
        </div>

        <div className="flex gap-3">
          <Button
            variant="outline"
            size="sm"
            onClick={onCancel}
            className="flex-1"
            data-testid="rejection-cancel"
          >
            {t('admin.kanban.rejectionModal.cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => selected && onSubmit(selected)}
            disabled={!selected}
            className="flex-1"
            data-testid="rejection-confirm"
          >
            {t('admin.kanban.rejectionModal.confirm')}
          </Button>
        </div>
      </div>
    </div>
  );
}
