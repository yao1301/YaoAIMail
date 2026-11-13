import ConfirmDialog from '@/components/ConfirmDialog';
import { useConfirmStore } from '@/stores/confirm.store';
export function ComposeWindowConfirm() {
  const { isOpen, title, message, destructive, confirmLabel, cancelLabel, alternateLabel, busy, handleAlternate, handleConfirm, handleCancel } = useConfirmStore();
  if (!isOpen) return null;
  return (
    <ConfirmDialog
      title={title}
      message={message}
      destructive={destructive}
      confirmLabel={confirmLabel}
      cancelLabel={cancelLabel}
      onConfirm={handleConfirm}
      onCancel={handleCancel}
      alternateLabel={alternateLabel}
      busy={busy}
      onAlternate={() => void handleAlternate()}
    />
  );
}
