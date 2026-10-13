/**
 * EnquadrePipelineSeals — os dois selos da esteira pós-call do evento (spec 052 §5.5): Importação e Resumo. A esteira
 * é a mesma da admissão, logo o chip é o `SealChip` e o tom da importação é `IMPORT_SEAL_TONE` — compostos, não
 * redesenhados. O texto reusa a chave da Admissão quando idêntico (ver `evidencias/prototipo/SELOS-CHAVES.md`).
 * A tela só TRADUZ o estado que o servidor derivou.
 */
import type { JSX } from 'react';
import { useTranslation } from 'react-i18next';
import { Text } from '@presentation/components/atoms/Text';
import type { EnquadrePipelineState } from '@domain/entities/EnquadreEvent';
import { SealChip } from '../../PatientDetail/admission/AdmissionSeals';
import { IMPORT_SEAL_TONE, type SealTone } from '../../PatientDetail/admission/sealTones';

const SUMMARY_TONE: Record<EnquadrePipelineState['summary'], SealTone> = {
  waiting: 'neutral',
  ready: 'ok',
  unavailable: 'warn',
};

interface Props {
  eventId: string;
  pipeline: EnquadrePipelineState;
}

export function EnquadrePipelineSeals({ eventId, pipeline }: Props): JSX.Element {
  const { t } = useTranslation();
  const ta = (key: string): string => t(`admin.patients.detail.admissionTab.${key}`);
  const te = (key: string, opts?: Record<string, unknown>): string => t(`admin.vacancyDetail.enquadre.${key}`, opts);
  const { importStatus, summary, blockedReason } = pipeline;
  const summaryText = summary === 'waiting' ? ta('seal.importStatus.waiting') : te(`seals.${summary === 'ready' ? 'summaryReady' : 'summaryUnavailable'}`);

  return (
    <div className="flex flex-wrap items-center gap-x-5 gap-y-2" data-testid={`enquadre-seals-${eventId}`}>
      <div className="flex items-center gap-1.5">
        <Text as="span" size="2xs" color="primary" className="uppercase">{ta('seal.import')}</Text>
        <SealChip tone={importStatus ? IMPORT_SEAL_TONE[importStatus] : 'neutral'} testId={`enquadre-seal-import-chip-${eventId}`}>
          {ta(`seal.importStatus.${importStatus ?? 'none'}`)}
        </SealChip>
        {importStatus === 'blocked' && blockedReason && (
          <Text color="inherit" as="span" size="xs" weight="medium" className="text-amber-900" data-testid={`enquadre-seal-blocked-reason-${eventId}`}>
            {te('seals.blockedWhy', { reason: blockedReason })}
          </Text>
        )}
      </div>
      <div className="flex items-center gap-1.5">
        <Text as="span" size="2xs" color="primary" className="uppercase">{te('seals.summary')}</Text>
        <SealChip tone={SUMMARY_TONE[summary]} testId={`enquadre-seal-summary-chip-${eventId}`}>{summaryText}</SealChip>
      </div>
    </div>
  );
}
