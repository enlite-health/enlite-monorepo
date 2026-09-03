import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, Pencil } from 'lucide-react';
import { Heading } from '@presentation/components/atoms/Heading';
import { Text } from '@presentation/components/atoms/Text';
import {
  Table,
  TableHeader,
  TableBody,
  TableRow,
  TableHead,
  TableCell,
} from '@presentation/components/atoms/Table';
import { Button } from '@presentation/components/atoms/Button';
import type { PatientAddressDetail } from '@domain/entities/PatientDetail';
import { PatientAddressDrawer } from './edit/PatientAddressDrawer';

interface LocalizacoesCardProps {
  addresses: PatientAddressDetail[];
  /** Patient id — required to create/edit addresses from the ficha (spec 012, US-B2). */
  patientId?: string;
  /** Called after a successful create/edit so the page can refetch the detail. */
  onSaved?: () => void;
}

export function LocalizacoesCard({ addresses, patientId, onSaved }: LocalizacoesCardProps) {
  const { t } = useTranslation();
  const rows = addresses ?? [];
  const empty = '—';
  // null = fechado · undefined = criar · objeto = editar a logística daquele endereço
  const [drawer, setDrawer] = useState<PatientAddressDetail | undefined | null>(null);

  return (
    <div
      className="bg-white rounded-card border-[1.5px] border-gray-700 p-6 sm:px-8 sm:py-10 flex flex-col gap-4"
      data-testid="localizacoes-card"
    >
      <div className="flex items-center justify-between flex-wrap gap-2">
        <Heading level={1} as="h3" weight="semibold" color="primary">
          {t('admin.patients.detail.locationsCard.title')}
        </Heading>
        <Button variant="outline" size="sm" disabled={!patientId} onClick={() => setDrawer(undefined)} className="flex items-center gap-1" data-testid="new-address-btn">
          <Plus className="w-4 h-4" />
          {t('admin.patients.detail.new')}
        </Button>
      </div>

      {drawer !== null && patientId && (
        <PatientAddressDrawer
          patientId={patientId}
          address={drawer}
          onClose={() => setDrawer(null)}
          onSaved={() => onSaved?.()}
        />
      )}

      {/* lex C2.1: rua + número é texto — sobe em claro para o Clarity sem isto. */}
      <div data-clarity-mask="True">
      <Table>
        <TableHeader>
          <TableHead>{t('admin.patients.detail.locationsCard.tableName')}</TableHead>
          <TableHead>{t('admin.patients.detail.locationsCard.tableAddress')}</TableHead>
          <TableHead>{t('admin.patients.detail.locationsCard.tableZone')}</TableHead>
          <TableHead>{t('admin.patients.detail.locationsCard.tableCorridor')}</TableHead>
          <TableHead>{t('admin.patients.detail.locationsCard.tableAccess')}</TableHead>
          <TableHead>{t('admin.patients.detail.locationsCard.tableNote')}</TableHead>
          {patientId && <TableHead unwrapped><span className="sr-only">{t('admin.patients.detail.edit')}</span></TableHead>}
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell unwrapped colSpan={7} className="py-6 text-center">
                <Text as="span" size="sm" color="secondary">
                  {t('admin.patients.detail.noData')}
                </Text>
              </TableCell>
            </TableRow>
          ) : (
            rows.map((addr, idx) => (
              <TableRow key={addr.id} className="align-top">
                <TableCell>
                  {t('admin.patients.detail.locationsCard.addressGeneric', {
                    index: idx + 1,
                    defaultValue: `Endereço ${idx + 1}`,
                  })}
                </TableCell>
                {/* Contrato real da API (spec 011 A2): formatado pelo geocoder, senão o cru do operador. */}
                <TableCell>{addr.addressFormatted ?? addr.addressRaw ?? empty}</TableCell>
                {/* Spec 012 US-B2: logística POR endereço — zona (`neighborhood`), corredor e acesso (texto livre, dentro da máscara). */}
                <TableCell>{addr.neighborhood ?? empty}</TableCell>
                <TableCell>{addr.logisticsCorridor ?? empty}</TableCell>
                <TableCell className="text-gray-600 whitespace-pre-line">{addr.accessNotes ?? empty}</TableCell>
                <TableCell className="text-gray-600">{addr.complement ?? empty}</TableCell>
                {patientId && (
                  <TableCell unwrapped>
                    <button type="button" onClick={() => setDrawer(addr)} aria-label={t('admin.patients.detail.locationsCard.editAddress')} className="text-slate-400 hover:text-primary transition-colors p-1 rounded" data-testid={`edit-address-${addr.id}`}>
                      <Pencil className="w-4 h-4" />
                    </button>
                  </TableCell>
                )}
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
      </div>
    </div>
  );
}
