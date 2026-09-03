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
import type { PatientDetail, PatientContractedServiceDetail } from '@domain/entities/PatientDetail';
import { PatientContractedServicesEditDrawer } from './edit/PatientContractedServicesEditDrawer';

interface ServicosContratadosCardProps {
  patient: PatientDetail;
  /** Called after a successful edit so the page can refetch the detail. */
  onSaved?: () => void;
}

const EMPTY = '—';

/**
 * "20 / 20" quando os dois vêm, "20" quando só `a` falta e `b` também falta em espírito
 * (`b` do lado do requisito, ex.: authorizedHours), "—" quando nenhum (spec 013, bloco C).
 *
 * QA-caça #3: quando só `a` falta mas `b` tem valor, NUNCA devolve `String(b)` sozinho — um `b`
 * legítimo de 0 (ex.: providersNeeded null + 0 prestadores ativos) ficaria indistinguível de
 * "precisa 0 e tem 0". Devolve "— / b" para manter os dois lados sempre discrimináveis.
 */
function pair(a: number | null, b: number | null): string {
  if (a == null && b == null) return EMPTY;
  if (a == null) return `${EMPTY} / ${b}`;
  if (b == null) return String(a);
  return `${a} / ${b}`;
}

function ServiceRow({ service, t }: { service: PatientContractedServiceDetail; t: (k: string, o?: any) => string }) {
  const activeProviders = service.providers.filter((p) => p.active).length;
  const valueDisplay = service.hourlyValueRedacted
    ? t('admin.patients.detail.contractedServicesCard.tableValueRedacted')
    : service.hourlyValue != null
      ? String(service.hourlyValue)
      : EMPTY;

  return (
    <TableRow data-testid={`contracted-service-row-${service.id}`} className={service.active ? '' : 'opacity-60'}>
      <TableCell unwrapped>
        {service.deviceTypes.length > 0
          ? service.deviceTypes
              .map((d) => t(`admin.patients.deviceTypeOptions.${d}`, d))
              .join(', ')
          : EMPTY}
      </TableCell>
      <TableCell unwrapped>
        <div className="flex items-center gap-2">
          <Text as="span" size="sm">
            {t(`admin.patients.detail.contractedServicesCard.serviceTypes.${service.serviceCode}`, service.serviceCode)}
          </Text>
          {!service.active && (
            <span className="bg-gray-200 text-gray-700 px-2 py-0.5 rounded-full">
              <Text as="span" size="xs" weight="medium" color="inherit">
                {t('admin.patients.detail.contractedServicesCard.inactiveBadge')}
              </Text>
            </span>
          )}
        </div>
      </TableCell>
      <TableCell data-testid={`contracted-service-providers-${service.id}`}>
        {pair(service.providersNeeded, activeProviders)}
      </TableCell>
      <TableCell data-testid={`contracted-service-hours-${service.id}`}>{pair(service.weeklyHours, service.authorizedHours)}</TableCell>
      <TableCell>
        {service.careLocation
          ? t(`admin.patients.detail.contractedServicesCard.careLocationOptions.${service.careLocation}`, service.careLocation)
          : EMPTY}
      </TableCell>
      <TableCell data-testid={`contracted-service-value-${service.id}`}>{valueDisplay}</TableCell>
      <TableCell>{service.version ?? EMPTY}</TableCell>
      <TableCell>{service.startDate ? new Date(service.startDate).toLocaleDateString() : EMPTY}</TableCell>
      <TableCell>
        {service.contractType
          ? t(`admin.patients.detail.contractedServicesCard.contractTypeOptions.${service.contractType}`, service.contractType)
          : EMPTY}
      </TableCell>
      <TableCell>
        {service.taxCondition
          ? t(`admin.patients.detail.contractedServicesCard.taxConditionOptions.${service.taxCondition}`, service.taxCondition)
          : EMPTY}
      </TableCell>
    </TableRow>
  );
}

export function ServicosContratadosCard({ patient, onSaved }: ServicosContratadosCardProps) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
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

      <Table>
        <TableHeader>
          <TableHead>{t('admin.patients.detail.contractedServicesCard.tableDevice')}</TableHead>
          <TableHead>{t('admin.patients.detail.contractedServicesCard.tableProfessional')}</TableHead>
          <TableHead>{t('admin.patients.detail.contractedServicesCard.tableProvidersNeeded')} / {t('admin.patients.detail.contractedServicesCard.tableProvidersActive')}</TableHead>
          <TableHead>{t('admin.patients.detail.contractedServicesCard.tableWeeklyHours')} / {t('admin.patients.detail.contractedServicesCard.tableAuthorizedHours')}</TableHead>
          <TableHead>{t('admin.patients.detail.contractedServicesCard.tableLocation')}</TableHead>
          <TableHead>{t('admin.patients.detail.contractedServicesCard.tableValue')}</TableHead>
          <TableHead>{t('admin.patients.detail.contractedServicesCard.tableVersion')}</TableHead>
          <TableHead>{t('admin.patients.detail.contractedServicesCard.tableStart')}</TableHead>
          <TableHead>{t('admin.patients.detail.contractedServicesCard.tableContract')}</TableHead>
          <TableHead>{t('admin.patients.detail.contractedServicesCard.tableIVA')}</TableHead>
        </TableHeader>
        <TableBody>
          {services.length === 0 ? (
            <TableRow>
              <TableCell unwrapped colSpan={10} className="py-6 text-center">
                <Text as="span" size="sm" color="secondary">
                  {t('admin.patients.detail.noData')}
                </Text>
              </TableCell>
            </TableRow>
          ) : (
            services.map((svc) => <ServiceRow key={svc.id} service={svc} t={t} />)
          )}
        </TableBody>
      </Table>
    </div>
  );
}
