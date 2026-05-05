const express = require('express');
const sqlite3 = require('sqlite3').verbose(); // better-sqlite3 yerine sqlite3
const bcrypt = require('bcryptjs');
const cors = require('cors');
const https = require('https');

const app = express();
app.use(cors());
app.use(express.json());

// ── VERİTABANI KURULUMU ──────────────────────────────────────────────
const db = new sqlite3.Database('adxpro.db', (err) => {
    if (err) console.error('Veritabanı bağlantı hatası:', err.message);
    else console.log('✅ SQLite veritabanına bağlanıldı.');
});

db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS users (
            id         INTEGER PRIMARY KEY AUTOINCREMENT,
            uid        TEXT UNIQUE NOT NULL,
            fullName   TEXT NOT NULL,
            email      TEXT UNIQUE NOT NULL,
            password   TEXT NOT NULL,
            balance    REAL DEFAULT 0,
            createdAt  TEXT DEFAULT (datetime('now'))
        )
    `);
});

// UID üretici (Dokunulmadı)
function generateUID() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const rand = (n) => Array.from({length: n}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    return `ADX-${rand(4)}-${rand(4)}`;
}

// HTTP yardımcısı (Dokunulmadı)
function fetchUrl(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => resolve(data));
        }).on('error', reject);
    });
}

// ── HİSSE FİYATI PROXY ───────────────────────────────────────────────
app.get('/api/stock/:symbol', async (req, res) => {
    const sym = req.params.symbol;
    try {
        const url  = `https://query2.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1m&range=1d`;
        const body = await fetchUrl(url);
        const data = JSON.parse(body);
        const meta = data?.chart?.result?.[0]?.meta;
        if (!meta) return res.status(404).json({ error: 'no data' });
        const price = parseFloat(meta.regularMarketPrice || meta.previousClose);
        const prev  = parseFloat(meta.previousClose || price);
        const change = ((price - prev) / prev * 100);
        res.json({ symbol: sym, price, prev, change });
    } catch(e) {
        res.status(500).json({ error: e.message });
    }
});

// ── KAYIT ─────────────────────────────────────────────────────────────
app.post('/api/register', async (req, res) => {
    const { fullName, email, password } = req.body;
    if (!fullName || !email || !password)
        return res.status(400).json({ message: 'Tüm alanları doldurun.' });
    if (password.length < 8)
        return res.status(400).json({ message: 'Şifre en az 8 karakter olmalı.' });

    db.get('SELECT id FROM users WHERE email = ?', [email], async (err, row) => {
        if (row) return res.status(409).json({ message: 'Bu e-posta zaten kayıtlı.' });

        const hashed = await bcrypt.hash(password, 10);
        const uid = generateUID();

        db.run('INSERT INTO users (uid, fullName, email, password) VALUES (?, ?, ?, ?)',
            [uid, fullName, email, hashed], function(err) {
                if (err) return res.status(500).json({ message: 'Kayıt hatası.' });

                db.get('SELECT id, uid, fullName, email, balance, createdAt FROM users WHERE id = ?', [this.lastID], (err, user) => {
                    res.status(201).json(user);
                });
            });
    });
});

// ── GİRİŞ ─────────────────────────────────────────────────────────────
app.post('/api/login', (req, res) => {
    const { email, password } = req.body;
    if (!email || !password)
        return res.status(400).json({ message: 'E-posta ve şifre gerekli.' });

    db.get('SELECT * FROM users WHERE email = ?', [email], async (err, user) => {
        if (!user) return res.status(401).json({ message: 'E-posta bulunamadı.' });
        const match = await bcrypt.compare(password, user.password);
        if (!match) return res.status(401).json({ message: 'Şifre hatalı.' });
        const { password: _, ...safeUser } = user;
        res.json({ user: safeUser });
    });
});

// ── TÜM KULLANICILARI LİSTELE ─────────────────────────────────────────
app.get('/api/admin/users', (req, res) => {
    db.all('SELECT id, uid, fullName, email, password, balance, createdAt FROM users ORDER BY id DESC', [], (err, rows) => {
        res.json(rows || []);
    });
});

// ── TEK KULLANICI GETİR ───────────────────────────────────────────────
app.get('/api/users/:uid', (req, res) => {
    db.get('SELECT id, uid, fullName, email, balance, createdAt FROM users WHERE uid = ?', [req.params.uid], (err, user) => {
        if (!user) return res.status(404).json({ message: 'Kullanıcı bulunamadı.' });
        res.json(user);
    });
});

// ── KULLANICI GÜNCELLE ────────────────────────────────────────────────
app.patch('/api/users/:uid/update', async (req, res) => {
    const { fullName, password } = req.body;
    const uid = req.params.uid;

    db.get('SELECT * FROM users WHERE uid = ?', [uid], async (err, user) => {
        if (!user) return res.status(404).json({ message: 'Kullanıcı bulunamadı.' });

        if (fullName) {
            db.run('UPDATE users SET fullName = ? WHERE uid = ?', [fullName, uid]);
        }
        if (password) {
            const hashed = await bcrypt.hash(password, 10);
            db.run('UPDATE users SET password = ? WHERE uid = ?', [hashed, uid]);
        }

        setTimeout(() => {
            db.get('SELECT id, uid, fullName, email, balance, createdAt FROM users WHERE uid = ?', [uid], (err, updated) => {
                res.json(updated);
            });
        }, 100);
    });
});

// ── BAKİYEYİ SET ET (frontend al/sat) ────────────────────────────────
app.patch('/api/users/:uid/setbalance', (req, res) => {
    const { balance } = req.body;
    if (isNaN(balance) || balance < 0) return res.status(400).json({ message: 'Geçersiz bakiye.' });

    db.run('UPDATE users SET balance = ? WHERE uid = ?', [parseFloat(balance), req.params.uid], (err) => {
        res.json({ uid: req.params.uid, balance: parseFloat(balance) });
    });
});

// ── BAKİYE ARTIR (admin) ──────────────────────────────────────────────
app.patch('/api/users/:uid/balance', (req, res) => {
    const { amount } = req.body;
    db.get('SELECT balance FROM users WHERE uid = ?', [req.params.uid], (err, row) => {
        if (!row) return res.status(404).json({ message: 'Kullanıcı bulunamadı.' });
        const newBalance = Math.max(0, row.balance + parseFloat(amount));
        db.run('UPDATE users SET balance = ? WHERE uid = ?', [newBalance, req.params.uid], () => {
            res.json({ uid: req.params.uid, balance: newBalance });
        });
    });
});

// ── KULLANICI SİL ─────────────────────────────────────────────────────
app.delete('/api/users/:uid', (req, res) => {
    db.run('DELETE FROM users WHERE uid = ?', [req.params.uid], function(err) {
        res.json({ success: true, message: `Kullanıcı silindi.` });
    });
});

// ── SUNUCU BAŞLAT ─────────────────────────────────────────────────────
const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
    console.log(`✅ Sunucu ${PORT} portunda aktif.`);
});