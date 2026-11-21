import { useEffect, useState } from "react";

export function PwaUpdate() {
  const [waiting, setWaiting] = useState<ServiceWorker>();
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
    const workers = navigator.serviceWorker;
    let disposed = false;
    let registration: ServiceWorkerRegistration | undefined;
    let installing: ServiceWorker | null = null;
    let controlled = workers.controller !== null;

    function onControllerChange() {
      if (controlled) window.location.reload();
      controlled = workers.controller !== null;
    }

    function showUpdate() {
      if (registration?.active && registration.waiting)
        setWaiting(registration.waiting);
    }

    function watchInstallation() {
      installing?.removeEventListener("statechange", showUpdate);
      installing = registration?.installing ?? null;
      installing?.addEventListener("statechange", showUpdate);
      showUpdate();
    }

    workers.addEventListener("controllerchange", onControllerChange);
    void workers
      .register("/service-worker.js")
      .then((result) => {
        if (disposed) return;
        registration = result;
        registration.addEventListener("updatefound", watchInstallation);
        watchInstallation();
      })
      .catch(() => {
        // The workspace is still available when service workers are disabled.
      });

    return () => {
      disposed = true;
      workers.removeEventListener("controllerchange", onControllerChange);
      registration?.removeEventListener("updatefound", watchInstallation);
      installing?.removeEventListener("statechange", showUpdate);
    };
  }, []);

  if (!waiting) return null;
  return (
    <aside className="pwa-update" aria-label="Heed update">
      <p role="status">An update is available.</p>
      <button
        type="button"
        className="primary"
        disabled={applying}
        onClick={() => {
          setApplying(true);
          waiting.postMessage("SKIP_WAITING");
        }}
      >
        {applying ? "Updating…" : "Update"}
      </button>
      <button
        type="button"
        className="subtle"
        disabled={applying}
        onClick={() => setWaiting(undefined)}
      >
        Later
      </button>
    </aside>
  );
}
