import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pencil } from 'lucide-react';
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
import type { PatientAddressDetail, PatientDetail, PatientContractedServiceDetail } from '@domain/entities/PatientDetail';
import { patientAddressLabel } from '@domain/entities/PatientContractedService';
import { PatientContractedServicesEditDrawer } from './edit/PatientContractedServicesEditDrawer';
import { ContractedServiceDetailDrawer } from './ContractedServiceDetailDrawer';
import { contractedServiceScheduleText } from './contractedServiceScheduleText';
import { useAutoOpenDrawer, type DrawerFocusRequest } from '@hooks/admin/useAutoOpenDrawer';

interface ServicosContratadosCardProps {
  patient: PatientDetail;
  /** Called after a successful edit so the page can refetch the detail. */
  onSaved?: () => void;
  /** Spec 014 US-D1: pedido de foco do checklist ("falta servicio contratado") — abre o drawer. */
  focusRequest?: DrawerFocusRequest | null;
}

const EMPTY = '—';

/**
 * UMA linha da tabela — as 5 colunas do Figma (decisão do Gabriel 05/09; "Sexo" ficou de fora a
 * pedido dele). Dispositivo ≠ Local ≠ Endereço: três coisas distintas. O endereço é resolvido
 * pelo PONTEIRO `service.addressId` contra `patient.addresses` — nada de endereço é copiado no
 * serviço (migration 330). Clique na linha abre o detalhe completo (`ContractedServiceDetailDrawer`).
 */
function ServiceRow({
  service,
  addresses,
  onOpen,
  t,
}: {
  service: PatientContractedServiceDetail;
  addresses: PatientAddressDetail[];
  onOpen: (service: PatientContractedServiceDetail) => void;
  t: (k: string, o?: any) => string;
}) {
  const tc = (k: string) => t(`admin.patients.detail.contractedServicesCard.${k}`);
  const address = addresses.find((a) => a.id === service.addressId) ?? null;
  const scheduleText = contractedServiceScheduleText(service.schedule);

  return (
    <TableRow
      data-testid={`contracted-service-row-${service.id}`}
      className={service.active ? '' : 'opacity-60'}
      onClick={() => onOpen(service)}
    >
      <TableCell unwrapped>
        {service.deviceTypes.length > 0
          ? service.deviceTypes
              .map((d) => t(`admin.patients.deviceTypeOptions.${d}`, d))
              .join(', ')
          : EMPTY}
      </TableCell>
      <TableCell unwrapped>
        <div className="flex items-center gap-2">
          <Text as="span" size="sm" weight="medium">
            {t(`admin.patients.detail.contractedServicesCard.serviceTypes.${service.serviceCode}`, service.serviceCode)}
          </Text>
          {!service.active && (
            <span className="bg-gray-200 text-gray-700 px-2 py-0.5 rounded-full">
              <Text as="span" size="xs" weight="medium" color="inherit">
                {tc('inactiveBadge')}
              </Text>
            </span>
          )}
        </div>
      </TableCell>
      <TableCell align="center" data-testid={`contracted-service-providers-${service.id}`}>
        {service.providersNeeded == null ? EMPTY : String(service.providersNeeded)}
      </TableCell>
      <TableCell unwrapped data-testid={`contracted-service-location-${service.id}`}>
        <div className="flex flex-col">
          <Text as="span" size="sm">
            {service.careLocation
              ? t(`admin.patients.detail.contractedServicesCard.careLocationOptions.${service.careLocation}`, service.careLocation)
              : EMPTY}
          </Text>
          {/* Sem endereço vinculado é um AVISO, não um traço: é o que trava a ativação
              (checklist SERVICE_ADDRESS) e a operadora precisa ver isso aqui, na linha. */}
          {address ? (
            <Text as="span" size="xs" color="secondary" data-testid={`contracted-service-address-${service.id}`}>
              {patientAddressLabel(address)}
            </Text>
          ) : (
            <Text as="span" size="xs" className="text-amber-700" data-testid={`contracted-service-address-missing-${service.id}`}>
              {tc('noAddressLinked')}
            </Text>
          )}
        </div>
      </TableCell>
      <TableCell unwrapped data-testid={`contracted-service-schedule-${service.id}`}>
        {scheduleText ? (
          <Text as="span" size="sm">{scheduleText}</Text>
        ) : (
          <Text as="span" size="sm" color="muted">{tc('noSchedule')}</Text>
        )}
      </TableCell>
    </TableRow>
  );
}

export function ServicosContratadosCard({ patient, onSaved, focusRequest }: ServicosContratadosCardProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [selected, setSelected] = useState<PatientContractedServiceDetail | null>(null);
  useAutoOpenDrawer(focusRequest, 'CONTRACTED_SERVICE', () => setEditing(true));
  // Migration 330: "falta endereço no serviço" também abre o drawer de edição — é lá que o
  // select "Domicilio" vive.
  useAutoOpenDrawer(focusRequest, 'SERVICE_ADDRESS', () => setEditing(true));
  const services = patient.contractedServices;

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
          <Pencil className="w-4 h-4" />
          {t('admin.patients.detail.contractedServicesCard.editButton')}
        </Button>
      </div>

      {editing && (
        <PatientContractedServicesEditDrawer
          patient={patient}
          onClose={() => setEditing(false)}
          onSaved={() => onSaved?.()}
        />
      )}

      {selected && (
        <ContractedServiceDetailDrawer
          service={selected}
          addresses={patient.addresses}
          onClose={() => setSelected(null)}
        />
      )}

      <Table>
        <TableHeader>
          <TableHead>{t('admin.patients.detail.contractedServicesCard.tableDevice')}</TableHead>
          <TableHead>{t('admin.patients.detail.contractedServicesCard.tableProfessional')}</TableHead>
          <TableHead align="center">{t('admin.patients.detail.contractedServicesCard.tableQuantity')}</TableHead>
          <TableHead>{t('admin.patients.detail.contractedServicesCard.tableLocation')}</TableHead>
          <TableHead>{t('admin.patients.detail.contractedServicesCard.tableSchedule')}</TableHead>
        </TableHeader>
        <TableBody>
          {services.length === 0 ? (
            <TableRow>
              <TableCell unwrapped colSpan={5} className="py-6 text-center">
                <Text as="span" size="sm" color="secondary">
                  {t('admin.patients.detail.noData')}
                </Text>
              </TableCell>
            </TableRow>
          ) : (
            services.map((svc) => (
              <ServiceRow key={svc.id} service={svc} addresses={patient.addresses} onOpen={setSelected} t={t} />
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
