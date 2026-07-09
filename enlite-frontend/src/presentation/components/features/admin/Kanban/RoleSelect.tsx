import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import { Heading } from '@presentation/components/atoms/Heading';
import { Button } from '@presentation/components/atoms/Button';
import { ENCUADRE_ROLES, type EncuadreRole } from '@domain/entities/EncuadreRole';

interface RoleSelectProps {
  onSubmit: (role: EncuadreRole) => void;
  onCancel: () => void;
}

/**
 * Ao selecionar um candidato (mover para SELECTED), pergunta se ele é TITULAR ou
 * SUBSTITUTO (RAPID_RESPONSE). Alimenta a métrica "Equipe Armada" do dashboard.
 * Espelha o padrão do RejectionReasonSelect. Enum sempre via i18n (nunca cru).
 */
export function RoleSelect({ onSubmit, onCancel }: RoleSelectProps) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<EncuadreRole | ''>('');

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50" data-testid="role-modal">
      <div className="bg-white rounded-2xl p-6 w-full max-w-sm shadow-xl">
        <Heading level={3} className="text-[#180149] mb-1">
          {t('admin.kanban.roleModal.title')}
        </Heading>
        <Text as="p" size="sm" color="secondary" className="mb-4">
          {t('admin.kanban.roleModal.subtitle')}
        </Text>

        <div className="flex flex-col gap-2 mb-6">
          {ENCUADRE_ROLES.map((value) => (
            <label
              key={value}
              data-testid={`role-option-${value.toLowerCase().replace(/_/g, '-')}`}
              className={`flex flex-col gap-0.5 px-3 py-2.5 rounded-xl border cursor-pointer transition-colors ${
                selected === value
                  ? 'border-purple-500 bg-purple-50'
                  : 'border-slate-200 hover:border-slate-300'
              }`}
            >
              <div className="flex items-center gap-3">
                <input
                  type="radio"
                  name="encuadre-role"
                  value={value}
                  checked={selected === value}
                  onChange={() => setSelected(value)}
                  className="accent-purple-600"
                />
                <Text as="span" size="sm" weight="medium" className="text-[#180149]">
                  {t(`admin.kanban.roleModal.options.${value}`)}
                </Text>
              </div>
              <Text as="span" size="xs" color="secondary" className="pl-7">
                {t(`admin.kanban.roleModal.hints.${value}`)}
              </Text>
            </label>
          ))}
        </div>

        <div className="flex gap-3">
          <Button variant="outline" size="sm" onClick={onCancel} className="flex-1" data-testid="role-cancel">
            {t('admin.kanban.roleModal.cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={() => selected && onSubmit(selected)}
            disabled={!selected}
            className="flex-1"
            data-testid="role-confirm"
          >
            {t('admin.kanban.roleModal.confirm')}
          </Button>
        </div>
      </div>
    </div>
  );
}
