import { createContext, useCallback, useContext, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";
import { uiSound } from "../audio/ui-sound";

export function Button({ loading, variant, block, children, onClick, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { loading?: boolean; variant?: "ghost"; block?: boolean }) {
  return (
    <button
      {...rest}
      className={["btn", variant, block && "block", rest.className].filter(Boolean).join(" ")}
      disabled={rest.disabled || loading}
      onMouseEnter={() => uiSound.hover()}
      onClick={(e) => {
        uiSound.click();
        onClick?.(e);
      }}
    >
      {loading && <span className="spinner" />}
      {children}
    </button>
  );
}

export function Field({ label, error, hint, ...input }: InputHTMLAttributes<HTMLInputElement> & { label: string; error?: string; hint?: string }) {
  return (
    <label className="field">
      <span className="label">{label}</span>
      <input {...input} aria-invalid={!!error} />
      {error ? <span className="err">{error}</span> : hint ? <span className="hint">{hint}</span> : null}
    </label>
  );
}

interface Toast { id: number; title: string; body: string }
const ToastCtx = createContext<(title: string, body: string) => void>(() => undefined);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((title: string, body: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-2), { id, title, body }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4200);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className="toast panel cut cut-sm">
            <strong>{t.title}</strong>
            {t.body}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}
export const useToast = () => useContext(ToastCtx);

export function Backdrop() {
  return (
    <div className="backdrop" aria-hidden>
      <div className="grid" />
      <div className="sweep" />
      <div className="scan" />
      <div className="vignette" />
    </div>
  );
}
