import { Check, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Combobox, Input, Label, Text } from '@presentation/components/atoms';
import { Button } from '@presentation/components/atoms/Button';
import { AREA_PERSON_KINDS, type AreaPeopleTypeFilter } from '@domain/entities/AreaMembership';
import { BUTTON_35, DENSE_CHEVRON, DENSE_COMBO_VALUE, DENSE_PLACEHOLDER } from './formStyles';

interface AreaPeopleToolbarProps {
  search: string;
  searchTooShort: boolean;
  type: AreaPeopleTypeFilter;
  onlyWithMembership: boolean;
  disabled: boolean;
  onSearch: (value: string) => void;
  onType: (value: AreaPeopleTypeFilter) => void;
  onToggleOnly: () => void;
}

/** Busca por nome/e-mail, filtro de tipo e "Solo con vínculo" (a vista de auditoria). */
export function AreaPeopleToolbar(p: AreaPeopleToolbarProps): JSX.Element {
  const { t } = useTranslation();
  const K = 'admin.access.areaMemberships';
  return (
    <div className="flex flex-wrap items-end gap-3" data-testid="vinculos-toolbar">
      <div className="relative space-y-1 flex-1 min-w-[14rem] max-w-[26rem]">
        <Label size="compact" className="block !font-normal" htmlFor="area-people-search">{t(`${K}.toolbar.search`)}</Label>
        <div className="relative">
          <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[#737373]" aria-hidden="true"><Search className="w-4 h-4" /></span>
          <Input
            id="area-people-search"
            data-testid="area-people-search"
            type="search"
            inputSize="dense"
            autoComplete="off"
            className={`!pl-[34px] ${DENSE_PLACEHOLDER}`}
            placeholder={t(`${K}.toolbar.searchPlaceholder`)}
            value={p.search}
            disabled={p.disabled}
            onChange={(e) => p.onSearch(e.target.value)}
          />
        </div>
        {/* Fora do fluxo (absoluto): a dica não empurra os outros controles da barra, que alinham pela base. */}
        {p.searchTooShort && (
          <Text size="xs" color="tertiary" role="status" className="absolute left-0 top-full pt-1" data-testid="area-people-min-chars">
            {t(`${K}.toolbar.minChars`)}
          </Text>
        )}
      </div>
      <div className="space-y-1 w-44">
        <Label size="compact" className="block !font-normal" htmlFor="area-people-type">{t(`${K}.toolbar.type`)}</Label>
        <Combobox
          id="area-people-type"
          data-testid="area-people-type"
          inputSize="dense"
          className={DENSE_CHEVRON}
          valueClassName={DENSE_COMBO_VALUE}
          value={p.type}
          disabled={p.disabled}
          onChange={(v) => p.onType(v as AreaPeopleTypeFilter)}
          options={[
            { value: 'all', label: t(`${K}.kinds.all`) },
            ...AREA_PERSON_KINDS.map((k) => ({ value: k, label: t(`${K}.kinds.${k}`) })),
          ]}
        />
      </div>
      <Button
        type="button"
        size="compact"
        variant={p.onlyWithMembership ? 'primary' : 'quiet'}
        className={BUTTON_35}
        aria-pressed={p.onlyWithMembership}
        disabled={p.disabled}
        data-testid="area-people-only-with"
        onClick={p.onToggleOnly}
      >
        {p.onlyWithMembership && <Check className="w-4 h-4" aria-hidden="true" />}
        {t(`${K}.toolbar.onlyWithMembership`)}
      </Button>
    </div>
  );
}
