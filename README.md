# PokerCrew Server

The complete PokerCrew app: a **web client** (served at `/`) plus the backend — **accounts** (signup, login, sessions, identity), **clubs** (create, join, invite, roles), **live tables** (real-time Hold'em over WebSockets, powered by the engine in `src/engine/`), and the **admin rake dashboard**.

## Web client

Open `http://localhost:3000` after `npm start`. It's a single-page app in `public/` (plain HTML/CSS/JS, no build step) with:

- Sign up / sign in (email code or password), profile with your permanent player ID
- Lobby: your clubs, invitations, create a club, join by code
- Club: members, roles, join requests, invite by player ID, open tables
- Live table: the PokerCrew oval felt, seats around the rail, hole cards, board, bets, timer, fold/check/call/raise slider/all-in, showdown reveal
- Admin (admin role only): rake by club/table/day, full player directory with CSV export, all clubs

The same screens are designed to be ported to React Native for iOS/Android; the API and WebSocket protocol are the contract.

## Quick start (you as owner)

```bash
npm install
npm start
```

1. Open http://localhost:3000 and create your account.
2. Make yourself admin: set the environment variable `ADMIN_EMAILS=you@example.com` (comma-separate several). Any account with that email is admin automatically — on signup or on the next restart.
3. Refresh; an **Admin** tab appears in the bottom nav.
4. Create a club, open a table, and invite people with the club code. Everyone starts with 10,000 play chips.

Dev mode prints one-time login codes to the server console.

## Identity rules

- **Player code** — every account gets a permanent public ID like `PC-8K3F9Q`. Generated with a CSPRNG, guaranteed unique, never reused. Players share this to be invited to clubs.
- **Display name** — chosen once at signup, unique (case-insensitive), and **locked**. There is no player-facing endpoint to change it. Only an `admin` role can override via `/admin/players/:code/display-name`.
- **Email** — required, normalized to lowercase, one account per email, linked one-to-one with the player code.
- **Login** — both methods available: email + 6-digit one-time code (10-min expiry, 5 attempts), or email + password (bcrypt). Passwordless users can add a password later.
- **Sessions** — 30-day JWTs backed by a `sessions` table so they can be revoked on logout.
- Every account starts with 10,000 play-money chips.

## Run

```bash
npm install
npm test                       # run all tests
npm start                      # start on http://localhost:3000 (WebSockets at ws://localhost:3000/ws)
```

Environment variables:

| Var | Default | Notes |
|---|---|---|
| `PORT` | `3000` | |
| `DB_PATH` | `./pokercrew.db` | SQLite file for dev; swap to Postgres for prod |
| `JWT_SECRET` | `dev-secret-change-me` | **Change this in production** |
| `ADMIN_EMAILS` | – | comma-separated emails that get the admin role automatically |
| `BREVO_API_KEY` | – | Brevo transactional email API key; if unset, codes are printed to logs |
| `MAIL_FROM` | – | verified sender address in Brevo, e.g. `hello@pokercrew.co` |
| `MAIL_FROM_NAME` | `PokerCrew` | sender display name |

## API

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/auth/signup/begin` | – | `{ email, displayName, password? }` → emails a code |
| POST | `/auth/signup/complete` | – | `{ email, displayName, code, password? }` → creates account, returns `{ user, token }` |
| POST | `/auth/login/code/request` | – | `{ email }` → emails a login code (silent if unknown email) |
| POST | `/auth/login/code/verify` | – | `{ email, code }` → `{ user, token }` |
| POST | `/auth/login/password` | – | `{ email, password }` → `{ user, token }` |
| POST | `/auth/logout` | Bearer | revokes session |
| GET | `/me` | Bearer | current user |
| POST | `/me/password` | Bearer | `{ password }` → add/replace password |
| GET | `/players/:code` | – | public `{ playerCode, displayName }` |
| POST | `/admin/players/:code/display-name` | Bearer (admin) | override a locked display name |
| GET | `/admin/players` | Bearer (admin) | full directory: player code ↔ email ↔ name, chips, activity. `?search=&limit=&offset=` |
| GET | `/admin/players/:code` | Bearer (admin) | one player in full, including sessions/devices/IPs |
| GET | `/admin/players/export.csv` | Bearer (admin) | download the whole directory as CSV |
| GET | `/health` | – | liveness |

Send `X-Device-Id` on auth requests so sessions can be tied to a device (used later for multi-account detection).

## Clubs

- Every club gets a public **club code** like `CL-7XK2QF` that players use to find and join it.
- **Join modes**: `open` (join instantly), `approval` (default — request, owner/manager approves), `invite_only` (only players invited by their `PC-` code can join).
- **Roles**: `owner` (one per club; full control, can promote managers, transfer, delete), `manager` (approve/reject requests, invite, kick members), `member`.
- Owners can't leave without transferring ownership first. Players can own up to 5 clubs.
- Non-members only see a public card (name, description, member count). Admin can list every club with its owner's email and player code.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/clubs` | Bearer | `{ name, description?, joinMode? }` → create club (you become owner) |
| GET | `/clubs/mine` | Bearer | clubs you belong to, with your role |
| GET | `/clubs/invites` | Bearer | clubs you've been invited to |
| GET | `/clubs/code/:code` | – | public preview of a club by its code |
| POST | `/clubs/code/:code/join` | Bearer | `{ message? }` → `joined` or `pending` depending on join mode |
| GET | `/clubs/:id` | Bearer | club details; members list only if you're a member |
| PATCH | `/clubs/:id` | owner | update name / description / joinMode |
| DELETE | `/clubs/:id` | owner or admin | delete club |
| GET | `/clubs/:id/requests` | owner/manager | pending join requests |
| POST | `/clubs/:id/requests/:code/approve` | owner/manager | approve a request |
| POST | `/clubs/:id/requests/:code/reject` | owner/manager | reject a request |
| POST | `/clubs/:id/invite` | owner/manager | `{ playerCode }` → invite by PC- code |
| POST | `/clubs/:id/members/:code/role` | owner | `{ role: "manager" \| "member" }` |
| DELETE | `/clubs/:id/members/:code` | owner/manager | remove a member (managers can't remove managers) |
| POST | `/clubs/:id/leave` | Bearer | leave (owner must transfer first) |
| POST | `/clubs/:id/transfer` | owner | `{ playerCode }` → hand over ownership |
| GET | `/admin/clubs` | admin | every club with owner identity |

## Live tables

Club owners/managers create tables; club members sit down and play. Each table is a `LiveTable` in memory that runs hands through the engine, enforces a 20-second action timer (auto check/fold), and persists every hand plus its rake.

- **Buy-in** moves chips from the player's balance to their table stack; standing up moves them back.
- A hand starts automatically as soon as 2 players are seated; players who sit mid-hand join the next one.
- Disconnected players keep their seat and get auto-folded by the timer until they return or are removed.
- Every completed hand is stored in `hands` (board, winners, hole cards, per-player net). If rake was taken, a row is added to `rake_ledger`.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/clubs/:id/tables` | owner/manager | `{ name, smallBlind, bigBlind, minBuyin?, maxBuyin?, maxSeats? }` |
| GET | `/clubs/:id/tables` | member | open tables in the club |
| GET | `/tables/:id` | Bearer | table summary + public state |
| POST | `/tables/:id/close` | owner/manager/admin | close table, cash everyone out |

### WebSocket protocol (`/ws`)

Client → server:

```json
{ "type": "auth", "token": "<jwt>" }
{ "type": "join", "tableId": "..." }
{ "type": "sit", "seat": 3, "buyIn": 1000 }
{ "type": "act", "action": "raise", "amount": 60 }   // fold | check | call | bet | raise | allin
{ "type": "leave" }
```

Server → client:

```json
{ "type": "authed", "user": { "playerCode", "displayName" } }
{ "type": "state", "table": { ...public state... }, "you": { "holeCards": [...], "legalActions": [...] } }
{ "type": "hand_started", "handNo": 12 }
{ "type": "hand_complete", "handNo": 12, "board": [...], "winners": [...], "showdown": [...] }
{ "type": "error", "code": "...", "message": "..." }
```

Hole cards are only ever sent to their owner in `you.holeCards`; the public `table` state never contains them.

## Admin rake dashboard

Rake is platform revenue (play-money). Only the `admin` role can read any of this; club owners and players get a 403.

| Method | Path | Purpose |
|---|---|---|
| GET | `/admin/rake/summary?from=&to=` | total rake, raked hands, total hands |
| GET | `/admin/rake/by-club?from=&to=` | rake per club |
| GET | `/admin/rake/by-table?clubId=&from=&to=` | rake per table with avg rake/hand |
| GET | `/admin/rake/daily?days=30` | rake per day |

`from`/`to` are ISO timestamps (e.g. `2026-08-01T00:00:00Z`).

## Email

`ConsoleMailer` prints codes to stdout in dev. For production, implement the `Mailer` interface with a real provider (Resend, Postmark, SES) and pass it to `buildServer`.

## Making yourself admin

There is deliberately no public "become admin" endpoint. After creating your own account, set the role directly in the database once:

```sql
UPDATE users SET role = 'admin' WHERE email = 'you@example.com';
```

## Next

- Tournaments (blind schedules, eliminations, payouts)
- Hand history endpoints for players
- Club alliances (shared player pools across clubs)
- Mobile / web client
