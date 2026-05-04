const express = require('express');
const Database = require('better-sqlite3');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const https = require('https');

const app = express();
app.use(cors());
app.use(express.json());

// ── VERİTABANI KURULUMU ──────────────────────────────────────────────
const db = new Database('adxpro.db');

db.exec(`
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

// UID üretici
function generateUID() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const rand = (n) => Array.from({length: n}, () => chars[Math.floor(Math.random() * chars.length)]).join('');
    return `ADX-${rand(4)}-${rand(4)}`;
}

// HTTP yardımcısı
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
    const existing = db.prepare('SELECT id FROM users WHERE email = ?').get(email);
    if (existing)
        return res.status(409).json({ message: 'Bu e-posta zaten kayıtlı.' });
    const hashed = await bcrypt.hash(password, 10);
    let uid;
    do { uid = generateUID(); } while (db.prepare('SELECT id FROM users WHERE uid = ?').get(uid));
    db.prepare('INSERT INTO users (uid, fullName, email, password) VALUES (?, ?, ?, ?)').run(uid, fullName, email, hashed);
    const user = db.prepare('SELECT id, uid, fullName, email, balance, createdAt FROM users WHERE uid = ?').get(uid);
    res.status(201).json(user);
});

// ── GİRİŞ ─────────────────────────────────────────────────────────────
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    if (!email || !password)
        return res.status(400).json({ message: 'E-posta ve şifre gerekli.' });
    const user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) return res.status(401).json({ message: 'E-posta bulunamadı.' });
    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ message: 'Şifre hatalı.' });
    const { password: _, ...safeUser } = user;
    res.json({ user: safeUser });
});

// ── TÜM KULLANICILARI LİSTELE ─────────────────────────────────────────
app.get('/api/admin/users', (req, res) => {
    const users = db.prepare('SELECT id, uid, fullName, email, password, balance, createdAt FROM users ORDER BY id DESC').all();
    res.json(users);
});

// ── TEK KULLANICI GETİR ───────────────────────────────────────────────
app.get('/api/users/:uid', (req, res) => {
    const user = db.prepare('SELECT id, uid, fullName, email, balance, createdAt FROM users WHERE uid = ?').get(req.params.uid);
    if (!user) return res.status(404).json({ message: 'Kullanıcı bulunamadı.' });
    res.json(user);
});

// ── KULLANICI GÜNCELLE ────────────────────────────────────────────────
app.patch('/api/users/:uid/update', async (req, res) => {
    const { fullName, password } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE uid = ?').get(req.params.uid);
    if (!user) return res.status(404).json({ message: 'Kullanıcı bulunamadı.' });
    if (fullName) db.prepare('UPDATE users SET fullName = ? WHERE uid = ?').run(fullName, req.params.uid);
    if (password) {
        if (password.length < 8) return res.status(400).json({ message: 'Şifre en az 8 karakter.' });
        const hashed = await bcrypt.hash(password, 10);
        db.prepare('UPDATE users SET password = ? WHERE uid = ?').run(hashed, req.params.uid);
    }
    const updated = db.prepare('SELECT id, uid, fullName, email, balance, createdAt FROM users WHERE uid = ?').get(req.params.uid);
    res.json(updated);
});

// ── BAKİYEYİ SET ET (frontend al/sat) ────────────────────────────────
app.patch('/api/users/:uid/setbalance', (req, res) => {
    const { balance } = req.body;
    if (isNaN(balance) || balance < 0) return res.status(400).json({ message: 'Geçersiz bakiye.' });
    const user = db.prepare('SELECT * FROM users WHERE uid = ?').get(req.params.uid);
    if (!user) return res.status(404).json({ message: 'Kullanıcı bulunamadı.' });
    db.prepare('UPDATE users SET balance = ? WHERE uid = ?').run(parseFloat(balance), req.params.uid);
    res.json({ uid: req.params.uid, balance: parseFloat(balance) });
});

// ── BAKİYE ARTIR (admin) ──────────────────────────────────────────────
app.patch('/api/users/:uid/balance', (req, res) => {
    const { amount } = req.body;
    const user = db.prepare('SELECT * FROM users WHERE uid = ?').get(req.params.uid);
    if (!user) return res.status(404).json({ message: 'Kullanıcı bulunamadı.' });
    const newBalance = Math.max(0, user.balance + parseFloat(amount));
    db.prepare('UPDATE users SET balance = ? WHERE uid = ?').run(newBalance, req.params.uid);
    res.json({ uid: req.params.uid, balance: newBalance });
});

// ── KULLANICI SİL ─────────────────────────────────────────────────────
app.delete('/api/users/:uid', (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE uid = ?').get(req.params.uid);
    if (!user) return res.status(404).json({ message: 'Kullanıcı bulunamadı.' });
    db.prepare('DELETE FROM users WHERE uid = ?').run(req.params.uid);
    res.json({ success: true, message: `${user.fullName} silindi.` });
});

// ── SUNUCU BAŞLAT ─────────────────────────────────────────────────────
app.listen(3001, () => {
    console.log('✅ ADX Pro Sunucu çalışıyor: http://localhost:3001');
    console.log('📊 Admin panel: http://localhost:3001/api/admin/users');
});