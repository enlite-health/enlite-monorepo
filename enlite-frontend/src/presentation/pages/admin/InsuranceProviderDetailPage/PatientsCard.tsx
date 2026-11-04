/**
 * PatientsCard — cartão "Pacientes" (spec 058 §4.2, §L): somente leitura. Os pacientes com vínculo VIGENTE a um contrato desta obra
 * social (caso, serviço, contrato, vigência). Vazio e 403 têm mensagem própria — nenhum dos dois pode parecer "carregando".
 * O país do ator recorta a lista no back (`COUNTRY_SCOPE_REQUIRED` quando o ator não tem país).
 */
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import { Text } from '@presentation/components/atoms/Text';
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@presentation/components/atoms/Table';
import { TableSkeleton } from '@presentation/components/ui/skeletons';
import { useActionGate } from '@presentation/hooks/useCellAccess';
import { AdminInsuranceApiService } from '@infrastructure/http/AdminInsuranceApiService';
import { insuranceErrorText } from '@presentation/utils/insuranceErrors';
import { formatCalendarDate } from './calendar';
import { CardMessage, ProviderCard } from './ProviderCard';
import { isForbidden, useCardLoad } from './useCardLoad';

const NS = 'admin.insuranceProviders.patients';

export function PatientsCard({ code }: { code: string }): JSX.Element {
  const { t } = useTranslation();
  const readGate = useActionGate('insurance_provider_patients', 'read');
  const { data, error, loading } = useCardLoad(() => AdminInsuranceApiService.listProviderPatients(code), readGate.allowed, [code]);
  const noRead = readGate.denied || isForbidden(error);
  const items = data ?? [];
  const asOf = items[0]?.asOf;

  return (
    <ProviderCard id="provider-patients-card" title={t(`${NS}.title`)}>
      {noRead ? (
        <CardMessage testId="patients-no-permission">{t(`${NS}.noPermission`)}</CardMessage>
      ) : loading ? (
        <TableSkeleton />
      ) : error ? (
        <CardMessage testId="patients-load-error" tone="error">{insuranceErrorText(t, error)}</CardMessage>
      ) : items.length === 0 ? (
        <CardMessage testId="patients-empty">{t(`${NS}.empty`)}</CardMessage>
      ) : (
        <div className="flex flex-col gap-2" data-testid="patients-table">
          {asOf && <Text as="span" size="xs" color="inherit" className="text-slate-600" data-testid="patients-as-of">{t(`${NS}.asOf`, { asOf: formatCalendarDate(asOf) })}</Text>}
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableHead>{t(`${NS}.columns.case`)}</TableHead>
                <TableHead>{t(`${NS}.columns.service`)}</TableHead>
                <TableHead>{t(`${NS}.columns.contract`)}</TableHead>
                <TableHead>{t(`${NS}.columns.validity`)}</TableHead>
              </TableHeader>
              <TableBody>
                {items.map((p) => (
                  <TableRow key={p.contractedServiceId} clickable={false} data-testid={`patient-row-${p.contractedServiceId}`}>
                    <TableCell unwrapped>
                      <Link to={`/admin/patients/${p.patientId}`} className="text-primary underline text-sm" data-testid={`patient-link-${p.contractedServiceId}`}>
                        {p.caseNumber !== null ? t(`${NS}.caseNumber`, { number: p.caseNumber }) : t(`${NS}.noCase`)}
                      </Link>
                    </TableCell>
                    <TableCell unwrapped><Text as="span" size="xs" color="inherit" className="font-mono text-slate-600" title={p.contractedServiceId}>{p.contractedServiceId.slice(0, 8)}</Text></TableCell>
                    <TableCell unwrapped><Text color="tertiary" as="span" size="sm">{p.contractName}</Text></TableCell>
                    <TableCell unwrapped>
                      <Text color="tertiary" as="span" size="sm">
                        {p.validTo
                          ? t('admin.insuranceProviders.contracts.validityRange', { from: formatCalendarDate(p.validFrom), to: formatCalendarDate(p.validTo) })
                          : t('admin.insuranceProviders.contracts.validityOpen', { from: formatCalendarDate(p.validFrom) })}
                      </Text>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </ProviderCard>
  );
}
