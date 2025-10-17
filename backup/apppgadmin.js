// PostgreSQL version of your temple billing system
const express = require('express');
const session = require('express-session');
const { Pool } = require('pg');
const bodyParser = require('body-parser');
const path = require('path');
const ExcelJS = require('exceljs');
const moment = require('moment');

const app = express();
const db = new Pool({
  user: 'postgres',
  host: 'localhost',
  database: 'temple_pg',
  password: 'sagar',
  port: 5432
});

function getFiscalYear() {
  const now = new Date();
  const year = now.getFullYear();
  const month = now.getMonth();
  const startYear = month >= 3 ? year % 100 : (year - 1) % 100;
  const endYear = (startYear + 1) % 100;
  return `${startYear.toString().padStart(2, '0')}-${endYear.toString().padStart(2, '0')}`;
}

app.set('view engine', 'ejs');
app.use(express.static('public'));
app.use(bodyParser.urlencoded({ extended: false }));
app.use(session({
  secret: 'temple-secret',
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 15 * 60 * 1000 }
}));

app.get('/', (req, res) => {
  res.render('login', { error: null });
});

app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  try {
    const result = await db.query('SELECT * FROM users WHERE username = $1 AND password = $2', [username, password]);
    const row = result.rows[0];
    if (row) {
      req.session.user = row;
      req.session.loginTime = new Date();
      res.redirect('/dashboard');
    } else {
      res.render('login', { error: 'Invalid login.' });
    }
  } catch (err) {
    console.error(err);
    res.render('login', { error: 'Login failed.' });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});
// Required: express, db (your database instance), session middleware configured
app.get('/dashboard', async (req, res) => {
  if (!req.session.user) return res.redirect('/');

  const username = req.session.user.username;
  const range = req.query.range || 'today';
  const startParam = req.query.start;
  const endParam = req.query.end;

  const current = new Date();
  const formatDate = d => d.toISOString().slice(0, 10);

  let startDate, endDate;

  switch (range) {
    case 'yesterday':
      const yesterday = new Date();
      yesterday.setDate(current.getDate() - 1);
      startDate = endDate = formatDate(yesterday);
      break;

    case 'week':
      // Week starting Monday
      const today = new Date();
      const day = today.getDay() || 7; // Sunday=0, so treat as 7
      const monday = new Date(today);
      monday.setDate(today.getDate() - day + 1);
      startDate = formatDate(monday);
      endDate = formatDate(current);
      break;

    case 'month':
      startDate = formatDate(new Date(current.getFullYear(), current.getMonth(), 1));
      endDate = formatDate(current);
      break;

    case 'custom':
      // Use query params, fallback to today if not valid
      startDate = startParam || formatDate(current);
      endDate = endParam || formatDate(current);
      break;

    case 'today':
    default:
      startDate = endDate = formatDate(current);
      break;
  }

  const billDateSql = startDate !== endDate
    ? `bill_date::date BETWEEN $1 AND $2`
    : `bill_date::date = $1`;

  const params = startDate !== endDate ? [startDate, endDate] : [startDate];

  try {
    const [
      topPoojasRes, totalRes, userTotalRes, paymentModeSplitRes,
      userWiseRes, donationTotalRes, trendsRes
    ] = await Promise.all([
      // Top 5 Poojas excluding donations
      db.query(
        `SELECT pooja_name, SUM(qty) as count
         FROM billing
         WHERE ${billDateSql} AND pooja_name NOT ILIKE 'Donation%'
         GROUP BY pooja_name ORDER BY count DESC LIMIT 5`,
        params
      ),

      // Total collection
      db.query(
        `SELECT SUM(total) as total FROM billing WHERE ${billDateSql}`,
        params
      ),

      // User total
      db.query(
        `SELECT SUM(total) as total FROM billing WHERE ${billDateSql} AND username = $${params.length + 1}`,
        [...params, username]
      ),

      // Payment mode totals (online / cash)
      db.query(
        `SELECT payment_mode, SUM(total) as total FROM billing WHERE ${billDateSql} GROUP BY payment_mode`,
        params
      ),

      // Collection by user
      db.query(
        `SELECT username, SUM(total) as total FROM billing WHERE ${billDateSql} GROUP BY username ORDER BY total DESC`,
        params
      ),

      // Donation totals
      db.query(
        `SELECT SUM(total) as total FROM billing WHERE ${billDateSql} AND pooja_name ILIKE 'Donation%'`,
        params
      ),

      // Trends for last 7 days (always last 7 days, can adapt if needed)
      db.query(
        `SELECT TO_CHAR(bill_date::date, 'YYYY-MM-DD') as date, SUM(total) as amount
         FROM billing
         WHERE bill_date >= CURRENT_DATE - INTERVAL '6 days'
         GROUP BY bill_date::date
         ORDER BY date ASC`
      )
    ]);

    let online_total = 0, cash_total = 0;
    (paymentModeSplitRes.rows || []).forEach(row => {
      const mode = (row.payment_mode || '').toLowerCase();
      const total = parseFloat(row.total || 0);
      if (mode.includes('online')) online_total += total;
      else cash_total += total;
    });

    res.render('dashboard', {
      top_poojas: topPoojasRes.rows || [],
      total_collection: totalRes.rows[0]?.total || 0,
      user_total: userTotalRes.rows[0]?.total || 0,
      online_total,
      cash_total,
      donation_total: donationTotalRes.rows[0]?.total || 0,
      userwise: userWiseRes.rows || [],
      trends: trendsRes.rows || [],

      // Pass filter info to template
      range,
      startDate,
      endDate
    });

  } catch (err) {
    console.error("🔥 Dashboard error:", err.message);
    res.status(500).send("Failed to load dashboard");
  }
});


app.get('/billing', async (req, res) => {
  if (!req.session.user) return res.redirect('/');

  try {
   const result = await db.query('SELECT * FROM pooja_master WHERE visible = true ORDER BY pooja_name');

    res.render('billing', { poojas: result.rows });
  } catch (err) {
    console.error(err);
    res.send("Error loading billing page.");
  }
});


app.post('/billing', async (req, res) => {
  const {
    dev_name,
    pooja_name,
    qty,
    donation_purpose,
    donation_amount,
    payment_mode = 'Cash'
  } = req.body;

  const username = req.session.user.username;
  const fiscalYear = getFiscalYear();

  const bill_datetime = new Date(); // Store actual date+time in UTC
  const bill_date = bill_datetime.toLocaleString('en-GB', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true
  }).replace(',', ''); // e.g., "15/07/2025 05:45:23 pm"

  let price = 0;
  let total = 0;
  let qtyNum = parseInt(qty) || 1;
  let actualPoojaName = pooja_name;

  try {
    // 🎁 Donation case
    if (pooja_name === 'Donation') {
      if (!donation_purpose || !donation_amount) {
        return res.send("Donation purpose or amount missing.");
      }

      price = parseFloat(donation_amount);
      total = price;
      qtyNum = 1;
      actualPoojaName = `Donation – ${donation_purpose}`;
    } else {
      // 🙏 Regular pooja case
      if (isNaN(qtyNum) || qtyNum <= 0) return res.send("Invalid quantity");

      const priceResult = await db.query(
        'SELECT price FROM pooja_master WHERE pooja_name = $1',
        [pooja_name]
      );

      const row = priceResult.rows[0];
      if (!row) return res.send("Invalid pooja selected.");

      price = row.price;
      total = price * qtyNum;
    }

    // 🧾 Generate Receipt Number
    const lastReceipt = await db.query(
      'SELECT receipt_no FROM billing WHERE receipt_no LIKE $1 ORDER BY id DESC LIMIT 1',
      [`SRI/${fiscalYear}/%`]
    );

    let nextSerial = 1;
    if (lastReceipt.rows.length > 0) {
      const parts = lastReceipt.rows[0].receipt_no.split('/');
      const lastSerial = parseInt(parts[2]);
      nextSerial = isNaN(lastSerial) ? 1 : lastSerial + 1;
    }

    const receipt_no = `SRI/${fiscalYear}/${nextSerial}`;

    // 📝 Insert billing record
    const insertResult = await db.query(
      `INSERT INTO billing 
        (dev_name, pooja_name, qty, price, total, bill_date, bill_datetime, username, payment_mode, withdrawn, receipt_no) 
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING id`,
      [dev_name, actualPoojaName, qtyNum, price, total, bill_date, bill_datetime, username, payment_mode, 0, receipt_no]
    );

    const bill_id = insertResult.rows[0].id;

    // 🧾 Render Receipt
    res.render('receipt', {
      dev_name,
      pooja_name: actualPoojaName,
      qty: qtyNum,
      price,
      total,
      bill_id,
      bill_date, // this is formatted like "15/07/2025 05:45:23 pm"
      payment_mode,
      receipt_no
    });

  } catch (err) {
    console.error('❌ Billing error:', err);
    res.send("Billing failed: " + err.message);
  }
});

// Pooja Master
// GET Pooja Master Page
app.get('/pooja-master', async (req, res) => {
  if (!req.session.user) return res.redirect('/');

  try {
    const result = await db.query('SELECT * FROM pooja_master ORDER BY id');
    res.render('pooja', { poojas: result.rows });
  } catch (err) {
    console.error(err);
    res.send("Error loading pooja master.");
  }
});

// ADD a new pooja
app.post('/pooja-master/add', async (req, res) => {
  const { pooja_name, price } = req.body;

  try {
    await db.query('INSERT INTO pooja_master (pooja_name, price, visible) VALUES ($1, $2, true)', [pooja_name, price]);
    res.redirect('/pooja-master');
  } catch (err) {
    console.error(err);
    res.send("Failed to add pooja.");
  }
});

// UPDATE price
app.post('/pooja-master/update/:id', async (req, res) => {
  const { price } = req.body;
  const id = req.params.id;

  try {
    await db.query('UPDATE pooja_master SET price = $1 WHERE id = $2', [price, id]);
    res.redirect('/pooja-master');
  } catch (err) {
    console.error(err);
    res.send("Failed to update pooja.");
  }
});

// DELETE pooja
app.post('/pooja-master/delete/:id', async (req, res) => {
  const id = req.params.id;

  try {
    await db.query('DELETE FROM pooja_master WHERE id = $1', [id]);
    res.redirect('/pooja-master');
  } catch (err) {
    console.error(err);
    res.send("Failed to delete pooja.");
  }
});

// TOGGLE Visibility (Hide/Unhide)
app.post('/pooja-master/toggle/:id', async (req, res) => {
  const id = req.params.id;

  try {
    const current = await db.query('SELECT visible FROM pooja_master WHERE id = $1', [id]);
    const isVisible = current.rows[0]?.visible;

    await db.query('UPDATE pooja_master SET visible = $1 WHERE id = $2', [!isVisible, id]);
    res.redirect('/pooja-master');
  } catch (err) {
    console.error(err);
    res.send("Failed to toggle visibility.");
  }
});




// GET report page
app.get('/report', async (req, res) => {
  try {
    const poojasResult = await db.query('SELECT DISTINCT pooja_name FROM billing');
    const usersResult = await db.query('SELECT DISTINCT username FROM billing');
    const paymentModesResult = await db.query('SELECT DISTINCT payment_mode FROM billing');

    res.render('report', {
      poojas: poojasResult.rows || [],
      users: usersResult.rows || [],
      paymentModes: paymentModesResult.rows || [],
      results: null
    });

  } catch (err) {
    console.error("❌ GET /report error:", err.message);
    console.error("📛 Stack:", err.stack);
    res.status(500).send("Error loading report page.");
  }
});


// POST report page
app.post('/report', async (req, res) => {
  const { from, to, pooja_name, username, payment_mode } = req.body;

  const formattedFrom = moment(from, 'D/M/YYYY').format('YYYY-MM-DD');
  const formattedTo = moment(to, 'D/M/YYYY').format('YYYY-MM-DD');

  let sql = `
    SELECT * FROM billing 
    WHERE bill_date::DATE BETWEEN $1 AND $2`;
  const params = [formattedFrom, formattedTo];

  let i = 3;

  if (pooja_name) {
    sql += ` AND pooja_name = $${i++}`;
    params.push(pooja_name);
  }

  if (username) {
    sql += ` AND username = $${i++}`;
    params.push(username);
  }

  if (payment_mode) {
    sql += ` AND LOWER(payment_mode) = $${i++}`;
    params.push(payment_mode.toLowerCase());
  }

  try {
    const poojasResult = await db.query('SELECT DISTINCT pooja_name FROM billing');
    const usersResult = await db.query('SELECT DISTINCT username FROM billing');
    const paymentModesResult = await db.query('SELECT DISTINCT payment_mode FROM billing');
    const reportResult = await db.query(sql, params);

    const moment = require('moment');

res.render('report', {
  poojas: poojasResult.rows,
  users: usersResult.rows,
  paymentModes: paymentModesResult.rows,
  results: reportResult.rows,
  moment  // 👈 pass this
});

  } catch (err) {
    console.error("❌ POST /report error:", err.message);
    res.status(500).send("Error generating report.");
  }
});


app.get('/report/export', async (req, res) => {
  const { from, to, pooja_name, username, payment_mode } = req.query;

  if (!from || !to) {
    return res.status(400).send('Missing "from" and "to" query parameters.');
  }

  const formattedFrom = moment(from, 'D/M/YYYY').format('YYYY-MM-DD');
  const formattedTo = moment(to, 'D/M/YYYY').format('YYYY-MM-DD');

  let sql = `SELECT * FROM billing WHERE bill_date::DATE BETWEEN $1 AND $2`;
  const params = [formattedFrom, formattedTo];
  let i = 3;

  if (pooja_name) {
    sql += ` AND pooja_name = $${i++}`;
    params.push(pooja_name);
  }

  if (username) {
    sql += ` AND username = $${i++}`;
    params.push(username);
  }

  if (payment_mode) {
    sql += ` AND LOWER(payment_mode) = $${i++}`;
    params.push(payment_mode.toLowerCase());
  }

  try {
    const result = await db.query(sql, params);

    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Temple Report');

    worksheet.columns = [
      { header: 'Receipt No', key: 'receipt_no', width: 15 },
      { header: 'Date & Time', key: 'bill_datetime_formatted', width: 22 },
      { header: 'Devotee', key: 'dev_name', width: 20 },
      { header: 'Pooja', key: 'pooja_name', width: 20 },
      { header: 'Qty', key: 'qty', width: 10 },
      { header: 'Total ₹', key: 'total', width: 12 },
      { header: 'Payment Mode', key: 'payment_mode', width: 15 },
      { header: 'User', key: 'username', width: 15 },
    ];

 result.rows.forEach(row => {
  const datetimeRaw = row.bill_datetime || row.bill_date || null;
  const datetimeFormatted = datetimeRaw
    ? moment(new Date(datetimeRaw)).format('DD/MM/YYYY HH:mm:ss')
    : 'Invalid Date';

  worksheet.addRow({
    receipt_no: row.receipt_no,
    bill_datetime_formatted: datetimeFormatted,
    dev_name: row.dev_name,
    pooja_name: row.pooja_name,
    qty: row.qty,
    total: row.total,
    payment_mode: row.payment_mode,
    username: row.username
  });
});


    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=temple-report.xlsx');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error('❌ Export error:', err.message);
    res.status(500).send("Database error");
  }
});





//const express = require('express');
const router = express.Router();

app.get('/collections', async (req, res) => {
  if (!req.session.user) return res.redirect('/');

  const username = req.session.user.username;
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const filterDate = req.query.date;
  const selectedDate = filterDate || today;

  try {
    // Billing summary for selected date
    const billingResult = await db.query(`
      SELECT payment_mode, SUM(total) AS amount
      FROM billing
      WHERE username = $1 AND bill_date::DATE = $2
      GROUP BY payment_mode
    `, [username, selectedDate]);

    let cash = 0, online = 0;
    billingResult.rows.forEach(row => {
      const mode = (row.payment_mode || '').toLowerCase();
      const amount = parseFloat(row.amount || 0);
      if (mode.includes('online')) online += amount;
      else cash += amount;
    });

    // Donations for selected date
    const donationRes = await db.query(`
      SELECT SUM(total) AS amount
      FROM billing
      WHERE username = $1 AND bill_date::DATE = $2
        AND pooja_name ILIKE 'Donation%'
    `, [username, selectedDate]);
    const donation = parseFloat(donationRes.rows[0]?.amount || 0);

    // Withdrawals for selected date
    const withdrawalsRes = await db.query(`
      SELECT * FROM withdrawals
      WHERE username = $1 AND date::DATE = $2
      ORDER BY created_at DESC
    `, [username, selectedDate]);

    // Total handed over on this date
    const sumHandoverRes = await db.query(`
      SELECT SUM(handover) AS sum_handover
      FROM withdrawals
      WHERE username = $1 AND date::DATE = $2
    `, [username, selectedDate]);
    const alreadyWithdrawn = parseFloat(sumHandoverRes.rows[0]?.sum_handover || 0);

    const total = cash + online;
    const remaining = cash - alreadyWithdrawn;

    // Compose daily summary object
    const summary = {
      cash,
      online,
      donation,
      total,
      remaining,
      withdrawn: alreadyWithdrawn
    };

    res.render('collections', {
      user: username,
      today,
      filterDate,
      summary,
      withdrawals: withdrawalsRes.rows
    });
  } catch (err) {
    console.error('/collections error:', err);
    res.status(500).send('Failed to load collections: ' + err.message);
  }
});

// POST handler remains as in your original code

module.exports = router;


// POST /withdraw
app.post('/withdraw', async (req, res) => {
  if (!req.session.user) return res.redirect('/');

  const username = req.session.user.username;
  const handover = parseFloat(req.body.handover_amount) || 0;
  const now = new Date();
  const todayDate = now.toISOString().slice(0, 10); // YYYY-MM-DD

  try {
    // Re-calculate for today (so today's handover never exceeds available)
    const paymentRes = await db.query(`
      SELECT payment_mode, SUM(total) AS amount
      FROM billing
      WHERE username = $1 AND bill_date::DATE = $2
      GROUP BY payment_mode
    `, [username, todayDate]);
    let cash = 0, online = 0;
    paymentRes.rows.forEach(row => {
      const mode = (row.payment_mode || '').toLowerCase();
      const amount = parseFloat(row.amount || 0);
      if (mode.includes('online')) online += amount;
      else cash += amount;
    });

    // Today's donations:
    const donationRes = await db.query(`
      SELECT SUM(total) AS amount
      FROM billing
      WHERE username = $1 AND bill_date::DATE = $2
        AND pooja_name ILIKE 'Donation%'
    `, [username, todayDate]);
    const donation = parseFloat(donationRes.rows[0]?.amount || 0);

    // Already withdrawn today:
    const sumRes = await db.query(`
      SELECT SUM(handover) AS total
      FROM withdrawals WHERE username = $1 AND date::DATE = $2
    `, [username, todayDate]);
    const alreadyWithdrawn = parseFloat(sumRes.rows[0]?.total || 0);

    const remaining = cash - (alreadyWithdrawn + handover);

    // Insert withdrawal:
    await db.query(`
      INSERT INTO withdrawals
      (username, date, cash, online, donation, handover, remaining, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
    `, [username, now, cash, online, donation, handover, remaining]);

    res.redirect('/collections');
  } catch (err) {
    console.error("❌ Error saving withdrawal:", err);
    res.status(500).send("Error saving withdrawal: " + err.message);
  }
});

module.exports = router;

app.listen(3000, () => {
  console.log('✅ Temple Billing running at http://localhost:3000');
});
