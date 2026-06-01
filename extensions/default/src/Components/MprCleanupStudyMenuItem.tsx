import React, { useSyncExternalStore } from 'react';
import { DropdownMenuItem, Icons } from '@ohif/ui-next';
import i18n from '@ohif/i18n';
import {
  getMprCleanupPhase,
  getMprCleanupProgress,
  getMprCleanupSnapshot,
  isMprCleanupInFlight,
  subscribeMprCleanup,
  MprCleanupPhase,
} from '../utils/mprCleanupState';

const CLEANUP_MENU_ITEM_ID = 'cleanupDuplicateMpr';

function labelForPhase(phase: MprCleanupPhase): string {
  const progress = getMprCleanupProgress();
  switch (phase) {
    case 'collecting':
      return i18n.t('StudyBrowser:MPR cleanup collecting');
    case 'confirming':
      return i18n.t('StudyBrowser:MPR cleanup confirming');
    case 'deleting':
      if (progress && progress.total > 0) {
        return i18n.t('StudyBrowser:MPR cleanup deleting progress', {
          from: progress.batchFrom,
          to: progress.batchTo,
          total: progress.total,
        });
      }
      return i18n.t('StudyBrowser:MPR cleanup deleting');
    default:
      return i18n.t('StudyBrowser:Cleanup duplicate MPR');
  }
}

type MprCleanupStudyMenuItemProps = {
  item: {
    id?: string;
    iconName?: string;
    commands?: string | Record<string, unknown>;
    commandOptions?: Record<string, unknown>;
  };
  commandsManager: AppTypes.CommandsManager;
  [key: string]: unknown;
};

export function isMprCleanupMenuItem(item: { id?: string }): boolean {
  return item?.id === CLEANUP_MENU_ITEM_ID;
}

export default function MprCleanupStudyMenuItem({
  item,
  commandsManager,
  ...rest
}: MprCleanupStudyMenuItemProps) {
  useSyncExternalStore(subscribeMprCleanup, getMprCleanupSnapshot, getMprCleanupSnapshot);
  const phase = getMprCleanupPhase();
  const inFlight = isMprCleanupInFlight();
  const label = labelForPhase(phase);

  return (
    <DropdownMenuItem
      disabled={inFlight}
      onSelect={event => {
        if (inFlight) {
          event.preventDefault();
          return;
        }
        commandsManager.runAsync(item.commands, {
          ...item.commandOptions,
          ...rest,
        });
      }}
      className="gap-[6px]"
    >
      {inFlight ? (
        <Icons.LoadingSpinner className="-ml-1 h-4 w-4 shrink-0 animate-spin" />
      ) : (
        item.iconName && (
          <Icons.ByName
            name={item.iconName}
            className="-ml-1"
          />
        )
      )}
      <span className={inFlight ? 'text-muted-foreground' : undefined}>{label}</span>
    </DropdownMenuItem>
  );
}
