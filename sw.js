// Controle+ Service Worker — Alertas de cotação em background
const SW_VERSION = 'v1';
const CHECK_INTERVAL = 5 * 60 * 1000; // 5 minutos

// ── Instala e ativa imediatamente ──
self.addEventListener('install',  e => { self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(self.clients.claim()); });

// ── Recebe mensagens da página ──
self.addEventListener('message', e => {
  if (e.data?.type === 'START_ALERT_CHECK') {
    startPeriodicCheck();
  }
  if (e.data?.type === 'STOP_ALERT_CHECK') {
    stopPeriodicCheck();
  }
  if (e.data?.type === 'UPDATE_ALERTS') {
    // Página enviou alertas atualizados
    self._alerts = e.data.alerts || [];
  }
});

let _checkTimer = null;
let _alerts = [];

function startPeriodicCheck() {
  if (_checkTimer) return; // já rodando
  _checkTimer = setInterval(checkAlerts, CHECK_INTERVAL);
  // Também verifica imediatamente
  checkAlerts();
}

function stopPeriodicCheck() {
  if (_checkTimer) { clearInterval(_checkTimer); _checkTimer = null; }
}

async function checkAlerts() {
  const activeAlerts = _alerts.filter(a => a.active && !a.triggered);
  if (!activeAlerts.length) return;

  try {
    const syms = [...new Set(activeAlerts.map(a => a.moeda))].join(',');
    const res  = await fetch(`https://api.frankfurter.app/latest?from=BRL&to=${syms}`);
    const data = await res.json();

    // Converte: data.rates[USD] = quanto USD vale 1 BRL → inverte para BRL por 1 moeda
    const ratesInBRL = { BRL: 1 };
    Object.entries(data.rates).forEach(([k, v]) => { ratesInBRL[k] = 1 / v; });

    const triggered = [];
    activeAlerts.forEach(a => {
      const rate = ratesInBRL[a.moeda];
      if (!rate) return;
      const hit = a.cond === 'acima' ? rate >= a.valor : rate <= a.valor;
      if (hit) triggered.push({ ...a, rateNow: rate });
    });

    if (triggered.length) {
      // Marca como disparados no storage
      const allAlerts = _alerts.map(a => {
        if (triggered.find(t => t.id === a.id)) return { ...a, triggered: true };
        return a;
      });
      _alerts = allAlerts;

      // Notifica a página se estiver aberta
      const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
      clients.forEach(c => c.postMessage({ type: 'ALERTS_TRIGGERED', triggered, allAlerts }));

      // Dispara notificações do sistema
      for (const a of triggered) {
        const ico = a.cond === 'acima' ? '▲' : '▼';
        const brl = a.rateNow.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
        await self.registration.showNotification(`💰 Controle+ — Alerta ${a.moeda}`, {
          body: `${a.moeda} ${ico} R$ ${a.valor.toFixed(2)}\nCotação atual: R$ ${brl}`,
          icon: 'https://akasacrypto-droid.github.io/financeiro/icon.png',
          badge: 'https://akasacrypto-droid.github.io/financeiro/icon.png',
          tag: `alert-${a.id}`,
          renotify: false,
          requireInteraction: true,
          data: { url: self.registration.scope }
        });
      }
    }
  } catch (e) {
    // Sem conexão — tenta na próxima rodada
  }
}

// Abre o app ao clicar na notificação
self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || self.registration.scope;
  e.waitUntil(
    self.clients.matchAll({ type: 'window' }).then(clients => {
      const existing = clients.find(c => c.url.startsWith(self.registration.scope));
      if (existing) return existing.focus();
      return self.clients.openWindow(url);
    })
  );
});

// ── Periodic Background Sync (Chrome Android) ──
self.addEventListener('periodicsync', e => {
  if (e.tag === 'price-alerts') {
    e.waitUntil(checkAlerts());
  }
});
