import { createRoot } from "react-dom/client";
import { PwaUpdate } from "./PwaUpdate";
import { App } from "./App";
import "./styles.css";
import "./mobile.css";

const root = document.getElementById("root");
if (root) {
  createRoot(root).render(
    <>
      <App />
      <PwaUpdate />
    </>,
  );
}
