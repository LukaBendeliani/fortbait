# Fortbait Server

Multiplayer game server using geckos.io for real-time UDP/WebRTC communication.

## Deploy to Railway

1. Create new project on Railway
2. Connect this folder as Git repo
3. Railway will auto-detect the Dockerfile
4. Set environment variable:
   - `PORT` — Railway sets this automatically

## Local Development

```bash
npm install
npm run dev
```

Server runs on port 9208 by default.

## Production

The server uses `tsx` to run TypeScript directly:

```bash
npm run start
```

## Docker

```bash
docker build -t fortbait-server .
docker run -p 9208:9208 fortbait-server
```
