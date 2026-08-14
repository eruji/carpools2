# 🚗 Carpool App

[![Build](https://github.com/eruji/carpools2/actions/workflows/docker-build.yml/badge.svg)](https://github.com/eruji/carpools2/actions/workflows/docker-build.yml)
[![Latest build](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fapi.github.com%2Frepos%2Feruji%2Fcarpools2%2Factions%2Fruns%3Fper_page%3D1&query=workflow_runs%5B0%5D.run_number&label=build&prefix=b&color=green)](https://github.com/eruji/carpools2/actions)

Real-time carpool coordination with location tracking, coins economy, and multi-phase session management.

## Setup

```bash
npm install
npm start        # Starts on http://localhost:3000
npm run dev      # Auto-restart on file changes
```

Open `http://localhost:3000` in a browser. Leaflet maps and Socket.IO load from CDN — no build step needed.

## Stack

| Layer | Tech |
|-------|------|
| Backend | Express, better-sqlite3, Socket.IO |
| Auth | express-session + bcryptjs |
| Frontend | Vanilla JS SPA, Leaflet maps |
| Real-time | Socket.IO + browser Geolocation API |

## How It Works

1. **Register** two+ users (or use the test script)
2. **Create a carpool** with pickup/destination coordinates
3. **Invite members** — they accept from the dashboard
4. **Start a session** — driver clicks "I'm Driving!"
5. **Members respond** — driving, riding, skip, or arrived
6. **Phase flow:** Pickup → Destination → Dropoff → Complete
7. **Coins** are distributed when leaving for destination: driver gets +1 per rider, riders pay -1 each
8. **Real-time map** shows member locations and route during active sessions

## API Endpoints

### Auth
- `POST /api/register` — `{ username, email, password }`
- `POST /api/login` — `{ username, password }`
- `POST /api/logout`
- `GET /api/me`

### Carpools
- `GET /api/carpools` — list user's carpools
- `POST /api/carpools` — create `{ name, meetup_name, meetup_lat, meetup_lng, destination_name, destination_lat, destination_lng }` (meetup = pickup point)
- `GET /api/carpools/:id` — detail with members, active session, history
- `PUT /api/carpools/:id` — update (owner only)
- `DELETE /api/carpools/:id` — delete (owner only)

### Members
- `POST /api/carpools/:id/members` — add by username `{ username }` (sends invitation)
- `DELETE /api/carpools/:id/members/:userId`
- `GET /api/users/search?q=` — search users

### Sessions
- `POST /api/carpools/:id/sessions/start` — start a new session
- `POST /api/carpools/:id/sessions/respond` — `{ status: 'driving'|'riding'|'skip'|'arrived' }`
- `POST /api/carpools/:id/sessions/skip-member` — driver skips a pending member `{ userId }`
- `POST /api/carpools/:id/sessions/advance-phase` — `{ phase: 'destination'|'back_to_meetup'|'completed' }`
- `POST /api/carpools/:id/sessions/cancel` — cancel active session
- `PUT /api/carpools/:id/sessions/locations` — update pickup/destination mid-session

### Invitations
- `GET /api/invitations` — pending invitations for current user
- `POST /api/invitations/:id/accept`
- `POST /api/invitations/:id/decline`

## Testing

```bash
node test.js
```

Runs a full end-to-end flow: register two users, create carpool, run through all four phases, and verify coins and history.

## Hosting on Unraid + Cloudflare

### 1. Push to GitHub

Create a private repo on GitHub, then:

```bash
git init
git add .
git commit -m "initial"
git remote add origin git@github.com:YOUR_USER/carpools2.git
git push -u origin main
```

GitHub Actions will auto-build the Docker image and push it to `ghcr.io`.

### 2. On Unraid

```bash
mkdir -p /mnt/user/appdata/carpool
cd /mnt/user/appdata/carpool

# Copy docker-compose.yml and edit the image line
# Change ghcr.io/YOUR_GITHUB_USER/YOUR_REPO:latest
nano docker-compose.yml

# Also set a real SESSION_SECRET
```

Then start:

```bash
docker compose up -d
```

### 3. How auto-updates work

```
You edit locally  →  git push  →  GitHub Actions builds image
                                      ↓
Unraid's Watchtower polls every 5 min  →  pulls new image  →  restarts container
```

Just run `git push` — Unraid updates itself.

### 3. Cloudflare Tunnel (no port forwarding)

Install the `cloudflared` container from Unraid's Community Apps, or run:

```bash
docker run -d --name cloudflared \
  --network host \
  cloudflare/cloudflared:latest tunnel \
  --url http://localhost:3000
```

Then in Cloudflare dashboard:
- Go to **Zero Trust** → **Tunnels**
- Create a tunnel, point it to `http://carpool:3000` (or `localhost:3000` if using host network)
- Assign a public hostname (e.g., `carpool.yourdomain.com`)
- Cloudflare handles SSL automatically

### 4. Docker network (alternative to host network)

Put both containers on the same Docker network:

```yaml
# Add to docker-compose.yml:
networks:
  default:
    name: carpool-net
```

Then connect cloudflared to `carpool-net` and point the tunnel to `http://carpool:3000`.

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Server port |
| `DB_PATH` | `carpool.db` | SQLite database path |
| `SESSION_SECRET` | random | Fixed secret so logins survive restarts |
