export type DocumentSortField = 'number' | 'created' | 'date';
export type DocumentSortDirection = 'asc' | 'desc';

export function parseDocumentSort(params: URLSearchParams): {
  sortBy: DocumentSortField;
  sortDirection: DocumentSortDirection;
} {
  const field = params.get('sortBy');
  return {
    sortBy: field === 'number' || field === 'date' ? field : 'created',
    sortDirection: params.get('sortDirection') === 'asc' ? 'asc' : 'desc',
  };
}
