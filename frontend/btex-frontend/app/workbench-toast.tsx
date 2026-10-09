import { useRef, useState } from "react";
import { Check } from "lucide-react";

export type ToastState = {
  text: string;
  actions?: { label: string; onClick: () => void }[];
  input?: { placeholder: string; onSubmit: (text: string) => void };
} | null;

export type NotifyOptions = {
  actions?: { label: string; onClick: () => void }[];
  input?: { placeholder: string; onSubmit: (text: string) => void };
};

export type NotifyFn = (text: string, opts?: NotifyOptions, ms?: number) => void;

function useWorkbenchToast() {
  const [toast, setToast] = useState<ToastState>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notify: NotifyFn = (s, opts, ms) => {
    if (toastTimerRef.current) {
      clearTimeout(toastTimerRef.current);
      toastTimerRef.current = null;
    }
    setToast({ text: s, actions: opts?.actions, input: opts?.input });
    if (!opts?.input)
      toastTimerRef.current = setTimeout(
        () => {
          setToast(null);
          toastTimerRef.current = null;
        },
        ms ?? (opts?.actions?.length ? 6000 : 2200),
      );
  };
  const dismiss = () => setToast(null);
  return { toast, notify, dismiss };
}

function WorkbenchToast({ toast, onDismiss }: { toast: NonNullable<ToastState>; onDismiss: () => void }) {
  const toastInputRef = useRef<HTMLInputElement>(null);
  return (
    <div className="toast">
      <Check /> <span className="toast-text">{toast.text}</span>
      {toast.input ? (
        <>
          <input
            ref={toastInputRef}
            className="toast-input"
            placeholder={toast.input.placeholder}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                const v = e.currentTarget.value.trim();
                if (v) {
                  const fn = toast.input!.onSubmit;
                  onDismiss();
                  fn(v);
                }
              } else if (e.key === "Escape") onDismiss();
            }}
          />
          <button
            className="toast-action"
            onClick={() => {
              const v = toastInputRef.current?.value?.trim();
              if (v) {
                const fn = toast.input!.onSubmit;
                onDismiss();
                fn(v);
              }
            }}
          >
            提交
          </button>
          <button className="toast-close" onClick={onDismiss} aria-label="关闭">
            ×
          </button>
        </>
      ) : (
        toast.actions?.map((a) => (
          <button
            key={a.label}
            className="toast-action"
            onClick={() => {
              const fn = a.onClick;
              onDismiss();
              fn();
            }}
          >
            {a.label}
          </button>
        ))
      )}
    </div>
  );
}

export { useWorkbenchToast, WorkbenchToast };
