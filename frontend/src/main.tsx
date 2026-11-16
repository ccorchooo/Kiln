import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app/App";
import { applyPalette, clay } from "./theme/themes";
import "./styles.css";

// First paint before /api/public/appearance answers: follow the OS preference.
const prefersDark = matchMedia("(prefers-color-scheme: dark)").matches;
applyPalette(prefersDark ? clay.dark : clay.light, prefersDark ? "dark" : "light");

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);
