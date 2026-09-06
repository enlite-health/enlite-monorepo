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
 * A aba Historial (spec 012, US-B7): QUANDO / DE → PARA / ORIGEM, de `patient_status_history`.
 * Sem "quem" (lex C7.2 — depende do aviso M1-1) e nunca a nota de espera (C7.3). Estado e
 * origem são enums: traduzidos, com fallback no valor cru.
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
          </TableHeader>
          <TableBody>
            {rows.map((r, i) => (
              <TableRow key={`${r.at}-${i}`} data-testid={`status-history-row-${i}`}>
                <TableCell>{formatWhen(r.at)}</TableCell>
                <TableCell>{status(r.from)}</TableCell>
                <TableCell weight="medium">{status(r.to)}</TableCell>
                <TableCell>{source(r.source)}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
