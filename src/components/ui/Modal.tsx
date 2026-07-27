
import { useEffect, useRef, type ReactNode } from 'react';
import { Icon } from './Icon';
import './modal.css';

interface Props {
  open: boolean;
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}

export function Modal({ open, title, subtitle, onClose, children, footer, width = 520 }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  if (!open) return null;
  return (
    <div className="modal-backdrop no-print" onMouseDown={onClose}>
      <div
        className="modal glass"
        style={{ width }}
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal
      >
        <div className="modal-head">
          <div>
            <h3>{title}</h3>
            {subtitle && <div className="muted" style={{ fontSize: 13 }}>{subtitle}</div>}
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close">
            <Icon name="close" size={18} />
          </button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

interface ConfirmProps {
  open: boolean;
  title: string;
  message: string;
  confirmLabel?: string;
   danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmDialog({
  open, title, message, confirmLabel = 'Confirm', danger, onConfirm, onCancel,
}: ConfirmProps) {
  // Fully keyboard-accessible confirm: the confirm button auto-focuses when the
  // dialog opens, Enter activates it (default/safe action), ←/→ move between the
  // two buttons, and Esc cancels (handled by <Modal>). No mouse required.
  const confirmRef = useRef<HTMLButtonElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (open) setTimeout(() => confirmRef.current?.focus(), 30);
  }, [open]);

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); onConfirm(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); cancelRef.current?.focus(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); confirmRef.current?.focus(); }
  };

  return (
    <Modal
      open={open}
      title={title}
      onClose={onCancel}
      width={420}
      footer={
        <>
          <button ref={cancelRef} className="btn" onClick={onCancel} onKeyDown={onKey}>Cancel</button>
          <button ref={confirmRef} className={danger ? 'btn btn-danger' : 'btn btn-primary'} onClick={onConfirm} onKeyDown={onKey}>
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className="muted" style={{ margin: 0 }}>{message}</p>
    </Modal>
  );
}
