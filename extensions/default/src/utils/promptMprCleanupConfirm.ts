import i18n from '@ohif/i18n';
import MprCleanupConfirmDialog, { MprCleanupSummary } from './MprCleanupConfirmDialog';

const DIALOG_ID = 'mpr-cleanup-confirm';

export type MprCleanupConfirmResult = 'delete' | 'cancel';

export function promptMprCleanupConfirm({
  uiDialogService,
  summary,
}: {
  uiDialogService: AppTypes.UIDialogService;
  summary: MprCleanupSummary;
}): Promise<MprCleanupConfirmResult> {
  return new Promise(resolve => {
    let settled = false;
    const settle = (result: MprCleanupConfirmResult) => {
      if (settled) {
        return;
      }
      settled = true;
      uiDialogService.hide(DIALOG_ID);
      resolve(result);
    };

    uiDialogService.show({
      id: DIALOG_ID,
      title: i18n.t('StudyBrowser:MPR cleanup dialog title'),
      content: MprCleanupConfirmDialog,
      shouldCloseOnEsc: true,
      shouldCloseOnOverlayClick: false,
      contentProps: {
        summary,
        onConfirm: () => settle('delete'),
        onCancel: () => settle('cancel'),
        onDismiss: () => settle('cancel'),
      },
    });
  });
}
