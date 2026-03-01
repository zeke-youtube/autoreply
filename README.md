# YouTube Auto-Reply Bot

Auto-replies to top-level comments on your own videos using the YouTube Data API v3 (OAuth2) and Groq (OpenAI-compatible).

## File Structure
- `src/index.js` main bot
- `data/replied.json` persisted replied comment IDs
- `data/tokens.json` OAuth tokens (created at first run)
- `data/rate-log.json` reply timestamps for rate limiting
- `.env.example` environment template

## Setup

1) Install deps

```bash
npm install
```

2) Create `.env`

```bash
copy .env.example .env
```

Fill in:
- `GROQ_API_KEY`
- `GROQ_MODEL` (optional)
- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_REDIRECT_URI` (use `http://localhost` for the manual code flow)

3) OAuth setup (Google Cloud Console)

- Create a project
- Enable **YouTube Data API v3**
- Configure OAuth consent screen (External or Internal as appropriate)
- Create OAuth Client ID (Desktop app)
- Add `http://localhost` as an authorized redirect URI
- Copy client ID + secret into `.env`

Required scope:
- `https://www.googleapis.com/auth/youtube.force-ssl`

4) Run

```bash
npm start
```

On first run, the app prints an authorization URL. Open it, approve, and paste the code into the terminal. Tokens are saved to `data/tokens.json`.

## Behavior
- Replies only to **top-level** comments on **your videos**
- Skips if **you already replied** (by `authorChannelId`)
- Skips spam/links/emoji-only
- No rate limit (disabled)
- Random delay 20–90 seconds before each reply
- Never replies twice to same comment (tracked in `data/replied.json`)

## Notes
- Replies use `textOriginal` and are short, casual, human-style.
- If you want to rerun from scratch, delete `data/replied.json`.
- The bot runs every 60 seconds.
