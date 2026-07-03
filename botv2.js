const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { HttpsProxyAgent } = require('https-proxy-agent');

// Config & State bawaan Script Pertama
const WALLET = "Alamat_Wallet_Solana_Kamu_Di_Sini";
const SESSION_PATH = path.join(__dirname, 'session.json');
const PROXY_PATH = path.join(__dirname, 'proxy.txt');
const BOT_NAME = "IslandsBot";
const BOT_COLOR = "#ff0000";
const SKILL_MODE = "combat"; // combat / farm
const ATK_INTERVAL = 200;    // Interval serangan dasar

const TILE_TO_WORLD = 64;

// State global dari Script Pertama
let state = {
  ws: null,
  connected: false,
  authed: false,
  reconnects: 0,
  maxReconnects: 5,
  _running: false,
  _lastKickReason: null,
  
  // Data Player
  id: null, x: 16000, y: 16000, facing: 1, boat: false,
  bd: 'right', vcx: 16000, vcy: 16000, vr: 3275,
  hp: 100, maxHp: 100,

  inventory: { wood: 0, meat: 0 },
  xp: { level: 1, free: 0, speedMult: 1 },
  world: { mobs: [] },
  
  currentTargetMobId: null,
  isMoving: false,
  
  // State Radar Internal
  searchAngle: 0,
  searchRadius: 250,

  // --- LOGIKA ANTI-KONVOI (Suntikan Baru) ---
  // Setiap akun yang jalan punya sudut kepungan dan jarak orbit unik agar tidak baris beriringan
  personalAngleOffset: Math.random() * Math.PI * 2,
  personalDistOffset: Math.floor(Math.random() * 20) + 10
};

// Timers
let stateInterval = null;
let attackInterval = null;
let healInterval = null;

function log(icon, msg) {
  console.log(`[${new Date().toLocaleTimeString()}] ${icon} ${msg}`);
}

// Proxy Loader dari Script Pertama
function getProxy() {
  if (fs.existsSync(PROXY_PATH)) {
    const lines = fs.readFileSync(PROXY_PATH, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length > 0) {
      // Ambil acak dari list proxy agar tiap akun beda IP
      return lines[Math.floor(Math.random() * lines.length)];
    }
  }
  return null;
}

async function doLogin() {
  log('🔑', 'Mencoba mengautentikasi wallet ke API Solana Islands...');
  // Asumsi fungsi login API web3 mengembalikan token baru
  const mockToken = "sess_" + Math.random().toString(36).substring(2);
  fs.writeFileSync(SESSION_PATH, JSON.stringify({ walletAddress: WALLET, sessionToken: mockToken }));
  return mockToken;
}

function send(msg) {
  if (state.connected && state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(msg));
  }
}

function stopIntervals() {
  if (stateInterval) clearInterval(stateInterval);
  if (attackInterval) clearInterval(attackInterval);
  if (healInterval) clearInterval(healInterval);
}

// Bawaan Script Pertama: Alokasi Stat & Auto-Heal Makan Daging
function checkAndAllocateSkills() {
  if (state.xp.free <= 0) return;
  const priority = ['str', 'agi', 'vit'];
  for (const stat of priority) {
    if (state.xp.free > 0) {
      send({ t: 'allocate', stat: stat });
      state.xp.free--;
      break;
    }
  }
}

function autoHealCheck() {
  // Jika HP di bawah 80% dan punya daging, otomatis konsumsi item
  if ((state.hp / state.maxHp) < 0.8 && state.inventory.meat > 0) {
    log('🍖', 'HP Rendah! Mengonsumsi daging untuk memulihkan diri.');
    send({ t: 'useItem', item: 'meat' });
  }
}

function skillPlanStr() {
  return "STR > AGI > VIT";
}

async function ensureNearbyChunks() {
  // Sinkronisasi chunk area maps disekitar bot
}

// ─── NAVIGASI UTAMA DENGAN DYNAMIC HYPER-STEP & ANTI-KONVOI ───
function moveToward(tx, ty, step) {
  const dx = tx - state.x;
  const dy = ty - state.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 1) return;

  // Penghitungan langkah presisi berdasar target koordinat
  const nextX = Math.round(state.x + (dx / dist) * step);
  const nextY = Math.round(state.y + (dy / dist) * step);

  state.x = nextX;
  state.y = nextY;
  state.vcx = nextX; // vcx sinkron dengan posisi real x untuk bypass anti-cheat server
  state.vcy = nextY; // vcy sinkron dengan posisi real y untuk bypass anti-cheat server
  state.facing = dx > 0 ? 1 : -1;
  state.bd = dx > 0 ? 'right' : 'left';
  state.isMoving = true;
}

function radarSweep() {
  // Tiap akun arah putarnya dibikin beda biar mencarnya merata saat ga ada monster
  const direction = (state.personalDistOffset % 2 === 0) ? 0.5 : -0.5;
  state.searchAngle += direction;
  state.searchRadius += 12;

  if (state.searchRadius > 1000) state.searchRadius = 200;

  const targetX = Math.round(state.x + Math.cos(state.searchAngle) * state.searchRadius);
  const targetY = Math.round(state.y + Math.sin(state.searchAngle) * state.searchRadius);

  moveToward(targetX, targetY, 150);
}

function distanceTo(x, y) {
  const dx = x - state.x;
  const dy = y - state.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function processRadarCombat() {
  if (!state.connected || !state.authed) return;

  const availableMobs = (state.world.mobs || []).filter(m => m.hp === undefined || m.hp > 0);

  if (availableMobs.length > 0) {
    let targetMob = null;

    const mappedMobs = availableMobs.map(m => {
      const wx = m.x !== undefined ? (m.x > 1000 ? m.x : m.x * TILE_TO_WORLD) : (m.wx || 0);
      const wy = m.y !== undefined ? (m.y > 1000 ? m.y : m.y * TILE_TO_WORLD) : (m.wy || 0);
      return { id: m.id, type: m.type || 'Monster', wx, wy, hp: m.hp };
    });

    if (state.currentTargetMobId) {
      targetMob = mappedMobs.find(m => m.id === state.currentTargetMobId);
    }

    if (!targetMob) {
      let minDistance = Infinity;
      for (const m of mappedMobs) {
        const d = distanceTo(m.wx, m.wy);
        if (d < minDistance) {
          minDistance = d;
          targetMob = m;
        }
      }
      if (targetMob) {
        state.currentTargetMobId = targetMob.id;
        log('⚔️', `Mengunci target Baru -> [${targetMob.type}]`);
      }
    }

    if (targetMob) {
      // --- LOGIKA ANTI-KONVOI (Pengepungan Sisi Luar) ---
      // Bot diarahkan ke lingkar luar target menggunakan offset konstan dari akun tersebut
      const targetX = targetMob.wx + Math.cos(state.personalAngleOffset) * state.personalDistOffset;
      const targetY = targetMob.wy + Math.sin(state.personalAngleOffset) * state.personalDistOffset;

      const distToFlankPoint = distanceTo(targetX, targetY);

      if (distToFlankPoint > 48) {
        // --- LOGIKA DYNAMIC HYPER-STEP / ADAPTIVE DASH ---
        let hyperStep = 90;
        if (distToFlankPoint > 400) {
          hyperStep = 550;
        } else if (distToFlankPoint >= 150 && distToFlankPoint <= 400) {
          hyperStep = 300;
        } else {
          hyperStep = 90;
        }

        // Pengali level kecepatan + micro jitter (+/- 4%) agar nilai step tidak identik antar akun
        const microJitter = 1 + (Math.random() * 0.08 - 0.04);
        const finalStep = Math.min(distToFlankPoint, hyperStep * state.xp.speedMult * microJitter);

        moveToward(targetX, targetY, finalStep);
      } else {
        state.isMoving = false;
        // Serang monster
        send({ t: 'attack' });
      }
    }
  } else {
    state.currentTargetMobId = null;
    radarSweep();
  }
}

// Packet Handler & Engine Intervals dari Script Pertama
function handleMsg(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch (e) { return; }

  switch (msg.t) {
    case 'welcome':
      state.id = msg.id;
      state.authed = true;
      log('🎉', 'Berhasil masuk ke arena permainan!');
      startIntervals();
      break;
    case 'player_stat': // Update status HP untuk fungsi auto-heal
      if (msg.hp !== undefined) state.hp = msg.hp;
      if (msg.maxHp !== undefined) state.maxHp = msg.maxHp;
      break;
    case 'inv':
      if (msg.wood !== undefined) state.inventory.wood = msg.wood;
      if (msg.meat !== undefined) state.inventory.meat = msg.meat;
      break;
    case 'xp':
      const prevLv = state.xp.level;
      state.xp = { level: msg.level, free: msg.free || 0, speedMult: msg.speedMult || 1 };
      if (msg.level > prevLv) log('⬆️', `LEVEL UP! Karakter sekarang Level ${msg.level}`);
      if (msg.free > 0) checkAndAllocateSkills();
      break;
    case 'world':
      if (msg.mobs) state.world.mobs = msg.mobs;
      break;
    case 'death':
      if (msg.id === state.currentTargetMobId) {
        log('💀', 'Monster target tereliminasi!');
        state.currentTargetMobId = null;
        state.searchRadius = 250;
        // Acak ulang sudut kepungan untuk target berikutnya
        state.personalAngleOffset = Math.random() * Math.PI * 2;
      }
      break;
    case 'kick':
      state._lastKickReason = msg.reason || 'swap-server';
      break;
  }
}

function startIntervals() {
  stopIntervals();
  
  // Penundaan jitter dasar agar pengiriman paket per terminal tidak bentrok di ms yang sama
  const accountSpecificJitter = Math.floor(Math.random() * 30);
  
  stateInterval = setInterval(() => {
    send({
      t: 'state',
      x: state.x, y: state.y,
      moving: state.isMoving,
      facing: state.facing,
      boat: state.boat,
      bd: state.bd,
      vcx: state.vcx,
      vcy: state.vcy,
      vr: state.vr
    });
  }, 45 + Math.floor(Math.random() * 10));

  attackInterval = setInterval(() => {
    processRadarCombat();
  }, ATK_INTERVAL + accountSpecificJitter);

  // Interval cek darah untuk memicu auto-heal daging (Script 1)
  healInterval = setInterval(() => {
    autoHealCheck();
  }, 1000);
}

// WebSocket Connection & Reconnect Logic dari Script Pertama
function connect(sessionToken) {
  const proxyUrl = getProxy();
  const options = {};
  if (proxyUrl) {
    log('🌐', `Mengaktifkan Proxy: ${proxyUrl}`);
    options.agent = new HttpsProxyAgent(proxyUrl);
  }

  log('🔌', 'Menyambungkan koneksi ke WebSocket game...');
  state.ws = new WebSocket("wss://islands.games/socket", options);

  state.ws.on('open', () => {
    state.connected = true;
    state.reconnects = 0;
    log('✅', 'Koneksi terjalin dengan server.');
    
    send({
      t: 'hello',
      auth: { walletAddress: WALLET, sessionToken },
      name: BOT_NAME,
      color: BOT_COLOR
    });
  });

  state.ws.on('message', (data) => {
    handleMsg(data.toString());
  });

  state.ws.on('close', async (code, reason) => {
    state.connected = false;
    state.authed = false;
    stopIntervals();
    log('🔌', `WebSocket terputus (Code: ${code})`);

    if (state._lastKickReason === 'swap-server') {
      log('🔄', 'Terjadi Server-Swap, menyambungkan ulang segera...');
      state._lastKickReason = null;
      setTimeout(() => main(), 1000);
      return;
    }

    if (state.reconnects < state.maxReconnects) {
      state.reconnects++;
      const delay = Math.min(1000 * Math.pow(2, state.reconnects), 30000);
      log('⏳', `Mencoba menyambung kembali dalam ${(delay / 1000).toFixed(1)}s...`);
      setTimeout(() => main(), delay);
    } else {
      log('❌', 'Batas maksimum rekoneksi tercapai.');
      process.exit(1);
    }
  });

  state.ws.on('error', (err) => {
    log('⚠️', `WebSocket Error: ${err.message}`);
  });
}

// Main Entry Point dari Script Pertama
async function main() {
  if (state._running) {
    try {
      let token;
      if (fs.existsSync(SESSION_PATH)) {
        const cached = JSON.parse(fs.readFileSync(SESSION_PATH, 'utf8'));
        if (cached.walletAddress === WALLET && cached.sessionToken) {
          token = cached.sessionToken;
        }
      }
      if (!token) token = await doLogin();
      connect(token);
    } catch (e) {
      setTimeout(main, 5000);
    }
    return;
  }

  state._running = true;
  console.log(`\n🏝️  Starting Islands Auto-Bot (Script 1 Modded)...`);
  console.log(`   Wallet: ${WALLET}`);
  console.log(`   Mode:   ${SKILL_MODE.toUpperCase()} (${skillPlanStr()})`);
  console.log(`   Adaptive Dash & Anti-Convoy: ACTIVE\n`);

  try {
    await ensureNearbyChunks();
    let token;
    if (fs.existsSync(SESSION_PATH)) {
      try {
        const cached = JSON.parse(fs.readFileSync(SESSION_PATH, 'utf8'));
        if (cached.walletAddress === WALLET && cached.sessionToken) {
          token = cached.sessionToken;
        }
      } catch (e) {}
    }
    if (!token) token = await doLogin();
    connect(token);
  } catch (err) {
    state._running = false;
    setTimeout(main, 10000);
  }
}

process.on('unhandledRejection', (reason) => {
  log('🐛', `Unhandled rejection: ${reason?.message || reason}`);
});

main();
