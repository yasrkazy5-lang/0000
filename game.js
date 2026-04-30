// ============================================================
// WORLD WAR ONLINE — game.js  (client)
// Full server-connected version
// ============================================================

// ─────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────
const SERVER_URL = window.location.origin;
const WS_URL     = (location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host;

// ─────────────────────────────────────────
// CLIENT STATE
// ─────────────────────────────────────────
const C = {
  token      : localStorage.getItem('wwo_token') || null,
  nationId   : localStorage.getItem('wwo_nationId') || null,
  nation     : null,
  gamedata   : null,
  territories: {},   // id -> ownerNationId
  players    : [],
  alliances  : [],
  leaderboard: [],
  tradeOffers: [],
  chatChannel: 'world',
  warTarget  : null,
  ws         : null,
  wsReady    : false,
  mapSX      : 0, mapSY: 0, mapScale: 1,
  dragging   : false, dStartX: 0, dStartY: 0,
  pingT      : 0,
  tick       : 0,
  selFlag    : '🦁',
  selColor   : '#8B0000',
  selIdeology: null,
};

// ─────────────────────────────────────────
// FLAGS & COLORS
// ─────────────────────────────────────────
const ALL_FLAGS = [
  '🦅','🐉','🦁','⭐','🌙','☀️','🌊','🔥','⚡','❄️',
  '🌿','🗡️','🛡️','👑','⚔️','🏰','🦊','🐺','🦋','🌹',
  '🗺️','⚓','🏹','🔱','🌐','💎','🦂','🌪️','🧿','🗻',
];
const COLORS = [
  '#8B0000','#1a3a8B','#2d5a27','#7a5a00','#4a007a','#007a7a',
  '#7a3a00','#005a5a','#8B4500','#3a3a8B','#5a8B00','#8B006a',
];
const CONT_NAMES = {
  namerica:'أمريكا الشمالية', samerica:'أمريكا الجنوبية',
  europe:'أوروبا', mideast:'الشرق الأوسط',
  africa:'أفريقيا', asia:'آسيا', oceania:'أوقيانوسيا',
};

// ─────────────────────────────────────────
// BOOT
// ─────────────────────────────────────────
window.onload = () => {
  spawnParticles();
  animateOnlineCount();
  if (C.token && C.nationId) {
    loadGameAndStart();
  }
};

function spawnParticles() {
  const bg = document.getElementById('ptBg');
  if (!bg) return;
  for (let i = 0; i < 45; i++) {
    const p = document.createElement('div');
    p.className = 'pt';
    const sz = Math.random() * 3 + 1;
    p.style.cssText = `left:${Math.random()*100}%;width:${sz}px;height:${sz}px;
      background:hsl(${40+Math.random()*20},80%,60%);
      animation-duration:${Math.random()*14+7}s;animation-delay:${Math.random()*12}s`;
    bg.appendChild(p);
  }
}

function animateOnlineCount() {
  let n = 1200;
  setInterval(() => {
    n += Math.floor(Math.random() * 7 - 3);
    const el = document.getElementById('olc');
    if (el) el.textContent = n.toLocaleString('ar-EG');
  }, 3000);
}

// ─────────────────────────────────────────
// AUTH
// ─────────────────────────────────────────
async function doLogin() {
  const user = document.getElementById('uIn').value.trim();
  const pass = document.getElementById('pIn').value.trim();
  const err  = document.getElementById('loginErr');
  if (!user) { shk('uIn'); err.textContent = '⚠️ أدخل اسم القائد'; return; }
  if (!pass) { shk('pIn'); err.textContent = '⚠️ أدخل كلمة المرور'; return; }
  err.textContent = 'جاري التحقق...';

  try {
    const res = await api('POST', '/api/auth', { username: user, password: pass });
    if (res.needsNation) {
      C.token = 'tmp_' + user + '_' + pass; // temp until nation created
      localStorage.setItem('wwo_token', C.token);
      err.textContent = '';
      showScreen('createScreen');
      buildCreateUI();
      return;
    }
    if (res.error) { err.textContent = '❌ ' + res.error; return; }
    C.token    = res.token;
    C.nationId = res.nationId;
    C.nation   = res.nation;
    localStorage.setItem('wwo_token', res.token);
    localStorage.setItem('wwo_nationId', res.nationId);
    err.textContent = '';
    await loadGameAndStart();
  } catch (e) {
    // Offline fallback
    C.token    = 'offline_token';
    C.nationId = 'offline_nation';
    C.nation   = buildOfflineNation(user);
    localStorage.setItem('wwo_token', C.token);
    localStorage.setItem('wwo_nationId', C.nationId);
    err.textContent = '';
    showNotif('⚠️ تشغيل بدون سيرفر (وضع أوفلاين)', 'info');
    showScreen('createScreen');
    buildCreateUI();
  }
}

async function doRegister() {
  const user = document.getElementById('uIn').value.trim();
  if (!user) { shk('uIn'); document.getElementById('loginErr').textContent = '⚠️ أدخل اسماً أولاً'; return; }
  C.token = 'new_' + user;
  localStorage.setItem('wwo_token', C.token);
  document.getElementById('loginErr').textContent = '';
  showScreen('createScreen');
  buildCreateUI();
}

function buildOfflineNation(user) {
  return {
    id: 'offline_nation', name: user + '\'s Nation', flag: '🦁',
    color: '#8B0000', ideology: 'empire',
    territories: ['t4'], military: { infantry:50,tank:10,artillery:5,fighter:3,bomber:1,navy:2,submarine:1,missile:0,nuclear:0 },
    buildings: {}, techs: [],
    resources: { gold:10000, iron:5000, food:8000, energy:2000, pop:1000000 },
    stats: { wins:0, losses:0 },
  };
}

async function loadGameAndStart() {
  try {
    const gd = await api('GET', '/api/gamedata');
    C.gamedata   = gd;
    C.territories = (await api('GET', '/api/territories')) || {};
    C.alliances  = gd.alliances || [];
    if (!C.nation) {
      const n = await api('GET', '/api/nation/' + C.nationId);
      C.nation = n;
    }
    startGame();
  } catch {
    // offline fallback with embedded data
    C.gamedata = getEmbeddedGamedata();
    C.territories = {};
    if (!C.nation) C.nation = buildOfflineNation('قائد');
    startGame();
  }
}

// ─────────────────────────────────────────
// CREATE NATION UI
// ─────────────────────────────────────────
function buildCreateUI() {
  // Flags
  const fg = document.getElementById('flagGrid');
  fg.innerHTML = '';
  ALL_FLAGS.forEach(f => {
    const el = document.createElement('div');
    el.className = 'fg' + (f === C.selFlag ? ' sel' : '');
    el.textContent = f;
    el.onclick = () => { C.selFlag = f; document.querySelectorAll('.fg').forEach(x=>x.classList.remove('sel')); el.classList.add('sel'); };
    fg.appendChild(el);
  });

  // Colors
  const cr = document.getElementById('colorRow');
  cr.innerHTML = '';
  COLORS.forEach(c => {
    const el = document.createElement('div');
    el.className = 'cs' + (c === C.selColor ? ' sel' : '');
    el.style.background = c;
    el.onclick = () => { C.selColor = c; document.querySelectorAll('.cs').forEach(x=>x.classList.remove('sel')); el.classList.add('sel'); };
    cr.appendChild(el);
  });

  // Ideologies
  const ig = document.getElementById('ideoGrid');
  ig.innerHTML = '';
  const ideos = C.gamedata?.ideologies || getEmbeddedGamedata().ideologies;
  C.selIdeology = ideos[2]; // empire default
  ideos.forEach(id => {
    const el = document.createElement('div');
    el.className = 'ic' + (id.id === C.selIdeology.id ? ' sel' : '');
    el.innerHTML = `<div class="ii">${id.icon}</div><div class="in">${id.name}</div><div class="ib">${Object.entries(id.bonuses).map(([k,v])=>'+'+v+'% '+k).join(' | ')}</div>`;
    el.onclick = () => { C.selIdeology = id; document.querySelectorAll('.ic').forEach(x=>x.classList.remove('sel')); el.classList.add('sel'); };
    ig.appendChild(el);
  });
}

async function doCreateNation() {
  const name = document.getElementById('nNameIn').value.trim();
  if (!name) { shk('nNameIn'); showNotif('⚠️ أدخل اسم الدولة!', 'info'); return; }

  const nationData = {
    name, flag: C.selFlag, color: C.selColor,
    ideology: C.selIdeology?.id || 'empire',
  };

  try {
    const res = await api('POST', '/api/auth', {
      username: C.token.replace(/^(tmp_|new_)/, '').split('_')[0],
      password: C.token.split('_')[1] || 'pass',
      nationData,
    });
    if (res.token) {
      C.token    = res.token;
      C.nationId = res.nationId;
      C.nation   = res.nation;
      localStorage.setItem('wwo_token', res.token);
      localStorage.setItem('wwo_nationId', res.nationId);
    }
  } catch {
    C.nation = {
      id: 'offline_nation', name, flag: C.selFlag,
      color: C.selColor, ideology: C.selIdeology?.id || 'empire',
      territories: ['t4'], military: { infantry:50,tank:10,artillery:5,fighter:3,bomber:1,navy:2,submarine:1,missile:0,nuclear:0 },
      buildings:{}, techs:[],
      resources:{ gold:10000,iron:5000,food:8000,energy:2000,pop:1000000 },
      stats:{ wins:0,losses:0 },
    };
    C.nationId = 'offline_nation';
  }

  showNotif('🎉 تأسست ' + name + '! انطلق للمعركة!', 'alliance');
  if (!C.gamedata) C.gamedata = getEmbeddedGamedata();
  setTimeout(startGame, 600);
}

// ─────────────────────────────────────────
// START GAME
// ─────────────────────────────────────────
function startGame() {
  showScreen('gameScreen');
  updateTopBar();
  renderMap();
  buildMinimap();
  renderLeftPanel('nation');
  buildPlayersList();
  connectWS();
  loadChatHistory();
  loadTradeOffers();
  startClientTick();

  setTimeout(() => {
    showNotif('⚔️ مرحباً في ساحة الحرب العالمية!', 'war');
    setTimeout(() => showNotif('💡 انقر على منطقة لاحتلالها أو مهاجمتها!', 'info'), 1600);
    setTimeout(() => showNotif('🤝 انضم لتحالف لتعزيز قوتك!', 'alliance'), 3200);
  }, 400);
}

// ─────────────────────────────────────────
// WEBSOCKET
// ─────────────────────────────────────────
function connectWS() {
  setConn('wait', 'جاري الاتصال...');
  try {
    C.ws = new WebSocket(WS_URL);
  } catch {
    setConn('off', 'لا يوجد سيرفر — وضع أوفلاين');
    simulateOfflineEvents();
    return;
  }

  C.ws.onopen = () => {
    setConn('on', 'متصل بالسيرفر ✓');
    C.wsReady = true;
    if (C.token) wsSend({ type: 'auth', token: C.token });
    pingLoop();
  };

  C.ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handleWsMsg(msg);
  };

  C.ws.onerror = () => setConn('off', 'خطأ في الاتصال');

  C.ws.onclose = () => {
    C.wsReady = false;
    setConn('off', 'الاتصال منقطع — إعادة المحاولة...');
    setTimeout(connectWS, 4000);
  };
}

function handleWsMsg(msg) {
  switch (msg.type) {
    case 'connected':
      if (msg.gamedata) {
        C.territories = msg.gamedata.territoryOwners || C.territories;
        C.alliances   = msg.gamedata.alliances || C.alliances;
        if (msg.gamedata.recentChat) {
          Object.entries(msg.gamedata.recentChat).forEach(([ch, msgs]) => {
            msgs.forEach(m => addChatMsg(m, false));
          });
          scrollChat();
        }
        renderMap();
        buildMinimap();
      }
      break;

    case 'auth_ok':
      if (msg.nation) { C.nation = msg.nation; updateTopBar(); }
      break;

    case 'chat':
      addChatMsg(msg.msg, true);
      break;

    case 'resources':
      if (C.nation) {
        C.nation.resources = msg.resources;
        updateTopBar();
      }
      break;

    case 'leaderboard':
      C.leaderboard = msg.data;
      renderLeaderboard();
      break;

    case 'territory_update':
      C.territories = msg.territories;
      renderMap();
      buildMinimap();
      break;

    case 'war_event':
      showNotif(`⚔️ ${msg.attackerFlag} ${msg.attackerName} هاجم ${msg.defenderFlag} ${msg.defenderName}!`, 'war');
      addChatMsg({
        flag: msg.attackerFlag, name: msg.attackerName, channel:'world',
        text: `⚔️ أعلنت الحرب على ${msg.defenderFlag} ${msg.defenderName}! [${msg.attackType}]`,
        time: now(),
      }, true);
      if (!msg.isBot) explodeMap();
      break;

    case 'alliance_update':
      C.alliances = msg.alliances;
      break;

    case 'trade_offer':
      C.tradeOffers.unshift(msg.offer);
      if (C.tradeOffers.length > 30) C.tradeOffers.pop();
      showNotif(`💱 ${msg.offer.fromFlag} ${msg.offer.fromName} يعرض تجارة!`, 'resource');
      break;

    case 'trade_done':
      showNotif(`✅ تمت الصفقة: ${msg.sellerName} ↔ ${msg.buyerName}`, 'alliance');
      break;

    case 'player_joined':
      showNotif(`🟢 ${msg.flag || '🏴'} ${msg.name} دخل الساحة!`, 'info');
      buildPlayersList();
      break;

    case 'player_left':
      buildPlayersList();
      break;

    case 'diplomacy_msg':
      document.getElementById('diploBadge').textContent =
        (parseInt(document.getElementById('diploBadge').textContent) || 0) + 1;
      showNotif(`📜 ${msg.msg.fromFlag} ${msg.msg.fromName}: ${msg.msg.action}`, 'info');
      break;

    case 'pong':
      document.getElementById('pingTxt').textContent = 'ping: ' + (Date.now() - C.pingT) + 'ms';
      break;
  }
}

function wsSend(data) {
  if (C.ws && C.wsReady && C.ws.readyState === WebSocket.OPEN) {
    C.ws.send(JSON.stringify(data));
  }
}

function pingLoop() {
  setInterval(() => {
    C.pingT = Date.now();
    wsSend({ type: 'ping' });
  }, 10000);
}

function simulateOfflineEvents() {
  // Simulate bot chat
  const botMsgs = [
    { flag:'☀️', name:'إمبراطورية الشمس',  channel:'world',  text:'⚔️ الهجوم مستمر! لا تحصن يوقفنا!' },
    { flag:'🌊', name:'جمهورية النيل',      channel:'trade',  text:'💱 أبيع 3000 حديد بسعر مناسب!' },
    { flag:'🔥', name:'اتحاد الشرق',        channel:'world',  text:'🛡️ الحدود الشرقية محصّنة!' },
    { flag:'🌙', name:'سلطنة الرمال',       channel:'trade',  text:'🛢️ أعلى سعر للنفط اليوم!' },
    { flag:'❄️', name:'قوة الجليد',         channel:'world',  text:'🥶 تحذير: الشمال يتحرك جنوباً!' },
    { flag:'🦁', name:'دولة الغابات',       channel:'alliance',text:'🤝 ندعو لتحالف دفاع مشترك!' },
  ];
  setInterval(() => {
    const m = botMsgs[Math.floor(Math.random() * botMsgs.length)];
    addChatMsg({ ...m, time: now() }, true);
  }, 6000 + Math.random() * 6000);

  // Simulate war events
  setInterval(() => {
    const gd = C.gamedata || getEmbeddedGamedata();
    const bots = gd.botNations;
    const a = bots[Math.floor(Math.random() * bots.length)];
    const d = bots[Math.floor(Math.random() * bots.length)];
    if (a.id !== d.id) {
      showNotif(`⚔️ ${a.flag} ${a.name} هاجم ${d.flag} ${d.name}!`, 'war');
      addChatMsg({ flag:a.flag, name:a.name, channel:'world', text:`⚔️ أعلنت الحرب على ${d.flag} ${d.name}!`, time:now() }, true);
      explodeMap();
    }
  }, 35000 + Math.random() * 25000);
}

// ─────────────────────────────────────────
// TOP BAR
// ─────────────────────────────────────────
function updateTopBar() {
  if (!C.nation) return;
  document.getElementById('tFlag').textContent = C.nation.flag || '🏴';
  document.getElementById('tName').textContent = C.nation.name || 'دولتي';

  const ideos = C.gamedata?.ideologies || getEmbeddedGamedata().ideologies;
  const ideo  = ideos.find(i => i.id === C.nation.ideology) || ideos[2];
  const iEl   = document.getElementById('tIdeo');
  iEl.textContent  = ideo.name;
  iEl.style.background = ideo.color + '44';
  iEl.style.color      = ideo.color;

  const r = C.nation.resources || {};
  document.getElementById('rGold').textContent   = fmt(r.gold   || 0);
  document.getElementById('rIron').textContent   = fmt(r.iron   || 0);
  document.getElementById('rFood').textContent   = fmt(r.food   || 0);
  document.getElementById('rEnergy').textContent = fmt(r.energy || 0);
  document.getElementById('rPop').textContent    = fmtPop(r.pop || 0);

  // Rate
  const terCnt = (C.nation.territories || []).length;
  document.getElementById('rGoldR').textContent = '+' + fmt(5*(terCnt+1)) + '/ث';

  // Stats
  document.getElementById('sTer').textContent  = terCnt + ' منطقة';
  document.getElementById('sWins').textContent = C.nation.stats?.wins  || 0;
  document.getElementById('sLoss').textContent = C.nation.stats?.losses || 0;

  // Military power
  const mil = calcPower(C.nation);
  document.getElementById('sMil').textContent = fmt(mil);
  const maxPow = 100000;
  const pct    = Math.min(100, Math.round(mil / maxPow * 100));
  document.getElementById('milBar').style.width = pct + '%';
  document.getElementById('milPct').textContent = pct + '%';

  // Alliance
  const myAlly = C.alliances.find(a => a.members && a.members.includes(C.nationId));
  document.getElementById('sAlly').textContent = myAlly ? myAlly.icon + ' ' + myAlly.name : 'لا يوجد';
}

// ─────────────────────────────────────────
// MAP
// ─────────────────────────────────────────
function renderMap() {
  const gd = C.gamedata || getEmbeddedGamedata();
  const tg = document.getElementById('terGroup');
  const lg = document.getElementById('lblGroup');
  tg.innerHTML = '';
  lg.innerHTML = '';

  gd.territories.forEach(t => {
    const ownerId  = C.territories[t.id];
    const isMe     = ownerId === C.nationId;
    const ownerBot = gd.botNations.find(b => b.id === ownerId);

    let fillColor = t.baseColor;
    if (isMe)       fillColor = C.nation?.color || '#8B0000';
    else if (ownerBot) fillColor = ownerBot.color;

    const rect = makeSVG('rect');
    rect.setAttribute('x', t.x); rect.setAttribute('y', t.y);
    rect.setAttribute('width', t.w); rect.setAttribute('height', t.h);
    rect.setAttribute('rx', '5');
    rect.setAttribute('fill', fillColor);
    rect.setAttribute('fill-opacity', isMe ? '0.88' : '0.72');
    rect.setAttribute('class', 'ter' + (isMe ? ' mine' : ''));
    rect.setAttribute('filter', isMe ? 'url(#glow)' : '');

    rect.addEventListener('mousemove', e => showTerPop(t, ownerId, ownerBot, isMe, e));
    rect.addEventListener('mouseleave', () => hideTerPop());
    rect.addEventListener('click', () => onTerClick(t, ownerId, ownerBot, isMe));
    tg.appendChild(rect);

    // Flag emoji
    const flagOwner = isMe ? C.nation?.flag : ownerBot?.flag;
    if (flagOwner) {
      const ft = makeSVG('text');
      ft.setAttribute('x', t.x + t.w/2); ft.setAttribute('y', t.y + t.h/2 - 6);
      ft.setAttribute('text-anchor','middle'); ft.setAttribute('font-size', t.w > 100 ? '16' : '12');
      ft.textContent = flagOwner;
      ft.style.pointerEvents = 'none';
      lg.appendChild(ft);
    }

    // Name label
    const lbl = makeSVG('text');
    lbl.setAttribute('x', t.x + t.w/2); lbl.setAttribute('y', t.y + t.h/2 + (flagOwner ? 12 : 5));
    lbl.setAttribute('class', 'terlbl');
    lbl.setAttribute('font-size', t.w > 110 ? '8.5' : '7');
    lbl.textContent = t.name;
    lg.appendChild(lbl);
  });

  setupMapDrag();
}

function showTerPop(t, ownerId, ownerBot, isMe, e) {
  const pop = document.getElementById('tpop');
  document.getElementById('tpName').textContent  = t.name;
  document.getElementById('tpOwner').textContent = isMe
    ? '🏴 ' + (C.nation?.name || 'دولتك')
    : ownerBot ? ownerBot.flag + ' ' + ownerBot.name : '🌍 محايدة';
  document.getElementById('tpPow').textContent   = ownerBot ? fmt(ownerBot.power) : (isMe ? fmt(calcPower(C.nation)) : 'غير محمية');
  document.getElementById('tpRes').textContent   = (t.res || []).join(' ');
  document.getElementById('tpPop').textContent   = fmtPop(t.pop || 0);
  document.getElementById('tpCont').textContent  = CONT_NAMES[t.continent] || t.continent;

  const rect = e.target.getBoundingClientRect();
  const cont = document.getElementById('mapCont').getBoundingClientRect();
  pop.style.left = (e.clientX - cont.left + 14) + 'px';
  pop.style.top  = (e.clientY - cont.top  - 20) + 'px';
  pop.classList.add('show');
}

function hideTerPop() { document.getElementById('tpop').classList.remove('show'); }

async function onTerClick(t, ownerId, ownerBot, isMe) {
  if (isMe) {
    showNotif('🏴 هذه أرضك! ' + t.name + ' | ' + (t.res||[]).join(' '), 'info');
    return;
  }
  if (ownerBot) {
    openWarModal(ownerBot, t);
    return;
  }
  // Neutral — annex
  const cost = 500;
  if ((C.nation?.resources?.gold || 0) < cost) {
    showNotif('⚠️ تحتاج ' + cost + ' ذهب لضم ' + t.name, 'info');
    return;
  }
  try {
    const res = await api('POST', '/api/territory/annex', { token: C.token, territoryId: t.id });
    if (res.success) {
      C.nation.territories = res.territories;
      C.nation.resources   = res.resources;
      C.territories[t.id] = C.nationId;
      showNotif('🎉 ضممت ' + t.name + ' لدولتك!', 'alliance');
      renderMap(); buildMinimap(); updateTopBar();
    } else showNotif('❌ ' + (res.error || 'خطأ'), 'info');
  } catch {
    // offline
    C.nation.resources.gold -= cost;
    if (!C.nation.territories.includes(t.id)) C.nation.territories.push(t.id);
    C.territories[t.id] = C.nationId;
    showNotif('🎉 ضممت ' + t.name + ' لدولتك!', 'alliance');
    renderMap(); buildMinimap(); updateTopBar();
  }
}

// ─────────────────────────────────────────
// MAP DRAG & ZOOM
// ─────────────────────────────────────────
function setupMapDrag() {
  const svg = document.getElementById('mapSvg');
  if (svg._dragging) return; // don't double-bind
  svg._dragging = true;

  let tx = 0, ty = 0, sc = 1, startX, startY;

  const apply = () => { svg.style.transform = `translate(${tx}px,${ty}px) scale(${sc})`; };

  svg.addEventListener('mousedown', e => {
    if (e.target.classList.contains('ter')) return;
    C.dragging = true; startX = e.clientX - tx; startY = e.clientY - ty;
  });
  window.addEventListener('mousemove', e => {
    if (!C.dragging) return;
    tx = e.clientX - startX; ty = e.clientY - startY; apply();
  });
  window.addEventListener('mouseup', () => { C.dragging = false; });
  svg.addEventListener('wheel', e => {
    e.preventDefault();
    sc = Math.max(0.4, Math.min(3.5, sc * (e.deltaY > 0 ? 0.88 : 1.13)));
    apply();
  }, { passive: false });

  // Touch support
  let lastDist = 0;
  svg.addEventListener('touchstart', e => {
    if (e.touches.length === 1) { C.dragging = true; startX = e.touches[0].clientX - tx; startY = e.touches[0].clientY - ty; }
    else if (e.touches.length === 2) { lastDist = Math.hypot(e.touches[0].clientX-e.touches[1].clientX, e.touches[0].clientY-e.touches[1].clientY); }
  });
  svg.addEventListener('touchmove', e => {
    e.preventDefault();
    if (e.touches.length === 1 && C.dragging) { tx = e.touches[0].clientX - startX; ty = e.touches[0].clientY - startY; apply(); }
    else if (e.touches.length === 2) {
      const d = Math.hypot(e.touches[0].clientX-e.touches[1].clientX, e.touches[0].clientY-e.touches[1].clientY);
      sc = Math.max(0.4, Math.min(3.5, sc * (d / lastDist)));
      lastDist = d; apply();
    }
  }, { passive: false });
  svg.addEventListener('touchend', () => { C.dragging = false; });

  C._mapApply = apply;
  C._mapState = { get tx(){ return tx; }, get ty(){ return ty; }, get sc(){ return sc; },
    set sc(v){ sc=v; apply(); }, setPos(x,y){ tx=x; ty=y; apply(); } };
}

function zm(f) { if (C._mapState) C._mapState.sc = Math.max(0.4, Math.min(3.5, C._mapState.sc * f)); }
function resetView() { if (C._mapState) { C._mapState.sc = 1; C._mapState.setPos(0,0); } }

// ─────────────────────────────────────────
// MINIMAP
// ─────────────────────────────────────────
function buildMinimap() {
  const canvas = document.getElementById('mmCanvas');
  if (!canvas) return;
  canvas.width  = 175; canvas.height = 87;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#060e1a'; ctx.fillRect(0,0,175,87);
  const sx = 175/1200, sy = 87/700;
  const gd = C.gamedata || getEmbeddedGamedata();
  gd.territories.forEach(t => {
    const oid = C.territories[t.id];
    const isMe = oid === C.nationId;
    const bot  = gd.botNations.find(b => b.id === oid);
    ctx.fillStyle  = isMe ? (C.nation?.color || '#8B0000') : bot ? bot.color : t.baseColor;
    ctx.globalAlpha = 0.72;
    ctx.fillRect(t.x*sx, t.y*sy, t.w*sx, t.h*sy);
  });
  ctx.globalAlpha = 1;
}

// ─────────────────────────────────────────
// LEFT PANEL TABS
// ─────────────────────────────────────────
function lTab(tab, el) {
  document.querySelectorAll('.ptab').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  ['nation','military','tech','build'].forEach(k => {
    const p = document.getElementById('lp-' + k);
    if (p) p.style.display = k === tab ? 'block' : 'none';
  });
  renderLeftPanel(tab);
}

function renderLeftPanel(tab) {
  if (tab === 'nation')   renderLeaderboard();
  if (tab === 'military') renderMilitary();
  if (tab === 'tech')     renderTech();
  if (tab === 'build')    renderBuildings();
}

// Leaderboard
function renderLeaderboard() {
  const lb = document.getElementById('lbList');
  if (!lb) return;
  const gd = C.gamedata || getEmbeddedGamedata();
  const all = [
    { name: C.nation?.name || 'دولتك', flag: C.nation?.flag || '🏴', power: calcPower(C.nation), isMe: true },
    ...gd.botNations.map(b => ({ name:b.name, flag:b.flag, power:b.power, isMe:false })),
    ...(C.leaderboard || []).filter(x => !gd.botNations.find(b=>b.id===x.id) && x.id !== C.nationId).slice(0,5),
  ].sort((a,b) => b.power - a.power).slice(0,10);

  lb.innerHTML = all.map((p,i) =>
    `<div class="lbi">
      <span class="lbr ${i===0?'t1':i===1?'t2':i===2?'t3':''}">${i+1}</span>
      <span class="lbf">${p.flag}</span>
      <span class="lbn" style="${p.isMe?'color:var(--gold-l)':''}">${p.name}${p.isMe?' ★':''}</span>
      <span class="lbs">${fmt(p.power)}</span>
    </div>`
  ).join('');
}

// Military
function renderMilitary() {
  const cont = document.getElementById('lp-military');
  const gd = C.gamedata || getEmbeddedGamedata();
  cont.innerHTML = '<div class="stitle">⚔️ قوات الجيش</div>';
  gd.units.forEach(u => {
    const cnt = C.nation?.military?.[u.id] || 0;
    const el = document.createElement('div');
    el.className = 'uc';
    el.innerHTML = `
      <div class="uh">
        <span class="uico">${u.icon}</span>
        <span class="uname">${u.name}</span>
        <span class="ucnt">${fmt(cnt)} وحدة</span>
      </div>
      <div class="ustats">
        <div class="us"><div class="usv" style="color:var(--nr)">${u.atk}</div><div class="usl">هجوم</div></div>
        <div class="us"><div class="usv" style="color:#2196F3">${u.def}</div><div class="usl">دفاع</div></div>
        <div class="us"><div class="usv" style="color:var(--ng)">${u.spd}</div><div class="usl">سرعة</div></div>
      </div>
      <button class="rbtn" onclick="recruitUnit('${u.id}')">
        ➕ تجنيد × 1 &nbsp;|&nbsp; 💰 ${fmt(u.cost)}
      </button>
      <button class="rbtn" style="margin-top:4px;background:rgba(139,0,0,.18)" onclick="recruitUnit('${u.id}',10)">
        ➕ × 10 &nbsp;|&nbsp; 💰 ${fmt(u.cost*10)}
      </button>`;
    cont.appendChild(el);
  });
}

async function recruitUnit(unitId, amount = 1) {
  const gd   = C.gamedata || getEmbeddedGamedata();
  const unit = gd.units.find(u => u.id === unitId);
  if (!unit) return;
  const cost = unit.cost * amount;
  if ((C.nation?.resources?.gold || 0) < cost) {
    showNotif(`⚠️ تحتاج ${fmt(cost)} ذهب!`, 'info'); return;
  }
  try {
    const res = await api('POST', '/api/military/recruit', { token: C.token, unitId, amount });
    if (res.success) {
      C.nation.military  = res.military;
      C.nation.resources.gold = res.gold;
    }
  } catch {
    C.nation.resources.gold -= cost;
    C.nation.military[unitId] = (C.nation.military[unitId] || 0) + amount;
  }
  showNotif(`✅ جنّدت ${amount} ${unit.icon} ${unit.name}!`, 'alliance');
  renderMilitary(); updateTopBar();
}

// Tech
function renderTech() {
  const cont = document.getElementById('lp-tech');
  const gd = C.gamedata || getEmbeddedGamedata();
  cont.innerHTML = '<div class="stitle">🔬 شجرة التقنية</div><div class="tech-grid" id="tg"></div>';
  const tg = document.getElementById('tg');
  gd.technologies.forEach(tech => {
    const done   = C.nation?.techs?.includes(tech.id);
    const locked = tech.prereq && !C.nation?.techs?.includes(tech.prereq);
    const el = document.createElement('div');
    el.className = 'tc' + (done ? ' done' : '') + (locked ? ' locked' : '');
    el.innerHTML = `
      ${done ? '<div class="done-badge">✅</div>' : ''}
      <div class="ti">${tech.icon}</div>
      <div class="tn">${tech.name}</div>
      <div class="te">${tech.effect}</div>
      <div class="tcost">${done ? '✅ مكتمل' : locked ? '🔒 ' + tech.prereq : '💰 ' + fmt(tech.cost)}</div>`;
    if (!done && !locked) el.onclick = () => researchTech(tech);
    tg.appendChild(el);
  });
}

async function researchTech(tech) {
  const cost = tech.cost;
  if ((C.nation?.resources?.gold || 0) < cost) {
    showNotif(`⚠️ تحتاج ${fmt(cost)} ذهب!`, 'info'); return;
  }
  try {
    const res = await api('POST', '/api/tech/research', { token: C.token, techId: tech.id });
    if (res.success) { C.nation.techs = res.techs; C.nation.resources.gold -= cost; }
    else { showNotif('❌ ' + res.error, 'info'); return; }
  } catch {
    C.nation.resources.gold -= cost;
    if (!C.nation.techs) C.nation.techs = [];
    C.nation.techs.push(tech.id);
  }
  showNotif(`🔬 تم بحث ${tech.name}! ${tech.effect}`, 'alliance');
  renderTech(); updateTopBar();
}

// Buildings
function renderBuildings() {
  const cont = document.getElementById('lp-build');
  const gd = C.gamedata || getEmbeddedGamedata();
  cont.innerHTML = '<div class="stitle">🏗️ المباني</div>';
  gd.buildings.forEach(b => {
    const lvl  = C.nation?.buildings?.[b.id] || 0;
    const cost = b.baseCost + b.perLevel * lvl;
    const el   = document.createElement('div');
    el.className = 'bc';
    el.innerHTML = `
      <div class="bh"><span class="bico">${b.icon}</span><span class="bname">${b.name}</span><span class="blvl">Lv${lvl}</span></div>
      <div class="beff">${b.effect}</div>
      <button class="bbtn" onclick="upgradeBuilding('${b.id}')">🏗️ ${lvl===0?'بناء':'ترقية'} | 💰 ${fmt(cost)}</button>`;
    cont.appendChild(el);
  });
}

async function upgradeBuilding(buildId) {
  const gd = C.gamedata || getEmbeddedGamedata();
  const b  = gd.buildings.find(x => x.id === buildId);
  if (!b) return;
  const lvl  = C.nation?.buildings?.[buildId] || 0;
  const cost = b.baseCost + b.perLevel * lvl;
  if ((C.nation?.resources?.gold || 0) < cost) {
    showNotif(`⚠️ تحتاج ${fmt(cost)} ذهب!`, 'info'); return;
  }
  try {
    const res = await api('POST', '/api/building/upgrade', { token: C.token, buildingId: buildId });
    if (res.success) { C.nation.buildings = res.buildings; C.nation.resources = res.resources; }
    else { showNotif('❌ ' + res.error, 'info'); return; }
  } catch {
    C.nation.resources.gold -= cost;
    if (!C.nation.buildings) C.nation.buildings = {};
    C.nation.buildings[buildId] = lvl + 1;
  }
  showNotif(`🏗️ ${b.icon} ${b.name} — المستوى ${lvl+1}!`, 'alliance');
  renderBuildings(); updateTopBar();
}

// ─────────────────────────────────────────
// PLAYERS LIST
// ─────────────────────────────────────────
function buildPlayersList() {
  const list = document.getElementById('playersList');
  const gd   = C.gamedata || getEmbeddedGamedata();
  const me   = { name: C.nation?.name || 'دولتك', flag: C.nation?.flag || '🏴', power: calcPower(C.nation), isMe:true, online:true };
  const all  = [me, ...gd.botNations.map(b => ({ name:b.name, flag:b.flag, power:b.power, online: Math.random()>.3 }))];
  document.getElementById('olCount').textContent = all.filter(p=>p.online).length;

  list.innerHTML = all.slice(0,12).map(p => `
    <div class="prow" onclick="${p.isMe?'':''}" >
      <div class="pst ${p.online?'on':'war'}"></div>
      <span class="pflag">${p.flag}</span>
      <span class="pname-t" style="${p.isMe?'color:var(--gold-l)':''}">${p.name}${p.isMe?' ★':''}</span>
      <span class="ppow">⚔️${(p.power/1000).toFixed(0)}k</span>
    </div>`).join('');
}

// ─────────────────────────────────────────
// CHAT
// ─────────────────────────────────────────
async function loadChatHistory() {
  try {
    const msgs = await api('GET', '/api/chat/world');
    msgs.slice(-25).forEach(m => addChatMsg(m, false));
    scrollChat();
  } catch {
    // offline messages
    const offline = [
      { flag:'☀️', name:'إمبراطورية الشمس', channel:'world', text:'⚔️ لن يوقفنا أحد! الحرب مستمرة!', time:'00:01' },
      { flag:'🌊', name:'جمهورية النيل',    channel:'trade', text:'💱 أبيع 5000 نفط مقابل حديد!',   time:'00:02' },
      { flag:'⭐', name:'مملكة الغرب',      channel:'world', text:'🛡️ ندعو للانضمام لتحالفنا!',     time:'00:03' },
      { text:'⚡ اللعبة بدأت! ادخل للمعركة!', type:'system' },
    ];
    offline.forEach(m => addChatMsg(m, false));
    scrollChat();
  }
}

function addChatMsg(msg, scroll = true) {
  const area = document.getElementById('chatArea');
  const el   = document.createElement('div');
  el.className = 'cmsg';
  if (msg.type === 'system' || !msg.flag) {
    el.innerHTML = `<div class="cmtxt sys">🔔 ${msg.text}</div>`;
  } else {
    const chLabel = msg.channel === 'alliance' ? 'تحالف' : msg.channel === 'trade' ? 'تجارة' : 'عالمي';
    const cls     = msg.channel === 'alliance' ? 'al' : '';
    el.innerHTML = `
      <div class="cmh">
        <span class="cmf">${msg.flag}</span>
        <span class="cmn">${msg.name || '?'}</span>
        <span class="cmc">[${chLabel}]</span>
        <span class="cmt">${msg.time || ''}</span>
      </div>
      <div class="cmtxt ${cls}">${escHtml(msg.text)}</div>`;
  }
  area.appendChild(el);
  if (scroll) scrollChat();
  // Keep max 80 messages
  while (area.children.length > 80) area.removeChild(area.firstChild);
}

function scrollChat() {
  const a = document.getElementById('chatArea');
  if (a) a.scrollTop = a.scrollHeight;
}

function setCh(ch, el) {
  C.chatChannel = ch;
  document.querySelectorAll('.chcbtn').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
}

function sendChat() {
  const inp  = document.getElementById('chatIn');
  const text = inp.value.trim();
  if (!text || !C.nation) return;
  const msg = {
    flag: C.nation.flag, name: C.nation.name,
    channel: C.chatChannel, text, time: now(),
  };
  wsSend({ type: 'chat', channel: C.chatChannel, text });
  // Optimistic local
  addChatMsg(msg, true);
  inp.value = '';
}

// ─────────────────────────────────────────
// WAR SYSTEM
// ─────────────────────────────────────────
function openWarModal(enemy, territory) {
  C.warTarget = enemy;
  document.getElementById('wAFlag').textContent = C.nation?.flag || '🏴';
  document.getElementById('wAName').textContent = C.nation?.name || 'دولتك';
  document.getElementById('wAPow').textContent  = 'القوة: ' + fmt(calcPower(C.nation));
  document.getElementById('wDFlag').textContent = enemy.flag;
  document.getElementById('wDName').textContent = enemy.name;
  document.getElementById('wDPow').textContent  = 'القوة: ' + fmt(enemy.power);
  document.getElementById('warOpts').style.display = 'grid';
  document.getElementById('battleRes').classList.remove('show');
  openModal('warModal');
}

const WAR_COSTS = { ground:500, air:1000, naval:800, nuclear:10000 };

async function launchWar(type) {
  if (!C.warTarget) return;
  const cost = WAR_COSTS[type] || 500;
  if ((C.nation?.resources?.gold || 0) < cost) {
    showNotif(`⚠️ تحتاج ${fmt(cost)} ذهب لهذا الهجوم!`, 'info'); return;
  }

  document.getElementById('warOpts').style.display   = 'none';
  document.getElementById('battleRes').classList.add('show');
  document.getElementById('blogEl').innerHTML        = '';
  document.getElementById('battleResultTxt').textContent = '⚔️ جارٍ القتال...';
  document.getElementById('battleResultTxt').style.color = 'var(--text)';

  let result;
  try {
    result = await api('POST', '/api/war/declare', { token: C.token, targetId: C.warTarget.id, attackType: type });
    if (result.war) {
      if (result.attacker) {
        C.nation.resources = result.attacker.resources;
        C.nation.stats     = result.attacker.stats;
        C.nation.territories = result.attacker.territories;
      }
    }
  } catch {
    // Offline simulation
    result = offlineSimBattle(type, cost);
  }

  animateBattle(result.war || result, type);
}

function offlineSimBattle(type, cost) {
  const mult = { ground:1, air:1.3, naval:1.1, nuclear:3 }[type] || 1;
  const myP  = calcPower(C.nation) * mult;
  const enP  = C.warTarget?.power || 30000;
  C.nation.resources.gold -= cost;

  let myHP = 100, enHP = 100;
  const log = [];
  for (let i = 0; i < 10; i++) {
    const d2en = Math.floor(myP/Math.max(enP,1)*15 + Math.random()*10);
    const d2me = Math.floor(enP/Math.max(myP,1)*12 + Math.random()*8);
    enHP = Math.max(0, enHP - d2en);
    myHP = Math.max(0, myHP - d2me);
    log.push({ round:i+1, atkHP:myHP, defHP:enHP, dmgToDefender:d2en, dmgToAttacker:d2me });
    if (myHP <= 0 || enHP <= 0) break;
  }
  const won = enHP <= 0;
  if (won) {
    const loot = Math.floor(Math.random()*3000+1000);
    C.nation.resources.gold += loot;
    C.nation.stats.wins = (C.nation.stats.wins||0)+1;
    return { war:{ result:{ winner:'attacker', log, atkHP:myHP, defHP:enHP, loot } } };
  } else {
    C.nation.stats.losses = (C.nation.stats.losses||0)+1;
    return { war:{ result:{ winner:'defender', log, atkHP:myHP, defHP:enHP } } };
  }
}

function animateBattle(warData, type) {
  const wr = warData?.result || warData;
  if (!wr) return;

  const logEl  = document.getElementById('blogEl');
  const atkBar = document.getElementById('atkBar');
  const defBar = document.getElementById('defBar');
  const myHP   = document.getElementById('myHP');
  const enHP   = document.getElementById('enHP');
  const resEl  = document.getElementById('battleResultTxt');

  const rounds = wr.log || [];
  let i = 0;

  const iv = setInterval(() => {
    if (i >= rounds.length) {
      clearInterval(iv);
      // Final result
      const won = wr.winner === 'attacker';
      resEl.textContent = won
        ? '🏆 انتصرت! ' + (C.warTarget?.flag || '') + ' استسلم!'
        : '💀 هُزمت! ' + (C.warTarget?.flag || '') + ' صمد!';
      resEl.style.color = won ? 'var(--ng)' : 'var(--nr)';

      if (won) {
        const loot = wr.loot || Math.floor(Math.random()*2000+500);
        showNotif(`🏆 انتصار! غنمت ${fmt(loot)} ذهب!`, 'alliance');
        addChatMsg({ flag:C.nation.flag, name:C.nation.name, channel:'world',
          text:`🏆 هزمت ${C.warTarget?.flag} ${C.warTarget?.name}!`, time:now() }, true);
        if (wr.capturedTerritory) {
          C.territories[wr.capturedTerritory] = C.nationId;
          renderMap(); buildMinimap();
        }
        explodeMap();
      } else {
        showNotif(`💀 هُزمت! تحتاج تعزيزات!`, 'war');
      }
      updateTopBar();
      return;
    }

    const r = rounds[i++];
    atkBar.style.width = r.atkHP + '%';
    defBar.style.width = r.defHP + '%';
    myHP.textContent   = r.atkHP + '%';
    enHP.textContent   = r.defHP + '%';
    logEl.innerHTML   += `<div>🔁 جولة ${r.round}: ألحقت ${r.dmgToDefender}🔴 | تلقيت ${r.dmgToAttacker}🔵</div>`;
    logEl.scrollTop    = logEl.scrollHeight;
  }, 380);
}

function explodeMap() {
  const cont = document.getElementById('mapCont');
  for (let i = 0; i < 3; i++) {
    setTimeout(() => {
      const el  = document.createElement('div');
      el.className  = 'explosion';
      el.textContent = ['💥','🔥','💣'][Math.floor(Math.random()*3)];
      el.style.left = (20 + Math.random()*60) + '%';
      el.style.top  = (20 + Math.random()*60) + '%';
      cont.appendChild(el);
      setTimeout(() => el.remove(), 900);
    }, i * 280);
  }
}

// ─────────────────────────────────────────
// TRADE
// ─────────────────────────────────────────
async function loadTradeOffers() {
  try {
    C.tradeOffers = await api('GET', '/api/trade/offers');
  } catch { C.tradeOffers = []; }
}

function openTrade() {
  renderTradeModal();
  openModal('tradeModal');
}

function renderTradeModal() {
  const list = document.getElementById('offerList');
  if (C.tradeOffers.length === 0) {
    list.innerHTML = '<div style="font-size:.8rem;color:var(--dim);text-align:center;padding:12px">لا توجد عروض حالياً</div>';
    return;
  }
  list.innerHTML = C.tradeOffers.slice(0,10).map(o => `
    <div class="offer-card">
      <span class="offer-flag">${o.fromFlag || '🌍'}</span>
      <div class="offer-info">
        <div class="offer-name">${o.fromName || 'مجهول'}</div>
        <div class="offer-deal">يعطي: ${o.give?.amount} ${o.give?.resource} ← يريد: ${o.want?.amount} ${o.want?.resource}</div>
      </div>
      <button class="abtn" onclick="acceptTrade('${o.id}')">✅ قبول</button>
    </div>`).join('');
}

async function postTrade() {
  const giveRes = document.getElementById('giveRes').value;
  const giveAmt = parseInt(document.getElementById('giveAmt').value) || 0;
  const wantRes = document.getElementById('wantRes').value;
  const wantAmt = parseInt(document.getElementById('wantAmt').value) || 0;
  if (!giveAmt || !wantAmt) { showNotif('⚠️ أدخل الكميات!', 'info'); return; }
  if ((C.nation?.resources?.[giveRes] || 0) < giveAmt) { showNotif('⚠️ موارد غير كافية!', 'info'); return; }

  const offer = { give:{ resource:giveRes, amount:giveAmt }, want:{ resource:wantRes, amount:wantAmt } };
  try {
    await api('POST', '/api/trade/offer', { token: C.token, offer });
  } catch {
    C.tradeOffers.unshift({ id:'local_'+Date.now(), fromFlag:C.nation.flag, fromName:C.nation.name, ...offer, status:'open' });
  }
  showNotif(`📢 نشرت عرض: ${giveAmt} ${giveRes} ↔ ${wantAmt} ${wantRes}`, 'resource');
  renderTradeModal();
}

async function acceptTrade(offerId) {
  try {
    const res = await api('POST', '/api/trade/accept', { token: C.token, offerId });
    if (res.success) { showNotif('✅ تمت الصفقة!', 'alliance'); loadTradeOffers().then(renderTradeModal); }
    else showNotif('❌ ' + res.error, 'info');
  } catch { showNotif('⚠️ لا يمكن إتمام الصفقة أوفلاين', 'info'); }
}

// ─────────────────────────────────────────
// DIPLOMACY
// ─────────────────────────────────────────
function openDiplo() {
  document.getElementById('diploBadge').textContent = '0';
  renderDiploModal();
  openModal('diploModal');
}

function renderDiploModal() {
  const list = document.getElementById('diploList');
  const gd   = C.gamedata || getEmbeddedGamedata();
  list.innerHTML = gd.botNations.slice(0,8).map(b => `
    <div class="diplo-card">
      <div class="diplo-hd">
        <span class="diplo-flag">${b.flag}</span>
        <span class="diplo-name">${b.name}</span>
        <span class="diplo-type">القوة: ${fmt(b.power)}</span>
      </div>
      <div class="diplo-acts">
        <button class="dact peace" onclick="sendDiplo('${b.id}','peace')">☮️ سلام</button>
        <button class="dact war"   onclick="sendDiplo('${b.id}','warn')">⚠️ تهديد</button>
        <button class="dact ally"  onclick="sendDiplo('${b.id}','ally')">🤝 تحالف</button>
        <button class="dact trade" onclick="sendDiplo('${b.id}','trade')">💱 تجارة</button>
        <button class="dact war"   onclick="closeModal('diploModal');setTimeout(()=>openWarModalById('${b.id}'),200)">⚔️ حرب</button>
      </div>
    </div>`).join('');
}

async function sendDiplo(targetId, action) {
  const labels = { peace:'طلب سلام', warn:'تهديد', ally:'اقتراح تحالف', trade:'اقتراح تجارة' };
  try {
    await api('POST', '/api/diplomacy/send', { token:C.token, targetId, action, message:labels[action] });
  } catch {}
  showNotif(`📜 أرسلت رسالة: ${labels[action]}`, 'info');
}

function openWarModalById(botId) {
  const gd  = C.gamedata || getEmbeddedGamedata();
  const bot = gd.botNations.find(b => b.id === botId);
  if (bot) openWarModal(bot, null);
}

// ─────────────────────────────────────────
// ALLIANCES
// ─────────────────────────────────────────
function openAlliances() {
  renderAllianceModal();
  openModal('allyModal');
}

function renderAllianceModal() {
  const list  = document.getElementById('allyList');
  const myAlly = C.alliances.find(a => a.members?.includes(C.nationId));
  list.innerHTML = C.alliances.map(a => {
    const inIt = a.members?.includes(C.nationId);
    return `
      <div class="diplo-card">
        <div class="diplo-hd">
          <span style="font-size:1.2rem">${a.icon}</span>
          <span class="diplo-name">${a.name}</span>
          <span class="diplo-type">${(a.members||[]).length} عضو</span>
        </div>
        <div style="font-size:.75rem;color:var(--dim);margin-bottom:9px">
          ${inIt ? '✅ أنت عضو في هذا التحالف' : myAlly ? '⚠️ أنت في تحالف آخر' : 'تحالف مفتوح للانضمام'}
        </div>
        <div class="diplo-acts">
          ${!inIt && !myAlly
            ? `<button class="dact ally" onclick="joinAlliance('${a.id}')">🤝 انضمام</button>`
            : inIt
            ? `<button class="dact war" onclick="leaveAlliance('${a.id}')">🚪 مغادرة</button>`
            : ''}
        </div>
      </div>`;
  }).join('');
}

async function joinAlliance(allianceId) {
  try {
    const res = await api('POST', '/api/alliance/join', { token: C.token, allianceId });
    if (res.success) {
      const a = C.alliances.find(x => x.id === allianceId);
      if (a && !a.members.includes(C.nationId)) a.members.push(C.nationId);
    }
  } catch {
    const a = C.alliances.find(x => x.id === allianceId);
    if (a && !a.members.includes(C.nationId)) a.members.push(C.nationId);
  }
  showNotif('🤝 انضممت للتحالف!', 'alliance');
  renderAllianceModal(); updateTopBar();
}

async function leaveAlliance(allianceId) {
  try { await api('POST', '/api/alliance/leave', { token: C.token, allianceId }); } catch {}
  const a = C.alliances.find(x => x.id === allianceId);
  if (a) a.members = (a.members||[]).filter(m => m !== C.nationId);
  showNotif('🚪 غادرت التحالف', 'info');
  renderAllianceModal(); updateTopBar();
}

// ─────────────────────────────────────────
// CLIENT TICK
// ─────────────────────────────────────────
function startClientTick() {
  setInterval(() => {
    C.tick++;
    // Local resource accumulation (until server syncs)
    if (C.nation?.resources) {
      const tc = (C.nation.territories||[]).length;
      C.nation.resources.gold   = Math.min(999999, C.nation.resources.gold   + Math.floor(5*(tc+1)/10));
      C.nation.resources.iron   = Math.min(999999, C.nation.resources.iron   + Math.floor(3*(tc+1)/10));
      C.nation.resources.food   = Math.min(999999, C.nation.resources.food   + Math.floor(8*(tc+1)/10));
      C.nation.resources.energy = Math.min(999999, C.nation.resources.energy + Math.floor(1*(tc+1)/10));
      C.nation.resources.pop    = Math.min(999999999, C.nation.resources.pop + Math.floor(100*(tc+1)/10));
    }
    if (C.tick % 3 === 0) updateTopBar();
    if (C.tick % 10 === 0) { renderLeaderboard(); buildPlayersList(); }
    document.getElementById('tickTxt').textContent = 'tick: ' + C.tick;
  }, 1000);
}

// ─────────────────────────────────────────
// NOTIFICATIONS
// ─────────────────────────────────────────
function showNotif(text, type = 'info') {
  const cont = document.getElementById('notifCont');
  const el   = document.createElement('div');
  el.className   = 'notif ' + type;
  el.innerHTML   = '<span>' + text + '</span>';
  cont.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

// ─────────────────────────────────────────
// MODALS
// ─────────────────────────────────────────
function openModal(id) { document.getElementById(id).classList.add('show'); }
function closeModal(id) { document.getElementById(id).classList.remove('show'); }

// ─────────────────────────────────────────
// LOGOUT
// ─────────────────────────────────────────
function doLogout() {
  if (!confirm('خروج من ساحة المعركة؟')) return;
  localStorage.removeItem('wwo_token');
  localStorage.removeItem('wwo_nationId');
  C.token = null; C.nationId = null; C.nation = null;
  if (C.ws) C.ws.close();
  showScreen('loginScreen');
  showNotif('👋 وداعاً! نراك في المعركة القادمة!', 'info');
}

// ─────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────
function showScreen(id) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  document.getElementById(id).classList.add('active');
}

function setConn(state, text) {
  const dot  = document.getElementById('connDot');
  const txt  = document.getElementById('connTxt');
  dot.className = 'conn-dot ' + state;
  txt.textContent = text;
}

function api(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  return fetch(SERVER_URL + path, opts).then(r => r.json());
}

function makeSVG(tag) { return document.createElementNS('http://www.w3.org/2000/svg', tag); }

function fmt(n)    { return Math.floor(n || 0).toLocaleString('ar-EG'); }
function fmtPop(n) { return n >= 1e9 ? (n/1e9).toFixed(1)+'B' : n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(0)+'k' : String(n); }
function now()     { return new Date().toLocaleTimeString('ar-EG', { hour:'2-digit', minute:'2-digit' }); }
function escHtml(s){ return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function shk(id)   { const el=document.getElementById(id); el.classList.add('shake'); setTimeout(()=>el.classList.remove('shake'),450); }

function calcPower(nation) {
  if (!nation) return 0;
  const gd = C.gamedata || getEmbeddedGamedata();
  let p = 0;
  gd.units.forEach(u => { p += (nation.military?.[u.id] || 0) * u.atk; });
  p += (nation.territories?.length || 0) * 1000;
  p += (nation.techs?.length || 0) * 500;
  p += Object.values(nation.buildings || {}).reduce((s,l) => s+l*200, 0);
  return p;
}

// ─────────────────────────────────────────
// EMBEDDED GAMEDATA (offline fallback)
// ─────────────────────────────────────────
function getEmbeddedGamedata() {
  return {
    territories:[
      {id:'t1',name:'ألاسكا',x:60,y:60,w:120,h:90,res:['oil','fish'],pop:700000,baseColor:'#2d5a8e',continent:'namerica'},
      {id:'t2',name:'كندا الغربية',x:150,y:55,w:130,h:110,res:['grain','oil'],pop:5200000,baseColor:'#3a7a5c',continent:'namerica'},
      {id:'t3',name:'كندا الشرقية',x:280,y:50,w:120,h:110,res:['wood','grain'],pop:8100000,baseColor:'#4a6a3c',continent:'namerica'},
      {id:'t4',name:'الولايات الشمالية',x:160,y:165,w:150,h:90,res:['industry','energy'],pop:42000000,baseColor:'#2a6a9c',continent:'namerica'},
      {id:'t5',name:'الولايات الجنوبية',x:170,y:255,w:140,h:80,res:['grain','oil'],pop:65000000,baseColor:'#3a7cbc',continent:'namerica'},
      {id:'t6',name:'المكسيك',x:140,y:335,w:110,h:90,res:['oil','silver'],pop:126000000,baseColor:'#6a8c4a',continent:'namerica'},
      {id:'t7',name:'أمريكا الوسطى',x:180,y:425,w:80,h:60,res:['coffee'],pop:48000000,baseColor:'#5a7c3a',continent:'samerica'},
      {id:'t8',name:'كولومبيا',x:190,y:480,w:90,h:80,res:['coffee','gold'],pop:51000000,baseColor:'#7a6a2a',continent:'samerica'},
      {id:'t9',name:'البرازيل',x:230,y:490,w:140,h:160,res:['grain','wood'],pop:215000000,baseColor:'#3a8c4a',continent:'samerica'},
      {id:'t10',name:'الأرجنتين',x:220,y:565,w:100,h:100,res:['grain'],pop:45000000,baseColor:'#5a8a6a',continent:'samerica'},
      {id:'t11',name:'إيبيريا',x:450,y:160,w:90,h:90,res:['fish','wine'],pop:57000000,baseColor:'#8a6a3a',continent:'europe'},
      {id:'t12',name:'فرنسا',x:490,y:130,w:90,h:90,res:['wine','industry'],pop:68000000,baseColor:'#4a6a9a',continent:'europe'},
      {id:'t13',name:'بريطانيا',x:460,y:85,w:70,h:80,res:['industry','gold'],pop:67000000,baseColor:'#2a4a8a',continent:'europe'},
      {id:'t14',name:'ألمانيا',x:540,y:110,w:90,h:80,res:['industry','steel'],pop:84000000,baseColor:'#5a5a5a',continent:'europe'},
      {id:'t15',name:'إيطاليا',x:545,y:175,w:70,h:90,res:['wine'],pop:60000000,baseColor:'#8a4a2a',continent:'europe'},
      {id:'t16',name:'روسيا الغربية',x:590,y:75,w:150,h:130,res:['oil','grain'],pop:80000000,baseColor:'#6a3a3a',continent:'europe'},
      {id:'t17',name:'روسيا الشرقية',x:740,y:55,w:200,h:150,res:['oil','wood'],pop:30000000,baseColor:'#7a4a4a',continent:'asia'},
      {id:'t18',name:'بولندا',x:565,y:105,w:70,h:70,res:['grain','steel'],pop:45000000,baseColor:'#5a7a4a',continent:'europe'},
      {id:'t19',name:'البلقان',x:580,y:185,w:80,h:70,res:['grain','wine'],pop:30000000,baseColor:'#7a5a3a',continent:'europe'},
      {id:'t20',name:'أوكرانيا',x:615,y:150,w:90,h:70,res:['grain','oil'],pop:44000000,baseColor:'#8a8a4a',continent:'europe'},
      {id:'t21',name:'تركيا',x:620,y:210,w:90,h:70,res:['grain'],pop:84000000,baseColor:'#7a3a2a',continent:'mideast'},
      {id:'t22',name:'الشام',x:660,y:250,w:70,h:70,res:['oil'],pop:50000000,baseColor:'#8a7a3a',continent:'mideast'},
      {id:'t23',name:'الجزيرة العربية',x:660,y:305,w:100,h:100,res:['oil','gold'],pop:45000000,baseColor:'#c8a830',continent:'mideast'},
      {id:'t24',name:'إيران',x:710,y:245,w:100,h:90,res:['oil','grain'],pop:85000000,baseColor:'#6a5a2a',continent:'mideast'},
      {id:'t25',name:'شمال أفريقيا',x:490,y:265,w:160,h:100,res:['oil'],pop:90000000,baseColor:'#c8a030',continent:'africa'},
      {id:'t26',name:'غرب أفريقيا',x:450,y:360,w:110,h:110,res:['diamond','grain'],pop:400000000,baseColor:'#5a7a2a',continent:'africa'},
      {id:'t27',name:'شرق أفريقيا',x:610,y:360,w:100,h:110,res:['coffee','diamond'],pop:350000000,baseColor:'#4a6a1a',continent:'africa'},
      {id:'t28',name:'جنوب أفريقيا',x:555,y:470,w:110,h:110,res:['diamond','gold'],pop:60000000,baseColor:'#3a5a1a',continent:'africa'},
      {id:'t29',name:'الكونغو',x:540,y:380,w:80,h:90,res:['diamond','wood'],pop:95000000,baseColor:'#2a5a1a',continent:'africa'},
      {id:'t30',name:'أفغانستان',x:740,y:265,w:90,h:80,res:['grain'],pop:230000000,baseColor:'#8a6a2a',continent:'asia'},
      {id:'t31',name:'الهند الشمالية',x:780,y:285,w:110,h:90,res:['grain','industry'],pop:700000000,baseColor:'#8a5a2a',continent:'asia'},
      {id:'t32',name:'الهند الجنوبية',x:800,y:360,w:90,h:100,res:['grain','tech'],pop:500000000,baseColor:'#9a6a3a',continent:'asia'},
      {id:'t33',name:'الصين الغربية',x:790,y:185,w:130,h:120,res:['grain','mineral'],pop:300000000,baseColor:'#8a2a2a',continent:'asia'},
      {id:'t34',name:'الصين الشرقية',x:880,y:200,w:130,h:120,res:['industry','tech'],pop:900000000,baseColor:'#aa3a3a',continent:'asia'},
      {id:'t35',name:'اليابان',x:980,y:175,w:60,h:90,res:['industry','tech'],pop:125000000,baseColor:'#cc4444',continent:'asia'},
      {id:'t36',name:'كوريا',x:940,y:200,w:50,h:70,res:['industry','tech'],pop:75000000,baseColor:'#4a4aaa',continent:'asia'},
      {id:'t37',name:'جنوب شرق آسيا',x:870,y:340,w:130,h:110,res:['grain','oil'],pop:680000000,baseColor:'#4a8a4a',continent:'asia'},
      {id:'t38',name:'أستراليا',x:900,y:470,w:160,h:140,res:['grain','mineral'],pop:26000000,baseColor:'#9a6a2a',continent:'oceania'},
      {id:'t39',name:'نيوزيلندا',x:1030,y:550,w:60,h:80,res:['grain','cattle'],pop:5000000,baseColor:'#6a9a5a',continent:'oceania'},
      {id:'t40',name:'كازاخستان',x:720,y:165,w:110,h:100,res:['oil','grain'],pop:19000000,baseColor:'#7a7a3a',continent:'asia'},
    ],
    units:[
      {id:'infantry',icon:'🪖',name:'مشاة',atk:10,def:8,spd:5,cost:100},
      {id:'tank',icon:'🛡️',name:'دبابات',atk:40,def:35,spd:3,cost:500},
      {id:'artillery',icon:'💣',name:'مدفعية',atk:60,def:10,spd:2,cost:800},
      {id:'fighter',icon:'✈️',name:'مقاتلات',atk:70,def:30,spd:10,cost:1200},
      {id:'bomber',icon:'💥',name:'قاذفات',atk:100,def:15,spd:7,cost:2000},
      {id:'navy',icon:'🚢',name:'سفن حربية',atk:80,def:60,spd:4,cost:1500},
      {id:'submarine',icon:'🤿',name:'غواصات',atk:90,def:40,spd:6,cost:1800},
      {id:'missile',icon:'🚀',name:'صواريخ',atk:150,def:5,spd:15,cost:3000},
      {id:'nuclear',icon:'☢️',name:'نووي',atk:500,def:0,spd:20,cost:50000},
    ],
    technologies:[
      {id:'steel',icon:'⚙️',name:'صلب متطور',effect:'+20% دبابات',cost:500,prereq:null},
      {id:'radar',icon:'📡',name:'رادار متقدم',effect:'+15% دفاع جوي',cost:800,prereq:null},
      {id:'nuclear',icon:'☢️',name:'الطاقة النووية',effect:'فتح أسلحة نووية',cost:10000,prereq:'steel'},
      {id:'cyber',icon:'💻',name:'حرب إلكترونية',effect:'+10% هجمات',cost:1200,prereq:'radar'},
      {id:'biotech',icon:'🧬',name:'تقنية حيوية',effect:'+25% سكان',cost:600,prereq:null},
      {id:'space',icon:'🛸',name:'برنامج فضائي',effect:'+30% استخبارات',cost:15000,prereq:'nuclear'},
      {id:'ai',icon:'🤖',name:'ذكاء اصطناعي',effect:'+20% اقتصاد',cost:3000,prereq:'cyber'},
      {id:'stealth',icon:'👻',name:'تقنية التخفي',effect:'+40% مقاتلات',cost:2000,prereq:'radar'},
    ],
    buildings:[
      {id:'barracks',icon:'🏚️',name:'ثكنات عسكرية',effect:'+20% تجنيد',baseCost:800,perLevel:400},
      {id:'factory',icon:'🏭',name:'مصنع أسلحة',effect:'+30% إنتاج أسلحة',baseCost:1500,perLevel:750},
      {id:'farm',icon:'🌾',name:'مزرعة ضخمة',effect:'+40% غذاء',baseCost:500,perLevel:250},
      {id:'mine',icon:'⛏️',name:'منجم حديد',effect:'+35% حديد',baseCost:700,perLevel:350},
      {id:'oilrig',icon:'⛽',name:'حقل نفط',effect:'+50% طاقة',baseCost:2000,perLevel:1000},
      {id:'bank',icon:'🏦',name:'مصرف مركزي',effect:'+25% ذهب',baseCost:1000,perLevel:500},
      {id:'port',icon:'⚓',name:'ميناء تجاري',effect:'+20% صادرات',baseCost:1200,perLevel:600},
      {id:'lab',icon:'🔬',name:'مركز بحثي',effect:'+40% بحث',baseCost:1800,perLevel:900},
      {id:'defense',icon:'🛡️',name:'منظومة دفاعية',effect:'+50% مقاومة',baseCost:2500,perLevel:1250},
      {id:'nuke_silo',icon:'🚀',name:'صومعة نووية',effect:'ضربات نووية',baseCost:20000,perLevel:10000},
    ],
    ideologies:[
      {id:'monarchy',icon:'👑',name:'ملكية',bonuses:{happiness:20,defense:10},color:'#8B6914'},
      {id:'republic',icon:'🏛️',name:'جمهورية',bonuses:{economy:15,research:10},color:'#1a5a9a'},
      {id:'empire',icon:'⚔️',name:'إمبراطورية',bonuses:{military:25,territory:15},color:'#8B0000'},
      {id:'democracy',icon:'🗳️',name:'ديمقراطية',bonuses:{research:20,economy:10},color:'#2a7a4a'},
      {id:'theocracy',icon:'☪️',name:'ثيوقراطية',bonuses:{defense:15,happiness:15},color:'#6a4a00'},
      {id:'communism',icon:'⭐',name:'شيوعية',bonuses:{production:20,military:10},color:'#8B1a1a'},
    ],
    alliances:[
      {id:'nato',name:'حلف الشمال الأطلسي',icon:'🛡️',color:'#2a5a9a',members:[]},
      {id:'redpact',name:'ميثاق القارة الحمراء',icon:'⭐',color:'#8a2a2a',members:[]},
      {id:'pacific',name:'اتحاد المحيط الهادئ',icon:'🌊',color:'#2a7a6a',members:[]},
      {id:'desert',name:'رابطة الصحراء',icon:'🌙',color:'#c8a030',members:[]},
      {id:'dragon',name:'تحالف التنين',icon:'🐉',color:'#aa3a3a',members:[]},
    ],
    botNations:[
      {id:'bot1',name:'إمبراطورية الشمس',flag:'☀️',color:'#cc4444',ideology:'empire',power:68200,territories:['t34','t35','t36']},
      {id:'bot2',name:'جمهورية النيل',flag:'🌊',color:'#2a8a5a',ideology:'republic',power:54100,territories:['t25','t26','t27']},
      {id:'bot3',name:'مملكة الغرب',flag:'⭐',color:'#2a5a9a',ideology:'monarchy',power:48900,territories:['t4','t5','t13']},
      {id:'bot4',name:'اتحاد الشرق',flag:'🔥',color:'#8a3a2a',ideology:'communism',power:41200,territories:['t16','t17','t40']},
      {id:'bot5',name:'سلطنة الرمال',flag:'🌙',color:'#c8a030',ideology:'theocracy',power:37800,territories:['t22','t23','t24']},
      {id:'bot6',name:'دولة الغابات',flag:'🦁',color:'#3a7a2a',ideology:'democracy',power:29300,territories:['t8','t9','t10']},
      {id:'bot7',name:'قوة الجليد',flag:'❄️',color:'#5a8abb',ideology:'monarchy',power:22100,territories:['t1','t2']},
      {id:'bot8',name:'حضارة الجنوب',flag:'🦅',color:'#7a5a2a',ideology:'republic',power:18500,territories:['t28','t29']},
    ],
  };
}

// ═══════════════════════════════════════════════════════
// MOBILE FUNCTIONS
// ═══════════════════════════════════════════════════════

const MOB = {
  currentNav : 'map',
  chatOpen   : false,
  warOpen    : false,
  chatChannel: 'world',
  chatUnread : 0,
};

// ── Detect mobile ──
function isMobile() { return window.innerWidth <= 768; }

// ── Mobile top bar update (also updates strip) ──
const _origUpdateTopBar = updateTopBar;
function updateTopBar() {
  _origUpdateTopBar();
  if (isMobile()) updateMobStrip();
}

function updateMobStrip() {
  const r = C.nation?.resources || {};
  const el = (id, v) => { const e = document.getElementById(id); if(e) e.textContent = v; };
  el('mrGold',   fmt(r.gold   || 0));
  el('mrIron',   fmt(r.iron   || 0));
  el('mrFood',   fmt(r.food   || 0));
  el('mrEnergy', fmt(r.energy || 0));
  el('mrPop',    fmtPop(r.pop || 0));
  el('mrPow',    fmt(calcPower(C.nation)));
}

// ── Bottom nav switch ──
function mobNavSwitch(tab, el) {
  document.querySelectorAll('.mob-nav-btn').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
  MOB.currentNav = tab;

  // Hide chat sheet when switching tabs
  if (tab !== 'chat') closeMobChat();

  // Close panel if open
  if (tab !== 'more' && tab !== 'nation' && tab !== 'military') closeMobPanel();

  switch(tab) {
    case 'map':      /* just show map */ break;
    case 'nation':   mobShowPanel('nation'); break;
    case 'military': mobShowPanel('military'); break;
    case 'chat':     mobToggleChat(); break;
    case 'more':     mobShowPanel('more'); break;
  }
}

// ── Chat sheet ──
function mobToggleChat() {
  const sheet = document.getElementById('mobChatSheet');
  if (MOB.chatOpen) {
    closeMobChat();
  } else {
    sheet.classList.add('show');
    MOB.chatOpen = true;
    MOB.chatUnread = 0;
    const badge = document.getElementById('chatBadge');
    badge.style.display = 'none';
    badge.textContent = '0';
    setTimeout(() => document.getElementById('mobChatIn')?.focus(), 100);
  }
}

function closeMobChat() {
  document.getElementById('mobChatSheet')?.classList.remove('show');
  MOB.chatOpen = false;
}

function mobSetCh(ch, el) {
  MOB.chatChannel = ch;
  C.chatChannel   = ch;
  document.querySelectorAll('.mob-ch-tab').forEach(b => b.classList.remove('active'));
  el.classList.add('active');
}

function mobSendChat() {
  const inp  = document.getElementById('mobChatIn');
  const text = inp?.value?.trim();
  if (!text || !C.nation) return;
  const msg = { flag:C.nation.flag, name:C.nation.name, channel:MOB.chatChannel, text, time:now() };
  wsSend({ type:'chat', channel:MOB.chatChannel, text });
  addChatMsg(msg, true);
  inp.value = '';
}

// Intercept addChatMsg to show badge on mobile
const _origAddChat = addChatMsg;
function addChatMsg(msg, scroll) {
  _origAddChat(msg, scroll);
  if (isMobile() && !MOB.chatOpen && msg.flag) {
    MOB.chatUnread++;
    const badge = document.getElementById('chatBadge');
    if (badge) { badge.style.display = 'flex'; badge.textContent = MOB.chatUnread > 9 ? '9+' : MOB.chatUnread; }
  }
}

// ── Mobile war sheet ──
function mobShowWarList() {
  // Show list of enemy nations to pick target
  const gd = C.gamedata || getEmbeddedGamedata();
  mobShowPanel('warlist');
}

function mobOpenWar(bot) {
  closeMobPanel();
  C.warTarget = bot;
  document.getElementById('mobWAFlag').textContent = C.nation?.flag || '🏴';
  document.getElementById('mobWAName').textContent = C.nation?.name || 'دولتك';
  document.getElementById('mobWAPow').textContent  = 'القوة: ' + fmt(calcPower(C.nation));
  document.getElementById('mobWDFlag').textContent = bot.flag;
  document.getElementById('mobWDName').textContent = bot.name;
  document.getElementById('mobWDPow').textContent  = 'القوة: ' + fmt(bot.power);
  document.getElementById('mobWarSheet').classList.add('show');
  MOB.warOpen = true;
}

function closeMobWar() {
  document.getElementById('mobWarSheet').classList.remove('show');
  MOB.warOpen = false;
  C.warTarget = null;
}

async function mobLaunchWar(type) {
  if (!C.warTarget) return;
  const cost = WAR_COSTS[type] || 500;
  if ((C.nation?.resources?.gold || 0) < cost) {
    showNotif(`⚠️ تحتاج ${fmt(cost)} ذهب!`, 'info'); return;
  }
  closeMobWar();
  openMobBattle(type);
}

// ── Mobile battle ──
function openMobBattle(type) {
  const overlay = document.getElementById('mobBattle');
  overlay.classList.add('show');
  document.getElementById('mbAFlag').textContent = C.nation?.flag || '🏴';
  document.getElementById('mbAName').textContent = C.nation?.name || 'دولتك';
  document.getElementById('mbDFlag').textContent = C.warTarget?.flag || '🏴';
  document.getElementById('mbDName').textContent = C.warTarget?.name || 'العدو';
  document.getElementById('mbRes').textContent   = '';
  document.getElementById('mbClose').style.display = 'none';
  document.getElementById('mbLog').innerHTML = '';

  // Run battle
  runMobBattle(type);
}

async function runMobBattle(type) {
  const cost = WAR_COSTS[type] || 500;
  let result;
  try {
    result = await api('POST', '/api/war/declare', { token:C.token, targetId:C.warTarget.id, attackType:type });
    if (result.attacker) { C.nation.resources = result.attacker.resources; C.nation.stats = result.attacker.stats; C.nation.territories = result.attacker.territories; }
  } catch {
    result = offlineSimBattle(type, cost);
  }

  const wr = result.war?.result || result?.war || result;
  const rounds = wr.log || [];
  const logEl  = document.getElementById('mbLog');
  let i = 0;

  const iv = setInterval(() => {
    if (i >= rounds.length) {
      clearInterval(iv);
      const won = wr.winner === 'attacker';
      const resEl = document.getElementById('mbRes');
      resEl.textContent = won ? '🏆 انتصرت!' : '💀 هُزمت!';
      resEl.style.color = won ? 'var(--ng)' : 'var(--nr)';
      document.getElementById('mbClose').style.display = 'block';

      if (won) {
        const loot = wr.loot || Math.floor(Math.random()*2000+500);
        showNotif(`🏆 انتصار! غنمت ${fmt(loot)} ذهب!`, 'alliance');
        addChatMsg({ flag:C.nation.flag, name:C.nation.name, channel:'world', text:`🏆 هزمت ${C.warTarget?.flag} ${C.warTarget?.name}!`, time:now() }, true);
        if (wr.capturedTerritory) { C.territories[wr.capturedTerritory] = C.nationId; renderMap(); buildMinimap(); }
        explodeMap();
      } else {
        showNotif('💀 هُزمت! عزّز جيشك!', 'war');
      }
      updateTopBar();
      return;
    }

    const r = rounds[i++];
    document.getElementById('mbABar').style.width = r.atkHP + '%';
    document.getElementById('mbDBar').style.width = r.defHP + '%';
    document.getElementById('mbAHP').textContent  = r.atkHP + '%';
    document.getElementById('mbDHP').textContent  = r.defHP + '%';
    logEl.innerHTML += `<div>🔁 جولة ${r.round}: أنت ${r.atkHP}% — عدو ${r.defHP}%</div>`;
    logEl.scrollTop = logEl.scrollHeight;
  }, 350);
}

function closeMobBattle() {
  document.getElementById('mobBattle').classList.remove('show');
  C.warTarget = null;
}

// ── Mobile panel ──
function mobShowPanel(type) {
  const panel   = document.getElementById('mobPanel');
  const box     = document.getElementById('mobPanelBox');
  const title   = document.getElementById('mobPanelTitle');
  const content = document.getElementById('mobPanelContent');

  const titles = {
    nation:'🏛️ الدولة', military:'⚔️ الجيش', tech:'🔬 التقنية',
    build:'🏗️ البناء', chat:'💬 الدردشة', ally:'🤝 التحالفات',
    trade:'💱 التجارة', diplo:'📜 الدبلوماسية', lb:'🏆 الترتيب',
    warlist:'⚔️ اختر هدفاً', more:'⚙️ المزيد', players:'🌐 اللاعبون',
  };

  title.textContent = titles[type] || '—';
  content.innerHTML = '';

  switch(type) {
    case 'nation':   mobBuildNation(content); break;
    case 'military': mobBuildMilitary(content); break;
    case 'tech':     mobBuildTech(content); break;
    case 'build':    mobBuildBuildings(content); break;
    case 'ally':     mobBuildAlliances(content); break;
    case 'trade':    mobBuildTrade(content); break;
    case 'diplo':    mobBuildDiplo(content); break;
    case 'lb':       mobBuildLeaderboard(content); break;
    case 'warlist':  mobBuildWarList(content); break;
    case 'players':  mobBuildPlayers(content); break;
    case 'more':     mobBuildMore(content); break;
  }

  panel.classList.add('show');
}

function closeMobPanel() {
  document.getElementById('mobPanel').classList.remove('show');
}

// ── Panel contents ──

function mobBuildNation(c) {
  const n   = C.nation || {};
  const r   = n.resources || {};
  const gd  = C.gamedata || getEmbeddedGamedata();
  const pow = calcPower(n);
  const ideo = gd.ideologies.find(i=>i.id===n.ideology) || gd.ideologies[2];

  c.innerHTML = `
    <div style="text-align:center;margin-bottom:14px">
      <div style="font-size:2.5rem;margin-bottom:4px">${n.flag||'🏴'}</div>
      <div style="font-family:Cinzel,serif;font-size:1rem;color:var(--gold-l);font-weight:700">${n.name||'دولتك'}</div>
      <div style="font-size:.7rem;padding:3px 10px;border-radius:12px;display:inline-block;margin-top:4px;background:${ideo.color}33;color:${ideo.color}">${ideo.icon} ${ideo.name}</div>
    </div>
    <div class="mob-stat-grid">
      <div class="mob-stat-card"><div class="mob-stat-val gld">${fmt(pow)}</div><div class="mob-stat-lbl">⚔️ القوة</div></div>
      <div class="mob-stat-card"><div class="mob-stat-val">${(n.territories||[]).length}</div><div class="mob-stat-lbl">🗺️ الأراضي</div></div>
      <div class="mob-stat-card"><div class="mob-stat-val good">${n.stats?.wins||0}</div><div class="mob-stat-lbl">🏆 انتصارات</div></div>
      <div class="mob-stat-card"><div class="mob-stat-val bad">${n.stats?.losses||0}</div><div class="mob-stat-lbl">💀 هزائم</div></div>
    </div>
    <div style="margin-bottom:16px">
      <div style="font-size:.7rem;color:var(--dim);margin-bottom:6px;letter-spacing:1.5px">📊 الموارد الحالية</div>
      ${[['💰','ذهب',r.gold],['🪨','حديد',r.iron],['🌾','غذاء',r.food],['⚡','طاقة',r.energy]].map(([ico,lbl,val])=>`
        <div style="display:flex;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(255,255,255,.04);font-size:.82rem">
          <span style="color:var(--dim)">${ico} ${lbl}</span>
          <span style="color:var(--gold-l);font-weight:700">${fmt(val||0)}</span>
        </div>`).join('')}
    </div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
      <button onclick="closeMobPanel();setTimeout(()=>mobShowPanel('lb'),100)" style="padding:10px;border-radius:8px;background:rgba(201,168,76,.15);border:1px solid rgba(201,168,76,.3);color:var(--gold);font-family:Cairo;font-size:.82rem;cursor:pointer">🏆 الترتيب</button>
      <button onclick="closeMobPanel();setTimeout(()=>mobShowPanel('diplo'),100)" style="padding:10px;border-radius:8px;background:rgba(26,58,92,.25);border:1px solid rgba(33,150,243,.3);color:#64B5F6;font-family:Cairo;font-size:.82rem;cursor:pointer">📜 دبلوماسية</button>
    </div>`;
}

function mobBuildMilitary(c) {
  const gd = C.gamedata || getEmbeddedGamedata();
  const mil = C.nation?.military || {};
  c.innerHTML = '<div style="font-size:.7rem;color:var(--dim);margin-bottom:12px;letter-spacing:1.5px">اضغط لتجنيد الوحدات بالذهب</div>';
  gd.units.forEach(u => {
    const cnt = mil[u.id] || 0;
    const el = document.createElement('div');
    el.className = 'mob-unit-card';
    el.innerHTML = `
      <div class="mob-unit-row">
        <div class="mob-unit-ico">${u.icon}</div>
        <div class="mob-unit-info">
          <div class="mob-unit-name">${u.name}</div>
          <div class="mob-unit-cnt">${fmt(cnt)} وحدة</div>
        </div>
      </div>
      <div class="mob-unit-stats">
        <div class="mob-us">هجوم: <span style="color:var(--nr)">${u.atk}</span></div>
        <div class="mob-us">دفاع: <span style="color:#2196F3">${u.def}</span></div>
        <div class="mob-us">سرعة: <span style="color:var(--ng)">${u.spd}</span></div>
      </div>
      <div class="mob-recruit-row">
        <button class="mob-rec-btn" onclick="recruitUnit('${u.id}',1);setTimeout(()=>mobShowPanel('military'),300)">➕×1 | 💰${fmt(u.cost)}</button>
        <button class="mob-rec-btn" onclick="recruitUnit('${u.id}',5);setTimeout(()=>mobShowPanel('military'),300)">➕×5 | 💰${fmt(u.cost*5)}</button>
      </div>`;
    c.appendChild(el);
  });
}

function mobBuildTech(c) {
  const gd = C.gamedata || getEmbeddedGamedata();
  gd.technologies.forEach(tech => {
    const done   = C.nation?.techs?.includes(tech.id);
    const locked = tech.prereq && !C.nation?.techs?.includes(tech.prereq);
    const el = document.createElement('div');
    el.className = 'mob-tech-card' + (done?' done':'') + (locked?' locked':'');
    el.innerHTML = `
      <div class="mob-tech-ico">${tech.icon}</div>
      <div class="mob-tech-info">
        <div class="mob-tech-name">${tech.name}${done?' ✅':''}</div>
        <div class="mob-tech-eff">${tech.effect}</div>
        <div class="mob-tech-cost">${done?'مكتمل':locked?'🔒 '+tech.prereq:'💰 '+fmt(tech.cost)}</div>
      </div>`;
    if (!done && !locked) el.onclick = () => { researchTech(tech); setTimeout(()=>mobShowPanel('tech'),400); };
    c.appendChild(el);
  });
}

function mobBuildBuildings(c) {
  const gd = C.gamedata || getEmbeddedGamedata();
  gd.buildings.forEach(b => {
    const lvl  = C.nation?.buildings?.[b.id] || 0;
    const cost = b.baseCost + b.perLevel * lvl;
    const el   = document.createElement('div');
    el.className = 'mob-build-card';
    el.innerHTML = `
      <div class="mob-build-row">
        <div class="mob-build-ico">${b.icon}</div>
        <div class="mob-build-info">
          <div class="mob-build-name">${b.name}</div>
          <div class="mob-build-lvl">المستوى ${lvl}</div>
        </div>
      </div>
      <div class="mob-build-eff">${b.effect}</div>
      <button class="mob-build-btn" onclick="upgradeBuilding('${b.id}');setTimeout(()=>mobShowPanel('build'),400)">
        🏗️ ${lvl===0?'بناء':'ترقية'} | 💰 ${fmt(cost)}
      </button>`;
    c.appendChild(el);
  });
}

function mobBuildAlliances(c) {
  const myAlly = C.alliances.find(a => a.members?.includes(C.nationId));
  C.alliances.forEach(a => {
    const inIt = a.members?.includes(C.nationId);
    const el   = document.createElement('div');
    el.className = 'mob-ally-card';
    el.innerHTML = `
      <div class="mob-ally-hd">
        <div class="mob-ally-ico">${a.icon}</div>
        <div class="mob-ally-name">${a.name}</div>
        <div class="mob-ally-cnt">${(a.members||[]).length} أعضاء</div>
      </div>
      <div style="font-size:.72rem;color:var(--dim);margin-bottom:9px">${inIt?'✅ أنت عضو':myAlly?'⚠️ في تحالف آخر':'مفتوح للانضمام'}</div>
      <div class="mob-ally-acts">
        ${!inIt && !myAlly
          ? `<button class="mob-ally-join" onclick="joinAlliance('${a.id}');setTimeout(()=>mobShowPanel('ally'),300)">🤝 انضمام</button>`
          : inIt
          ? `<button class="mob-ally-leave" onclick="leaveAlliance('${a.id}');setTimeout(()=>mobShowPanel('ally'),300)">🚪 مغادرة</button>`
          : '<span style="font-size:.75rem;color:var(--dim)">غير متاح</span>'}
      </div>`;
    c.appendChild(el);
  });
}

function mobBuildTrade(c) {
  const offers = C.tradeOffers.filter(o=>o.status==='open').slice(0,8);
  if (offers.length) {
    const hd = document.createElement('div');
    hd.innerHTML = '<div style="font-size:.7rem;color:var(--dim);margin-bottom:10px;letter-spacing:1.5px">عروض مفتوحة</div>';
    c.appendChild(hd);
    offers.forEach(o => {
      const el = document.createElement('div');
      el.className = 'mob-trade-offer';
      el.innerHTML = `
        <span class="mob-trade-flag">${o.fromFlag||'🌍'}</span>
        <div class="mob-trade-info">
          <div class="mob-trade-name">${o.fromName||'مجهول'}</div>
          <div class="mob-trade-deal">يعطي: ${o.give?.amount} ${o.give?.resource} ← يريد: ${o.want?.amount} ${o.want?.resource}</div>
        </div>
        <button class="mob-trade-accept" onclick="acceptTrade('${o.id}');setTimeout(()=>mobShowPanel('trade'),300)">✅ قبول</button>`;
      c.appendChild(el);
    });
  }

  const newTrade = document.createElement('div');
  newTrade.innerHTML = `
    <div style="font-size:.7rem;color:var(--dim);margin:12px 0 8px;letter-spacing:1.5px">📢 عرض جديد</div>
    <div class="mob-new-trade">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:6px">
        <div>
          <div style="font-size:.7rem;color:var(--dim);margin-bottom:4px">أعطي</div>
          <select class="mob-trade-sel" id="mgr"><option value="gold">💰 ذهب</option><option value="iron">🪨 حديد</option><option value="food">🌾 غذاء</option><option value="energy">⚡ طاقة</option></select>
          <input class="mob-trade-inp" id="mga" type="number" placeholder="الكمية" min="1">
        </div>
        <div>
          <div style="font-size:.7rem;color:var(--dim);margin-bottom:4px">أريد</div>
          <select class="mob-trade-sel" id="mwr"><option value="iron">🪨 حديد</option><option value="gold">💰 ذهب</option><option value="food">🌾 غذاء</option><option value="energy">⚡ طاقة</option></select>
          <input class="mob-trade-inp" id="mwa" type="number" placeholder="الكمية" min="1">
        </div>
      </div>
      <button class="mob-trade-post" onclick="mobPostTrade()">📢 نشر العرض</button>
    </div>`;
  c.appendChild(newTrade);
}

async function mobPostTrade() {
  const giveRes = document.getElementById('mgr')?.value;
  const giveAmt = parseInt(document.getElementById('mga')?.value) || 0;
  const wantRes = document.getElementById('mwr')?.value;
  const wantAmt = parseInt(document.getElementById('mwa')?.value) || 0;
  if (!giveAmt || !wantAmt) { showNotif('⚠️ أدخل الكميات!', 'info'); return; }
  const offer = { give:{resource:giveRes,amount:giveAmt}, want:{resource:wantRes,amount:wantAmt} };
  try { await api('POST','/api/trade/offer',{token:C.token,offer}); } catch {
    C.tradeOffers.unshift({id:'m_'+Date.now(),fromFlag:C.nation.flag,fromName:C.nation.name,...offer,status:'open'});
  }
  showNotif(`📢 نشرت عرض تجاري!`, 'resource');
  closeMobPanel();
}

function mobBuildDiplo(c) {
  const gd = C.gamedata || getEmbeddedGamedata();
  gd.botNations.slice(0,8).forEach(b => {
    const el = document.createElement('div');
    el.className = 'mob-player-card';
    el.innerHTML = `
      <div class="mob-pst on"></div>
      <div class="mob-pflag">${b.flag}</div>
      <div class="mob-pinfo">
        <div class="mob-pname">${b.name}</div>
        <div class="mob-pideo">القوة: ${fmt(b.power)}</div>
      </div>
      <div style="display:flex;flex-direction:column;gap:4px">
        <button class="mob-attack-btn" onclick="closeMobPanel();setTimeout(()=>mobOpenWar(${JSON.stringify(b).replace(/"/g,"'")}),150)">⚔️ حرب</button>
        <button style="padding:5px 10px;background:rgba(45,90,39,.25);border:1px solid rgba(76,175,80,.35);border-radius:5px;color:var(--ng);font-size:.65rem;cursor:pointer;font-family:Cairo" onclick="sendDiplo('${b.id}','ally');showNotif('📜 أرسلت طلب تحالف!','info')">🤝 حلف</button>
      </div>`;
    c.appendChild(el);
  });
}

function mobBuildLeaderboard(c) {
  const gd  = C.gamedata || getEmbeddedGamedata();
  const all = [
    { name:C.nation?.name||'دولتك', flag:C.nation?.flag||'🏴', power:calcPower(C.nation), isMe:true },
    ...gd.botNations.map(b=>({name:b.name,flag:b.flag,power:b.power})),
  ].sort((a,b)=>b.power-a.power).slice(0,12);

  all.forEach((p,i) => {
    const el = document.createElement('div');
    el.className = 'mob-lb-item';
    el.innerHTML = `
      <span class="mob-lb-rank ${i===0?'r1':i===1?'r2':i===2?'r3':''}">${i+1}</span>
      <span class="mob-lb-flag">${p.flag}</span>
      <span class="mob-lb-name" style="${p.isMe?'color:var(--gold-l)':''}">${p.name}${p.isMe?' ★':''}</span>
      <span class="mob-lb-score">${fmt(p.power)}</span>`;
    c.appendChild(el);
  });
}

function mobBuildWarList(c) {
  const gd = C.gamedata || getEmbeddedGamedata();
  c.innerHTML = '<div style="font-size:.75rem;color:var(--dim);margin-bottom:12px">اختر دولة لمهاجمتها</div>';
  gd.botNations.forEach(b => {
    const el = document.createElement('div');
    el.className = 'mob-player-card';
    el.innerHTML = `
      <div class="mob-pst war"></div>
      <div class="mob-pflag">${b.flag}</div>
      <div class="mob-pinfo">
        <div class="mob-pname">${b.name}</div>
        <div class="mob-pideo">⚔️ ${fmt(b.power)} | 🗺️ ${b.territories.length} منطقة</div>
      </div>
      <button class="mob-attack-btn" onclick="closeMobPanel();setTimeout(()=>mobOpenWar(${JSON.stringify(b).replace(/"/g,"'")}),150)">⚔️ هجوم</button>`;
    c.appendChild(el);
  });
}

function mobBuildPlayers(c) {
  const gd = C.gamedata || getEmbeddedGamedata();
  const me = { name:C.nation?.name||'دولتك', flag:C.nation?.flag||'🏴', power:calcPower(C.nation), isMe:true, online:true };
  [me, ...gd.botNations].forEach(p => {
    const el = document.createElement('div');
    el.className = 'mob-player-card';
    el.innerHTML = `
      <div class="mob-pst ${p.online!==false?'on':'war'}"></div>
      <div class="mob-pflag">${p.flag}</div>
      <div class="mob-pinfo">
        <div class="mob-pname" style="${p.isMe?'color:var(--gold-l)':''}">${p.name}${p.isMe?' ★':''}</div>
        <div class="mob-pideo">${p.isMe?'دولتك':'مشارك'}</div>
      </div>
      <span class="mob-ppow">⚔️ ${(p.power/1000).toFixed(0)}k</span>`;
    c.appendChild(el);
  });
}

function mobBuildMore(c) {
  const items = [
    { icon:'🏆', label:'الترتيب العالمي', action:"mobShowPanel('lb')" },
    { icon:'🌐', label:'اللاعبون الأونلاين', action:"mobShowPanel('players')" },
    { icon:'📜', label:'الدبلوماسية',     action:"mobShowPanel('diplo')" },
    { icon:'🤝', label:'التحالفات',       action:"mobShowPanel('ally')" },
    { icon:'💱', label:'سوق التجارة',     action:"mobShowPanel('trade')" },
    { icon:'🔬', label:'شجرة التقنية',   action:"mobShowPanel('tech')" },
    { icon:'🏗️', label:'المباني',         action:"mobShowPanel('build')" },
    { icon:'🚪', label:'تسجيل الخروج',   action:'doLogout()' },
  ];
  c.innerHTML = items.map(it => `
    <div onclick="${it.action};closeMobPanel()" style="
      display:flex;align-items:center;gap:14px;padding:14px 10px;
      border-bottom:1px solid rgba(255,255,255,.05);cursor:pointer;
      transition:.18s;border-radius:8px;margin-bottom:2px;
      -webkit-tap-highlight-color:transparent">
      <span style="font-size:1.4rem">${it.icon}</span>
      <span style="font-size:.9rem;font-weight:600">${it.label}</span>
      <span style="margin-right:auto;color:var(--dim);font-size:.9rem">›</span>
    </div>`).join('');
}

// ── Override onTerClick for mobile war sheet ──
const _origTerClick = onTerClick;
async function onTerClick(t, ownerId, ownerBot, isMe) {
  if (isMobile() && ownerBot) {
    mobOpenWar(ownerBot, t);
    return;
  }
  _origTerClick(t, ownerId, ownerBot, isMe);
}

// ── Override openWarModal for mobile ──
const _origOpenWarModal = openWarModal;
function openWarModal(enemy, territory) {
  if (isMobile()) { mobOpenWar(enemy, territory); return; }
  _origOpenWarModal(enemy, territory);
}

// ── Init mobile ──
function initMobile() {
  if (!isMobile()) return;
  // Auto-show chat sheet toggle when nav chat is active
  window.addEventListener('resize', () => {
    if (!isMobile()) closeMobPanel();
  });
  // Prevent scroll bounce
  document.body.addEventListener('touchmove', (e) => {
    if (!e.target.closest('.mob-panel-box, .mob-battle-box, .chat-area, .pcontent')) {
      e.preventDefault();
    }
  }, { passive:false });
}

// Hook into startGame
const _origStartGame = startGame;
function startGame() {
  _origStartGame();
  initMobile();
}

