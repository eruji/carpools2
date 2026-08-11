const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const path = require('path');
const { execSync } = require('child_process');
const pkg = require('./package.json');

// In Docker these come from build args; locally derive them from git
function gitBuildInfo() {
  try {
    return {
      sha: execSync('git rev-parse HEAD', { cwd: __dirname }).toString().trim(),
      num: execSync('git rev-list --count HEAD', { cwd: __dirname }).toString().trim()
    };
  } catch (e) {
    return { sha: null, num: null };
  }
}

// ── App Setup ────────────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const io = new Server(server);
const dbPath = process.env.DB_PATH || 'carpool.db';
const db = new Database(dbPath);

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Database Schema ──────────────────────────────────────────────────────────
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS carpools (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    owner_id INTEGER NOT NULL REFERENCES users(id),
    meetup_name TEXT DEFAULT '',
    meetup_lat REAL DEFAULT 0,
    meetup_lng REAL DEFAULT 0,
    meetup_nickname TEXT DEFAULT '',
    destination_name TEXT DEFAULT '',
    destination_lat REAL DEFAULT 0,
    destination_lng REAL DEFAULT 0,
    destination_nickname TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS carpool_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    carpool_id INTEGER NOT NULL REFERENCES carpools(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    coins_balance INTEGER DEFAULT 0,
    joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(carpool_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS carpool_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    carpool_id INTEGER NOT NULL REFERENCES carpools(id) ON DELETE CASCADE,
    driver_id INTEGER REFERENCES users(id),
    phase TEXT DEFAULT 'idle',
    started_at DATETIME,
    ended_at DATETIME,
    meetup_lat REAL,
    meetup_lng REAL,
    meetup_name TEXT,
    destination_lat REAL,
    destination_lng REAL,
    destination_name TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS session_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id INTEGER NOT NULL REFERENCES carpool_sessions(id) ON DELETE CASCADE,
    user_id INTEGER NOT NULL REFERENCES users(id),
    status TEXT DEFAULT 'pending',
    location_lat REAL,
    location_lng REAL,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(session_id, user_id)
  );

  CREATE TABLE IF NOT EXISTS carpool_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    carpool_id INTEGER NOT NULL REFERENCES carpools(id),
    session_id INTEGER NOT NULL REFERENCES carpool_sessions(id),
    phase TEXT NOT NULL,
    driver_id INTEGER REFERENCES users(id),
    event TEXT NOT NULL,
    coins_data TEXT DEFAULT '{}',
    mileage REAL DEFAULT 0,
    details TEXT DEFAULT '',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS invitations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    carpool_id INTEGER NOT NULL REFERENCES carpools(id) ON DELETE CASCADE,
    invited_user_id INTEGER NOT NULL REFERENCES users(id),
    invited_by INTEGER NOT NULL REFERENCES users(id),
    status TEXT DEFAULT 'pending',
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS carpool_locations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    carpool_id INTEGER NOT NULL REFERENCES carpools(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    address TEXT DEFAULT '',
    lat REAL DEFAULT 0,
    lng REAL DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);

// ── Migrations (existing databases) ────────────────────────────────────────
const carpoolCols = db.prepare('PRAGMA table_info(carpools)').all().map(c => c.name);
if (!carpoolCols.includes('meetup_nickname')) {
  db.exec("ALTER TABLE carpools ADD COLUMN meetup_nickname TEXT DEFAULT ''");
}
if (!carpoolCols.includes('destination_nickname')) {
  db.exec("ALTER TABLE carpools ADD COLUMN destination_nickname TEXT DEFAULT ''");
}
if (!carpoolCols.includes('invite_code')) {
  db.exec("ALTER TABLE carpools ADD COLUMN invite_code TEXT DEFAULT ''");
}
if (!carpoolCols.includes('arrival_radius')) {
  db.exec('ALTER TABLE carpools ADD COLUMN arrival_radius REAL DEFAULT 400');
}
// Repair any member statuses that were accidentally set to NULL by old location updates
db.exec("UPDATE session_members SET status='pending' WHERE status IS NULL");
// Track geo-fence (automatic) arrivals
const smCols = db.prepare('PRAGMA table_info(session_members)').all().map(c => c.name);
if (!smCols.includes('auto_arrived')) {
  db.exec('ALTER TABLE session_members ADD COLUMN auto_arrived INTEGER DEFAULT 0');
}

// ── Invite code generator ───────────────────────────────────────────────────
function generateInviteCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no ambiguous chars
  let code = '';
  for (let i = 0; i < 8; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

// ── Prepared Statements ─────────────────────────────────────────────────────
const stmts = {
  // Users
  userById: db.prepare('SELECT id, username, email, created_at FROM users WHERE id = ?'),
  userByUsername: db.prepare('SELECT * FROM users WHERE username = ?'),
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  createUser: db.prepare('INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)'),
  searchUsers: db.prepare('SELECT id, username, email FROM users WHERE (username LIKE ? OR email LIKE ?) AND id != ? LIMIT 20'),

  // Carpools
  createCarpool: db.prepare('INSERT INTO carpools (name, owner_id, meetup_name, meetup_lat, meetup_lng, meetup_nickname, destination_name, destination_lat, destination_lng, destination_nickname, invite_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'),
  carpoolById: db.prepare('SELECT * FROM carpools WHERE id = ?'),
  carpoolsByUser: db.prepare(`
    SELECT c.*, cm.coins_balance,
      (SELECT COUNT(*) FROM carpool_members WHERE carpool_id = c.id) AS member_count
    FROM carpools c
    JOIN carpool_members cm ON cm.carpool_id = c.id
    WHERE cm.user_id = ?
    ORDER BY c.created_at DESC
  `),
  updateCarpool: db.prepare('UPDATE carpools SET name=?, meetup_name=?, meetup_lat=?, meetup_lng=?, meetup_nickname=?, destination_name=?, destination_lat=?, destination_lng=?, destination_nickname=?, arrival_radius=? WHERE id=?'),
  deleteCarpool: db.prepare('DELETE FROM carpools WHERE id=?'),

  // Members
  addMember: db.prepare('INSERT OR IGNORE INTO carpool_members (carpool_id, user_id) VALUES (?, ?)'),
  removeMember: db.prepare('DELETE FROM carpool_members WHERE carpool_id=? AND user_id=?'),
  carpoolMembers: db.prepare(`
    SELECT u.id, u.username, u.email, cm.coins_balance, cm.joined_at
    FROM carpool_members cm
    JOIN users u ON u.id = cm.user_id
    WHERE cm.carpool_id = ?
    ORDER BY cm.coins_balance ASC, u.username COLLATE NOCASE ASC
  `),
  isMember: db.prepare('SELECT * FROM carpool_members WHERE carpool_id=? AND user_id=?'),
  updateCoins: db.prepare('UPDATE carpool_members SET coins_balance = coins_balance + ? WHERE carpool_id=? AND user_id=?'),

  // Sessions
  createSession: db.prepare('INSERT INTO carpool_sessions (carpool_id, driver_id, phase, started_at, meetup_lat, meetup_lng, meetup_name, destination_lat, destination_lng, destination_name) VALUES (?, ?, ?, datetime(\'now\'), ?, ?, ?, ?, ?, ?)'),
  activeSession: db.prepare(`
    SELECT * FROM carpool_sessions
    WHERE carpool_id = ? AND phase != 'idle' AND phase != 'completed'
    ORDER BY created_at DESC LIMIT 1
  `),
  latestSession: db.prepare('SELECT * FROM carpool_sessions WHERE carpool_id=? ORDER BY created_at DESC LIMIT 1'),
  updateSessionPhase: db.prepare('UPDATE carpool_sessions SET phase=?, ended_at=CASE WHEN ? = \'completed\' THEN datetime(\'now\') ELSE ended_at END WHERE id=?'),
  updateSessionDriver: db.prepare('UPDATE carpool_sessions SET driver_id=? WHERE id=?'),
  updateSessionLocations: db.prepare('UPDATE carpool_sessions SET meetup_lat=?, meetup_lng=?, meetup_name=?, destination_lat=?, destination_lng=?, destination_name=? WHERE id=?'),

  // Session Members
  addSessionMember: db.prepare('INSERT OR IGNORE INTO session_members (session_id, user_id, status) VALUES (?, ?, ?)'),
  updateSessionMember: db.prepare('UPDATE session_members SET status=COALESCE(?, status), location_lat=COALESCE(?, location_lat), location_lng=COALESCE(?, location_lng), updated_at=datetime(\'now\') WHERE session_id=? AND user_id=?'),
  sessionMembers: db.prepare(`
    SELECT sm.*, u.username FROM session_members sm
    JOIN users u ON u.id = sm.user_id
    WHERE sm.session_id = ?
  `),
  sessionMemberByUser: db.prepare('SELECT * FROM session_members WHERE session_id=? AND user_id=?'),

  // History
  addHistory: db.prepare('INSERT INTO carpool_history (carpool_id, session_id, phase, driver_id, event, coins_data, mileage, details) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
  carpoolHistory: db.prepare(`
    SELECT h.*, u.username as driver_name FROM carpool_history h
    LEFT JOIN users u ON u.id = h.driver_id
    WHERE h.carpool_id = ?
    ORDER BY h.created_at DESC LIMIT 100
  `),

  // Invitations
  createInvitation: db.prepare('INSERT OR IGNORE INTO invitations (carpool_id, invited_user_id, invited_by) VALUES (?, ?, ?)'),
  pendingInvitations: db.prepare(`
    SELECT i.*, c.name as carpool_name, u.username as invited_by_name
    FROM invitations i
    JOIN carpools c ON c.id = i.carpool_id
    JOIN users u ON u.id = i.invited_by
    WHERE i.invited_user_id = ? AND i.status = 'pending'
  `),
  acceptInvitation: db.prepare('UPDATE invitations SET status=\'accepted\' WHERE id=? AND invited_user_id=?'),
  declineInvitation: db.prepare('UPDATE invitations SET status=\'declined\' WHERE id=? AND invited_user_id=?'),
};

// ── Middleware ───────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
// Never cache the HTML shell or styles so UI updates appear immediately
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html') || req.path.endsWith('.css') || req.path.endsWith('.js')) {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  }
  next();
});
app.use(express.static(path.join(__dirname, 'public')));
app.use(session({
  secret: process.env.SESSION_SECRET || 'carpool-secret-change-in-production-' + Math.random().toString(36),
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 } // 7 days
}));

// Cloudflare Access auto-login — trust the email header Cloudflare adds after
// the user passes an Access policy. Safe because the origin is only reachable
// through the tunnel (Cloudflare validates and strips these headers).
app.use((req, res, next) => {
  const cfEmail = req.headers['cf-access-authenticated-user-email'];
  if (cfEmail && typeof cfEmail === 'string' && cfEmail.trim()) {
    const email = cfEmail.trim().toLowerCase();
    let user = stmts.userByEmail.get(email);
    if (!user) {
      // Auto-register: email local part as username, random password (Access handles auth)
      let username = (email.split('@')[0] || 'user').replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 20) || 'user';
      let candidate = username, n = 2;
      while (stmts.userByUsername.get(candidate)) { candidate = username + n; n++; }
      const hash = bcrypt.hashSync(Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2), 10);
      const result = stmts.createUser.run(candidate, email, hash);
      user = stmts.userById.get(result.lastInsertRowid);
    }
    req.session.userId = user.id;
  }
  next();
});

function requireAuth(req, res, next) {
  if (!req.session.userId) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  next();
}

// ── Auth Routes ─────────────────────────────────────────────────────────────
app.post('/api/register', (req, res) => {
  try {
    const { username, email, password } = req.body;
    if (!username || !email || !password) {
      return res.status(400).json({ error: 'All fields required' });
    }
    if (password.length < 4) {
      return res.status(400).json({ error: 'Password must be at least 4 characters' });
    }
    if (stmts.userByUsername.get(username)) {
      return res.status(409).json({ error: 'Username taken' });
    }
    if (stmts.userByEmail.get(email)) {
      return res.status(409).json({ error: 'Email already registered' });
    }
    const hash = bcrypt.hashSync(password, 10);
    const result = stmts.createUser.run(username, email, hash);
    req.session.userId = result.lastInsertRowid;
    res.json({ ok: true, user: { id: result.lastInsertRowid, username, email } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/login', (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password required' });
    }
    const user = stmts.userByUsername.get(username);
    if (!user || !bcrypt.compareSync(password, user.password_hash)) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    req.session.userId = user.id;
    res.json({ ok: true, user: { id: user.id, username: user.username, email: user.email } });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ ok: true });
});

// Forgot password — verifies username + email, then issues a temporary password
app.post('/api/forgot-password', (req, res) => {
  try {
    const { username, email } = req.body;
    if (!username || !email) return res.status(400).json({ error: 'Username and email required' });
    const user = stmts.userByUsername.get(username.trim());
    if (!user || user.email.toLowerCase() !== email.trim().toLowerCase()) {
      return res.status(404).json({ error: 'No account matches that username and email' });
    }
    const temp = Math.random().toString(36).slice(2, 10); // 8-char temporary password
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(bcrypt.hashSync(temp, 10), user.id);
    res.json({ ok: true, username: user.username, tempPassword: temp });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/me', (req, res) => {
  if (!req.session.userId) return res.json({ user: null });
  const user = stmts.userById.get(req.session.userId);
  res.json({ user });
});

// Version info — lets you verify the running build is up to date
app.get('/api/version', (req, res) => {
  const git = gitBuildInfo();
  res.json({
    version: pkg.version,
    build: process.env.BUILD_SHA || git.sha,
    buildNum: process.env.BUILD_NUM || git.num,
    builtAt: process.env.BUILD_TIME || null
  });
});

// Update profile (name / email)
app.put('/api/profile', requireAuth, (req, res) => {
  try {
    const { username, email } = req.body;
    const user = stmts.userById.get(req.session.userId);
    if (!user) return res.status(404).json({ error: 'Not found' });
    const newUsername = (username || user.username).trim();
    const newEmail = (email || user.email).trim();
    if (!newUsername || !newEmail) return res.status(400).json({ error: 'Name and email required' });
    if (newUsername !== user.username && stmts.userByUsername.get(newUsername)) {
      return res.status(409).json({ error: 'Username taken' });
    }
    if (newEmail !== user.email && stmts.userByEmail.get(newEmail)) {
      return res.status(409).json({ error: 'Email already registered' });
    }
    db.prepare('UPDATE users SET username=?, email=? WHERE id=?').run(newUsername, newEmail, user.id);
    res.json({ ok: true, user: stmts.userById.get(user.id) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Change password (requires current password)
app.put('/api/profile/password', requireAuth, (req, res) => {
  try {
    const { current, next } = req.body;
    if (!current || !next) return res.status(400).json({ error: 'Current and new password required' });
    if (next.length < 4) return res.status(400).json({ error: 'Password must be at least 4 characters' });
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.session.userId);
    if (!user || !bcrypt.compareSync(current, user.password_hash)) {
      return res.status(403).json({ error: 'Current password is incorrect' });
    }
    const hash = bcrypt.hashSync(next, 10);
    db.prepare('UPDATE users SET password_hash=? WHERE id=?').run(hash, user.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Admin debug page (password protected) ───────────────────────────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admin123';
const ADMIN_TABLES = ['users', 'carpools', 'carpool_members', 'carpool_sessions', 'session_members', 'carpool_history', 'carpool_locations', 'invitations'];

app.get('/admin/logout', (req, res) => {
  req.session.isAdmin = false;
  res.redirect('/admin');
});

app.get('/admin', (req, res) => {
  if (req.session.isAdmin) return renderAdminPage(res);
  res.send(`<!DOCTYPE html><html><head><title>Vroommates Admin</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>body{font-family:system-ui;background:#F5F5F1;color:#333;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
    form{background:#fff;border:1px solid #ddd;border-radius:12px;padding:24px;width:280px;box-shadow:0 4px 16px rgba(0,0,0,0.08)}
    h2{margin:0 0 4px;font-size:1.2rem}
    input{width:100%;padding:10px;margin:10px 0 14px;border:1px solid #ccc;border-radius:8px;font-size:1rem;box-sizing:border-box}
    button{width:100%;padding:12px;background:#7C9A77;color:#fff;border:none;border-radius:8px;font-size:1rem;cursor:pointer}
    .err{color:#B07166;font-size:0.85rem}</style></head>
    <body><form method="POST" action="/admin">
      <h2>Vroommates Admin</h2>
      <p style="color:#888;font-size:0.85rem;margin:0">Database debug</p>
      <input type="password" name="password" placeholder="Admin password" autofocus required>
      <button type="submit">Login</button>
      ${req.query.err ? '<p class="err">Wrong password</p>' : ''}
    </form></body></html>`);
});

app.post('/admin', (req, res) => {
  if (req.body.password === ADMIN_PASSWORD) {
    req.session.isAdmin = true;
    return res.redirect('/admin');
  }
  res.redirect('/admin?err=1');
});

function renderAdminPage(res) {
  let html = `<!DOCTYPE html><html><head><title>Vroommates Admin</title>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <style>body{font-family:system-ui;background:#F5F5F1;color:#333;padding:16px;max-width:1100px;margin:auto}
    h1{font-size:1.3rem;display:flex;justify-content:space-between;align-items:center}
    h2{font-size:1rem;margin:22px 0 6px;border-bottom:1px solid #ccc;padding-bottom:4px}
    table{border-collapse:collapse;width:100%;font-size:0.75rem;background:#fff}
    th,td{border:1px solid #ddd;padding:4px 6px;text-align:left;white-space:nowrap;max-width:220px;overflow:hidden;text-overflow:ellipsis}
    th{background:#EFEFEA}
    tr:nth-child(even){background:#FAFAF8}
    a{color:#B07166;font-size:0.8rem}
    .meta{color:#888;font-size:0.75rem}</style></head><body>
    <h1>Vroommates Admin <a href="/admin/logout">logout</a></h1>
    <p class="meta">version ${pkg.version}</p>`;
  for (const t of ADMIN_TABLES) {
    const rows = db.prepare('SELECT * FROM ' + t).all();
    const keys = rows.length ? Object.keys(rows[0]) : [];
    html += `<h2>${t} (${rows.length})</h2>`;
    if (!rows.length) { html += '<p class="meta">(empty)</p>'; continue; }
    html += `<table><tr>${keys.map(k => `<th>${k}</th>`).join('')}</tr>` +
      rows.map(r => `<tr>${keys.map(k => `<td>${r[k] == null ? '' : String(r[k])}</td>`).join('')}</tr>`).join('') +
      `</table>`;
  }
  html += '</body></html>';
  res.send(html);
}

// ── Carpool Routes ──────────────────────────────────────────────────────────
app.get('/api/carpools', requireAuth, (req, res) => {
  const carpools = stmts.carpoolsByUser.all(req.session.userId);
  res.json({ carpools });
});

app.post('/api/carpools', requireAuth, (req, res) => {
  try {
    const { name, meetup_name, meetup_lat, meetup_lng, meetup_nickname, destination_name, destination_lat, destination_lng, destination_nickname } = req.body;
    if (!name) return res.status(400).json({ error: 'Carpool name required' });
    const result = stmts.createCarpool.run(
      name, req.session.userId,
      meetup_name || '', meetup_lat || 0, meetup_lng || 0,
      meetup_nickname || '',
      destination_name || '', destination_lat || 0, destination_lng || 0,
      destination_nickname || '',
      generateInviteCode()
    );
    const carpoolId = result.lastInsertRowid;
    stmts.addMember.run(carpoolId, req.session.userId);
    res.json({ ok: true, carpool: stmts.carpoolById.get(carpoolId) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/carpools/:id', requireAuth, (req, res) => {
  const carpool = stmts.carpoolById.get(req.params.id);
  if (!carpool) return res.status(404).json({ error: 'Not found' });
  const member = stmts.isMember.get(carpool.id, req.session.userId);
  if (!member) return res.status(403).json({ error: 'Not a member' });
  const members = stmts.carpoolMembers.all(carpool.id);
  const activeSession = stmts.activeSession.get(carpool.id);
  let sessionData = null;
  if (activeSession) {
    sessionData = {
      ...activeSession,
      members: stmts.sessionMembers.all(activeSession.id)
    };
  }
  const history = stmts.carpoolHistory.all(carpool.id);
  const isOwner = carpool.owner_id === req.session.userId;
  res.json({ carpool, members, activeSession: sessionData, history, isOwner, myMembership: member });
});

app.put('/api/carpools/:id', requireAuth, (req, res) => {
  const carpool = stmts.carpoolById.get(req.params.id);
  if (!carpool) return res.status(404).json({ error: 'Not found' });
  if (carpool.owner_id !== req.session.userId) return res.status(403).json({ error: 'Only owner can edit' });
  const { name, meetup_name, meetup_lat, meetup_lng, meetup_nickname, destination_name, destination_lat, destination_lng, destination_nickname, arrival_radius } = req.body;
  stmts.updateCarpool.run(
    name || carpool.name,
    meetup_name ?? carpool.meetup_name, meetup_lat ?? carpool.meetup_lat, meetup_lng ?? carpool.meetup_lng,
    meetup_nickname ?? carpool.meetup_nickname,
    destination_name ?? carpool.destination_name, destination_lat ?? carpool.destination_lat, destination_lng ?? carpool.destination_lng,
    destination_nickname ?? carpool.destination_nickname,
    arrival_radius ?? carpool.arrival_radius,
    carpool.id
  );
  res.json({ ok: true, carpool: stmts.carpoolById.get(carpool.id) });
});

app.delete('/api/carpools/:id', requireAuth, (req, res) => {
  try {
    const carpool = stmts.carpoolById.get(req.params.id);
    if (!carpool) return res.status(404).json({ error: 'Not found' });
    if (carpool.owner_id !== req.session.userId) return res.status(403).json({ error: 'Only owner can delete' });
    // Delete dependent records first (history, sessions, members) before the carpool
    db.prepare('DELETE FROM carpool_history WHERE carpool_id = ?').run(carpool.id);
    db.prepare('DELETE FROM session_members WHERE session_id IN (SELECT id FROM carpool_sessions WHERE carpool_id = ?)').run(carpool.id);
    db.prepare('DELETE FROM carpool_sessions WHERE carpool_id = ?').run(carpool.id);
    stmts.deleteCarpool.run(carpool.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Member Routes ───────────────────────────────────────────────────────────
app.post('/api/carpools/:id/members', requireAuth, (req, res) => {
  const carpool = stmts.carpoolById.get(req.params.id);
  if (!carpool) return res.status(404).json({ error: 'Not found' });
  if (carpool.owner_id !== req.session.userId) return res.status(403).json({ error: 'Only owner can add members' });
  const { username } = req.body;
  if (!username) return res.status(400).json({ error: 'Username required' });
  const user = stmts.userByUsername.get(username);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.id === req.session.userId) return res.status(400).json({ error: 'Cannot add yourself' });
  const member = stmts.isMember.get(carpool.id, user.id);
  if (member) return res.status(409).json({ error: 'Already a member' });
  stmts.addMember.run(carpool.id, user.id);
  // Also create an invitation record
  stmts.createInvitation.run(carpool.id, user.id, req.session.userId);
  // If a session is already active, add the new member to it as pending
  const active = stmts.activeSession.get(carpool.id);
  if (active) stmts.addSessionMember.run(active.id, user.id, 'pending');
  const members = stmts.carpoolMembers.all(carpool.id);
  res.json({ ok: true, members });
});

app.delete('/api/carpools/:id/members/:userId', requireAuth, (req, res) => {
  const carpool = stmts.carpoolById.get(req.params.id);
  if (!carpool) return res.status(404).json({ error: 'Not found' });
  if (carpool.owner_id !== req.session.userId) return res.status(403).json({ error: 'Only owner can remove members' });
  if (parseInt(req.params.userId) === req.session.userId) return res.status(400).json({ error: 'Cannot remove yourself' });
  stmts.removeMember.run(carpool.id, req.params.userId);
  const members = stmts.carpoolMembers.all(carpool.id);
  res.json({ ok: true, members });
});

app.get('/api/users/search', requireAuth, (req, res) => {
  const { q } = req.query;
  if (!q || q.length < 2) return res.json({ users: [] });
  const users = stmts.searchUsers.all(`%${q}%`, `%${q}%`, req.session.userId);
  res.json({ users });
});

// ── Invite Routes ───────────────────────────────────────────────────────────
app.get('/api/carpools/:id/invite', requireAuth, (req, res) => {
  const carpool = stmts.carpoolById.get(req.params.id);
  if (!carpool) return res.status(404).json({ error: 'Not found' });
  if (carpool.owner_id !== req.session.userId) return res.status(403).json({ error: 'Only owner can get invite link' });
  let code = carpool.invite_code;
  if (!code) {
    code = generateInviteCode();
    db.prepare('UPDATE carpools SET invite_code = ? WHERE id = ?').run(code, carpool.id);
  }
  res.json({ code });
});

app.post('/api/carpools/:id/invite/rotate', requireAuth, (req, res) => {
  const carpool = stmts.carpoolById.get(req.params.id);
  if (!carpool) return res.status(404).json({ error: 'Not found' });
  if (carpool.owner_id !== req.session.userId) return res.status(403).json({ error: 'Only owner can rotate invite link' });
  const code = generateInviteCode();
  db.prepare('UPDATE carpools SET invite_code = ? WHERE id = ?').run(code, carpool.id);
  res.json({ code });
});

app.post('/api/carpools/join', requireAuth, (req, res) => {
  try {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: 'Invite code required' });
    const carpool = db.prepare('SELECT * FROM carpools WHERE invite_code = ?').get(code.trim().toUpperCase());
    if (!carpool) return res.status(404).json({ error: 'Invalid or expired invite code' });
    const member = stmts.isMember.get(carpool.id, req.session.userId);
    if (member) {
      return res.json({ ok: true, carpool, alreadyMember: true });
    }
    stmts.addMember.run(carpool.id, req.session.userId);
    stmts.createInvitation.run(carpool.id, req.session.userId, carpool.owner_id);
    // If a session is already active, add the new member to it as pending
    const active = stmts.activeSession.get(carpool.id);
    if (active) stmts.addSessionMember.run(active.id, req.session.userId, 'pending');
    res.json({ ok: true, carpool, alreadyMember: false });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Saved Locations Routes (available to all carpool members) ───────────────
function requireMember(req, res) {
  const carpool = stmts.carpoolById.get(req.params.id);
  if (!carpool) { res.status(404).json({ error: 'Not found' }); return null; }
  if (!stmts.isMember.get(carpool.id, req.session.userId)) { res.status(403).json({ error: 'Not a member' }); return null; }
  return carpool;
}

app.get('/api/carpools/:id/locations', requireAuth, (req, res) => {
  const carpool = requireMember(req, res);
  if (!carpool) return;
  const locations = db.prepare('SELECT * FROM carpool_locations WHERE carpool_id = ? ORDER BY created_at ASC').all(carpool.id);
  res.json({ locations });
});

app.post('/api/carpools/:id/locations', requireAuth, (req, res) => {
  const carpool = requireMember(req, res);
  if (!carpool) return;
  const { name, address, lat, lng } = req.body;
  if (!name || !lat || !lng) return res.status(400).json({ error: 'Name and coordinates required' });
  const result = db.prepare('INSERT INTO carpool_locations (carpool_id, name, address, lat, lng) VALUES (?, ?, ?, ?, ?)')
    .run(carpool.id, name, address || '', lat, lng);
  res.json({ ok: true, location: db.prepare('SELECT * FROM carpool_locations WHERE id = ?').get(result.lastInsertRowid) });
});

app.put('/api/carpools/:id/locations/:locId', requireAuth, (req, res) => {
  const carpool = requireMember(req, res);
  if (!carpool) return;
  const loc = db.prepare('SELECT * FROM carpool_locations WHERE id = ? AND carpool_id = ?').get(req.params.locId, carpool.id);
  if (!loc) return res.status(404).json({ error: 'Location not found' });
  const { name, address, lat, lng } = req.body;
  db.prepare('UPDATE carpool_locations SET name=?, address=?, lat=?, lng=? WHERE id=?').run(
    name ?? loc.name, address ?? loc.address, lat ?? loc.lat, lng ?? loc.lng, loc.id
  );
  res.json({ ok: true, location: db.prepare('SELECT * FROM carpool_locations WHERE id = ?').get(loc.id) });
});

app.delete('/api/carpools/:id/locations/:locId', requireAuth, (req, res) => {
  const carpool = requireMember(req, res);
  if (!carpool) return;
  db.prepare('DELETE FROM carpool_locations WHERE id = ? AND carpool_id = ?').run(req.params.locId, carpool.id);
  res.json({ ok: true });
});

// Any member can set the active meetup/destination (updates carpool + active session)
app.post('/api/carpools/:id/location', requireAuth, (req, res) => {
  try {
    const carpool = requireMember(req, res);
    if (!carpool) return;
    const { slot, name, address, lat, lng } = req.body;
    if ((slot !== 'meetup' && slot !== 'destination') || !lat || !lng || !name) {
      return res.status(400).json({ error: 'slot, name and coordinates required' });
    }
    if (slot === 'meetup') {
      db.prepare('UPDATE carpools SET meetup_name=?, meetup_nickname=?, meetup_lat=?, meetup_lng=? WHERE id=?')
        .run(address || name, name, lat, lng, carpool.id);
    } else {
      db.prepare('UPDATE carpools SET destination_name=?, destination_nickname=?, destination_lat=?, destination_lng=? WHERE id=?')
        .run(address || name, name, lat, lng, carpool.id);
    }
    // Keep the active session in sync
    const fresh = stmts.carpoolById.get(carpool.id);
    const active = stmts.activeSession.get(carpool.id);
    if (active) {
      stmts.updateSessionLocations.run(
        fresh.meetup_lat, fresh.meetup_lng, fresh.meetup_name,
        fresh.destination_lat, fresh.destination_lng, fresh.destination_name,
        active.id
      );
      io.to('carpool:' + carpool.id).emit('session-updated', {
        ...stmts.latestSession.get(carpool.id),
        members: stmts.sessionMembers.all(active.id)
      });
    }
    res.json({ ok: true, carpool: fresh });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Session Routes ──────────────────────────────────────────────────────────
app.post('/api/carpools/:id/sessions/start', requireAuth, (req, res) => {
  try {
    const carpool = stmts.carpoolById.get(req.params.id);
    if (!carpool) return res.status(404).json({ error: 'Not found' });
    const member = stmts.isMember.get(carpool.id, req.session.userId);
    if (!member) return res.status(403).json({ error: 'Not a member' });

    // Check for existing active session
    const existing = stmts.activeSession.get(carpool.id);
    if (existing) return res.status(409).json({ error: 'Active session already exists', sessionId: existing.id });

    // Create session with current carpool meetup/destination (no driver yet)
    const result = stmts.createSession.run(
      carpool.id, null, 'meetup',
      carpool.meetup_lat, carpool.meetup_lng, carpool.meetup_name,
      carpool.destination_lat, carpool.destination_lng, carpool.destination_name
    );
    const sessionId = result.lastInsertRowid;

    // Everyone starts pending — the session doesn't begin until someone claims driving
    const members = stmts.carpoolMembers.all(carpool.id);
    for (const m of members) {
      stmts.addSessionMember.run(sessionId, m.id, 'pending');
    }

    const session = { ...stmts.latestSession.get(carpool.id), members: stmts.sessionMembers.all(sessionId) };

    // Notify via socket
    io.to('carpool:' + carpool.id).emit('session-started', session);

    res.json({ ok: true, session });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/carpools/:id/sessions/respond', requireAuth, (req, res) => {
  try {
    const { status, auto } = req.body; // 'driving' | 'riding' | 'skip' | 'arrived'; auto = geo-fence arrival
    const validStatuses = ['driving', 'riding', 'skip', 'arrived'];
    if (!validStatuses.includes(status)) {
      return res.status(400).json({ error: 'Invalid status. Must be: ' + validStatuses.join(', ') });
    }

    const carpool = stmts.carpoolById.get(req.params.id);
    if (!carpool) return res.status(404).json({ error: 'Not found' });

    const activeSession = stmts.activeSession.get(carpool.id);
    if (!activeSession) return res.status(400).json({ error: 'No active session' });

    let sm = stmts.sessionMemberByUser.get(activeSession.id, req.session.userId);
    if (!sm) {
      // Member joined after the session started — add them now
      const member = stmts.isMember.get(carpool.id, req.session.userId);
      if (!member) return res.status(403).json({ error: 'Not in session' });
      stmts.addSessionMember.run(activeSession.id, req.session.userId, 'pending');
      sm = stmts.sessionMemberByUser.get(activeSession.id, req.session.userId);
    }

    // If claiming driving, update the session driver and demote the previous driver
    if (status === 'driving') {
      const prevDriver = stmts.sessionMembers.all(activeSession.id)
        .find(m => m.status === 'driving' && m.user_id !== req.session.userId);
      if (prevDriver) {
        stmts.updateSessionMember.run('riding', null, null, activeSession.id, prevDriver.user_id);
      }
      stmts.updateSessionDriver.run(req.session.userId, activeSession.id);
    }

    stmts.updateSessionMember.run(status, null, null, activeSession.id, req.session.userId);

    // Mark geo-fence arrivals so the UI can show it
    if (status === 'arrived' && auto) {
      db.prepare('UPDATE session_members SET auto_arrived = 1 WHERE session_id = ? AND user_id = ?')
        .run(activeSession.id, req.session.userId);
    }

    // Broadcast updated session
    const updatedSession = {
      ...stmts.latestSession.get(carpool.id),
      members: stmts.sessionMembers.all(activeSession.id)
    };
    io.to('carpool:' + carpool.id).emit('session-updated', updatedSession);

    // If everyone has arrived at the meetup, move to the destination phase
    autoAdvanceCheck(carpool.id);

    res.json({ ok: true, session: updatedSession });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/carpools/:id/sessions/skip-member', requireAuth, (req, res) => {
  try {
    const { userId } = req.body;
    const carpool = stmts.carpoolById.get(req.params.id);
    if (!carpool) return res.status(404).json({ error: 'Not found' });

    const activeSession = stmts.activeSession.get(carpool.id);
    if (!activeSession) return res.status(400).json({ error: 'No active session' });
    // Any session member may skip themselves or any other member
    const skipper = stmts.sessionMemberByUser.get(activeSession.id, req.session.userId);
    if (!skipper) return res.status(403).json({ error: 'Not in session' });

    stmts.updateSessionMember.run('skip', null, null, activeSession.id, userId);

    const updatedSession = {
      ...stmts.latestSession.get(carpool.id),
      members: stmts.sessionMembers.all(activeSession.id)
    };
    io.to('carpool:' + carpool.id).emit('session-updated', updatedSession);
    autoAdvanceCheck(carpool.id);
    res.json({ ok: true, session: updatedSession });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/carpools/:id/sessions/advance-phase', requireAuth, (req, res) => {
  const advancePhase = db.transaction(() => {
    const { phase } = req.body; // 'destination' | 'back_to_meetup' | 'completed'
    const validPhases = ['destination', 'back_to_meetup', 'completed'];
    if (!validPhases.includes(phase)) {
      throw { status: 400, error: 'Invalid phase' };
    }

    const carpool = stmts.carpoolById.get(req.params.id);
    if (!carpool) throw { status: 404, error: 'Not found' };

    const activeSession = stmts.activeSession.get(carpool.id);
    if (!activeSession) throw { status: 400, error: 'No active session' };

    const userId = req.session.userId;
    let mileage = 0;

    // Phase transitions
    if (phase === 'destination' && activeSession.phase === 'meetup') {
      mileage = transitionToDestination(carpool, activeSession);
    } else if (phase === 'back_to_meetup' && activeSession.phase === 'destination') {
      mileage = haversine(
        activeSession.destination_lat, activeSession.destination_lng,
        activeSession.meetup_lat, activeSession.meetup_lng
      );
      stmts.addHistory.run(carpool.id, activeSession.id, 'back_to_meetup', activeSession.driver_id, 'phase_start', '{}', mileage,
        'Heading back to meetup.');

    } else if (phase === 'completed' && activeSession.phase === 'back_to_meetup') {
      // Total mileage for the return trip already logged; just complete
      stmts.addHistory.run(carpool.id, activeSession.id, 'completed', activeSession.driver_id, 'carpool_complete', '{}', 0,
        'Carpool completed. All members back at meetup.');
    } else {
      throw { status: 400, error: `Cannot transition from ${activeSession.phase} to ${phase}` };
    }

    stmts.updateSessionPhase.run(phase, phase, activeSession.id);

    return { activeSession, carpool, phase, mileage };
  });

  try {
    const result = advancePhase();
    const { activeSession, carpool, phase, mileage } = result;

    const updatedSession = {
      ...stmts.latestSession.get(carpool.id),
      members: stmts.sessionMembers.all(activeSession.id)
    };

    io.to('carpool:' + carpool.id).emit('session-updated', updatedSession);
    io.to('carpool:' + carpool.id).emit('phase-changed', {
      from: activeSession.phase,
      to: phase,
      coinsDistributed: phase === 'destination',
      mileage
    });

    res.json({ ok: true, session: updatedSession });
  } catch (err) {
    if (err.status) {
      res.status(err.status).json({ error: err.error });
    } else {
      res.status(500).json({ error: err.message });
    }
  }
});

app.post('/api/carpools/:id/sessions/cancel', requireAuth, (req, res) => {
  try {
    const carpool = stmts.carpoolById.get(req.params.id);
    if (!carpool) return res.status(404).json({ error: 'Not found' });
    const activeSession = stmts.activeSession.get(carpool.id);
    if (!activeSession) return res.status(400).json({ error: 'No active session' });
    if (activeSession.driver_id !== req.session.userId && carpool.owner_id !== req.session.userId) {
      return res.status(403).json({ error: 'Only driver or owner can cancel' });
    }
    stmts.updateSessionPhase.run('completed', 'completed', activeSession.id);
    stmts.addHistory.run(carpool.id, activeSession.id, 'cancelled', activeSession.driver_id, 'session_cancelled', '{}', 0, 'Session cancelled');
    io.to('carpool:' + carpool.id).emit('session-cancelled', { sessionId: activeSession.id });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Update session locations (meetup/destination on the fly)
app.put('/api/carpools/:id/sessions/locations', requireAuth, (req, res) => {
  try {
    const carpool = stmts.carpoolById.get(req.params.id);
    if (!carpool) return res.status(404).json({ error: 'Not found' });
    const activeSession = stmts.activeSession.get(carpool.id);
    if (!activeSession) return res.status(400).json({ error: 'No active session' });
    const { meetup_lat, meetup_lng, meetup_name, destination_lat, destination_lng, destination_name } = req.body;
    stmts.updateSessionLocations.run(
      meetup_lat ?? activeSession.meetup_lat,
      meetup_lng ?? activeSession.meetup_lng,
      meetup_name ?? activeSession.meetup_name,
      destination_lat ?? activeSession.destination_lat,
      destination_lng ?? activeSession.destination_lng,
      destination_name ?? activeSession.destination_name,
      activeSession.id
    );
    const updatedSession = {
      ...stmts.latestSession.get(carpool.id),
      members: stmts.sessionMembers.all(activeSession.id)
    };
    io.to('carpool:' + carpool.id).emit('session-updated', updatedSession);
    res.json({ ok: true, session: updatedSession });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Invitations ─────────────────────────────────────────────────────────────
app.get('/api/invitations', requireAuth, (req, res) => {
  const invitations = stmts.pendingInvitations.all(req.session.userId);
  res.json({ invitations });
});

app.post('/api/invitations/:id/accept', requireAuth, (req, res) => {
  const result = stmts.acceptInvitation.run(req.params.id, req.session.userId);
  if (result.changes === 0) return res.status(404).json({ error: 'Invitation not found' });
  // Get the invitation to know carpool_id
  const inv = db.prepare('SELECT * FROM invitations WHERE id=?').get(req.params.id);
  stmts.addMember.run(inv.carpool_id, req.session.userId);
  // If a session is already active, add the new member to it as pending
  const active = stmts.activeSession.get(inv.carpool_id);
  if (active) stmts.addSessionMember.run(active.id, req.session.userId, 'pending');
  res.json({ ok: true });
});

app.post('/api/invitations/:id/decline', requireAuth, (req, res) => {
  stmts.declineInvitation.run(req.params.id, req.session.userId);
  res.json({ ok: true });
});

// ── Utility ─────────────────────────────────────────────────────────────────
// Meetup → Destination: distribute coins, log mileage/history, set phase
function transitionToDestination(carpool, activeSession) {
  const members = stmts.sessionMembers.all(activeSession.id);
  const driver = members.find(m => m.status === 'driving');
  const actualDriverId = driver ? driver.user_id : activeSession.driver_id;
  // Riders: anyone riding OR arrived at the meetup (excluding the driver)
  const riders = members.filter(m =>
    (m.status === 'riding' || m.status === 'arrived') && m.user_id !== actualDriverId
  );

  const coinsData = {};
  for (const rider of riders) {
    stmts.updateCoins.run(-1, carpool.id, rider.user_id);
    coinsData[rider.user_id] = -1;
  }
  if (actualDriverId) {
    stmts.updateCoins.run(riders.length, carpool.id, actualDriverId);
    coinsData[actualDriverId] = riders.length;
  }
  stmts.updateSessionDriver.run(actualDriverId, activeSession.id);

  const mileage = haversine(
    activeSession.meetup_lat, activeSession.meetup_lng,
    activeSession.destination_lat, activeSession.destination_lng
  );
  stmts.addHistory.run(carpool.id, activeSession.id, 'destination', actualDriverId, 'phase_start',
    JSON.stringify(coinsData), mileage,
    `Departed for destination. ${riders.length} riders. Coins distributed.`);
  stmts.updateSessionPhase.run('destination', 'destination', activeSession.id);
  return mileage;
}

// If everyone (non-skipped) has arrived at the meetup, auto-advance to the destination
function autoAdvanceCheck(carpoolId) {
  const session = stmts.activeSession.get(carpoolId);
  if (!session || session.phase !== 'meetup' || !session.driver_id) return false;
  const members = stmts.sessionMembers.all(session.id);
  const active = members.filter(m => m.status !== 'skip');
  if (active.length === 0) return false;
  if (!active.every(m => m.status === 'arrived')) return false;

  const mileage = transitionToDestination(stmts.carpoolById.get(carpoolId), session);
  const updated = { ...stmts.latestSession.get(carpoolId), members: stmts.sessionMembers.all(session.id) };
  io.to('carpool:' + carpoolId).emit('session-updated', updated);
  io.to('carpool:' + carpoolId).emit('phase-changed', {
    from: 'meetup', to: 'destination', coinsDistributed: true, mileage
  });
  return true;
}

function haversine(lat1, lng1, lat2, lng2) {
  if (!lat1 || !lng1 || !lat2 || !lng2) return 0;
  const R = 3959; // Earth radius in miles
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ── Socket.IO ───────────────────────────────────────────────────────────────
const onlineUsers = new Map(); // socketId -> { userId, username, currentCarpool }

io.on('connection', (socket) => {
  console.log('Socket connected:', socket.id);

  socket.on('authenticate', (data) => {
    // In a real app, verify session. For now, trust the userId passed from client.
    if (data.userId && data.username) {
      onlineUsers.set(socket.id, {
        userId: data.userId,
        username: data.username,
        currentCarpool: null
      });
      socket.emit('authenticated', { ok: true });
    }
  });

  socket.on('join-carpool', (carpoolId) => {
    const user = onlineUsers.get(socket.id);
    if (!user) return;
    // Leave previous carpool room
    if (user.currentCarpool) {
      socket.leave('carpool:' + user.currentCarpool);
    }
    socket.join('carpool:' + carpoolId);
    user.currentCarpool = carpoolId;
    onlineUsers.set(socket.id, user);
    socket.emit('joined-carpool', { carpoolId });

    // Push the current session state so late/re-joiners are instantly in sync
    const active = stmts.activeSession.get(carpoolId);
    if (active) {
      socket.emit('session-updated', { ...active, members: stmts.sessionMembers.all(active.id) });
    }
  });

  socket.on('leave-carpool', (carpoolId) => {
    socket.leave('carpool:' + carpoolId);
    const user = onlineUsers.get(socket.id);
    if (user) {
      user.currentCarpool = null;
      onlineUsers.set(socket.id, user);
    }
  });

  socket.on('location-update', (data) => {
    const user = onlineUsers.get(socket.id);
    if (!user || !user.currentCarpool) return;

    const { sessionId, lat, lng } = data;
    try {
      stmts.updateSessionMember.run(null, lat, lng, sessionId, user.userId);
    } catch (e) { /* ignore */ }

    // Broadcast to carpool room
    socket.to('carpool:' + user.currentCarpool).emit('member-location', {
      userId: user.userId,
      username: user.username,
      lat,
      lng,
      timestamp: Date.now()
    });
  });

  socket.on('disconnect', () => {
    console.log('Socket disconnected:', socket.id);
    onlineUsers.delete(socket.id);
  });
});

// ── Start Server ────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Carpool server running at http://localhost:${PORT}`);
});
