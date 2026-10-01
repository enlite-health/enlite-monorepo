/**
 * Campo "Segmento (Ana Care)" do form do PTI (spec 030, FR-007). Extraído de `TherapeuticProjectForm`
 * (teto de 400 linhas). É MACRO e CLÍNICO: em "Nuevo" é um select obrigatório sobre o catálogo ATIVO;
 * em "Editar" é TEXTO travado (o servidor herda o segmento da versão de origem), nunca input
 * desabilitado. Versão com `redacted.clinical` mostra o marcador de redigido, não "—".
 * `data-clarity-mask` (lex C8): o rótulo do segmento é dado de saúde.
 */
import { useTranslation } from 'react-i18next';
import type { CatalogSnapshotItem, TherapeuticCatalogItem } from '@domain/entities/TherapeuticProject';
import { FormField } from '@presentation/components/molecules/FormField';
import { Select } from '@presentation/components/atoms/Select';
import { Text } from '@presentation/components/atoms/Text';

interface Props {
  segments: TherapeuticCatalogItem[];
  value: string;
  onChange: (segmentId: string) => void;
  /** `true` em "Editar" (`isMacroLocked('segmentId')`) — mostra `from.segment` como texto. */
  locked: boolean;
  /** Segmento congelado da versão de origem (só lido quando `locked`). */
  lockedSegment?: CatalogSnapshotItem | null;
  /** `from.redacted.clinical` — sem `patient_clinical:read` o segmento chega `null` por REDAÇÃO. */
  redacted: boolean;
}

export function TherapeuticProjectSegmentField({ segments, value, onChange, locked, lockedSegment, redacted }: Props): JSX.Element {
  const { t } = useTranslation();
  const tf = (k: string) => t(`admin.patients.detail.therapeuticProjectForm.${k}`);
  const empty = segments.length === 0;

  return (
    <FormField label={tf('segment')} htmlFor="tp-segment" labelSize="compact" required={!locked}>
      {locked ? (
        <Text as="p" size="sm" color="primary" data-clarity-mask="True" data-testid="tp-segment-locked">
          {redacted ? t('admin.patients.detail.therapeuticProjectCard.redacted') : (lockedSegment?.label ?? '—')}
        </Text>
      ) : (
        <>
          <Select
            id="tp-segment"
            inputSize="compact"
            value={value}
            onValueChange={onChange}
            placeholder={tf('segmentPlaceholder')}
            options={segments.map((s) => ({ value: s.id, label: s.label }))}
            data-clarity-mask="True"
            data-testid="tp-segment"
          />
          {empty && (
            <Text size="xs" className="text-amber-700" data-testid="tp-segment-empty">{tf('segmentEmpty')}</Text>
          )}
        </>
      )}
    </FormField>
  );
}
