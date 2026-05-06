import { useTranslation } from 'react-i18next';
import { Plus, Search } from 'lucide-react';
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

export function RelatoriosAtendimentosCard() {
  const { t } = useTranslation();

  return (
    <div className="bg-white rounded-card border-[1.5px] border-gray-700 p-6 sm:px-8 sm:py-10 flex flex-col gap-4">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <Heading level={1} as="h3" weight="semibold" color="primary">
          {t('admin.patients.detail.attendanceReportsCard.title')}
        </Heading>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" disabled onClick={() => {}} className="w-28">
            {t('admin.patients.detail.edit')}
          </Button>
          <Button variant="outline" size="sm" disabled onClick={() => {}} className="flex items-center gap-1">
            <Plus className="w-4 h-4" />
            {t('admin.patients.detail.new')}
          </Button>
        </div>
      </div>

      <div className="relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-500 pointer-events-none" />
        <input
          type="text"
          readOnly
          placeholder={t('admin.patients.detail.searchPlaceholder')}
          className="w-full pl-9 pr-4 py-2 border border-gray-300 rounded-lg font-lexend text-sm text-gray-700 bg-gray-50 cursor-default outline-none"
        />
      </div>

      <Table>
        <TableHeader>
          <TableHead>{t('admin.patients.detail.attendanceReportsCard.tableDate')}</TableHead>
          <TableHead>{t('admin.patients.detail.attendanceReportsCard.tableCheckIn')}</TableHead>
          <TableHead>{t('admin.patients.detail.attendanceReportsCard.tableCheckOut')}</TableHead>
          <TableHead>{t('admin.patients.detail.attendanceReportsCard.tableCaregiver')}</TableHead>
          <TableHead>{t('admin.patients.detail.attendanceReportsCard.tableScore')}</TableHead>
          <TableHead>{t('admin.patients.detail.attendanceReportsCard.tableStatus')}</TableHead>
        </TableHeader>
        <TableBody>
          <TableRow>
            <TableCell unwrapped colSpan={6} className="py-6 text-center">
              <Text as="span" size="sm" color="secondary">
                {t('admin.patients.detail.noData')}
              </Text>
            </TableCell>
          </TableRow>
        </TableBody>
      </Table>
    </div>
  );
}
