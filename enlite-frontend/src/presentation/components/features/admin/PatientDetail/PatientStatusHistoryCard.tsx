import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AdminApiService } from '@infrastructure/http/AdminApiService';
import type { PatientStatusHistoryEntry } from '@domain/entities/PatientDetail';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from '@presentation/components/atoms/Table';

interface Props {
  patientId: string;
}

function formatWhen(iso: string): string {
  try {
    return new Date(iso).toLocaleString('es-AR', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

/**
 * A aba Historial (spec 012, US-B7): QUANDO / DE → PARA / ORIGEM / MOTIVO / AUTOR, de
 * `patient_status_history`. Motivo e autor entraram na migration 486 (decisão do Gabriel
 * 29/09/2026) — substitui o "sem quem" de C7.2 (aviso M1-1 ainda pendente). Nunca a nota de
 * espera (C7.3): a trilha não guarda texto clínico. Estado, origem e motivo são enums:
 * traduzidos, com fallback no valor cru; autor é o uid CRU (sem tradução — não é vocabulário).
 */
export function PatientStatusHistoryCard({ patientId }: Props): JSX.Element {
  const { t } = useTranslation();
  const th = (k: string) => t(`admin.patients.status.historyCard.${k}`);
  const [rows, setRows] = useState<PatientStatusHistoryEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    AdminApiService.getPatientStatusHistory(patientId)
      .then((h) => { if (!cancelled) setRows(h); })
      .catch((err) => { if (!cancelled) setError(err instanceof Error ? err.message : th('error')); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientId]);

  const status = (s: string | null) => (s ? t(`admin.patients.statusOptions.${s}`, s) : '—');
  const source = (s: string | null) => (s ? t(`admin.patients.status.sources.${s}`, s) : '—');
  const reasonLabel = (r: string | null) => (r ? t(`admin.patients.suspensionExitReasonOptions.${r}`, r) : '—');
  const actor = (uid: string | null) => uid ?? '—';

  return (
    <div
      className="bg-white rounded-card border-[1.5px] border-gray-700 p-6 sm:px-8 sm:py-10 flex flex-col gap-4"
      data-testid="patient-status-history-card"
    >
      <Heading level={1} as="h3" weight="semibold" color="primary">{th('title')}</Heading>
      {error && <Text size="sm" className="text-red-600" data-testid="status-history-error">{error}</Text>}
      {rows && rows.length === 0 && (
        <Text size="sm" color="secondary" data-testid="status-history-empty">{t('admin.patients.detail.noData')}</Text>
      )}
      {rows && rows.length > 0 && (
        <Table>
          <TableHeader>
            <TableHead>{th('when')}</TableHead>
            <TableHead>{th('from')}</TableHead>
            <TableHead>{th('to')}</TableHead>
            <TableHead>{th('source')}</TableHead>
            <TableHead>{th('reason')}</TableHead>
            <TableHead>{th('actor')}</TableHead>
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow key={`${r.at}-${i}`} data-testid={`status-history-row-${i}`}>
                <TableCell>{formatWhen(r.at)}</TableCell>
                <TableCell>{status(r.from)}</TableCell>
                <TableCell weight="medium">{status(r.to)}</TableCell>
                <TableCell>{source(r.source)}</TableCell>
                <TableCell data-testid={`status-history-reason-${i}`}>{reasonLabel(r.reason)}</TableCell>
                <TableCell data-testid={`status-history-actor-${i}`}>{actor(r.actorUid)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
