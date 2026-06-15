import { createRoot } from "react-dom/client";
import { App } from "@/app/app";
import "@/styles.css";
// Side effect: starts tracking the on-screen keyboard (--keyboard-inset).
import "@/lib/keyboard-inset";

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root element #root not found");
}

createRoot(container).render(<App />);
