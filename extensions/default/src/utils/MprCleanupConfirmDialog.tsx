import React, { useEffect } from 'react';
import i18n from '@ohif/i18n';
import { Button } from '@ohif/ui-next';

export type MprCleanupSummary = {
  obsoleteSeries?: number;
  groupsWithDuplicates?: number;
  mprSeriesFound?: number;
  keptSeries?: number;
  derivationResolvedSeries?: number;
  sourceUnresolvedSeries?: number;
  largestDuplicateGroup?: number;
};

type MprCleanupConfirmDialogProps = {
  hide?: () => void;
  summary: MprCleanupSummary;
  onConfirm: () => void;
  onCancel: () => void;
  onDismiss?: () => void;
};

function MprCleanupConfirmDialog({
  summary,
  onConfirm,
  onCancel,
  onDismiss,
}: MprCleanupConfirmDialogProps) {
  useEffect(() => () => onDismiss?.(), [onDismiss]);
  const obsoleteCount = summary.obsoleteSeries ?? 0;
  const groupCount = summary.groupsWithDuplicates ?? 0;
  const mprFound = summary.mprSeriesFound ?? 0;
  const keptCount = summary.keptSeries ?? 0;
  const derivationResolved = summary.derivationResolvedSeries ?? 0;
  const largestGroup = summary.largestDuplicateGroup ?? 0;
  const showLargeGroupHint = obsoleteCount > 100 && largestGroup > 10;

  const handleCancel = () => {
    onCancel();
  };

  const handleConfirm = () => {
    onConfirm();
  };

  return (
    <div className="text-foreground flex w-full max-w-md flex-col gap-4 p-1">
      <p className="text-muted-foreground text-sm leading-relaxed">
        {i18n.t('StudyBrowser:MPR cleanup dialog description', {
          obsoleteCount,
          groupCount,
        })}
      </p>

      <dl className="bg-muted/40 grid grid-cols-2 gap-3 rounded-md border border-white/10 p-3 text-sm">
        <div>
          <dt className="text-muted-foreground">
            {i18n.t('StudyBrowser:MPR cleanup derived series')}
          </dt>
          <dd className="text-lg font-medium">{mprFound}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">
            {i18n.t('StudyBrowser:MPR cleanup duplicate groups')}
          </dt>
          <dd className="text-lg font-medium">{groupCount}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">
            {i18n.t('StudyBrowser:MPR cleanup to remove')}
          </dt>
          <dd className="text-destructive text-lg font-medium">{obsoleteCount}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground">
            {i18n.t('StudyBrowser:MPR cleanup to keep')}
          </dt>
          <dd className="text-lg font-medium">{keptCount}</dd>
        </div>
        <div className="col-span-2">
          <dt className="text-muted-foreground">
            {i18n.t('StudyBrowser:MPR cleanup source resolved')}
          </dt>
          <dd className="text-lg font-medium">
            {derivationResolved} / {mprFound}
          </dd>
        </div>
      </dl>

      {showLargeGroupHint ? (
        <p className="text-amber-400/90 text-xs leading-relaxed">
          {i18n.t('StudyBrowser:MPR cleanup large batch hint', {
            largestGroup,
            obsoleteCount,
          })}
        </p>
      ) : null}

      <p className="text-muted-foreground text-xs">
        {i18n.t('StudyBrowser:MPR cleanup dialog hint')}
      </p>

      <div className="flex justify-end gap-2 pt-1">
        <Button
          type="button"
          variant="outline"
          onClick={handleCancel}
        >
          {i18n.t('StudyBrowser:MPR cleanup cancel')}
        </Button>
        <Button
          type="button"
          variant="destructive"
          onClick={handleConfirm}
        >
          {i18n.t('StudyBrowser:MPR cleanup delete')}
        </Button>
      </div>
    </div>
  );
}

export default MprCleanupConfirmDialog;
