// ============================================================
// WORLD WAR ONLINE - index.js (Server)
// ============================================================
const express = require('express');
const http    = require('http');
const WebSocket = require('ws');
const { v4: uuidv4 } = require('uuid');
const fs   = require('fs');
const path = require('path');

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

const PORT = process.env.PORT || 3000;
const GAMEDATA = JSON.parse(fs.readFileSync(path.join(__dirname,'data','gamedata.json'),'utf8'));

// ===== IN-MEMORY STATE =====
const state = {
  players: {},        // socketId -> playerData
  nations: {},        // nationId -> nationData
  sessions: {},       // username -> sessionToken
  wars: [],           // active wars
  alliances: JSON.parse(JSON.stringify(GAMEDATA.alliances)),
  chat: {
    world: [], alliance: [], trade: []
  },
  territories: {},    // territoryId -> ownerNationId
  tradeOffers: [],
  diplomacy: [],
  tick: 0,
};

// Assign bot territories
GAMEDATA.botNations.forEach(bot => {
  state.nations[bot.id] = {
    ...bot,
    military: { infantry:200, tank:50, artillery:30, fighter:20, bomber:10, navy:15, submarine:8, missile:5, nuclear:0 },
    buildings: {}, techs: [],
    resources: { gold: bot.gold, iron: bot.iron, food: 20000, energy: 5000, pop: 5000000 },
    stats: { wins:Math.floor(Math.random()*20), losses:Math.floor(Math.random()*5), age:0 },
    isBot: true, online: true,
  };
  bot.territories.forEach(tid => { state.territories[tid] = bot.id; });
});

// ===== MIDDLEWARE =====
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ===== REST API =====

// GET game data (territories, units, tech, etc.)
app.get('/api/gamedata', (req, res) => {
  res.json({
    territories: GAMEDATA.territories,
    units: GAMEDATA.units,
    technologies: GAMEDATA.technologies,
    buildings: GAMEDATA.buildings,
    ideologies: GAMEDATA.ideologies,
    alliances: state.alliances,
    botNations: GAMEDATA.botNations,
  });
});

// GET leaderboard
app.get('/api/leaderboard', (req, res) => {
  const all = Object.values(state.nations).map(n => ({
    id: n.id, name: n.name, flag: n.flag, color: n.color,
    power: calcPower(n),
    territories: n.territories.length,
    online: n.online || false,
    ideology: n.ideology,
  })).sort((a, b) => b.power - a.power).slice(0, 20);
  res.json(all);
});

// GET territory ownership map
app.get('/api/territories', (req, res) => {
  res.json(state.territories);
});

// GET online players
app.get('/api/players', (req, res) => {
  const online = Object.values(state.players).map(p => ({
    name: p.name, flag: p.flag, nationId: p.nationId,
    power: p.nationId && state.nations[p.nationId] ? calcPower(state.nations[p.nationId]) : 0,
  }));
  res.json(online);
});

// POST register / login
app.post('/api/auth', (req, res) => {
  const { username, password, nationData } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'بيانات ناقصة' });

  const savedFile = path.join(__dirname, 'data', 'players', username + '.json');
  const dir = path.join(__dirname, 'data', 'players');
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  let player;
  if (fs.existsSync(savedFile)) {
    player = JSON.parse(fs.readFileSync(savedFile, 'utf8'));
    if (player.password !== password) return res.status(401).json({ error: 'كلمة مرور خاطئة' });
  } else {
    if (!nationData) return res.json({ needsNation: true });
    const nationId = 'n_' + uuidv4().slice(0,8);
    const startTerr = getRandomNeutralTerritory();
    state.nations[nationId] = {
      id: nationId, name: nationData.name, flag: nationData.flag,
      color: nationData.color, ideology: nationData.ideology,
      territories: startTerr ? [startTerr] : [],
      military: { infantry:50, tank:10, artillery:5, fighter:3, bomber:1, navy:2, submarine:1, missile:0, nuclear:0 },
      buildings: {}, techs: [],
      resources: { gold:10000, iron:5000, food:8000, energy:2000, pop:1000000 },
      stats: { wins:0, losses:0, age:0 },
      online: false, isBot: false,
    };
    if (startTerr) state.territories[startTerr] = nationId;

    player = { username, password, nationId, createdAt: Date.now() };
    fs.writeFileSync(savedFile, JSON.stringify(player, null, 2));
  }

  const token = uuidv4();
  state.sessions[token] = { username, nationId: player.nationId };

  // Mark nation online
  if (state.nations[player.nationId]) state.nations[player.nationId].online = true;

  res.json({ token, nationId: player.nationId, nation: state.nations[player.nationId] });
});

// POST create nation
app.post('/api/nation/create', (req, res) => {
  const { token, nationData } = req.body;
  const sess = state.sessions[token];
  if (!sess) return res.status(401).json({ error: 'جلسة منتهية' });
  const nation = state.nations[sess.nationId];
  if (!nation) return res.status(404).json({ error: 'الدولة غير موجودة' });
  Object.assign(nation, nationData);
  saveNation(sess.username, sess.nationId);
  res.json({ success: true, nation });
});

// GET nation data
app.get('/api/nation/:id', (req, res) => {
  const nation = state.nations[req.params.id];
  if (!nation) return res.status(404).json({ error: 'غير موجود' });
  res.json({ ...nation, power: calcPower(nation) });
});

// POST recruit military
app.post('/api/military/recruit', (req, res) => {
  const { token, unitId, amount } = req.body;
  const sess = state.sessions[token];
  if (!sess) return res.status(401).json({ error: 'غير مصرح' });
  const nation = state.nations[sess.nationId];
  const unit = GAMEDATA.units.find(u => u.id === unitId);
  if (!nation || !unit) return res.status(400).json({ error: 'خطأ' });
  const cost = unit.cost * (amount || 1);
  if (nation.resources.gold < cost) return res.status(400).json({ error: 'ذهب غير كافٍ' });
  nation.resources.gold -= cost;
  nation.military[unitId] = (nation.military[unitId] || 0) + (amount || 1);
  broadcast({ type:'nation_update', nationId: sess.nationId, military: nation.military, resources: nation.resources });
  res.json({ success: true, military: nation.military, gold: nation.resources.gold });
});

// POST research tech
app.post('/api/tech/research', (req, res) => {
  const { token, techId } = req.body;
  const sess = state.sessions[token];
  if (!sess) return res.status(401).json({ error: 'غير مصرح' });
  const nation = state.nations[sess.nationId];
  const tech = GAMEDATA.technologies.find(t => t.id === techId);
  if (!nation || !tech) return res.status(400).json({ error: 'خطأ' });
  if (nation.techs.includes(techId)) return res.status(400).json({ error: 'مبحوثة بالفعل' });
  if (tech.prereq && !nation.techs.includes(tech.prereq)) return res.status(400).json({ error: 'تحتاج: ' + tech.prereq });
  if (nation.resources.gold < tech.cost) return res.status(400).json({ error: 'ذهب غير كافٍ' });
  nation.resources.gold -= tech.cost;
  nation.techs.push(techId);
  saveNation(sess.username, sess.nationId);
  res.json({ success: true, techs: nation.techs });
});

// POST upgrade building
app.post('/api/building/upgrade', (req, res) => {
  const { token, buildingId } = req.body;
  const sess = state.sessions[token];
  if (!sess) return res.status(401).json({ error: 'غير مصرح' });
  const nation = state.nations[sess.nationId];
  const building = GAMEDATA.buildings.find(b => b.id === buildingId);
  if (!nation || !building) return res.status(400).json({ error: 'خطأ' });
  const level = nation.buildings[buildingId] || 0;
  const cost = building.baseCost + building.perLevel * level;
  if (nation.resources.gold < cost) return res.status(400).json({ error: 'ذهب غير كافٍ، تحتاج ' + cost });
  nation.resources.gold -= cost;
  nation.buildings[buildingId] = level + 1;
  applyBuildingBonus(nation, buildingId, level + 1);
  saveNation(sess.username, sess.nationId);
  res.json({ success: true, buildings: nation.buildings, resources: nation.resources });
});

// POST declare war
app.post('/api/war/declare', (req, res) => {
  const { token, targetId, attackType } = req.body;
  const sess = state.sessions[token];
  if (!sess) return res.status(401).json({ error: 'غير مصرح' });
  const attacker = state.nations[sess.nationId];
  const defender = state.nations[targetId];
  if (!attacker || !defender) return res.status(400).json({ error: 'دولة غير موجودة' });

  const result = simulateBattle(attacker, defender, attackType);
  const war = {
    id: uuidv4().slice(0,8),
    attackerId: sess.nationId,
    defenderId: targetId,
    attackType,
    result,
    timestamp: Date.now(),
  };
  state.wars.push(war);

  // Apply war results
  if (result.winner === 'attacker') {
    attacker.stats.wins++;
    defender.stats.losses++;
    const loot = Math.floor(defender.resources.gold * 0.15);
    attacker.resources.gold += loot;
    defender.resources.gold -= loot;
    result.loot = loot;
    // Move one territory
    if (defender.territories.length > 0) {
      const captured = defender.territories[Math.floor(Math.random() * defender.territories.length)];
      defender.territories = defender.territories.filter(t => t !== captured);
      attacker.territories.push(captured);
      state.territories[captured] = sess.nationId;
      result.capturedTerritory = captured;
    }
  } else {
    defender.stats.wins++;
    attacker.stats.losses++;
    const penalty = Math.floor(attacker.resources.gold * 0.1);
    attacker.resources.gold -= penalty;
    result.penalty = penalty;
  }

  // Broadcast war event
  broadcastAll({
    type: 'war_event',
    attackerName: attacker.name,
    attackerFlag: attacker.flag,
    defenderName: defender.name,
    defenderFlag: defender.flag,
    result: result.winner,
    attackType,
  });

  broadcastAll({ type: 'territory_update', territories: state.territories });

  saveNation(sess.username, sess.nationId);
  res.json({ success: true, war, attacker: { resources: attacker.resources, stats: attacker.stats, territories: attacker.territories }, defender: { resources: defender.resources } });
});

// POST annex neutral territory
app.post('/api/territory/annex', (req, res) => {
  const { token, territoryId } = req.body;
  const sess = state.sessions[token];
  if (!sess) return res.status(401).json({ error: 'غير مصرح' });
  const nation = state.nations[sess.nationId];
  if (!nation) return res.status(400).json({ error: 'خطأ' });
  if (state.territories[territoryId]) return res.status(400).json({ error: 'المنطقة محتلة' });
  if (nation.resources.gold < 500) return res.status(400).json({ error: 'تحتاج 500 ذهب' });
  nation.resources.gold -= 500;
  nation.territories.push(territoryId);
  state.territories[territoryId] = sess.nationId;
  saveNation(sess.username, sess.nationId);
  broadcastAll({ type: 'territory_update', territories: state.territories });
  res.json({ success: true, resources: nation.resources, territories: nation.territories });
});

// POST join alliance
app.post('/api/alliance/join', (req, res) => {
  const { token, allianceId } = req.body;
  const sess = state.sessions[token];
  if (!sess) return res.status(401).json({ error: 'غير مصرح' });
  const alliance = state.alliances.find(a => a.id === allianceId);
  if (!alliance) return res.status(404).json({ error: 'تحالف غير موجود' });
  if (!alliance.members.includes(sess.nationId)) {
    alliance.members.push(sess.nationId);
    broadcastAll({ type: 'alliance_update', alliances: state.alliances });
  }
  res.json({ success: true, alliance });
});

// POST leave alliance
app.post('/api/alliance/leave', (req, res) => {
  const { token, allianceId } = req.body;
  const sess = state.sessions[token];
  if (!sess) return res.status(401).json({ error: 'غير مصرح' });
  const alliance = state.alliances.find(a => a.id === allianceId);
  if (alliance) {
    alliance.members = alliance.members.filter(m => m !== sess.nationId);
    broadcastAll({ type: 'alliance_update', alliances: state.alliances });
  }
  res.json({ success: true });
});

// POST trade offer
app.post('/api/trade/offer', (req, res) => {
  const { token, offer } = req.body;
  const sess = state.sessions[token];
  if (!sess) return res.status(401).json({ error: 'غير مصرح' });
  const tradeOffer = {
    id: uuidv4().slice(0,8),
    fromId: sess.nationId,
    fromName: state.nations[sess.nationId]?.name,
    fromFlag: state.nations[sess.nationId]?.flag,
    ...offer,
    timestamp: Date.now(),
    status: 'open',
  };
  state.tradeOffers.unshift(tradeOffer);
  if (state.tradeOffers.length > 50) state.tradeOffers.pop();
  broadcastAll({ type: 'trade_offer', offer: tradeOffer });
  res.json({ success: true, offer: tradeOffer });
});

// POST accept trade
app.post('/api/trade/accept', (req, res) => {
  const { token, offerId } = req.body;
  const sess = state.sessions[token];
  if (!sess) return res.status(401).json({ error: 'غير مصرح' });
  const offer = state.tradeOffers.find(o => o.id === offerId && o.status === 'open');
  if (!offer) return res.status(404).json({ error: 'عرض غير موجود' });
  const buyer  = state.nations[sess.nationId];
  const seller = state.nations[offer.fromId];
  if (!buyer || !seller) return res.status(400).json({ error: 'خطأ' });

  // Execute trade
  const res1 = offer.give; // seller gives
  const res2 = offer.want; // buyer gives
  if (seller.resources[res1.resource] >= res1.amount && buyer.resources[res2.resource] >= res2.amount) {
    seller.resources[res1.resource] -= res1.amount;
    buyer.resources[res1.resource]  = (buyer.resources[res1.resource] || 0) + res1.amount;
    buyer.resources[res2.resource]  -= res2.amount;
    seller.resources[res2.resource] = (seller.resources[res2.resource] || 0) + res2.amount;
    offer.status = 'done';
    broadcastAll({ type: 'trade_done', offerId, buyerName: buyer.name, sellerName: seller.name });
    res.json({ success: true });
  } else {
    res.status(400).json({ error: 'موارد غير كافية' });
  }
});

// GET trade offers
app.get('/api/trade/offers', (req, res) => {
  res.json(state.tradeOffers.filter(o => o.status === 'open').slice(0, 20));
});

// GET war history
app.get('/api/wars', (req, res) => {
  res.json(state.wars.slice(-30));
});

// GET chat history
app.get('/api/chat/:channel', (req, res) => {
  const ch = req.params.channel;
  res.json(state.chat[ch] || []);
});

// POST diplomacy message (declare peace, threaten, etc.)
app.post('/api/diplomacy/send', (req, res) => {
  const { token, targetId, action, message } = req.body;
  const sess = state.sessions[token];
  if (!sess) return res.status(401).json({ error: 'غير مصرح' });
  const from = state.nations[sess.nationId];
  const target = state.nations[targetId];
  if (!from || !target) return res.status(400).json({ error: 'خطأ' });

  const diploMsg = {
    id: uuidv4().slice(0,8),
    fromId: sess.nationId,
    fromName: from.name,
    fromFlag: from.flag,
    targetId,
    action,
    message,
    timestamp: Date.now(),
  };
  state.diplomacy.push(diploMsg);

  // Notify target if online
  const targetSocket = Object.values(state.players).find(p => p.nationId === targetId);
  if (targetSocket && targetSocket.ws && targetSocket.ws.readyState === WebSocket.OPEN) {
    send(targetSocket.ws, { type: 'diplomacy_msg', msg: diploMsg });
  }

  res.json({ success: true });
});

// ===== WEBSOCKET =====
wss.on('connection', (ws) => {
  const socketId = uuidv4().slice(0, 8);
  state.players[socketId] = { ws, socketId, name: '...', nationId: null, flag: '🏴' };

  send(ws, { type:'connected', socketId, gamedata: {
    territories: GAMEDATA.territories,
    territoryOwners: state.territories,
    alliances: state.alliances,
    onlinePlayers: getOnlineSummary(),
    recentChat: { world: state.chat.world.slice(-30), alliance: [], trade: state.chat.trade.slice(-20) },
  }});

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'auth': {
        const sess = state.sessions[msg.token];
        if (sess) {
          state.players[socketId].nationId = sess.nationId;
          state.players[socketId].name = sess.username;
          const nation = state.nations[sess.nationId];
          if (nation) {
            state.players[socketId].flag = nation.flag;
            nation.online = true;
          }
          send(ws, { type:'auth_ok', nationId: sess.nationId, nation });
          broadcastAll({ type:'player_joined', name: sess.username, flag: nation?.flag || '🏴', nationId: sess.nationId });
        }
        break;
      }

      case 'chat': {
        const player = state.players[socketId];
        const nation = player.nationId ? state.nations[player.nationId] : null;
        const channel = ['world','alliance','trade'].includes(msg.channel) ? msg.channel : 'world';
        const text = String(msg.text || '').slice(0, 200);
        if (!text.trim()) break;
        const chatMsg = {
          id: uuidv4().slice(0,8),
          flag: nation?.flag || '🏴',
          name: nation?.name || player.name || 'مجهول',
          channel,
          text,
          time: new Date().toLocaleTimeString('ar'),
          nationId: player.nationId,
        };
        state.chat[channel] = state.chat[channel] || [];
        state.chat[channel].push(chatMsg);
        if (state.chat[channel].length > 100) state.chat[channel].shift();

        if (channel === 'alliance') {
          // Only broadcast to alliance members
          const allianceId = getAllianceOf(player.nationId);
          const allianceMembers = allianceId ? state.alliances.find(a => a.id === allianceId)?.members || [] : [];
          Object.values(state.players).forEach(p => {
            if (!allianceId || allianceMembers.includes(p.nationId)) {
              if (p.ws.readyState === WebSocket.OPEN) send(p.ws, { type:'chat', msg: chatMsg });
            }
          });
        } else {
          broadcastAll({ type:'chat', msg: chatMsg });
        }
        break;
      }

      case 'ping':
        send(ws, { type:'pong', tick: state.tick });
        break;
    }
  });

  ws.on('close', () => {
    const player = state.players[socketId];
    if (player && player.nationId && state.nations[player.nationId]) {
      state.nations[player.nationId].online = false;
    }
    if (player) {
      broadcastAll({ type:'player_left', nationId: player.nationId, name: player.name });
    }
    delete state.players[socketId];
  });
});

// ===== GAME TICK =====
setInterval(() => {
  state.tick++;

  // Resource generation for all real nations
  Object.values(state.nations).forEach(nation => {
    if (!nation.isBot && !nation.online) return;
    const terCount = nation.territories.length;
    nation.resources.gold   = Math.min(999999, nation.resources.gold   + 5 * (terCount + 1));
    nation.resources.iron   = Math.min(999999, nation.resources.iron   + 3 * (terCount + 1));
    nation.resources.food   = Math.min(999999, nation.resources.food   + 8 * (terCount + 1));
    nation.resources.energy = Math.min(999999, nation.resources.energy + 1 * (terCount + 1));
    nation.resources.pop    = Math.min(999999999, nation.resources.pop + 100 * (terCount + 1));
    nation.stats.age++;
  });

  // Bot behavior every 30 ticks
  if (state.tick % 30 === 0) {
    botTick();
  }

  // Send resource updates to connected players
  if (state.tick % 5 === 0) {
    Object.values(state.players).forEach(player => {
      if (!player.nationId) return;
      const nation = state.nations[player.nationId];
      if (!nation) return;
      if (player.ws.readyState === WebSocket.OPEN) {
        send(player.ws, { type:'resources', resources: nation.resources });
      }
    });
  }

  // Send leaderboard every 60 ticks
  if (state.tick % 60 === 0) {
    const lb = Object.values(state.nations).map(n => ({
      id: n.id, name: n.name, flag: n.flag,
      power: calcPower(n), territories: n.territories.length, online: n.online,
    })).sort((a, b) => b.power - a.power).slice(0, 15);
    broadcastAll({ type:'leaderboard', data: lb });
  }

}, 1000);

// Bot tick - bots do things
function botTick() {
  const bots = Object.values(state.nations).filter(n => n.isBot);
  bots.forEach(bot => {
    const roll = Math.random();
    if (roll < 0.15) {
      // Bot sends chat
      const msgs = GAMEDATA.chatBotMessages.filter(m => m.flag === bot.flag);
      if (msgs.length) {
        const m = msgs[Math.floor(Math.random() * msgs.length)];
        const chatMsg = {
          id: uuidv4().slice(0,8),
          flag: m.flag, name: m.name, channel: m.channel,
          text: m.text, time: new Date().toLocaleTimeString('ar'),
          nationId: bot.id,
        };
        const ch = m.channel;
        state.chat[ch] = state.chat[ch] || [];
        state.chat[ch].push(chatMsg);
        if (state.chat[ch].length > 100) state.chat[ch].shift();
        broadcastAll({ type:'chat', msg: chatMsg });
      }
    } else if (roll < 0.25) {
      // Bot attacks another bot
      const targets = bots.filter(b => b.id !== bot.id);
      if (targets.length) {
        const target = targets[Math.floor(Math.random() * targets.length)];
        const result = simulateBattle(bot, target, 'ground');
        if (result.winner === 'attacker' && target.territories.length > 0) {
          const cap = target.territories.splice(Math.floor(Math.random() * target.territories.length), 1)[0];
          bot.territories.push(cap);
          state.territories[cap] = bot.id;
          broadcastAll({ type:'territory_update', territories: state.territories });
        }
        broadcastAll({
          type: 'war_event',
          attackerName: bot.name, attackerFlag: bot.flag,
          defenderName: target.name, defenderFlag: target.flag,
          result: result.winner, attackType: 'ground', isBot: true,
        });
      }
    } else if (roll < 0.30) {
      // Bot tries to annex neutral
      const neutrals = GAMEDATA.territories.filter(t => !state.territories[t.id]);
      if (neutrals.length) {
        const t = neutrals[Math.floor(Math.random() * neutrals.length)];
        bot.territories.push(t.id);
        state.territories[t.id] = bot.id;
        broadcastAll({ type:'territory_update', territories: state.territories });
      }
    }
  });
}

// ===== HELPERS =====
function calcPower(nation) {
  if (!nation) return 0;
  const units = GAMEDATA.units;
  let power = 0;
  units.forEach(u => { power += (nation.military[u.id] || 0) * u.atk; });
  power += nation.territories.length * 1000;
  power += nation.techs.length * 500;
  power += Object.values(nation.buildings).reduce((s, l) => s + l * 200, 0);
  return power;
}

function simulateBattle(attacker, defender, attackType) {
  const typeMult = { ground:1, air:1.3, naval:1.1, nuclear:3 };
  const mult = typeMult[attackType] || 1;
  const atkPow = calcPower(attacker) * mult * (0.7 + Math.random() * 0.6);
  const defPow = calcPower(defender) * (0.7 + Math.random() * 0.6);

  const atkHPStart = 100, defHPStart = 100;
  let atkHP = atkHPStart, defHP = defHPStart;
  const log = [];

  for (let i = 0; i < 10; i++) {
    const dmgToDefender = Math.floor((atkPow / Math.max(defPow, 1)) * 15 + Math.random() * 10);
    const dmgToAttacker = Math.floor((defPow / Math.max(atkPow, 1)) * 12 + Math.random() * 8);
    defHP = Math.max(0, defHP - dmgToDefender);
    atkHP = Math.max(0, atkHP - dmgToAttacker);
    log.push({ round: i + 1, atkHP, defHP, dmgToDefender, dmgToAttacker });
    if (atkHP <= 0 || defHP <= 0) break;
  }

  return {
    winner: defHP <= 0 ? 'attacker' : 'defender',
    atkHP, defHP, log,
    atkPowerUsed: Math.floor(atkPow), defPowerUsed: Math.floor(defPow),
  };
}

function applyBuildingBonus(nation, buildingId, level) {
  const bonuses = {
    farm:    () => { /* food rate boost tracked on client */ },
    mine:    () => {},
    oilrig:  () => {},
    bank:    () => nation.resources.gold += 200 * level,
  };
  if (bonuses[buildingId]) bonuses[buildingId]();
}

function getRandomNeutralTerritory() {
  const owned = new Set(Object.keys(state.territories));
  const neutral = GAMEDATA.territories.filter(t => !owned.has(t.id));
  if (!neutral.length) return null;
  const t = neutral[Math.floor(Math.random() * neutral.length)];
  return t.id;
}

function getAllianceOf(nationId) {
  const a = state.alliances.find(al => al.members.includes(nationId));
  return a ? a.id : null;
}

function getOnlineSummary() {
  return Object.values(state.players).map(p => ({
    name: p.name, flag: p.flag, nationId: p.nationId,
  }));
}

function send(ws, data) {
  try {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
  } catch {}
}

function broadcast(data) {
  // Broadcast to all except bots
  Object.values(state.players).forEach(p => send(p.ws, data));
}

function broadcastAll(data) {
  Object.values(state.players).forEach(p => send(p.ws, data));
}

function saveNation(username, nationId) {
  try {
    const dir = path.join(__dirname, 'data', 'nations');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, nationId + '.json'), JSON.stringify(state.nations[nationId], null, 2));
  } catch {}
}

// ===== START =====
server.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════╗');
  console.log('║   ⚔️  WORLD WAR ONLINE - SERVER      ║');
  console.log('╠══════════════════════════════════════╣');
  console.log('║  http://localhost:' + PORT + '               ║');
  console.log('║  WebSocket: ws://localhost:' + PORT + '      ║');
  console.log('╚══════════════════════════════════════╝');
  console.log('');
  console.log('📡 Server running! Bots active:', Object.keys(state.nations).length);
});
