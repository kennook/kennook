'use client';

interface Props {
  page: number;            // 1-indexed
  hasMore: boolean;
  totalCount?: number;     // optional: exact total when known
  pageSize: number;
  onPageChange: (page: number) => void;
}

export function Pagination({ page, hasMore, totalCount, pageSize, onPageChange }: Props) {
  if (page === 1 && !hasMore) return null;

  const totalPages = totalCount !== undefined
    ? Math.max(1, Math.ceil(totalCount / pageSize))
    : null;
  const start = (page - 1) * pageSize + 1;
  const end = (page - 1) * pageSize + (totalCount !== undefined
    ? Math.min(pageSize, totalCount - (page - 1) * pageSize)
    : pageSize);

  return (
    <div className="flex items-center justify-center gap-3 mt-8 pb-4 text-sm">
      <button
        onClick={() => onPageChange(1)}
        disabled={page <= 1}
        title="Jump to the first page"
        className="px-3 py-1.5 rounded-md text-zinc-200 bg-zinc-900 border border-zinc-800
                   hover:border-zinc-600 disabled:opacity-30 disabled:cursor-not-allowed
                   disabled:hover:border-zinc-800 transition"
      >
        « First
      </button>

      <button
        onClick={() => onPageChange(page - 1)}
        disabled={page <= 1}
        className="px-3 py-1.5 rounded-md text-zinc-200 bg-zinc-900 border border-zinc-800
                   hover:border-zinc-600 disabled:opacity-30 disabled:cursor-not-allowed
                   disabled:hover:border-zinc-800 transition"
      >
        ← Previous
      </button>

      <span className="text-zinc-400 px-2 tabular-nums">
        {totalCount !== undefined ? (
          <>Page {page} of {totalPages} <span className="text-zinc-600 mx-1">·</span> <span className="text-zinc-500">{start}–{Math.max(end, start)} of {totalCount}</span></>
        ) : (
          <>Page {page}</>
        )}
      </span>

      <button
        onClick={() => onPageChange(page + 1)}
        disabled={!hasMore}
        className="px-3 py-1.5 rounded-md text-zinc-200 bg-zinc-900 border border-zinc-800
                   hover:border-zinc-600 disabled:opacity-30 disabled:cursor-not-allowed
                   disabled:hover:border-zinc-800 transition"
      >
        Next →
      </button>

      {/* Jump-to-last only when the total (and thus the last page) is known. */}
      {totalPages !== null && (
        <button
          onClick={() => onPageChange(totalPages)}
          disabled={page >= totalPages}
          title="Jump to the last page"
          className="px-3 py-1.5 rounded-md text-zinc-200 bg-zinc-900 border border-zinc-800
                     hover:border-zinc-600 disabled:opacity-30 disabled:cursor-not-allowed
                     disabled:hover:border-zinc-800 transition"
        >
          Last »
        </button>
      )}
    </div>
  );
}
