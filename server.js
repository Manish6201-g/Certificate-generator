const express    = require('express');
const nodemailer = require('nodemailer');
const cors       = require('cors');
const path       = require('path');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

// Serve static assets securely without exposing backend source files
app.use('/css', express.static(path.join(__dirname, 'css')));
app.use('/js',  express.static(path.join(__dirname, 'js')));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/index.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// Cache transporters to pool and reuse connections for bulk email sending
const transporterCache = new Map();

function getTransporter(smtp) {
  const port = parseInt(smtp.port, 10) || 587;
  const secure = port === 465;
  const cacheKey = `${smtp.host}:${port}:${smtp.user}:${smtp.pass}:${secure}`;

  if (!transporterCache.has(cacheKey)) {
    const transporter = nodemailer.createTransport({
      pool: true,
      maxConnections: 3,
      maxMessages: 100,
      host:   smtp.host,
      port,
      secure,
      auth:   { user: smtp.user, pass: smtp.pass },
      tls:    { rejectUnauthorized: false },
    });
    transporterCache.set(cacheKey, transporter);
  }
  return { transporter: transporterCache.get(cacheKey), cacheKey };
}

// POST /api/test-smtp  — verify credentials without sending
app.post('/api/test-smtp', async (req, res) => {
  const { smtp } = req.body;
  if (!smtp || !smtp.host || !smtp.user || !smtp.pass) {
    return res.status(400).json({ error: 'host, user and pass are required' });
  }

  const { transporter, cacheKey } = getTransporter(smtp);

  try {
    await transporter.verify();
    res.json({ ok: true, message: 'SMTP connection successful' });
  } catch (err) {
    transporterCache.delete(cacheKey);
    console.error('Test error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// POST /api/send-email
// Body: { smtp, to, subject, html, attachmentBase64, filename }
app.post('/api/send-email', async (req, res) => {
  const { smtp, to, subject, html, attachmentBase64, filename } = req.body;

  if (!smtp || !to || !subject || !attachmentBase64) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const senderEmail = ((smtp.fromEmail && smtp.fromEmail.trim()) || smtp.user || '').trim();
  if (!senderEmail || !senderEmail.includes('@')) {
    return res.status(400).json({
      error: 'Invalid sender: Please provide a valid email address in "From Email" in the SMTP settings.'
    });
  }

  const hostLower = (smtp.host || '').toLowerCase();
  if ((hostLower.includes('mailrcld') || hostLower.includes('mailercloud')) && (senderEmail.endsWith('@gmail.com') || senderEmail.endsWith('@googlemail.com'))) {
    return res.status(400).json({
      error: 'Mailercloud does not permit sending from @gmail.com addresses. To send from your Gmail address, change SMTP Host to "smtp.gmail.com" and use a Google App Password.'
    });
  }

  const fromOption = smtp.fromName && smtp.fromName.trim()
    ? { name: smtp.fromName.trim(), address: senderEmail }
    : senderEmail;

  console.log(`[send-email] to: ${to} | sender: ${senderEmail} | fromName: "${smtp.fromName || ''}" | host: ${smtp.host}`);

  const { transporter, cacheKey } = getTransporter(smtp);

  try {
    const info = await transporter.sendMail({
      from:     fromOption,
      to,
      subject,
      html,
      priority: 'high',
      headers: {
        'X-Priority':        '1',
        'X-MSMail-Priority': 'High',
        'Importance':        'High',
      },
      attachments: [{
        filename:    filename || 'certificate.png',
        content:     attachmentBase64,
        encoding:    'base64',
        contentType: 'image/png',
      }],
    });

    console.log(`[send-email] SUCCESS messageId: ${info.messageId}`);
    res.json({ ok: true, messageId: info.messageId });
  } catch (err) {
    transporterCache.delete(cacheKey);
    console.error(`[send-email] FAILED for ${to}:`, err.message);
    if (err.response) {
      console.error(`[send-email] SMTP Server Response:`, err.response);
    }
    res.status(500).json({ error: err.message, response: err.response });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Certificate mailer running → http://localhost:${PORT}`);
  console.log('Open http://localhost:' + PORT + '/index.html in your browser.');
});
