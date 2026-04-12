const CACHE = 'controle-v1';
const ASSETS = ['./', './index.html', './icon.svg'];

// Instala e cacheia assets principais
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting())
  );
});

// Ativa e limpa caches antigos
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// Fetch — network first, cache fallback
self.addEventListener('fetch', e => {
  // Ignora requests não-GET e externos
  if(e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if(url.origin !== location.origin) return;

  e.respondWith(
    fetch(e.request)
      .then(res => {
        if(res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});

// ── ALERTAS DE COTAÇÃO EM BACKGROUND ──
let _alerts = [];

self.addEventListener('message', e => {
  if(e.data?.type === 'UPDATE_ALERTS') {
    _alerts = e.data.alerts || [];
  }
  if(e.data?.type === 'PING') {
    checkAlerts();
  }
});

self.addEventListener('periodicsync', e => {
  if(e.tag === 'price-alerts') e.waitUntil(checkAlerts());
});

async function checkAlerts() {
  if(!_alerts.length) return;
  const active = _alerts.filter(a => a.active !== false);
  if(!active.length) return;

  try {
    const moedas = [...new Set(active.map(a => a.moeda).filter(m => !['BTC','ETH','BNB','SOL','XRP','ADA','DOGE','DOT'].includes(m)))];
    if(!moedas.length) return;

    const pairs = moedas.map(m => `${m}-BRL`).join(',');
    const res = await fetch(`https://economia.awesomeapi.com.br/json/last/${pairs}`);
    const data = await res.json();

    const triggered = [];
    const updated = _alerts.map(a => {
      const key = `${a.moeda}BRL`;
      const rate = data[key] ? parseFloat(data[key].bid) : null;
      if(!rate) return a;
      const hit = a.cond === 'acima' ? rate >= a.valor : rate <= a.valor;
      if(hit && a.active !== false) {
        triggered.push({ ...a, rateNow: rate });
        return { ...a, active: false };
      }
      return a;
    });

    if(triggered.length) {
      _alerts = updated;
      // Notifica clientes abertos
      const clients = await self.clients.matchAll();
      clients.forEach(c => c.postMessage({ type: 'ALERTS_TRIGGERED', triggered, allAlerts: updated }));
      // Push notification se app fechado
      triggered.forEach(a => {
        const ico = a.cond === 'acima' ? '▲' : '▼';
        self.registration.showNotification(`🔔 Alerta ${a.moeda} ${ico} R$ ${a.valor.toFixed(2)}`, {
          body: `Cotação atual: R$ ${Number(a.rateNow).toLocaleString('pt-BR',{minimumFractionDigits:4,maximumFractionDigits:4})}`,
          icon: './icon.svg',
          badge: './icon.svg',
          tag: `alert-${a.moeda}`,
          renotify: true,
        });
      });
    }
  } catch(e) {}
}
