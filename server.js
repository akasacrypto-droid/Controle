const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT || 8765);
const ROOT = __dirname;
const FIAT_CODES = ['USD', 'EUR', 'GBP', 'ARS', 'JPY', 'CAD', 'CHF', 'CNY', 'AUD', 'MXN'];

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'access-control-allow-origin': '*',
  });
  res.end(body);
}

function getJson(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, {
      headers: {
        accept: 'application/json',
        'user-agent': 'ControleCambio/1.0',
      },
      timeout: 15000,
    }, response => {
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { body += chunk; });
      response.on('end', () => {
        if (response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode}`));
          return;
        }

        try {
          resolve(JSON.parse(body));
        } catch (error) {
          reject(error);
        }
      });
    });

    req.on('timeout', () => req.destroy(new Error('Timeout na fonte de cambio')));
    req.on('error', reject);
  });
}

async function fetchRealtimeRates() {
  const pairs = FIAT_CODES.map(code => `${code}-BRL`).join(',');
  let data;
  try {
    data = await getJson(`https://economia.awesomeapi.com.br/json/last/${pairs}`);
  } catch (error) {
    const fallback = await getJson('https://open.er-api.com/v6/latest/BRL');
    const rates = { BRL: 1 };

    FIAT_CODES.forEach(code => {
      const value = fallback.rates && fallback.rates[code];
      if (value) rates[code] = 1 / value;
    });

    return {
      ok: true,
      source: 'open.er-api.com',
      fetchedAt: new Date().toISOString(),
      rates,
      changes: {},
      raw: fallback,
    };
  }
  const rates = { BRL: 1 };
  const changes = {};
  const raw = {};

  FIAT_CODES.forEach(code => {
    const item = data[`${code}BRL`];
    if (!item) return;

    const bid = Number(item.bid);
    const pct = Number(item.pctChange);
    if (Number.isFinite(bid)) rates[code] = bid;
    if (Number.isFinite(pct)) changes[code] = pct;
    raw[code] = item;
  });

  return {
    ok: true,
    source: 'AwesomeAPI',
    fetchedAt: new Date().toISOString(),
    rates,
    changes,
    raw,
  };
}

function serveFile(req, res) {
  const urlPath = req.url === '/' ? '/index.html' : decodeURIComponent(req.url.split('?')[0]);
  const filePath = path.resolve(ROOT, `.${urlPath}`);

  if (!filePath.startsWith(ROOT)) {
    send(res, 403, 'Forbidden', 'text/plain; charset=utf-8');
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      send(res, 404, 'Not found', 'text/plain; charset=utf-8');
      return;
    }

    const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(content);
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    send(res, 204, '');
    return;
  }

  if (req.url.startsWith('/api/cambio/realtime')) {
    try {
      const payload = await fetchRealtimeRates();
      send(res, 200, JSON.stringify(payload));
    } catch (error) {
      send(res, 502, JSON.stringify({ ok: false, error: error.message }));
    }
    return;
  }

  serveFile(req, res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Controle rodando em http://127.0.0.1:${PORT}`);
});
