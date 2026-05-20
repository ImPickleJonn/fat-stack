# Fat Stack

Block-puzzle Telegram Mini App. Single-file `index.html` (canvas, plain JS, no build step) + `server.js` (Express + Telegram Stars IAP + bot notifications).

## Run locally

Double-click `RUN.bat`. First run installs deps and opens http://localhost:3000.

## Architecture

- `index.html` — the whole game. Sections marked with `// === SECTION ===` banners. Do NOT introduce bundlers, TypeScript, or module splits.
- `server.js` — Express. Serves the static files, mints Stars invoices, receives `pre_checkout_query` + `successful_payment` webhooks, queues purchases for the client to drain, and runs the outbound-notification cron.
- `privacy.html`, `terms.html` — required for Telegram Mini Apps. Linked from the settings panel.
- `versions/` — snapshots of `index.html` before substantive edits. Naming: `fat-stack-vN.html`, **numeric** sort to find next N (PowerShell `Sort-Object Name` is alphabetical so `v10` sorts before `v9` — use `Sort-Object { [int]($_.BaseName -replace 'fat-stack-v','') }`).

## Env vars

| Var | Required | Notes |
|---|---|---|
| `BOT_TOKEN` | for IAP/notifs | From @BotFather. Without it the app still serves but IAP and notifications are disabled. |
| `PUBLIC_DOMAIN` | for deploy | e.g. `fatstack.up.railway.app` — used to build webhook URL and the "play now" button link. |
| `PORT` | no | Defaults to 3000. |

## After deploying

Register the Telegram webhook once:

```
curl -X POST https://<your-domain>/api/setup-webhook -H "x-setup-key: <BOT_TOKEN>"
```

## Parse-check before commit

```
node -e "const html=require('fs').readFileSync('index.html','utf8'); const m=[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)]; let i=0; for(const s of m){ i++; try { new Function(s[1]); } catch(e) { console.log('FAIL block '+i+': '+e.message); process.exit(1); } } console.log('OK ('+i+' blocks)');"
```

## Localization

20 languages, table lives in `STRINGS` inside `index.html`. Auto-picks from `Telegram.WebApp.initDataUnsafe.user.language_code`, falls back to `navigator.language`, then `en`. Russian (`ru`) is fully translated; `ar` and `he` flip to RTL. Other languages fall back to English at the string level if a key is missing.
