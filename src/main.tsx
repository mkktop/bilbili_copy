import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { UpdateProvider } from "./contexts/UpdateContext";
import { ToastProvider } from "./components/Toast";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <UpdateProvider>
      <ToastProvider>
        <App />
      </ToastProvider>
    </UpdateProvider>
  </React.StrictMode>,
);
