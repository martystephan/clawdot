import { StrictMode, type ReactNode } from "react";

/** Global providers wrapper. Future homes: error boundary, query client. */
export function AppProvider({ children }: { children: ReactNode }) {
  return <StrictMode>{children}</StrictMode>;
}
