const escaped: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function html(value: string) {
  return value.replace(/[&<>"']/g, (char) => escaped[char]);
}

export function consentPage(
  client: string,
  redirectUri: string,
  workspace: string,
  csrf: string,
) {
  const callback = new URL(redirectUri);
  return new Response(
    `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Connect an app | Heed</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100dvh; display: grid; place-items: center; padding: 24px; background: #f2f5f0; color: #172b27; font: 16px/1.5 system-ui, sans-serif; }
  main { width: min(100%, 520px); padding: clamp(20px, 5vw, 36px); background: #fff; border: 1px solid #d8e2db; border-radius: 18px; }
  h1 { margin: 0; font-size: 28px; line-height: 1.2; letter-spacing: -.03em; }
  p { margin: 12px 0 20px; color: #415b53; overflow-wrap: anywhere; }
  label, legend { font-weight: 650; }
  legend { padding: 0; }
  input[name=label] { display: block; width: 100%; margin: 6px 0 20px; padding: 9px 12px; border: 1px solid #9bb0a5; border-radius: 8px; font: inherit; }
  fieldset { border: 0; margin: 0; padding: 0; min-width: 0; }
  .option { display: block; padding: 10px 12px; margin-top: 8px; background: #f2f5f0; border-radius: 8px; }
  .option small { display: block; margin-left: 23px; color: #415b53; font-weight: 400; }
  .option .warning { color: #824414; }
  .actions { display: flex; flex-wrap: wrap; justify-content: flex-end; gap: 8px; margin-top: 24px; }
  button { min-height: 42px; padding: 7px 16px; border: 1px solid #9bb0a5; border-radius: 8px; background: #fff; color: #172b27; font: inherit; font-weight: 650; cursor: pointer; }
  button[value=approve] { background: #245448; border-color: #245448; color: #fff; }
</style>
<main>
  <h1>Connect an app</h1>
  <p><strong>${html(client)}</strong> (${html(callback.origin)}) is requesting access to workspace <strong>${html(workspace)}</strong>.</p>
  <form method="post" action="/auth/mcp/authorize">
    <input type="hidden" name="csrf" value="${csrf}">
    <label>Agent label
      <input name="label" maxlength="200" required value="${html(client)}">
    </label>
    <fieldset>
      <legend>Access</legend>
      <label class="option"><input type="radio" name="scope" value="report" checked> Report
        <small>View the canvas, report progress, and flag handoffs.</small>
      </label>
      <label class="option"><input type="radio" name="scope" value="steer"> Steer
        <small class="warning">Also lets this app replace workspace guidance and change protected item fields. Choose this only for an app you trust to steer your work.</small>
      </label>
    </fieldset>
    <div class="actions">
      <button name="decision" value="deny" formnovalidate>Cancel</button>
      <button name="decision" value="approve">Connect app</button>
    </div>
  </form>
</main>
</html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": `default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; form-action 'self' ${callback.origin}; base-uri 'none'`,
        "Cache-Control": "no-store",
        "Referrer-Policy": "strict-origin",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
