import { useTranslation } from 'react-i18next';
import { Plus } from 'lucide-react';
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

interface LocalizacoesCardProps {
  addresses: PatientAddressDetail[];
}

export function LocalizacoesCard({ addresses }: LocalizacoesCardProps) {
  const { t } = useTranslation();
  const rows = addresses ?? [];
  const empty = '—';

  return (
    <div
      className="bg-white rounded-card border-[1.5px] border-gray-700 p-6 sm:px-8 sm:py-10 flex flex-col gap-4"
      data-testid="localizacoes-card"
    >
      <div className="flex items-center justify-between flex-wrap gap-2">
        <Heading level={1} as="h3" weight="semibold" color="primary">
          {t('admin.patients.detail.locationsCard.title')}
        </Heading>
        <Button variant="outline" size="sm" disabled onClick={() => {}} className="flex items-center gap-1">
          <Plus className="w-4 h-4" />
          {t('admin.patients.detail.new')}
        </Button>
      </div>

      <Table>
        <TableHeader>
          <TableHead>{t('admin.patients.detail.locationsCard.tableName')}</TableHead>
          <TableHead>{t('admin.patients.detail.locationsCard.tableAddress')}</TableHead>
          <TableHead>{t('admin.patients.detail.locationsCard.tableNote')}</TableHead>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow>
              <TableCell unwrapped colSpan={3} className="py-6 text-center">
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
                <TableCell>
                  {addr.addressFormatted ?? addr.addressRaw ?? empty}
                </TableCell>
                <TableCell className="text-gray-600">{addr.complement ?? empty}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
