interface UpdatePromptProps {
  open: boolean;
  onUpdate: () => void;
  onDismiss: () => void;
}

/** A new shell is installed; reload only when the user says so. */
export function UpdatePrompt({ open, onUpdate, onDismiss }: UpdatePromptProps) {
  if (!open) return null;
  return (
    <div className="update-prompt" role="status" aria-live="polite" data-testid="update-prompt">
      <span className="update-copy">새 버전이 준비되었습니다</span>
      <button type="button" className="primary-btn tiny-btn" onClick={onUpdate}>
        업데이트
      </button>
      <button type="button" className="ghost-btn tiny" onClick={onDismiss} aria-label="나중에">
        나중에
      </button>
    </div>
  );
}
