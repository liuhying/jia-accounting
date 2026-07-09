const accountSet = require('./middleware/accountSet');
require('dotenv').config({ path: '/var/www/jia_app/.env' });
const express = require('express');
const cors = require('cors');

const citiesRoutes = require('./routes/cities');
const shopsRoutes = require('./routes/shops');
const categoriesRoutes = require('./routes/categories');
const authRoutes = require('./routes/auth');
const announcementsRoutes = require('./routes/announcements');
const feedbackRoutes = require('./routes/feedback');
const noticesRoutes = require("./routes/notices");
const configRoutes = require('./routes/config');

const usersRoutes = require('./routes/users');
const productsRoutes = require('./routes/products');
const ordersRoutes = require('./routes/orders');
const withdrawsRoutes = require('./routes/withdraws');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '10mb' }));

app.get('/', (req, res) => {
  res.json({ name: '家APP API', version: '1.0.0', status: 'running' });
});

app.use('/api/cities', citiesRoutes);
app.use('/api/shops', shopsRoutes);
app.use('/api/categories', categoriesRoutes);
app.use('/api/auth', authRoutes);
app.use('/api/announcements', announcementsRoutes);
app.use('/api/feedback', feedbackRoutes);
app.use('/api/config', configRoutes);
app.use('/api/notices', noticesRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/products', productsRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/withdraws', withdrawsRoutes);

app.use('/api/accounting', accountSet, require('./routes/accounting'));
app.use('/api/tax', require('./routes/tax'));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`家APP backend running on port ${PORT}`);
});
