import { useTranslation } from 'react-i18next';

interface TablePaginationProps {
  currentPage: number;
  totalPages: number;
  totalItems: number;
  itemsPerPage: number;
  startIndex: number;
  endIndex: number;
  onPrevPage: () => void;
  onNextPage: () => void;
  onItemsPerPageChange: (value: number) => void;
}

export const TablePagination = ({
  currentPage,
  totalPages,
  totalItems,
  itemsPerPage,
  startIndex,
  endIndex,
  onPrevPage,
  onNextPage,
  onItemsPerPageChange,
}: TablePaginationProps): JSX.Element => {
  const { t } = useTranslation();

  return (
    <div className="flex items-center justify-end gap-4">
      <div className="relative w-[100px]">
        <select
          value={itemsPerPage}
          onChange={(e) => onItemsPerPageChange(Number(e.target.value))}
          className="w-full px-4 py-2 rounded-[10px] border-[1.5px] border-[#D9D9D9] font-lexend font-medium text-sm text-[#180149] bg-white appearance-none cursor-pointer focus:outline-none focus:ring-0"
        >
          <option value={10}>10</option>
          <option value={20}>20</option>
          <option value={50}>50</option>
          <option value={100}>100</option>
        </select>
        <svg className="absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400 pointer-events-none" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </div>

      <p className="font-lexend font-medium text-[#737373] text-base whitespace-nowrap">
        {t('common.pageRange', { start: startIndex + 1, end: endIndex, total: totalItems })}
      </p>

      <div className="flex items-center gap-2">
        <button
          onClick={onPrevPage}
          disabled={currentPage === 1}
          className="p-2 rounded-lg border-[1.5px] border-[#D9D9D9] bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          aria-label={t('common.previousPage')}
        >
          <svg className="w-5 h-5 text-[#737373]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 19l-7-7 7-7" />
          </svg>
        </button>
        <button
          onClick={onNextPage}
          disabled={currentPage === totalPages}
          className="p-2 rounded-lg border-[1.5px] border-[#D9D9D9] bg-white hover:bg-gray-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          aria-label={t('common.nextPage')}
        >
          <svg className="w-5 h-5 text-[#737373]" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
          </svg>
        </button>
      </div>
    </div>
  );
};
