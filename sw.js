// Controle+ Service Worker v2
const CACHE = 'controle-v1';

self.addEventListener('install', e => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

// ── Alertas salvos no SW (recebidos da página) ──
let _alerts = [];

self.addEventListener('message', e => {
  if (e.data?.type === 'UPDATE_ALERTS') {
    _alerts = e.data.alerts || [];
  }
  if (e.data?.type === 'PING') {
    // Página ainda aberta — verifica agora
    checkAlerts();
  }
});

// ── Periodic Background Sync (Chrome Android com PWA instalada) ──
self.addEventListener('periodicsync', e => {
  if (e.tag === 'price-alerts') {
    e.waitUntil(checkAlertsFromStorage());
  }
});

// ── Push (fallback futuro) ──
self.addEventListener('push', e => {
  if (e.data) notify(e.data.json());
});

// Lê alertas direto do IndexedDB/storage via clients
async function checkAlertsFromStorage() {
  // Tenta pegar alertas da página aberta primeiro
  const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  if (clients.length > 0) {
    // Página aberta — pede pra ela checar
    clients[0].postMessage({ type: 'CHECK_NOW' });
    return;
  }
  // App fechado — usa alertas que foram enviados via UPDATE_ALERTS
  await checkAlerts();
}

async function checkAlerts() {
  const active = _alerts.filter(a => a.active && !a.triggered);
  if (!active.length) return;

  try {
    const pairs = [...new Set(active.map(a => a.moeda))].map(m=>`${m}-BRL`).join(',');

    // AwesomeAPI — cotação real do mercado brasileiro
    const res = await fetch(`https://economia.awesomeapi.com.br/json/last/${pairs}`, { cache: 'no-store' });
    if (!res.ok) throw new Error('awesomeapi falhou');
    const data = await res.json();

    const rates = { BRL: 1 };
    Object.entries(data).forEach(([key, val]) => {
      // key = "USDBRL" → code = "USD"
      const code = key.replace('BRL','');
      rates[code] = parseFloat(val.bid);
    });

    const triggered = [];
    _alerts = _alerts.map(a => {
      if (!a.active || a.triggered) return a;
      const rate = rates[a.moeda];
      if (!rate) return a;
      const hit = a.cond === 'acima' ? rate >= a.valor : rate <= a.valor;
      if (hit) { triggered.push({ ...a, rateNow: rate }); return { ...a, triggered: true }; }
      return a;
    });

    if (!triggered.length) return;

    // Notifica a página se aberta
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    clients.forEach(c => c.postMessage({ type: 'ALERTS_TRIGGERED', triggered, allAlerts: _alerts }));

    // Dispara notificações
    for (const a of triggered) {
      const ico = a.cond === 'acima' ? '▲' : '▼';
      const brl = a.rateNow.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
      await self.registration.showNotification(`💰 Alerta ${a.moeda} ${ico} R$ ${a.valor.toFixed(2)}`, {
        body: `Cotação atual: R$ ${brl}\nToque para abrir o Controle+`,
        icon: '/financeiro/icon-192.png',
        badge: '/financeiro/icon-192.png',
        tag: `fin-alert-${a.id}`,
        requireInteraction: true,
        renotify: true,
        vibrate: [200, 100, 200],
        data: { url: self.registration.scope }
      });
    }
  } catch(e) {}
}

// Clique na notificação → abre o app
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/financeiro/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(clients => {
      const open = clients.find(c => c.url.includes('financeiro'));
      return open ? open.focus() : self.clients.openWindow(url);
    })
  );
});
