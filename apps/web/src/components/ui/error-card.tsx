import type { ReactNode } from "react";

/** Red callout for run failures and daemon errors. */
export function ErrorCard({ children }: { children: ReactNode }) {
  return (
    <div className="whitespace-pre-wrap wrap-break-word rounded-md border border-del/50 bg-del-bg px-3 py-2.5 text-del">
      {children}
    </div>
  );
}
