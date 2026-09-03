import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import StatusPage from "./StatusPage";

// No router — the app is a single authenticated dashboard shell everywhere
// except this one path, which has to work for a logged-out, never-will-log-in
// visitor (see StatusPage.tsx).
const isStatusPage = window.location.pathname === "/status";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>{isStatusPage ? <StatusPage /> : <App />}</React.StrictMode>
);
