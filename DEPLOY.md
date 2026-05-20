# Fat Stack — Deploy & Bot Setup

Step-by-step to get this from `localhost:3000` into a live Telegram Mini App. Same flow you've used for Match Icon, abbreviated for Fat Stack.

## 1. Create the Telegram bot

Open [@BotFather](https://t.me/BotFather) in Telegram and run:

```
/newbot
```

Pick a name (e.g. **Fat Stack**) and a username ending in `bot` (e.g. `FatStackGameBot` or `fat_stack_game_bot`).

BotFather replies with a token like `1234567890:AAH...`. **Copy it** — that's your `BOT_TOKEN`.

Then in the same BotFather chat:

```
/setdescription
```
→ pick your bot → paste:
> Stack the blocks. Clear the lines. Smash high scores. Daily challenges + weekly tournaments. Stars-only, no ads.

```
/setabouttext
```
→ pick your bot → paste:
> Block puzzle. No ads. Just stack.

```
/setuserpic
```
→ upload a square logo (PNG, 640×640). You can put together a quick one later — not blocking.

## 2. Push to GitHub

From `C:\Users\jonnw\Desktop\fat-stack-project`:

```
git init
git add .
git commit -m "Fat Stack v0.2 — tabs (Shop/Home/Earn), missions, daily chest"
gh repo create fat-stack --public --source=. --remote=origin --push
```

(`gh repo create` does the GitHub-side create + first push in one shot. If you'd rather create it via the web UI, do that, then `git remote add origin <url> && git push -u origin main`.)

## 3. Deploy

You've got two configs already in the repo — pick whichever host you prefer:

### Option A — Railway (where Match Icon lives)

1. [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo** → pick `fat-stack`.
2. Railway reads `railway.json`, provisions the service.
3. In **Variables**, set:
   - `BOT_TOKEN` = the token from step 1
   - (Railway auto-injects `RAILWAY_PUBLIC_DOMAIN` — `server.js` reads it)
4. Railway gives you a URL like `https://fat-stack-production.up.railway.app`.

### Option B — Render

1. [render.com](https://render.com) → **New +** → **Blueprint** → pick `fat-stack`.
2. Render reads `render.yaml`, provisions the service.
3. In **Environment**, set:
   - `BOT_TOKEN` = the token from step 1
4. Render gives you a URL like `https://fat-stack-XXXX.onrender.com`.

## 4. Register the Telegram webhook

Once your service is up, hit the setup endpoint once (the bot token doubles as the setup key — only you have it):

```
curl -X POST https://<your-deploy-url>/api/setup-webhook \
  -H "x-setup-key: <BOT_TOKEN>"
```

Expect a 200 response with `{ webhook_url, telegram: { ok: true } }`. After this, Telegram will start delivering `pre_checkout_query`, `successful_payment`, and `/start` updates to your server.

To confirm later:
```
curl -X POST https://<your-deploy-url>/api/webhook-info \
  -H "x-setup-key: <BOT_TOKEN>"
```

## 5. Register the Mini App URL with BotFather

Back in @BotFather:

```
/newapp
```

Pick your bot. Then:
- **Title:** Fat Stack
- **Description:** Stack the blocks. Clear the lines. Smash high scores.
- **Photo:** square 640×640 logo
- **Demo GIF:** optional, can add later
- **Web App URL:** `https://<your-deploy-url>/`
- **Short name:** `play` (so the launch link becomes `t.me/YourBot/play`)

Then `/setmenubutton` → pick your bot → set:
- **Button text:** `▶️ Play Fat Stack`
- **Web App URL:** `https://<your-deploy-url>/`

This makes the blue "Open" button appear at the bottom of every chat with the bot.

## 6. Test it

Open `t.me/<YourBotUsername>` in Telegram. Tap **/start** (or the blue button). You should see the welcome message and an inline `▶️ PLAY FAT STACK` button. Tap it. The Mini App opens. Stack blocks. Try a Stars purchase (1⭐ if you set up a test SKU, or 30⭐ for a real revive).

## 7. After-deploy gotchas (carried over from Match Icon)

- **`npm ci` requires `package-lock.json` to be in sync.** If you `npm install` a new dependency, commit the updated lockfile in the SAME push. Otherwise the build fails with `Missing: <pkg>@<ver> from lock file`.
- **iOS haptics may not fire.** Match Icon hit this; Android works fine. Pickle's call: leave for now.
- **Old Telegram WebView on Android** drops `flex:` shorthand and `height: 100%` on absolutely-positioned children. Use longhand + explicit pixel heights. Already followed in Fat Stack's CSS.
- **WebView backgrounding pauses `performance.now()`** — Fat Stack uses it only for the spring-animation delta (fine to pause when invisible) and `Date.now()` for actual wall-clock things (streak deadline).

## Quick reference

| What | Where |
|---|---|
| Bot token | @BotFather |
| Env var | `BOT_TOKEN` |
| Webhook setup | `POST /api/setup-webhook` with `x-setup-key: <BOT_TOKEN>` |
| Local dev | `RUN.bat` → `localhost:3000` |
| Parse-check | see `README.md` |
| Snapshot before edits | `versions/fat-stack-vN.html` (numeric sort) |
