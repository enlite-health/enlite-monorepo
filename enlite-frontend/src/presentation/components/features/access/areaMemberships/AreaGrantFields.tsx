import { useTranslation } from 'react-i18next';
import { Combobox, Label } from '@presentation/components/atoms';
import { STORED_AREA_ROLES, type StoredArea } from '@domain/entities/AreaMembership';
import { GRANT_AREAS } from './grantAreas';
import { DENSE_CHEVRON, DENSE_COMBO_VALUE } from './formStyles';

interface AreaGrantFieldsProps {
  area: StoredArea;
  role: string;
  onArea: (area: StoredArea) => void;
  onRole: (role: string) => void;
}

/** Os dois campos de "Conceder vínculo": área e papel (os papéis seguem a área — `STORED_AREA_ROLES`). */
export function AreaGrantFields({ area, role, onArea, onRole }: AreaGrantFieldsProps): JSX.Element {
  const { t } = useTranslation();
  const K = 'admin.access.areaMemberships';
  return (
    <div className="flex flex-wrap items-start gap-3">
      <div className="space-y-1 flex-1 min-w-[8rem]">
        <Label size="compact" className="block !font-normal" htmlFor="area-grant-area">{t(`${K}.grant.area`)}</Label>
        <Combobox
          id="area-grant-area"
          data-testid="area-grant-area"
          inputSize="dense"
          className={DENSE_CHEVRON}
          valueClassName={DENSE_COMBO_VALUE}
          value={area}
          onChange={(v) => onArea(v as StoredArea)}
          options={GRANT_AREAS.map((a) => ({ value: a, label: t(`areas.names.${a}`) }))}
        />
      </div>
      <div className="space-y-1 flex-1 min-w-[8rem]">
        <Label size="compact" className="block !font-normal" htmlFor="area-grant-role">{t(`${K}.grant.role`)}</Label>
        <Combobox
          id="area-grant-role"
          data-testid="area-grant-role"
          inputSize="dense"
          className={DENSE_CHEVRON}
          valueClassName={DENSE_COMBO_VALUE}
          value={role}
          onChange={onRole}
          options={STORED_AREA_ROLES[area].map((r) => ({ value: r, label: t(`${K}.roles.${r}`) }))}
        />
      </div>
    </div>
  );
}
