const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../config/database');
const auth = require('../middleware/auth');

// GET /me — refresh current user info (role, etc.)
router.get('/me', auth, async (req, res) => {
  try {
    const [rows] = await db.execute('SELECT id, username, role FROM admins WHERE id = ?', [req.user.id]);
    if (rows.length === 0) {
      return res.json({ code: 404, message: '用户不存在' });
    }
    res.json({ code: 0, data: { id: rows[0].id, username: rows[0].username, role: rows[0].role } });
  } catch (err) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const [rows] = await db.execute('SELECT * FROM admins WHERE username = ?', [username]);
    if (rows.length === 0) {
      return res.json({ code: 401, message: '用户名或密码错误' });
    }
    const admin = rows[0];
    const valid = await bcrypt.compare(password, admin.password_hash);
    if (!valid) {
      return res.json({ code: 401, message: '用户名或密码错误' });
    }
    await db.execute('UPDATE admins SET last_login = NOW() WHERE id = ?', [admin.id]);
    const token = jwt.sign(
      { id: admin.id, username: admin.username, role: admin.role },
      process.env.JWT_SECRET,
      { expiresIn: '30d' }
    );
    res.json({ code: 0, data: { token, user: { id: admin.id, username: admin.username, role: admin.role } } });
  } catch (err) {
    res.status(500).json({ code: 500, message: err.message });
  }
});

module.exports = router;
