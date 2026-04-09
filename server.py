import http.server
import socketserver
import json
import sqlite3
import os
import uuid
import http.cookies
import hashlib

PORT = 8080
DB_FILE = 'trading_risk_engine.db'
SESSION_FILE = 'sessions.json'

ADMIN_USERNAME = 'harshraj'

# ── Persistent session store ────────────────────────────
def load_sessions():
    if os.path.exists(SESSION_FILE):
        try:
            with open(SESSION_FILE, 'r') as f:
                return json.load(f)
        except: pass
    return {}

def save_sessions(sess):
    with open(SESSION_FILE, 'w') as f:
        json.dump(sess, f)

sessions = load_sessions()

# ── Simple password hashing ─────────────────────────────
def hash_pw(password):
    return hashlib.sha256(password.encode('utf-8')).hexdigest()

# ── Database initialization & migration ─────────────────
def init_db():
    conn = sqlite3.connect(DB_FILE)
    cursor = conn.cursor()

    # Users table
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS users (
            id TEXT PRIMARY KEY,
            username TEXT UNIQUE,
            password TEXT
        )
    ''')

    # Check if the tables have the OLD schema (no user_id)
    needs_migration = False
    existing_tables = [r[0] for r in cursor.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()]

    if 'trades' in existing_tables:
        cols = [c[1] for c in cursor.execute("PRAGMA table_info(trades)").fetchall()]
        if 'user_id' not in cols:
            needs_migration = True

    if needs_migration:
        print("[MIGRATION] Detected old schema without user_id. Migrating...")
        # Back up old data
        old_trades = cursor.execute("SELECT id, data FROM trades").fetchall()
        old_systems = cursor.execute("SELECT name, data FROM systems").fetchall()
        old_instruments = cursor.execute("SELECT symbol, data FROM instruments").fetchall()

        # Drop old tables
        cursor.execute("DROP TABLE IF EXISTS trades")
        cursor.execute("DROP TABLE IF EXISTS systems")
        cursor.execute("DROP TABLE IF EXISTS instruments")
        conn.commit()

        # Create new tables with user_id
        _create_data_tables(cursor)
        conn.commit()

        # If there are existing users, assign old data to the FIRST user
        first_user = cursor.execute("SELECT id FROM users LIMIT 1").fetchone()
        if first_user and (old_trades or old_systems or old_instruments):
            uid = first_user[0]
            print(f"[MIGRATION] Assigning {len(old_trades)} trades, {len(old_systems)} systems, {len(old_instruments)} instruments to first user.")
            for (tid, data) in old_trades:
                cursor.execute('INSERT OR IGNORE INTO trades (user_id, id, data) VALUES (?, ?, ?)', (uid, tid, data))
            for (name, data) in old_systems:
                cursor.execute('INSERT OR IGNORE INTO systems (user_id, name, data) VALUES (?, ?, ?)', (uid, name, data))
            for (sym, data) in old_instruments:
                cursor.execute('INSERT OR IGNORE INTO instruments (user_id, symbol, data) VALUES (?, ?, ?)', (uid, sym, data))
            conn.commit()
            print("[MIGRATION] Migration complete.")
        elif old_trades or old_systems or old_instruments:
            print("[MIGRATION] WARNING: Old data found but no users exist. Old data has been dropped.")
            print("[MIGRATION] Create an account and re-import your backup JSON to restore data.")
    else:
        # Tables might not exist yet (fresh DB)
        _create_data_tables(cursor)
        conn.commit()

    conn.close()

def _create_data_tables(cursor):
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS trades (
            user_id TEXT NOT NULL,
            id TEXT NOT NULL,
            data TEXT,
            PRIMARY KEY (user_id, id)
        )
    ''')
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS systems (
            user_id TEXT NOT NULL,
            name TEXT NOT NULL,
            data TEXT,
            PRIMARY KEY (user_id, name)
        )
    ''')
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS instruments (
            user_id TEXT NOT NULL,
            symbol TEXT NOT NULL,
            data TEXT,
            PRIMARY KEY (user_id, symbol)
        )
    ''')

init_db()

# ── HTTP Handler ────────────────────────────────────────
class AppHandler(http.server.SimpleHTTPRequestHandler):

    def get_user_id(self):
        cookie_header = self.headers.get('Cookie')
        if not cookie_header:
            return None
        cookies = http.cookies.SimpleCookie(cookie_header)
        sid = cookies.get('sid')
        if not sid:
            return None
        return sessions.get(sid.value)

    def _send_json(self, code, obj):
        body = json.dumps(obj).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-type', 'application/json')
        self.end_headers()
        self.wfile.write(body)

    # ── GET ──────────────────────────────────────────────
    def do_GET(self):
        if self.path == '/api/admin/users':
            uid = self.get_user_id()
            if not uid:
                self._send_json(401, {"error": "Not authenticated"})
                return

            conn = sqlite3.connect(DB_FILE)
            cursor = conn.cursor()
            try:
                user_row = cursor.execute('SELECT username FROM users WHERE id = ?', (uid,)).fetchone()
                if not user_row or user_row[0] != ADMIN_USERNAME:
                    self._send_json(403, {"error": "Forbidden: Admins only"})
                    return
                
                users = cursor.execute('SELECT id, username FROM users').fetchall()
                results = []
                for (u_id, u_name) in users:
                    t_cnt = cursor.execute('SELECT COUNT(*) FROM trades WHERE user_id = ?', (u_id,)).fetchone()[0]
                    s_cnt = cursor.execute('SELECT COUNT(*) FROM systems WHERE user_id = ?', (u_id,)).fetchone()[0]
                    results.append({"id": u_id, "username": u_name, "trades": t_cnt, "systems": s_cnt})

                self._send_json(200, {"users": results})
            except Exception as e:
                self._send_json(500, {"error": str(e)})
            finally:
                conn.close()
            return

        if self.path == '/api/load_state':
            uid = self.get_user_id()
            if not uid:
                self._send_json(401, {"error": "Not authenticated"})
                return

            conn = sqlite3.connect(DB_FILE)
            cursor = conn.cursor()
            try:
                user_row = cursor.execute('SELECT username FROM users WHERE id = ?', (uid,)).fetchone()
                username = user_row[0] if user_row else 'User'
                is_admin = (username == ADMIN_USERNAME)

                trades = [json.loads(r[0]) for r in cursor.execute('SELECT data FROM trades WHERE user_id = ?', (uid,))]
                syss   = [json.loads(r[0]) for r in cursor.execute('SELECT data FROM systems WHERE user_id = ?', (uid,))]
                insts  = [json.loads(r[0]) for r in cursor.execute('SELECT data FROM instruments WHERE user_id = ?', (uid,))]

                self._send_json(200, {
                    'trades': trades,
                    'systems': syss,
                    'instruments': insts,
                    'username': username,
                    'is_admin': is_admin
                })
            except Exception as e:
                self._send_json(500, {"error": str(e)})
                print(f"Error loading state: {e}")
            finally:
                conn.close()
            return

        if self.path == '/':
            self.path = '/trading_risk_app_index.html'
        return super().do_GET()

    # ── POST ─────────────────────────────────────────────
    def do_POST(self):
        content_length = int(self.headers.get('Content-Length', 0))
        post_data = self.rfile.read(content_length)
        payload = {}
        try:
            payload = json.loads(post_data.decode('utf-8'))
        except:
            pass

        # ── LOGIN ────────────────────────────────────────
        if self.path == '/api/login':
            username = payload.get('username', '')
            password = payload.get('password', '')
            conn = sqlite3.connect(DB_FILE)
            cursor = conn.cursor()
            # Support both hashed and legacy plain-text passwords
            hashed = hash_pw(password)
            user = cursor.execute(
                'SELECT id FROM users WHERE username = ? AND (password = ? OR password = ?)',
                (username, hashed, password)
            ).fetchone()

            if user:
                # Upgrade plain-text password to hashed on successful login
                cursor.execute('UPDATE users SET password = ? WHERE id = ?', (hashed, user[0]))
                conn.commit()

                sid = str(uuid.uuid4())
                sessions[sid] = user[0]
                save_sessions(sessions)

                self.send_response(200)
                self.send_header('Set-Cookie', f'sid={sid}; Path=/')
                self.send_header('Content-type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"status": "success", "username": username}).encode('utf-8'))
            else:
                self._send_json(401, {"error": "Invalid credentials"})
            conn.close()
            return

        # ── SIGNUP ───────────────────────────────────────
        if self.path == '/api/signup':
            username = payload.get('username', '').strip()
            password = payload.get('password', '').strip()
            if not username or not password:
                self._send_json(400, {"error": "Username and password required"})
                return
            uid = str(uuid.uuid4())
            try:
                conn = sqlite3.connect(DB_FILE)
                cursor = conn.cursor()
                cursor.execute('INSERT INTO users (id, username, password) VALUES (?, ?, ?)',
                               (uid, username, hash_pw(password)))
                conn.commit()
                conn.close()
                self._send_json(200, {"status": "success"})
            except sqlite3.IntegrityError:
                self._send_json(400, {"error": "Username already exists"})
            return

        # ── LOGOUT ───────────────────────────────────────
        if self.path == '/api/logout':
            # Remove session from store
            cookie_header = self.headers.get('Cookie')
            if cookie_header:
                cookies = http.cookies.SimpleCookie(cookie_header)
                sid = cookies.get('sid')
                if sid and sid.value in sessions:
                    del sessions[sid.value]
                    save_sessions(sessions)

            self.send_response(200)
            self.send_header('Set-Cookie', 'sid=; Path=/; Max-Age=0')
            self.end_headers()
            return

        # ── DELETE ACCOUNT ───────────────────────────────
        if self.path == '/api/delete_account':
            uid = self.get_user_id()
            if not uid:
                self._send_json(401, {"error": "Not authenticated"})
                return

            conn = None
            try:
                conn = sqlite3.connect(DB_FILE)
                cursor = conn.cursor()
                cursor.execute('DELETE FROM trades WHERE user_id = ?', (uid,))
                cursor.execute('DELETE FROM systems WHERE user_id = ?', (uid,))
                cursor.execute('DELETE FROM instruments WHERE user_id = ?', (uid,))
                cursor.execute('DELETE FROM users WHERE id = ?', (uid,))
                conn.commit()

                # Purge all sessions for this user
                to_del = [s for s, u in sessions.items() if u == uid]
                for k in to_del:
                    del sessions[k]
                save_sessions(sessions)

                self.send_response(200)
                self.send_header('Set-Cookie', 'sid=; Path=/; Max-Age=0')
                self.send_header('Content-type', 'application/json')
                self.end_headers()
                self.wfile.write(json.dumps({"status": "success"}).encode('utf-8'))
            except Exception as e:
                if conn:
                    conn.rollback()
                self._send_json(500, {"error": str(e)})
                print(f"Delete account error: {e}")
            finally:
                if conn:
                    conn.close()
            return

        # ── ADMIN ACTIONS ────────────────────────────────
        if self.path == '/api/admin/delete_user':
            uid = self.get_user_id()
            if not uid: return self._send_json(401, {"error": "Not authenticated"})
            
            conn = sqlite3.connect(DB_FILE)
            cursor = conn.cursor()
            user_row = cursor.execute('SELECT username FROM users WHERE id = ?', (uid,)).fetchone()
            if not user_row or user_row[0] != ADMIN_USERNAME:
                conn.close()
                return self._send_json(403, {"error": "Forbidden: Admins only"})
                
            target_id = payload.get('target_user_id')
            if not target_id:
                conn.close()
                return self._send_json(400, {"error": "Target user required"})
                
            try:
                cursor.execute('DELETE FROM trades WHERE user_id = ?', (target_id,))
                cursor.execute('DELETE FROM systems WHERE user_id = ?', (target_id,))
                cursor.execute('DELETE FROM instruments WHERE user_id = ?', (target_id,))
                cursor.execute('DELETE FROM users WHERE id = ?', (target_id,))
                conn.commit()
                
                to_del = [s for s, target in sessions.items() if target == target_id]
                for k in to_del: del sessions[k]
                save_sessions(sessions)
                
                self._send_json(200, {"status": "success"})
            except Exception as e:
                conn.rollback()
                self._send_json(500, {"error": str(e)})
            finally:
                conn.close()
            return

        if self.path == '/api/admin/change_password':
            uid = self.get_user_id()
            if not uid: return self._send_json(401, {"error": "Not authenticated"})
            
            conn = sqlite3.connect(DB_FILE)
            cursor = conn.cursor()
            user_row = cursor.execute('SELECT username FROM users WHERE id = ?', (uid,)).fetchone()
            if not user_row or user_row[0] != ADMIN_USERNAME:
                conn.close()
                return self._send_json(403, {"error": "Forbidden: Admins only"})
                
            target_id = payload.get('target_user_id')
            new_pass = payload.get('new_password')
            if not target_id or not new_pass:
                conn.close()
                return self._send_json(400, {"error": "Missing parameters"})
                
            try:
                cursor.execute('UPDATE users SET password = ? WHERE id = ?', (hash_pw(new_pass), target_id))
                conn.commit()
                
                # Optionally kill their sessions so they have to log in again
                to_del = [s for s, target in sessions.items() if target == target_id]
                for k in to_del: del sessions[k]
                save_sessions(sessions)
                
                self._send_json(200, {"status": "success"})
            except Exception as e:
                conn.rollback()
                self._send_json(500, {"error": str(e)})
            finally:
                conn.close()
            return

        # ── SAVE STATE ───────────────────────────────────
        if self.path == '/api/save_state':
            uid = self.get_user_id()
            if not uid:
                self._send_json(401, {"error": "Not authenticated"})
                return

            state = payload.get('state', {})
            conn = None
            try:
                conn = sqlite3.connect(DB_FILE)
                cursor = conn.cursor()

                # Full-sync per user within a transaction
                if 'trades' in state:
                    cursor.execute('DELETE FROM trades WHERE user_id = ?', (uid,))
                    for trade in state['trades']:
                        cursor.execute('INSERT INTO trades (user_id, id, data) VALUES (?, ?, ?)',
                                       (uid, trade.get('id', str(uuid.uuid4())), json.dumps(trade)))

                if 'systems' in state:
                    cursor.execute('DELETE FROM systems WHERE user_id = ?', (uid,))
                    for sys_obj in state['systems']:
                        cursor.execute('INSERT INTO systems (user_id, name, data) VALUES (?, ?, ?)',
                                       (uid, sys_obj.get('name', 'Unnamed'), json.dumps(sys_obj)))

                if 'instruments' in state:
                    cursor.execute('DELETE FROM instruments WHERE user_id = ?', (uid,))
                    for inst in state['instruments']:
                        cursor.execute('INSERT INTO instruments (user_id, symbol, data) VALUES (?, ?, ?)',
                                       (uid, inst.get('symbol', 'UNKNOWN'), json.dumps(inst)))

                conn.commit()
                self._send_json(200, {"status": "success"})
            except Exception as e:
                if conn:
                    conn.rollback()
                self._send_json(500, {"error": str(e)})
                print(f"Save error: {e}")
            finally:
                if conn:
                    conn.close()
            return

        self._send_json(404, {"error": "Not found"})

# ── Start Server ────────────────────────────────────────
socketserver.TCPServer.allow_reuse_address = True
with socketserver.TCPServer(("", PORT), AppHandler) as httpd:
    print(f"Serving Authenticated Risk Engine at http://localhost:{PORT}")
    httpd.serve_forever()
