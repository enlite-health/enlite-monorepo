import { useState } from 'react';
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
import type { PatientDetail } from '@domain/entities/PatientDetail';
import { PatientServiceEditDrawer } from './edit/PatientServiceEditDrawer';

interface ServicosContratadosCardProps {
  patient: PatientDetail;
  /** Called after a successful edit so the page can refetch the detail. */
  onSaved?: () => void;
}

export function ServicosContratadosCard({ patient, onSaved }: ServicosContratadosCardProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const empty = '—';
  const services = patient.serviceType ?? [];

  return (
    <div
      className="bg-white rounded-card border-[1.5px] border-gray-700 p-6 sm:px-8 sm:py-10 flex flex-col gap-4"
      data-testid="servicos-contratados-card"
    >
      <div className="flex items-center justify-between flex-wrap gap-2">
        <Heading level={1} as="h3" weight="semibold" color="primary">
          {t('admin.patients.detail.contractedServicesCard.title')}
        </Heading>
        <Button variant="outline" size="sm" onClick={() => setEditing(true)} className="flex items-center gap-1" data-testid="edit-service-btn">
          <Plus className="w-4 h-4" />
          {t('admin.patients.detail.new')}
        </Button>
      </div>

      {editing && (
        <PatientServiceEditDrawer
          patient={patient}
          onClose={() => setEditing(false)}
          onSaved={() => onSaved?.()}
        />
      )}

      <Table>
        <TableHeader>
          <TableHead>{t('admin.patients.detail.contractedServicesCard.tableDevice')}</TableHead>
          <TableHead>{t('admin.patients.detail.contractedServicesCard.tableProfessional')}</TableHead>
          <TableHead>{t('admin.patients.detail.contractedServicesCard.tableQuantity')}</TableHead>
          <TableHead>{t('admin.patients.detail.contractedServicesCard.tableLocation')}</TableHead>
          <TableHead>{t('admin.patients.detail.contractedServicesCard.tableSex')}</TableHead>
          <TableHead>{t('admin.patients.detail.contractedServicesCard.tableValue')}</TableHead>
          <TableHead>{t('admin.patients.detail.contractedServicesCard.tableVersion')}</TableHead>
        </TableHeader>
        <TableBody>
          {services.length === 0 ? (
            <TableRow>
              <TableCell unwrapped colSpan={7} className="py-6 text-center">
                <Text as="span" size="sm" color="secondary">
                  {t('admin.patients.detail.noData')}
                </Text>
              </TableCell>
            </TableRow>
          ) : (
            services.map((svc) => (
              <TableRow key={svc}>
                <TableCell>{patient.deviceType ?? empty}</TableCell>
                <TableCell>
                  {t(`admin.patients.detail.contractedServicesCard.serviceTypes.${svc}`, svc)}
                </TableCell>
                <TableCell>{empty}</TableCell>
                <TableCell>{empty}</TableCell>
                <TableCell>{empty}</TableCell>
                <TableCell>{empty}</TableCell>
                <TableCell>{empty}</TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
