const CACHE = 'controle-v2';
const ASSETS = ['./', './index.html', './manifest.json', './icon.svg'];
const ALERT_STATE_URL = './__alert_state__';
const CRYPTO_IDS = {BTC:'bitcoin',ETH:'ethereum',BNB:'binancecoin',SOL:'solana',XRP:'ripple',ADA:'cardano',DOGE:'dogecoin',DOT:'polkadot'};

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
    e.waitUntil?.(saveAlertState());
  }
  if(e.data?.type === 'PING' || e.data?.type === 'START_ALERT_CHECK') {
    e.waitUntil?.(checkAlerts());
  }
});

self.addEventListener('periodicsync', e => {
  if(e.tag === 'price-alerts') e.waitUntil(checkAlerts());
});

async function checkAlerts() {
  await restoreAlertState();
  if(!_alerts.length) return;
  const active = _alerts.filter(a => a.active !== false && !a.triggered);
  if(!active.length) return;

  try {
    const fiatMoedas = [...new Set(active.map(a => a.moeda).filter(m => !CRYPTO_IDS[m]))];
    const cryptoMoedas = [...new Set(active.map(a => a.moeda).filter(m => CRYPTO_IDS[m]))];
    const rateMap = {};

    if(fiatMoedas.length){
      try {
        const pairs = fiatMoedas.map(m => `${m}-BRL`).join(',');
        const res = await fetch(`https://economia.awesomeapi.com.br/json/last/${pairs}`);
        const data = await res.json();
        fiatMoedas.forEach(code=>{
          const key = `${code}BRL`;
          if(data[key]) rateMap[code] = parseFloat(data[key].bid);
        });
      } catch(e) {}
    }

    if(cryptoMoedas.length){
      const ids = cryptoMoedas.map(code => CRYPTO_IDS[code]).filter(Boolean).join(',');
      if(ids){
        try {
          const res = await fetch(`https://api.coingecko.com/api/v3/coins/markets?vs_currency=brl&ids=${ids}&order=market_cap_desc&sparkline=false`);
          const data = await res.json();
          if(Array.isArray(data)){
            data.forEach(item=>{
              const code = Object.keys(CRYPTO_IDS).find(k => CRYPTO_IDS[k] === item.id);
              if(code && Number.isFinite(Number(item.current_price))) rateMap[code] = Number(item.current_price);
            });
          }
        } catch(e) {}
      }
    }

    const triggered = [];
    const updated = _alerts.map(a => {
      if(a.triggered || a.active === false) return a;
      const rate = rateMap[a.moeda];
      if(!rate) return a;
      const hit = a.cond === 'acima' ? rate >= a.valor : rate <= a.valor;
      if(hit && a.active !== false) {
        triggered.push({ ...a, rateNow: rate });
        return { ...a, active: false, triggered: true };
      }
      return a;
    });

    if(triggered.length) {
      _alerts = updated;
      await saveAlertState();
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

async function saveAlertState(){
  try {
    const cache = await caches.open(CACHE);
    await cache.put(ALERT_STATE_URL, new Response(JSON.stringify(_alerts), {
      headers: { 'Content-Type': 'application/json' }
    }));
  } catch(e) {}
}

async function restoreAlertState(){
  if(_alerts.length) return;
  try {
    const cache = await caches.open(CACHE);
    const res = await cache.match(ALERT_STATE_URL);
    if(res){
      const data = await res.json();
      if(Array.isArray(data)) _alerts = data;
    }
  } catch(e) {}
}
