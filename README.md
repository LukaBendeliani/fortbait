# 2D Multiplayer Battle Royale

## Deployment

### 1. The Server (PaaS/VPS)
The server uses **Geckos.io** (UDP/WebRTC), which requires a persistent instance and an open port.
- **Recommended**: [Railway.app](https://railway.app/) or [DigitalOcean App Platform](https://www.digitalocean.com/products/app-platform/).
- Use the included `Dockerfile.server`.
- Expose port `9208` (both TCP and UDP).

### 2. The Client (Vercel/Netlify)
The client is a static Vite app.
- Set the `Root Directory` to `packages/client`.
- **Build Command**: `cd ../.. && npm install && npm run build -w @game/shared && cd packages/client && npm run build`
- **Output Directory**: `dist`
- **Environment Variables**:
  - `VITE_SERVER_URL`: The public URL/IP of your deployed server.
  - `VITE_SERVER_PORT`: `9208` (or the port your PaaS provides).

## Local Development
```bash
npm install
npm run build -w @game/shared
npm run dev
```
- Client: http://localhost:3000
- Server: http://localhost:9208
