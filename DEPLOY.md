# Deployment Guide

This app uses a custom Node HTTP server (`server.ts`) to co-host Next.js + Socket.io. It **cannot** be deployed on Vercel or Netlify (serverless — no persistent WebSocket connections).

## Recommended: Railway (~$5/month)

### 1. Push to GitHub
Make sure your repo is on GitHub (public or private).

### 2. Create a Railway project
1. Go to [railway.app](https://railway.app) → **New Project** → **Deploy from GitHub repo**
2. Select this repo
3. Railway auto-detects Node.js

### 3. Set environment variables
In Railway → your service → **Variables**, add:
```
NEXT_PUBLIC_SUPABASE_URL=<your supabase project URL>
NEXT_PUBLIC_SUPABASE_ANON_KEY=<your supabase anon key>
SUPABASE_SERVICE_ROLE_KEY=<your supabase service role key>
NODE_ENV=production
```

Railway injects `PORT` automatically — the server already reads it.

### 4. Build & start commands (auto-detected, but verify)
- **Build**: `npm run build`
- **Start**: `npm start`

### 5. Update Supabase auth settings
In your Supabase dashboard → **Authentication** → **URL Configuration**:
- **Site URL**: `https://<your-railway-domain>`
- **Redirect URLs**: add `https://<your-railway-domain>/**`

### 6. Share with friends
Send them the Railway URL. On mobile they can tap **Share → Add to Home Screen** to install it as a PWA (landscape, full-screen, no browser chrome).

---

## Alternative platforms

| Platform | Cost | Notes |
|---|---|---|
| Render | $7/month | Free tier spins down after inactivity — bad for a live game |
| Fly.io | ~$2–5/month | More setup; good if you want Docker control |
| DigitalOcean App Platform | $5/month | Works well, same approach |
| Any VPS (Hetzner, DO Droplet) | €4–6/month | Full control; run `npm run build && npm start` |

## Local network play (no cloud)

If all players are on the same Wi-Fi, you can skip deployment entirely:

1. Run `npm run build && npm start` on the host machine
2. Find the host's local IP: `ipconfig` → IPv4 address (e.g. `192.168.1.X`)
3. Players open `http://192.168.1.X:3000` on their phones

You may need to allow port 3000 through Windows Firewall.
