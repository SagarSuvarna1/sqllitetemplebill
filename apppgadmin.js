const express = require('express');
const session = require('express-session');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const path = require('path');
const ExcelJS = require('exceljs');
const moment = require('moment');

const app = express();

// SQLite DB connection
const db = new sqlite3.Database('./temple.db', (err) => {
  if (err) {
    console.error('❌ SQLite connection error:', err.message);
  } else {
    console.log('✅ Connected to SQLite database.');
  }
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

// Login Page
app.get('/', (req, res) => {
  res.render('login', { error: null });
});

// Login POST (SQLite)
app.post('/login', (req, res) => {
  const { username, password } = req.body;

  const sql = 'SELECT * FROM users WHERE username = ? AND password = ?';
  db.get(sql, [username, password], (err, row) => {
    if (err) {
      console.error('❌ Login error:', err.message);
      return res.render('login', { error: 'Login failed.' });
    }

    if (row) {
      req.session.user = row;
      req.session.loginTime = new Date();
      res.redirect('/dashboard');
    } else {
      res.render('login', { error: 'Invalid login.' });
    }
  });
});

// Logout
app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

// Helper to promisify db.all
function dbAllAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// Helper to promisify db.get
function dbGetAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

// Dashboard route
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
      const today = new Date();
      const day = today.getDay() || 7;
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
      startDate = startParam || formatDate(current);
      endDate = endParam || formatDate(current);
      break;

    case 'today':
    default:
      startDate = endDate = formatDate(current);
      break;
  }

  const isRange = startDate !== endDate;
  const dateCondition = isRange
    ? `date(bill_date) BETWEEN ? AND ?`
    : `date(bill_date) = ?`;
  const dateParams = isRange ? [startDate, endDate] : [startDate];

  try {
    // Top 5 Poojas excluding donations
    const topPoojas = await dbAllAsync(
      `SELECT pooja_name, SUM(qty) as count
       FROM billing
       WHERE ${dateCondition} AND pooja_name NOT LIKE 'Donation%' COLLATE NOCASE
       GROUP BY pooja_name
       ORDER BY count DESC
       LIMIT 5`,
      dateParams
    );

    // Total collection
    const totalRes = await dbGetAsync(
      `SELECT SUM(total) AS total FROM billing WHERE ${dateCondition}`,
      dateParams
    );

    // User total
    const userTotalRes = await dbGetAsync(
      `SELECT SUM(total) AS total FROM billing WHERE ${dateCondition} AND username = ?`,
      [...dateParams, username]
    );

    // Payment mode totals
    const paymentModes = await dbAllAsync(
      `SELECT payment_mode, SUM(total) AS total
       FROM billing
       WHERE ${dateCondition}
       GROUP BY payment_mode`,
      dateParams
    );

    // Collection by user
    const userwise = await dbAllAsync(
      `SELECT username, SUM(total) AS total
       FROM billing
       WHERE ${dateCondition}
       GROUP BY username
       ORDER BY total DESC`,
      dateParams
    );

    // Donation totals
    const donationRes = await dbGetAsync(
      `SELECT SUM(total) AS total
       FROM billing
       WHERE ${dateCondition} AND pooja_name LIKE 'Donation%' COLLATE NOCASE`,
      dateParams
    );

    // Trends for last 7 days
    const trends = await dbAllAsync(
      `SELECT date(bill_date) AS date, SUM(total) AS amount
       FROM billing
       WHERE date(bill_date) >= date('now', '-6 days')
       GROUP BY date(bill_date)
       ORDER BY date ASC`
    );

    // Calculate online vs cash totals
    let online_total = 0, cash_total = 0;
    (paymentModes || []).forEach(row => {
      const mode = (row.payment_mode || '').toLowerCase();
      const total = parseFloat(row.total || 0);
      if (mode.includes('online')) online_total += total;
      else cash_total += total;
    });

    // Render dashboard
    res.render('dashboard', {
      top_poojas: topPoojas || [],
      total_collection: totalRes?.total || 0,
      user_total: userTotalRes?.total || 0,
      online_total,
      cash_total,
      donation_total: donationRes?.total || 0,
      userwise: userwise || [],
      trends: trends || [],
      range,
      startDate,
      endDate
    });

  } catch (err) {
    console.error("🔥 Dashboard error:", err.message);
    res.status(500).send("Failed to load dashboard");
  }
});
// ---------------- Helper functions ----------------
function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows));
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
  });
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve(this); // this.lastID
    });
  });
}

// ---------------- Billing Page (Load Pooja List) ----------------
app.get('/billing', async (req, res) => {
  if (!req.session.user) return res.redirect('/');

  try {
    const poojas = await dbAll(`SELECT * FROM pooja_master WHERE visible = 1 ORDER BY pooja_name`);
    res.render('billing', { poojas: poojas || [] });
  } catch (err) {
    console.error("❌ Error loading billing page:", err);
    res.send("Error loading billing page.");
  }
});

// ---------------- Billing Submission ----------------
app.post('/billing', async (req, res) => {
  if (!req.session.user) return res.redirect('/');

  const {
    dev_name,
    pooja_name,
    qty,
    donation_purpose,
    donation_amount,
    payment_mode = 'Cash',
    reference_id
  } = req.body;

  const username = req.session.user.username;
  const fiscalYear = getFiscalYear();
  const bill_datetime = new Date().toISOString(); // Store ISO date
  const bill_date = bill_datetime.split('T')[0];   // YYYY-MM-DD

  let price = 0;
  let total = 0;
  let qtyNum = parseInt(qty) || 1;
  let actualPoojaName = pooja_name;

  try {
    // ----- Handle Donation -----
    if (pooja_name === 'Donation') {
      if (!donation_purpose || !donation_amount) {
        return res.send("Donation purpose or amount missing.");
      }
      price = parseFloat(donation_amount);
      total = price;
      qtyNum = 1;
      actualPoojaName = `Donation – ${donation_purpose}`;
    } else {
      if (isNaN(qtyNum) || qtyNum <= 0) return res.send("Invalid quantity");
      const poojaRow = await dbGet(`SELECT price FROM pooja_master WHERE pooja_name = ?`, [pooja_name]);
      if (!poojaRow) return res.send("Invalid pooja selected.");
      price = poojaRow.price;
      total = price * qtyNum;
    }

    // ----- Generate Receipt Number -----
    const lastReceipt = await dbGet(
      `SELECT receipt_no FROM billing WHERE receipt_no LIKE ? ORDER BY id DESC LIMIT 1`,
      [`SRI/${fiscalYear}/%`]
    );

    let nextSerial = 1;
    if (lastReceipt) {
      const parts = lastReceipt.receipt_no.split('/');
      const lastSerial = parseInt(parts[2]);
      nextSerial = isNaN(lastSerial) ? 1 : lastSerial + 1;
    }
    const receipt_no = `SRI/${fiscalYear}/${nextSerial}`;

    // ----- Insert Billing Record -----
    const result = await dbRun(
      `INSERT INTO billing
      (dev_name, pooja_name, qty, price, total, bill_date, bill_datetime, username, payment_mode, withdrawn, receipt_no, reference_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        dev_name,
        actualPoojaName,
        qtyNum,
        price,
        total,
        bill_date,
        bill_datetime,
        username,
        payment_mode,
        receipt_no,
        payment_mode.toLowerCase() === 'online' ? reference_id : null
      ]
    );

    const bill_id = result.lastID;

    // ----- Render Receipt Page -----
    res.render('receipt', {
      dev_name,
      pooja_name: actualPoojaName,
      qty: qtyNum,
      price,
      total,
      bill_id,
      bill_date,
      payment_mode,
      receipt_no,
      reference_id: payment_mode.toLowerCase() === 'online' ? reference_id : null
    });

  } catch (err) {
    console.error('❌ Billing error:', err);
    res.send("Billing failed: " + err.message);
  }
});

// ----- Helper Promises for SQLite -----
function dbAll(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

function dbGet(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

function dbRun(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve(this); // use this.lastID
    });
  });
}

// ----- GET Pooja Master Page -----
app.get('/pooja-master', async (req, res) => {
  if (!req.session.user) return res.redirect('/');
  try {
    const poojas = await dbAll(`SELECT * FROM pooja_master ORDER BY id`);
    res.render('pooja', { poojas: poojas || [] });
  } catch (err) {
    console.error("❌ Error loading pooja master:", err);
    res.send("Error loading pooja master.");
  }
});

// ----- ADD a New Pooja -----
app.post('/pooja-master/add', async (req, res) => {
  const { pooja_name, price } = req.body;
  if (!pooja_name || !price) return res.send("Pooja name and price required.");

  try {
    await dbRun(
      `INSERT INTO pooja_master (pooja_name, price, visible) VALUES (?, ?, 1)`,
      [pooja_name, price]
    );
    res.redirect('/pooja-master');
  } catch (err) {
    console.error("❌ Failed to add pooja:", err);
    res.send("Failed to add pooja.");
  }
});

// ----- UPDATE Pooja Price -----
app.post('/pooja-master/update/:id', async (req, res) => {
  const { price } = req.body;
  const id = req.params.id;
  if (!price) return res.send("Price is required.");

  try {
    await dbRun(`UPDATE pooja_master SET price = ? WHERE id = ?`, [price, id]);
    res.redirect('/pooja-master');
  } catch (err) {
    console.error("❌ Failed to update pooja:", err);
    res.send("Failed to update pooja.");
  }
});

// ----- DELETE Pooja -----
app.post('/pooja-master/delete/:id', async (req, res) => {
  const id = req.params.id;
  try {
    await dbRun(`DELETE FROM pooja_master WHERE id = ?`, [id]);
    res.redirect('/pooja-master');
  } catch (err) {
    console.error("❌ Failed to delete pooja:", err);
    res.send("Failed to delete pooja.");
  }
});

// ----- TOGGLE Visibility (Hide/Unhide) -----
app.post('/pooja-master/toggle/:id', async (req, res) => {
  const id = req.params.id;
  try {
    const row = await dbGet(`SELECT visible FROM pooja_master WHERE id = ?`, [id]);
    const newValue = row?.visible ? 0 : 1;
    await dbRun(`UPDATE pooja_master SET visible = ? WHERE id = ?`, [newValue, id]);
    res.redirect('/pooja-master');
  } catch (err) {
    console.error("❌ Failed to toggle visibility:", err);
    res.send("Failed to toggle visibility.");
  }
});
// Helper to promisify db.all
function dbAllAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// Helper to promisify db.get
function dbGetAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

// GET /report page
app.get('/report', async (req, res) => {
  if (!req.session.user) return res.redirect('/');

  try {
    const poojas = await dbAllAsync('SELECT DISTINCT pooja_name FROM billing');
    const users = await dbAllAsync('SELECT DISTINCT username FROM billing');
    const paymentModes = await dbAllAsync('SELECT DISTINCT payment_mode FROM billing');

    res.render('report', {
      poojas: poojas || [],
      users: users || [],
      paymentModes: paymentModes || [],
      results: null,
      moment
    });

  } catch (err) {
    console.error("❌ GET /report error:", err);
    res.status(500).send("Error loading report page.");
  }
});

// POST /report (filter results)
app.post('/report', async (req, res) => {
  if (!req.session.user) return res.redirect('/');

  const { from, to, pooja_name, username, payment_mode } = req.body;

  const formattedFrom = moment(from, 'D/M/YYYY').format('YYYY-MM-DD');
  const formattedTo = moment(to, 'D/M/YYYY').format('YYYY-MM-DD');

  let sql = `SELECT * FROM billing WHERE date(bill_date) BETWEEN ? AND ?`;
  const params = [formattedFrom, formattedTo];

  if (pooja_name) {
    sql += ` AND pooja_name = ?`;
    params.push(pooja_name);
  }

  if (username) {
    sql += ` AND username = ?`;
    params.push(username);
  }

  if (payment_mode) {
    sql += ` AND LOWER(payment_mode) = ?`;
    params.push(payment_mode.toLowerCase());
  }

  try {
    const poojas = await dbAllAsync('SELECT DISTINCT pooja_name FROM billing');
    const users = await dbAllAsync('SELECT DISTINCT username FROM billing');
    const paymentModes = await dbAllAsync('SELECT DISTINCT payment_mode FROM billing');
    const results = await dbAllAsync(sql, params);

    res.render('report', {
      poojas,
      users,
      paymentModes,
      results,
      moment
    });

  } catch (err) {
    console.error("❌ POST /report error:", err);
    res.status(500).send("Error generating report.");
  }
});

// GET /report/export (export filtered report to Excel)
app.get('/report/export', async (req, res) => {
  if (!req.session.user) return res.redirect('/');

  const { from, to, pooja_name, username, payment_mode } = req.query;

  if (!from || !to) return res.status(400).send('Missing "from" and "to" query parameters.');

  const formattedFrom = moment(from, 'D/M/YYYY').format('YYYY-MM-DD');
  const formattedTo = moment(to, 'D/M/YYYY').format('YYYY-MM-DD');

  let sql = `SELECT * FROM billing WHERE date(bill_date) BETWEEN ? AND ?`;
  const params = [formattedFrom, formattedTo];

  if (pooja_name) {
    sql += ` AND pooja_name = ?`;
    params.push(pooja_name);
  }

  if (username) {
    sql += ` AND username = ?`;
    params.push(username);
  }

  if (payment_mode) {
    sql += ` AND LOWER(payment_mode) = ?`;
    params.push(payment_mode.toLowerCase());
  }

  try {
    const results = await dbAllAsync(sql, params);

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
      { header: 'Reference ID', key: 'reference_id', width: 25 },
      { header: 'User', key: 'username', width: 15 },
    ];

    results.forEach(row => {
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
        reference_id: row.reference_id || '',
        username: row.username
      });
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=temple-report.xlsx');
    await workbook.xlsx.write(res);
    res.end();

  } catch (err) {
    console.error('❌ Export error:', err);
    res.status(500).send("Database error");
  }
});


// Helper to promisify db.all
function dbAllAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// Helper to promisify db.get
function dbGetAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

// GET /collections
app.get('/collections', async (req, res) => {
  if (!req.session.user) return res.redirect('/');

  const username = req.session.user.username;
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const filterDate = req.query.date;
  const selectedDate = filterDate || today;

  try {
    // Billing summary for selected date
    const billingResult = await dbAllAsync(`
      SELECT payment_mode, SUM(total) AS amount
      FROM billing
      WHERE username = ? AND date(bill_date) = ?
      GROUP BY payment_mode
    `, [username, selectedDate]);

    let cash = 0, online = 0;
    billingResult.forEach(row => {
      const mode = (row.payment_mode || '').toLowerCase();
      const amount = parseFloat(row.amount || 0);
      if (mode.includes('online')) online += amount;
      else cash += amount;
    });

    // Donations for selected date
    const donationRes = await dbGetAsync(`
      SELECT SUM(total) AS amount
      FROM billing
      WHERE username = ? AND date(bill_date) = ? AND LOWER(pooja_name) LIKE 'donation%'
    `, [username, selectedDate]);
    const donation = parseFloat(donationRes?.amount || 0);

    // Withdrawals for selected date
    const withdrawalsRes = await dbAllAsync(`
      SELECT * FROM withdrawals
      WHERE username = ? AND date(date) = ?
      ORDER BY created_at DESC
    `, [username, selectedDate]);

    // Total handed over on this date
    const sumHandoverRes = await dbGetAsync(`
      SELECT SUM(handover) AS sum_handover
      FROM withdrawals
      WHERE username = ? AND date(date) = ?
    `, [username, selectedDate]);
    const alreadyWithdrawn = parseFloat(sumHandoverRes?.sum_handover || 0);

    const total = cash + online;
    const remaining = cash - alreadyWithdrawn;

    const summary = { cash, online, donation, total, remaining, withdrawn: alreadyWithdrawn };

    res.render('collections', {
      user: username,
      today,
      filterDate,
      summary,
      withdrawals: withdrawalsRes
    });

  } catch (err) {
    console.error('/collections error:', err);
    res.status(500).send('Failed to load collections: ' + err.message);
  }
});

// POST /withdraw
app.post('/withdraw', async (req, res) => {
  if (!req.session.user) return res.redirect('/');

  const username = req.session.user.username;
  const handover = parseFloat(req.body.handover_amount) || 0;
  const now = new Date();
  const todayDate = now.toISOString().slice(0, 10); // YYYY-MM-DD

  try {
    // Get today's billing totals
    const paymentRes = await dbAllAsync(`
      SELECT payment_mode, SUM(total) AS amount
      FROM billing
      WHERE username = ? AND date(bill_date) = ?
      GROUP BY payment_mode
    `, [username, todayDate]);

    let cash = 0, online = 0;
    paymentRes.forEach(row => {
      const mode = (row.payment_mode || '').toLowerCase();
      const amount = parseFloat(row.amount || 0);
      if (mode.includes('online')) online += amount;
      else cash += amount;
    });

    const donationRes = await dbGetAsync(`
      SELECT SUM(total) AS amount
      FROM billing
      WHERE username = ? AND date(bill_date) = ? AND LOWER(pooja_name) LIKE 'donation%'
    `, [username, todayDate]);
    const donation = parseFloat(donationRes?.amount || 0);

    const sumRes = await dbGetAsync(`
      SELECT SUM(handover) AS total
      FROM withdrawals
      WHERE username = ? AND date(date) = ?
    `, [username, todayDate]);
    const alreadyWithdrawn = parseFloat(sumRes?.total || 0);

    const remaining = cash - (alreadyWithdrawn + handover);

    await db.run(`
      INSERT INTO withdrawals
      (username, date, cash, online, donation, handover, remaining, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, [username, now.toISOString(), cash, online, donation, handover, remaining, now.toISOString()]);

    res.redirect('/collections');

  } catch (err) {
    console.error("❌ Error saving withdrawal:", err);
    res.status(500).send("Error saving withdrawal: " + err.message);
  }
});


// Helper to promisify db.all
function dbAllAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows);
    });
  });
}

// Helper to promisify db.run
function dbRunAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function(err) {
      if (err) reject(err);
      else resolve(this);
    });
  });
}

// Helper to promisify db.get
function dbGetAsync(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
      if (err) reject(err);
      else resolve(row);
    });
  });
}

// POST /expenses/add
app.post('/expenses/add', async (req, res) => {
  const { expense_date, purpose, amount, added_by } = req.body;
  if (!expense_date || !purpose || !amount) {
    return res.status(400).send("All fields are required.");
  }
  try {
    await dbRunAsync(
      `INSERT INTO expenses (expense_date, purpose, amount, added_by) VALUES (?, ?, ?, ?)`,
      [expense_date, purpose, amount, added_by || 'Admin']
    );
    res.redirect('/expenses');
  } catch (err) {
    console.error(err);
    res.status(500).send("Database error");
  }
});

// GET /expenses - List/Filter Expenses

// GET /expenses - List/Filter Expenses
app.get('/expenses', async (req, res) => {
  const { from, to } = req.query;
  let sql = `SELECT * FROM expenses`;
  const params = [];

  if (from && to) {
    sql += ` WHERE expense_date BETWEEN ? AND ?`;
    params.push(from, to);
  }
  sql += ` ORDER BY expense_date DESC`;

  try {
    const result = await dbAllAsync(sql, params);

    // Format dates for EJS
    const formattedExpenses = result.map(e => ({
      ...e,
      expense_date_formatted: moment(e.expense_date).format('YYYY-MM-DD') // or 'DD/MM/YYYY'
    }));

    res.render('expenses', {
      expenses: formattedExpenses,
      from: from || '',
      to: to || ''
    });
  } catch (err) {
    console.error(err);
    res.status(500).send("Database error");
  }
});

// GET /expenses/export - Export to Excel
app.get('/expenses/export', async (req, res) => {
  const { from, to } = req.query;
  let sql = `SELECT * FROM expenses`;
  const params = [];

  if (from && to) {
    sql += ` WHERE expense_date BETWEEN ? AND ?`;
    params.push(from, to);
  }
  sql += ` ORDER BY expense_date DESC`;

  try {
    const result = await dbAllAsync(sql, params);

    const ExcelJS = require('exceljs');
    const moment = require('moment');
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Temple Expenses');

    worksheet.columns = [
      { header: 'Date', key: 'expense_date', width: 15 },
      { header: 'Purpose', key: 'purpose', width: 40 },
      { header: 'Amount ₹', key: 'amount', width: 15 },
      { header: 'Added By', key: 'added_by', width: 20 },
    ];

    result.forEach(row => {
      worksheet.addRow({
        expense_date: moment(row.expense_date).format('DD/MM/YYYY'),
        purpose: row.purpose,
        amount: row.amount,
        added_by: row.added_by
      });
    });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', 'attachment; filename=temple-expenses.xlsx');
    await workbook.xlsx.write(res);
    res.end();
  } catch (err) {
    console.error(err);
    res.status(500).send("Database error");
  }
});

// Start server
app.listen(3000, () => {
  console.log('✅ Temple Billing running at http://localhost:3000');
});
