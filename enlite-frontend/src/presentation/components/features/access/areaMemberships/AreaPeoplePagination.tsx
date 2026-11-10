import { TablePagination } from '@presentation/components/molecules/TablePagination';

interface AreaPeoplePaginationProps {
  page: number;
  perPage: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
  onPerPage: (value: number) => void;
}

/**
 * O `TablePagination` da casa. Os ícones (lucide) e o aria-label do seletor foram para o próprio molecule
 * (vale para as 3 telas que o usam). Aqui fica só o que é desta aba: o desenho lê o intervalo
 * ("1 - 20 de N") em #374151 e o molecule o desenha em #737373 — ajuste por seletor, sem mexer nas outras telas.
 */
export function AreaPeoplePagination({ page, perPage, total, onPrev, onNext, onPerPage }: AreaPeoplePaginationProps): JSX.Element {
  const pages = Math.max(1, Math.ceil(total / perPage));
  const start = (page - 1) * perPage;
  return (
    <div data-testid="pagination" className="[&_p]:!text-[#374151]">
      <TablePagination
        currentPage={page}
        totalPages={pages}
        totalItems={total}
        itemsPerPage={perPage}
        startIndex={start}
        endIndex={Math.min(total, start + perPage)}
        onPrevPage={onPrev}
        onNextPage={onNext}
        onItemsPerPageChange={onPerPage}
      />
    </div>
  );
}
