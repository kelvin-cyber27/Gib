const form = document.getElementById('signup-form');
const payBtn = document.getElementById('pay-btn');
const statusBox = document.getElementById('status-message');

function showStatus(message, type) {
  statusBox.textContent = message;
  statusBox.className = `status ${type}`;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();

  const email = document.getElementById('email').value.trim();
  const phone = document.getElementById('phone').value.trim();

  if (!email || !phone) {
    showStatus('Please fill in all fields.', 'error');
    return;
  }

  payBtn.disabled = true;
  payBtn.textContent = 'Sending STK Push…';
  showStatus('Requesting M‑Pesa prompt…', 'info');

  try {
    const res = await fetch('/api/stkpush', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, phone }),
    });

    const data = await res.json();

    if (!data.success) {
      throw new Error(data.error || 'Payment initiation failed');
    }

    showStatus(
      '✅ STK Push sent! Check your phone and enter your M‑Pesa PIN.',
      'success'
    );

    // Poll for payment confirmation (backend stores paid users in memory)
    pollForAccess(email);
  } catch (err) {
    showStatus(`❌ ${err.message}`, 'error');
    payBtn.disabled = false;
    payBtn.textContent = 'Pay $2 & Activate';
  }
});

/**
 * Poll the dashboard route until the user is marked as paid.
 * In production use a WebSocket or a dedicated “payment status” endpoint.
 */
function pollForAccess(email) {
  let attempts = 0;
  const maxAttempts = 24; // 24 × 5s = 2 minutes

  const interval = setInterval(async () => {
    attempts++;

    // Check if backend has marked this email as paid
    // by trying to fetch the protected dashboard with ?email=
    const res = await fetch(`/dashboard?email=${encodeURIComponent(email)}`, {
      redirect: 'manual',
    });

    if (res.status === 200) {
      clearInterval(interval);
      showStatus('🎉 Payment confirmed! Redirecting…', 'success');
      setTimeout(() => {
        window.location.href = `/dashboard?email=${encodeURIComponent(email)}`;
      }, 1200);
    } else if (attempts >= maxAttempts) {
      clearInterval(interval);
      showStatus(
        '⏳ Payment not confirmed yet. If you paid, please refresh the page.',
        'info'
      );
    }
  }, 5000);
}
