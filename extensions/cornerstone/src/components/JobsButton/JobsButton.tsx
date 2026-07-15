import React, { useEffect, useState } from 'react';
import { useSystem } from '@ohif/core';
import { Button, Icons, Popover, PopoverTrigger, PopoverContent } from '@ohif/ui-next';
import { getFunctionsBaseUrl } from '../../../../../platform/app/src/utils/buildFunctionUrl';

const PAGE_SIZE = 5;
// While the popover is open, re-fetch to keep in-progress stage bars live.
const POLL_INTERVAL_MS = 5000;

interface Operation {
  operation_id: string;
  operation_name: string;
  task_name: string;
  study_id: string;
  series_id: string;
  status: string | null;
  created_at: string;
  stage?: number | null;
  stage_count?: number | null;
  stage_label?: string | null;
}

function StageBar({
  stage,
  stageCount,
  stageLabel,
}: {
  stage: number;
  stageCount: number;
  stageLabel?: string | null;
}) {
  return (
    <div className="mt-1">
      <div className="flex gap-0.5">
        {Array.from({ length: stageCount }, (_, i) => i + 1).map(i => (
          <div
            key={i}
            className={`h-1 flex-1 rounded-sm ${
              i < stage ? 'bg-primary-light' : i === stage ? 'bg-primary-main' : 'bg-black'
            }`}
          />
        ))}
      </div>
      {stageLabel ? (
        <div className="mt-0.5 text-center text-[10px] text-white">{stageLabel}</div>
      ) : null}
    </div>
  );
}

const STATUS_LABEL: Record<string, string> = {
  InQueue: 'In Queue',
  InProgress: 'In Progress',
  Completed: 'Completed',
  Failed: 'Failed',
};

const STATUS_COLOR: Record<string, string> = {
  InQueue: 'text-yellow-400',
  InProgress: 'text-blue-400',
  Completed: 'text-green-400',
  Failed: 'text-red-400',
};

function OperationRow({ operation }: { operation: Operation }) {
  const status = operation.status ?? 'Unknown';
  const label = STATUS_LABEL[status] ?? status;
  const color = STATUS_COLOR[status] ?? 'text-white/50';
  const name = operation.task_name
    ? `${operation.operation_name} (${operation.task_name})`
    : operation.operation_name;

  const studyUrl = `${window.location.origin}/segmentation?StudyInstanceUIDs=${operation.study_id}`;

  return (
    <div className="flex items-start gap-2 border-b border-white/10 py-2 last:border-0">
      <div className="mt-0.5 shrink-0">
        <Icons.StatusTracking className="h-4 w-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium text-white">{name}</div>
        <a
          href={studyUrl}
          className="truncate text-xs text-blue-400 underline hover:text-white"
          title={operation.study_id}
          onClick={e => {
            e.preventDefault();
            window.location.href = studyUrl;
          }}
        >
          Study: …{operation.study_id?.slice(-12)}
        </a>
        <div
          className="text-muted-foreground truncate text-xs"
          title={operation.series_id}
        >
          Series: …{operation.series_id?.slice(-12)}
        </div>
        {status === 'InProgress' && operation.stage_count ? (
          <StageBar
            stage={operation.stage ?? 0}
            stageCount={operation.stage_count}
            stageLabel={operation.stage_label}
          />
        ) : null}
      </div>
      <div className={`shrink-0 text-xs font-semibold ${color}`}>{label}</div>
    </div>
  );
}

export function JobsButton() {
  const { extensionManager } = useSystem();
  const [operations, setOperations] = useState<Operation[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(0);
  const [isOpen, setIsOpen] = useState(false);

  const fetchOperations = async () => {
    try {
      setLoading(true);
      const [ds] = extensionManager?.getActiveDataSource?.() ?? [];
      if (!ds) {
        return;
      }
      const config = ds.getConfig?.() ?? {};
      const baseUrl = getFunctionsBaseUrl(config);
      if (!baseUrl) {
        return;
      }

      const bearer = ds?.retrieve?.customClient?.headers?.Authorization;
      const headers = bearer ? { Authorization: bearer } : {};
      const response = await fetch(`${baseUrl}/GetOperations`, { headers });
      if (!response.ok) {
        return;
      }
      const data: Operation[] = await response.json();
      data.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
      setOperations(data);
      setPage(0);
    } catch (e) {
      console.error('Failed to fetch operations:', e);
    } finally {
      setLoading(false);
    }
  };

  const totalPages = Math.ceil((operations?.length ?? 0) / PAGE_SIZE);
  const paginated = operations?.slice(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE) ?? [];

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    const interval = setInterval(fetchOperations, POLL_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [isOpen]);

  return (
    <Popover
      onOpenChange={open => {
        setIsOpen(open);
        if (open) {
          fetchOperations();
        }
      }}
    >
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="hover:bg-primary-dark"
          title="Operations"
        >
          <Icons.ListView className="h-5 w-5" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={8}
        className="w-80 p-0"
      >
        <div className="bg-primary-dark rounded-md p-3">
          <div className="mb-2 flex items-center justify-between">
            <span className="text-sm font-semibold text-white">Operations</span>
            <button
              className="text-muted-foreground text-xs hover:text-white"
              onClick={fetchOperations}
            >
              {loading ? 'Loading…' : 'Refresh'}
            </button>
          </div>

          {loading && operations === null ? (
            <div className="text-muted-foreground py-4 text-center text-sm">Loading…</div>
          ) : !operations?.length ? (
            <div className="text-muted-foreground py-4 text-center text-sm">No operations yet</div>
          ) : (
            <>
              <div>
                {paginated.map(op => (
                  <OperationRow
                    key={op.operation_id}
                    operation={op}
                  />
                ))}
              </div>

              {totalPages > 1 && (
                <div className="mt-2 flex items-center justify-between">
                  <button
                    className="text-muted-foreground text-xs hover:text-white disabled:opacity-30"
                    onClick={() => setPage(p => p - 1)}
                    disabled={page === 0}
                  >
                    ← Prev
                  </button>
                  <span className="text-muted-foreground text-xs">
                    {page + 1} / {totalPages}
                  </span>
                  <button
                    className="text-muted-foreground text-xs hover:text-white disabled:opacity-30"
                    onClick={() => setPage(p => p + 1)}
                    disabled={page >= totalPages - 1}
                  >
                    Next →
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}

export default JobsButton;
