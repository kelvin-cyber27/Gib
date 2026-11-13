require('dotenv').config();
const express = require('express');
const axios = require('axios');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// –––––––– In‑memory store for paid users ––––––––
// In production use a real database (PostgreSQL, MongoDB, etc.)
const paidUsers = new Set();

// –––––––– Helpers ––––––––
const BASE_URL =
  process.env.DARAJA_ENV === 'production'
    ? 'https://api.safaricom.co.ke'
    : 'https://sandbox.safaricom.co.ke';

/** Get OAuth access token */
async function getAccessToken() {
  const auth = Buffer.from(
    `${process.env.CONSUMER_KEY}:${process.env.CONSUMER_SECRET}`
  ).toString('base64');

  const { data } = await axios.get(
    `${BASE_URL}/oauth/v1/generate?grant_type=client_credentials`,
    { headers: { Authorization: `Basic ${auth}` } }
  );
  return data.access_token;
}

/** Generate timestamp yyyyMMddHHmmss */
function generateTimestamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(
    d.getHours()
  )}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** Generate STK password = base64(shortcode + passkey + timestamp) */
function generatePassword() {
  const ts = generateTimestamp();
  const raw = `${process.env.BUSINESS_SHORT_CODE}${process.env.PASSKEY}${ts}`;
  return Buffer.from(raw).toString('base64');
}

// –––––––– STK Push endpoint ––––––––
app.post('/api/stkpush', async (req, res) => {
  const { phone, email } = req.body;

  if (!phone || !email) {
    return res.status(400).json({ error: 'Phone and email are required.' });
  }

  // Normalise phone: remove leading 0 or +254, ensure 2547XXXXXXXX
  let msisdn = phone.replace(/\D/g, '');
  if (msisdn.startsWith('0')) msisdn = '254' + msisdn.slice(1);
  if (msisdn.startsWith('254') === false) msisdn = '254' + msisdn;

  const amountKES = Number(process.env.USD_TO_KES) * 2; // $2 → KES

  try {
    const token = await getAccessToken();
    const timestamp = generateTimestamp();
    const password = generatePassword();

    const payload = {
      BusinessShortCode: process.env.BUSINESS_SHORT_CODE,
      Password: password,
      Timestamp: timestamp,
      TransactionType: 'CustomerPayBillOnline',
      Amount: amountKES,
      PartyA: msisdn,
      PartyB: process.env.BUSINESS_SHORT_CODE,
      PhoneNumber: msisdn,
      CallBackURL: process.env.CALLBACK_URL,
      AccountReference: `SIGNUP-${email}`,
      TransactionDesc: 'Dropshipping signup fee ($2)',
    };

    const { data } = await axios.post(
      `${BASE_URL}/mpesa/stkpush/v1/processrequest`,
      payload,
      { headers: { Authorization: `Bearer ${token}` } }
    );

    // Store the CheckoutRequestID so we can match the callback
    // In production store this in DB together with user email.
    console.log('STK Push sent:', data);

    res.json({
      success: true,
      checkoutRequestId: data.CheckoutRequestID,
      message: 'STK Push sent. Check your phone for the M‑Pesa prompt.',
    });
  } catch (err) {
    console.error('STK Push error:', err.response?.data || err.message);
    res.status(500).json({
      success: false,
      error: err.response?.data?.errorMessage || 'STK Push failed',
    });
  }
});

// –––––––– M‑Pesa callback webhook ––––––––
app.post('/api/mpesa/callback', (req, res) => {
  // Respond immediately – Safaricom expects a response within 5 s[reference:2]
  res.json({ ResultCode: 0, ResultDesc: 'Success' });

  const callback = req.body?.Body?.stkCallback;
  if (!callback) return;

  console.log('M‑Pesa callback:', JSON.stringify(callback, null, 2));

  if (callback.ResultCode === 0) {
    // Payment successful – extract metadata
    const items = callback.CallbackMetadata?.Item || [];
    const phone = items.find((i) => i.Name === 'PhoneNumber')?.Value;
    const amount = items.find((i) => i.Name === 'Amount')?.Value;
    const receipt = items.find((i) => i.Name === 'MpesaReceiptNumber')?.Value;
    const accountRef = items.find((i) => i.Name === 'AccountReference')?.Value;

    // Extract email from account reference (SIGNUP-email)
    const email = accountRef?.replace('SIGNUP-', '');
    if (email) paidUsers.add(email);

    console.log(
      `✅ Payment confirmed – ${email} paid ${amount} KES (receipt: ${receipt})`
    );

    // In production: update DB, send confirmation email, etc.
  } else {
    console.log(`❌ Payment failed – ResultCode ${callback.ResultCode}`);
  }
});

// –––––––– Protected dashboard route ––––––––
app.get('/dashboard', (req, res) => {
  const email = req.query.email;
  if (!email || !paidUsers.has(email)) {
    return res.redirect('/?error=payment_required');
  }
  res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

// –––––––– Start ––––––––
app.listen(process.env.PORT, () => {
  console.log(`🚀 Server running on http://localhost:${process.env.PORT}`);
});
