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

export function ProjetoTerapeuticoCard() {
  const { t } = useTranslation();

  return (
    <div className="bg-white rounded-card border-[1.5px] border-gray-700 p-6 sm:px-8 sm:py-10 flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <Heading level={1} as="h3" weight="semibold" color="primary">
          {t('admin.patients.detail.therapeuticProjectCard.title')}
        </Heading>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled onClick={() => {}} className="flex items-center gap-1">
            <Plus className="w-4 h-4" />
            {t('admin.patients.detail.new')}
          </Button>
          <Button variant="outline" size="sm" disabled onClick={() => {}} className="w-28">
            {t('admin.patients.detail.edit')}
          </Button>
        </div>
      </div>

      <div className="flex flex-col gap-2.5">
        {[
          'cid',
          'hypothesis',
          'currentClinicalContext',
          'generalObjective',
          'specificObjectives',
          'activitiesPlan',
          'symptoms',
          'observations',
          'deadlines',
          'pathologyTypes',
        ].map((key) => (
          <Text key={key} size="sm">
            <Text as="span" size="sm" weight="medium" color="secondary">
              {t(`admin.patients.detail.therapeuticProjectCard.${key}`)}:{' '}
            </Text>
            <Text as="span" size="sm" color="muted">—</Text>
          </Text>
        ))}
      </div>

      <div className="mt-4">
        <Text size="sm" weight="semibold" color="secondary" className="mb-2">
          {t('admin.patients.detail.therapeuticProjectCard.tableVersion')}
        </Text>
        <Table>
          <TableHeader>
            <TableHead>{t('admin.patients.detail.therapeuticProjectCard.tableVersion')}</TableHead>
            <TableHead>{t('admin.patients.detail.therapeuticProjectCard.tableAuthor')}</TableHead>
            <TableHead>{t('admin.patients.detail.therapeuticProjectCard.tableStartDate')}</TableHead>
            <TableHead>{t('admin.patients.detail.therapeuticProjectCard.tableEndDate')}</TableHead>
          </TableHeader>
          <TableBody>
            <TableRow>
              <TableCell unwrapped colSpan={4} className="py-6 text-center">
                <Text as="span" size="sm" color="secondary">
                  {t('admin.patients.detail.noData')}
                </Text>
              </TableCell>
            </TableRow>
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
