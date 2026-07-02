/**
 * bot.js — Islands.games Full Auto-Bot v3
 * Run: node bot.js --help  to see all options
 */

const WebSocket = require('ws');
const nacl      = require('tweetnacl');
const bs58      = require('bs58');
const fs        = require('fs');
const path      = require('path');
const { Keypair } = require('@solana/web3.js');
const bip39       = require('bip39');
const { derivePath } = require('ed25519-hd-key');
const { ProxyAgent } = require('proxy-agent'); // <-- Ditambahkan untuk penanganan multi-protocol proxy

// ─────────────────────────────────────────────
// HELP SCREEN
// ─────────────────────────────────────────────
const HELP = `
╔═══════════════════════════════════════════════════════════════╗
║           🏝️  ISLANDS BOT v3 — COMMAND USAGE                  ║
╚═══════════════════════════════════════════════════════════════╝

  node bot.js [options]

──────────────────────────────────────────────────────────────
  FOCUS / FARMING MODE
──────────────────────────────────────────────────────────────
  --focus <mode>        What to farm (default: tree)
  --skip <mobs>         Comma-separated list of mobs to ignore (e.g. shaman,pigrider)

  Modes:
    tree                 Mine trees only (wood)
    gold                 Mine gold nodes only (requires Level 25!)
    diamond              Mine diamonds only (requires Level 60!)
    monster              Kill monsters (mob)
    boss                 Kill boss monsters only
    tree+gold            Farm trees AND gold (gold needs Lv25)
    tree+monster         Farm trees AND kill monsters
    tree+gold+diamond    Farm all resources
    all                  Everything: tree+gold+diamond+monster+boss

  Examples:
    node bot.js --focus tree
    node bot.js --focus tree+gold
    node bot.js --focus monster --skip pigrider,shaman
    node bot.js --focus all

──────────────────────────────────────────────────────────────
  SKILL ALLOCATION
──────────────────────────────────────────────────────────────
  --skill <mode>        Skill mode: priority | percent | single
                        (default: priority)

  Priority mode — fill first stat, then second:
    --skill priority --prio vit,str,agi
    node bot.js --skill priority --prio vit,str,agi

  Percent mode — distribute by percentage (must total 100):
    --skill percent --vit 60 --str 30 --agi 10
    node bot.js --skill percent --vit 50 --str 50 --agi 0

  Single mode — dump ALL points into one stat instantly:
    --skill single --stat vit
    node bot.js --skill single --stat str

──────────────────────────────────────────────────────────────
  PLAYER SETTINGS
──────────────────────────────────────────────────────────────
  --name <name>         Bot player name  (default: IslandsBot)
  --color <color>       Player color     (default: Blue)
                        Colors: Blue Red Green Yellow Purple Orange

──────────────────────────────────────────────────────────────
  PERFORMANCE
──────────────────────────────────────────────────────────────
  --speed <ms>          Attack interval in ms (default: 500)
                        Lower = faster attacks (min ~200)
  --chase <px>          Max chase distance for mobs (default: 400)
                        WARNING: Values below 300 can trigger anti-cheat!
  --fast                Enable speedhack for instant movement

──────────────────────────────────────────────────────────────
  EXAMPLES
──────────────────────────────────────────────────────────────
  # Tree farming, fast attacks, priority skill (vit first)
  node bot.js --focus tree --speed 300 --skill priority --prio vit,str,agi

  # All resources, percent skill split
  node bot.js --focus all --skill percent --vit 60 --str 30 --agi 10

  # Boss hunting, dump all skill into STR
  node bot.js --focus boss --skill single --stat str --speed 250

  # Custom name and color
  node bot.js --focus tree+gold --name MyBot --color Red

──────────────────────────────────────────────────────────────
  WALLET
──────────────────────────────────────────────────────────────
  Edit wallet.json and put your phrase or private key:
  { "wallet": "word1 word2 ... word12" }
  { "wallet": "base58privatekey..." }

══════════════════════════════════════════════════════════════
`;

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(HELP);
  process.exit(0);
}

// ─────────────────────────────────────────────
// CONFIG & CLI PARSER
// ─────────────────────────────────────────────
const CFG_PATH    = path.join(__dirname, 'bot-config.json');
const WALLET_PATH      = path.join(__dirname, 'wallet.json');
const SESSION_PATH     = path.join(__dirname, 'session.json');
const RARE_MOBS_PATH   = path.join(__dirname, 'rare_mob_types.json');
const KNOWN_SPAWNS_PATH= path.join(__dirname, 'known_mob_spawns.json');
const PROXY_PATH       = path.join(__dirname, 'free-proxy-list.txt');

// PROXY VARIABLES
let proxyList = [];
let currentProxyIndex = -1; // -1 artinya mencoba login langsung dahulu tanpa proxy

function loadProxies() {
  if (fs.existsSync(PROXY_PATH)) {
    const content = fs.readFileSync(PROXY_PATH, 'utf8');
    proxyList = content
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith('#'));
    console.log(`[🌐 PROXY] Loaded ${proxyList.length} proxies dari free-proxy-list.txt`);
  } else {
    console.log(`[⚠️ PROXY] free-proxy-list.txt tidak ditemukan. Berjalan tanpa backup proxy.`);
  }
}
// Muat daftar proxy saat program diinisialisasi
loadProxies();

// RARE DROP DETECTION
const RARE_ITEMS = new Set([
  'shard', 'sigil', 'tome', 'awakening_stone', 
  'old_boat', 'old_shoe', 'fish_manual',
  'rune_sharpness', 'rune_leeching', 'rune_bulwark', 'rune_slayer',
  'rune_mining', 'rune_fortune', 'rune_insight', 'rune_swift',
]);
let rareMobTypes = {};
try {
  if (fs.existsSync(RARE_MOBS_PATH)) {
    rareMobTypes = JSON.parse(fs.readFileSync(RARE_MOBS_PATH, 'utf8'));
    const known = Object.keys(rareMobTypes);
    if (known.length > 0) console.log(`[RARE] Loaded ${known.length} known rare-drop mob types: ${known.join(', ')}`);
  }
} catch (e) { console.warn('[RARE] Could not load rare_mob_types.json:', e.message); }

// GLOBAL SPAWN MEMORY
let knownMobSpawns = {};
let lastSpawnSave = Date.now();
try {
  if (fs.existsSync(KNOWN_SPAWNS_PATH)) {
    knownMobSpawns = JSON.parse(fs.readFileSync(KNOWN_SPAWNS_PATH, 'utf8'));
    console.log(`[SPAWN] Loaded ${Object.keys(knownMobSpawns).length} known mob spawn locations.`);
  }
} catch (e) { console.warn('[SPAWN] Could not load known_mob_spawns.json:', e.message); }

function updateSpawnMemory(mobs) {
  let changed = false;
  const now = Date.now();
  const excludeTypes = ['torch', 'log', 'box', 'barrel', 'crate', 'table', 'chair', 'bed', 'fire', 'anvil'];
  for (const m of mobs) {
    if (!m.type || m.type === 'unknown' || skipMobs.includes(m.type.toLowerCase()) || excludeTypes.includes(m.type.toLowerCase())) continue;
    const gx = Math.round(m.x / 200) * 200;
    const gy = Math.round(m.y / 200) * 200;
    const key = `${gx},${gy}`;
    
    if (!knownMobSpawns[key]) {
      knownMobSpawns[key] = { type: m.type, x: gx, y: gy, lastSeen: now, lastVisited: 0 };
      changed = true;
    } else {
      knownMobSpawns[key].lastSeen = now;
      if (rareMobTypes[m.type.toLowerCase()] && !rareMobTypes[knownMobSpawns[key].type.toLowerCase()]) {
        knownMobSpawns[key].type = m.type;
        changed = true;
      }
    }
  }
  
  if (changed || now - lastSpawnSave > 30000) {
    fs.writeFileSync(KNOWN_SPAWNS_PATH, JSON.stringify(knownMobSpawns, null, 2));
    lastSpawnSave = now;
  }
}

if (!fs.existsSync(WALLET_PATH)) {
  console.error('\n❌ wallet.json not found!');
  console.error('   Edit wallet.json and add your phrase or private key.\n');
  process.exit(1);
}

const cfg = fs.existsSync(CFG_PATH)
  ? JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'))
  : {};

function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function hasArg(flag) { return process.argv.includes(flag); }

const focusArg = arg('--focus', cfg.focus || 'tree');
const skipArg = arg('--skip', '');
const skipMobs = skipArg.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);

function parseFocus(f) {
  if (f === 'all') return { tree: true, gold: true, diamond: true, monster: true, boss: true, fishing: false };
  const parts = f.split('+');
  return {
    tree:    parts.includes('tree'),
    gold:    parts.includes('gold'),
    diamond: parts.includes('diamond'),
    monster: parts.includes('monster'),
    boss:    parts.includes('boss'),
    fishing: parts.includes('fishing'),
  };
}
const MODES = parseFocus(focusArg);

const SKILL_MODE = arg('--skill', cfg.autoSkill?.mode || 'priority').toLowerCase();
const SKILL_PRIO = arg('--prio',  (cfg.autoSkill?.priority || ['vit','str','agi']).join(',')).split(',');
const SKILL_STAT = arg('--stat',  cfg.autoSkill?.single?.stat || 'vit').toLowerCase();
const SKILL_VIT  = parseInt(arg('--vit', cfg.autoSkill?.percent?.vit  ?? 60));
const SKILL_STR  = parseInt(arg('--str', cfg.autoSkill?.percent?.str  ?? 30));
const SKILL_AGI  = parseInt(arg('--agi', cfg.autoSkill?.percent?.agi  ?? 10));

let BOT_NAME  = arg('--name', null);
if (!BOT_NAME && cfg.player?.name && cfg.player?.name !== 'IslandsBot') {
  BOT_NAME = cfg.player.name;
}
const BOT_COLOR = arg('--color', cfg.player?.color || 'Blue');

const ATK_INTERVAL = parseInt(arg('--speed', cfg.settings?.attackIntervalMs || 400));
const ST_INTERVAL  = 100;
const MAX_CHASE    = parseInt(arg('--chase', cfg.settings?.maxMobChaseDist  || 400));
const FAST_MODE    = hasArg('--fast');
const MOVE_STEP    = FAST_MODE ? 500 : 80;
const GOLD_LEVEL_REQ    = 25;
const DIAMOND_LEVEL_REQ = 60;

const BASE_URL = 'https://islands.games';
const SIGN_MSG = 'islands: verify wallet ownership';
const GAME_WS  = 'wss://game-production-87db.up.railway.app/';
const TILE     = 64;

// ─────────────────────────────────────────────
// WALLET — auto-detect phrase or base58 key
// ─────────────────────────────────────────────
function loadKeypair() {
  const wData = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf8'));
  const input = (wData.wallet || wData.secretKeyBase58 || '').trim();

  if (!input) {
    console.error('\n❌ wallet.json is empty!');
    process.exit(1);
  }

  const words = input.split(/\s+/);

  if (words.length === 12 || words.length === 24) {
    if (!bip39.validateMnemonic(input)) {
      console.error('\n❌ Invalid mnemonic phrase — check your words.\n');
      process.exit(1);
    }
    const seed    = bip39.mnemonicToSeedSync(input);
    const derived = derivePath("m/44'/501'/0'/0'", seed.toString('hex')).key;
    return Keypair.fromSeed(derived);
  }

  try {
    const raw = bs58.decode(input);
    if (raw.length !== 64) throw new Error('Expected 64-byte key');
    return Keypair.fromSecretKey(raw);
  } catch (e) {
    console.error('\n❌ Invalid wallet value in wallet.json');
    process.exit(1);
  }
}

const keypair = loadKeypair();
const WALLET  = keypair.publicKey.toBase58();

function signAuthMessage() {
  const msgBytes = new TextEncoder().encode(SIGN_MSG);
  const sig      = nacl.sign.detached(msgBytes, keypair.secretKey);
  return bs58.encode(Buffer.from(sig));
}

// ─────────────────────────────────────────────
// HTTP AUTH (Auto-Proxy Fallback System)
// ─────────────────────────────────────────────
async function doLogin() {
  const sig = signAuthMessage();

  while (true) {
    let currentProxy = null;
    let fetchOptions = {
      method:  'POST',
      headers: { 
        'Content-Type': 'application/json', 
        'Origin': BASE_URL,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      },
      body: JSON.stringify({ walletAddress: WALLET, walletType: 'phantom', signature: sig, message: SIGN_MSG }),
    };

    // Jika index proxy aktif, gunakan ProxyAgent
    if (currentProxyIndex >= 0 && proxyList.length > 0) {
      currentProxy = proxyList[currentProxyIndex];
      log('🌐', `Mencoba login via Proxy [${currentProxyIndex + 1}/${proxyList.length}]: ${currentProxy}`);
      
      try {
        fetchOptions.agent = new ProxyAgent(currentProxy);
      } catch (proxyErr) {
        log('❌', `Format Proxy Salah (${currentProxy}): ${proxyErr.message}`);
        currentProxyIndex++;
        if (currentProxyIndex >= proxyList.length) {
          throw new Error("Semua proxy di list sudah dicoba dan tidak ada yang valid.");
        }
        continue;
      }
    } else {
      log('🔐', `Signing auth message & mencoba login langsung (Tanpa Proxy)...`);
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 12000); // 12 Detik limit per percobaan
    fetchOptions.signal = controller.signal;

    try {
      const res = await fetch(`${BASE_URL}/api/auth/connect`, fetchOptions);
      clearTimeout(timeoutId);

      const data = await res.json();
      if (!res.ok || !data.sessionToken) {
        throw new Error(`Server Response: ${data.error || JSON.stringify(data)}`);
      }

      log('✅', `Login OK — isNew: ${data.isNew} char: ${data.char}`);
      if (currentProxy) {
        log('⭐', `Proxy terhubung aktif & digunakan: ${currentProxy}`);
      }
      fs.writeFileSync(SESSION_PATH, JSON.stringify({ walletAddress: WALLET, sessionToken: data.sessionToken, ...data }, null, 2));
      return data.sessionToken;

    } catch (err) {
      clearTimeout(timeoutId);
      
      if (currentProxy) {
        log('❌', `Proxy ${currentProxy} Gagal Terhubung: ${err.message}`);
      } else {
        log('❌', `Login langsung gagal: ${err.message}. Mengalihkan ke sistem proxy otomatis.`);
      }

      // Pindah ke urutan proxy selanjutnya
      currentProxyIndex++;

      if (proxyList.length === 0) {
        throw new Error(`Login gagal dan tidak ada proxy yang tertera di free-proxy-list.txt`);
      }
      
      if (currentProxyIndex >= proxyList.length) {
        log('🚨', `Semua daftar proxy telah habis dicoba.`);
        currentProxyIndex = 0; // Reset kembali ke urutan pertama
        log('🔄', `Mengulang pencarian dari proxy urutan awal...`);
        await new Promise(resolve => setTimeout(resolve, 5000));
      }
      
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }
}

// ─────────────────────────────────────────────
// DASHBOARD / DISPLAY
// ─────────────────────────────────────────────
let lastRender = 0;
const RENDER_INTERVAL = 500;

function hpBar(pct, width = 20) {
  if (isNaN(pct) || typeof pct !== 'number') pct = 1;
  if (pct < 0) pct = 0;
  if (pct > 1) pct = 1;
  const filled = Math.round(pct * width);
  const bar    = '█'.repeat(filled) + '░'.repeat(width - filled);
  const color  = pct > 0.6 ? '\x1b[32m' : pct > 0.3 ? '\x1b[33m' : '\x1b[31m';
  const val = pct * 100;
  const pctStr = (val > 0 && val < 100) ? val.toFixed(4) : val.toFixed(0);
  return `${color}[${bar}]\x1b[0m ${pctStr}%`;
}

function xpBar(xpVal, cur, next, width = 20) {
  const req = next - cur;
  const progress = xpVal - cur;
  const pct = req > 0 ? Math.max(0, Math.min(1, progress / req)) : 0;
  const filled = Math.round(pct * width);
  return `\x1b[34m[${'█'.repeat(filled)}${'░'.repeat(width - filled)}]\x1b[0m ${progress}/${req}`;
}

function modeStr() {
  return Object.entries(MODES)
    .filter(([, v]) => v)
    .map(([k]) => k.toUpperCase())
    .join(' + ');
}

function renderDashboard(state) {
  const now = Date.now();
  if (now - lastRender < RENDER_INTERVAL) return;
  lastRender = now;

  const p   = state.player;
  const inv = state.inv;
  const xp  = state.xp;
  const sess= state.session;

  process.stdout.write('\x1b[2J\x1b[H');

  const line = (s = '') => console.log(s);
  const sep  = (c = '─', n = 62) => console.log(c.repeat(n));

  sep('═');
  console.log(`  🏝️  ISLANDS BOT v3   │  Wallet: ${WALLET.slice(0,8)}...${WALLET.slice(-6)}`);
  if (currentProxyIndex >= 0 && proxyList[currentProxyIndex]) {
    console.log(`  🌐  Proxy Aktif: ${proxyList[currentProxyIndex]}`);
  }
  sep('═');

  line(`  👤 Player: \x1b[1m${BOT_NAME}\x1b[0m   ID: ${p.id || '—'}   Level: \x1b[33m${xp.level}\x1b[0m`);
  line(`  ❤️  HP  ${hpBar(p.hpPct)}`);
  line(`  ⭐ XP  ${xpBar(xp.xp, xp.cur, xp.next)}   Total: ${xp.xp}`);
  line(`  ⚡ Skills  STR:\x1b[31m${xp.str}\x1b[0m  VIT:\x1b[32m${xp.vit}\x1b[0m  AGI:\x1b[36m${xp.agi}\x1b[0m  Free:\x1b[33m${xp.free}\x1b[0m  Speed:${xp.speedMult}x`);
  line(`  📍 Pos: (${p.x}, ${p.y})   Facing: ${p.facing > 0 ? '→' : '←'}   Boat: ${p.boat ? '⛵' : '🚶'}`);

  sep();

  line(`  🎒 INVENTORY`);
  line(`     🌲 Wood:    \x1b[32m${inv.wood.toString().padStart(6)}\x1b[0m   (+${sess.wood} this session)`);
  line(`     💰 Gold:    \x1b[33m${inv.gold.toString().padStart(6)}\x1b[0m   (+${sess.gold} this session)`);
  line(`     🥩 Meat:    \x1b[31m${inv.meat.toString().padStart(6)}\x1b[0m   (+${sess.meat} this session)`);
  line(`     💎 Diamond: \x1b[96m${(inv.diamond || 0).toString().padStart(6)}\x1b[0m   (+${(sess.extra && sess.extra.diamond) || 0} this session)`);
  if (inv.usdc > 0) line(`     💵 USDC:    \x1b[32m${inv.usdc.toFixed(2).padStart(6)}\x1b[0m`);

  const extraItems = [
    { key: 'fish', label: '🐟 Fish' }, { key: 'shard', label: '🔮 Void Shard' },
    { key: 'sigil', label: '🛡️ War Sigil' }, { key: 'tome', label: '📖 Tome of Ref.' },
    { key: 'awakening_stone', label: '✨ Awk. Stone' }, { key: 'old_boat', label: '🛶 Old Boat' },
    { key: 'old_shoe', label: '👞 Old Shoe' }, { key: 'fish_manual', label: '📘 Fish Manual' },
    { key: 'rune_sharpness', label: '🗡️ Sharpness' }, { key: 'rune_leeching', label: '🩸 Leeching' },
    { key: 'rune_bulwark', label: '🛡️ Bulwark' }, { key: 'rune_slayer', label: '💀 Slayer' },
    { key: 'rune_mining', label: '⛏️ Mining' }, { key: 'rune_fortune', label: '🍀 Fortune' },
    { key: 'rune_insight', label: '👁️ Insight' }, { key: 'rune_swift', label: '⚡ Swift' }
  ];

  for (let i = 0; i < extraItems.length; i += 2) {
    const left = extraItems[i]; const right = extraItems[i + 1];
    const sessLeft = (sess.extra && sess.extra[left.key]) || 0;
    let row = `     ${left.label.padEnd(16)}: \x1b[35m${(inv[left.key] || 0).toString().padStart(4)}\x1b[0m (+${sessLeft})`.padEnd(43);
    if (right) {
      const sessRight = (sess.extra && sess.extra[right.key]) || 0;
      row += `   ${right.label.padEnd(16)}: \x1b[35m${(inv[right.key] || 0).toString().padStart(4)}\x1b[0m (+${sessRight})`;
    }
    line(row);
  }

  sep();

  console.log(`  🌍 WORLD STATE`);
  const knownSpawnsCount = Object.keys(knownMobSpawns).length;
  console.log(`     ⚔️  Mobs: ${String(state.world.mobs.length).padEnd(3)} (Bosses: ${state.world.mobs.filter(m=>m.boss).length})  │  🗺️ Known Spawns: ${knownSpawnsCount}`);
  console.log(`     🌲 Trees (full): ${state.world.trees.length} / ${chunks.trees.length}`);
  console.log(`     ⛏️  Gold nodes:   ${chunks.golds.length} available`);
  console.log(`     💎 Diamond:      ${chunks.diamonds.length} available`);

  if (state.currentTarget) {
    const t = state.currentTarget;
    let distVal = t.dist !== undefined ? t.dist.toFixed(0) : '?';
    let liveHpPct = t.hpPct ?? 1;
    line('');
    line(`  🎯 TARGET: \x1b[33m${t.type || t.kind || '?'}\x1b[0m  HP: ${hpBar(liveHpPct, 12)}  dist: ${distVal}`);
  }

  sep();
  line(`  📊 SESSION STATS`);
  line(`     Kills:   ${sess.kills}   Attacks: ${sess.attacks}   Skill-ups: ${sess.skillUps}`);
  line(`     Mode:    \x1b[1m\x1b[36m${state.mode.toUpperCase()}\x1b[0m   Focus: \x1b[33m${modeStr()}\x1b[0m`);
  line(`     Uptime:  ${formatTime(Date.now() - state.startTime)}`);
  sep('═');
  line(`  \x1b[90mPress Ctrl+C to stop\x1b[0m`);
}

function formatTime(ms) {
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m ${s % 60}s`;
}

function log(icon, msg) {
  const ts = new Date().toLocaleTimeString();
  process.stdout.write(`\x1b[0m${icon}  [${ts}] ${msg}\n`);
}

function sendAttack(tx, ty) {
  const isMoving = Date.now() < state.movingUntil;
  let bd = state.player.bd || 'left';
  if (tx !== undefined) {
    if (tx > state.player.x) { bd = 'right'; state.player.facing = 1; }
    else { bd = 'left'; state.player.facing = -1; }
    state.player.bd = bd;
  }

  const payload = {
    t: 'state', x: Math.round(state.player.x), y: Math.round(state.player.y),
    moving: isMoving, facing: state.player.facing > 0 ? 1 : -1,
    boat: state.player.boat, bd: bd,
    vcx: Math.round(state.player.x), vcy: Math.round(state.player.y), vr: 830,
  };
  send(payload);
  send({ t: 'attack' });
  state.session.attacks++;
  state.attacksOnCurrentTarget++;
}

// ─────────────────────────────────────────────
// GAME STATE
// ─────────────────────────────────────────────
const state = {
  ws:        null, connected: false, authed:    false,
  mode:      Object.keys(MODES).find(k => MODES[k]) || 'tree',
  modeIdx:   0, modeList:  Object.keys(MODES).filter(k => MODES[k]),
  startTime: Date.now(),
  player: { id: null, x: 16000, y: 16000, facing: 1, boat: false, hpPct: 1, bd: 'right', vcx: 16000, vcy: 16000, vr: 3275 },
  inv:    { wood: 0, gold: 0, meat: 0, diamond: 0, usdc: 0 },
  xp:     { level: 1, xp: 0, cur: 0, next: 100, str: 0, vit: 0, agi: 0, free: 0, speedMult: 1 },
  world:  { mobs: [], trees: [], golds: [], diamonds: [], players: [], treeHits: [], farMobs: [] },
  equipment: {}, inventoryItems: [], currentTarget: null, movingUntil:   0,
  session: { wood: 0, gold: 0, meat: 0, kills: 0, attacks: 0, skillUps: 0, extra: {} },
  _killsBaseline: null, reconnects:    0, maxReconnects: cfg.settings?.maxReconnects || 10,
  _running:      false, worldReceived: false, playerPosInitialized: false,
};

const landCache = new Set();
const TILE_SIZE = 64;

function markLand(wx, wy) {
  const cx = Math.floor(wx / TILE_SIZE); const cy = Math.floor(wy / TILE_SIZE);
  landCache.add(`${cx},${cy}`);
}

function send(msg) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(msg));
  }
}

function sendState() {
  if (state.player.hpPct <= 0) return;
  const isMoving = Date.now() < state.movingUntil;
  let vcx = Math.round(state.player.x); let vcy = Math.round(state.player.y);
  if (state.currentTarget) {
    vcx = Math.round(state.currentTarget.wx || state.player.x);
    vcy = Math.round(state.currentTarget.wy || state.player.y);
  }
  const payload = {
    t: 'state', x: Math.round(state.player.x), y: Math.round(state.player.y),
    moving: isMoving, facing: state.player.facing > 0 ? 1 : -1,
    boat: state.player.boat, bd: state.player.bd, vcx, vcy, vr: 830,
  };
  send(payload);
}

function handleMsg(raw) {
  let msg; try { msg = JSON.parse(raw); } catch { return; }
  switch (msg.t) {
    case 'welcome':
      state.player.id = msg.id; state.authed = true; state.reconnects = 0;
      log('✅', `Authenticated! Player ID: ${msg.id}`);
      startIntervals();
      break;
    case 'hp': state.player.hpPct = msg.pct ?? msg.hp ?? 1; break;
    case 'inv':
      state.inv = { ...state.inv, wood: msg.wood ?? state.inv.wood, gold: msg.gold ?? state.inv.gold, meat: msg.meat ?? state.inv.meat, diamond: msg.diamond ?? state.inv.diamond };
      break;
    case 'xp':
      state.xp = { level: msg.level ?? state.xp.level, xp: msg.xp ?? state.xp.xp, cur: msg.cur ?? state.xp.cur, next: msg.next ?? state.xp.next, str: msg.str ?? state.xp.str, vit: msg.vit ?? state.xp.vit, agi: msg.agi ?? state.xp.agi, free: msg.free ?? state.xp.free, speedMult: msg.speedMult ?? state.xp.speedMult };
      break;
    case 'world':
      state.worldReceived = true;
      if (msg.mobs) state.world.mobs = msg.mobs.map(m => Array.isArray(m) ? { id: m[0], x: m[1], y: m[2], hpPct: m[4]/100, type: m[6], boss: m[6]?.toLowerCase().includes('boss') } : m);
      if (msg.trees) state.world.trees = msg.trees.map(t => Array.isArray(t) ? { x: t[0], y: t[1] } : t);
      break;
    case 'loot':
      onLoot(msg.item, msg.qty);
      break;
  }
}

function onLoot(item, qty) {
  if (!item) return;
  const k = item.toLowerCase();
  qty = qty || 1;
  if (k === 'wood') { state.inv.wood += qty; state.session.wood += qty; }
  else if (k === 'gold') { state.inv.gold += qty; state.session.gold += qty; }
  else if (k === 'meat') { state.inv.meat += qty; state.session.meat += qty; }
  else if (k === 'diamond') { state.inv.diamond = (state.inv.diamond || 0) + qty; if(!state.session.extra.diamond) state.session.extra.diamond=0; state.session.extra.diamond += qty; }
  else { state.inv[k] = (state.inv[k] || 0) + qty; state.session.extra[k] = (state.session.extra[k] || 0) + qty; }
}

const chunks = { trees: [], golds: [], diamonds: [] };

function startIntervals() {
  if (state._stateTimer) return;
  state._stateTimer = setInterval(sendState, 400);
  state._atkTimer   = setInterval(() => {
    if (state.currentTarget) sendAttack(state.currentTarget.wx, state.currentTarget.wy);
  }, ATK_INTERVAL);
  state._dashTimer  = setInterval(() => renderDashboard(state), RENDER_INTERVAL);
}

function stopIntervals() {
  clearInterval(state._stateTimer); state._stateTimer = null;
  clearInterval(state._atkTimer);   state._atkTimer = null;
  clearInterval(state._dashTimer);  state._dashTimer = null;
}

async function main() {
  try {
    let sessionToken = null;
    if (fs.existsSync(SESSION_PATH)) {
      const sessData = JSON.parse(fs.readFileSync(SESSION_PATH, 'utf8'));
      if (sessData.walletAddress === WALLET && sessData.sessionToken) {
        sessionToken = sessData.sessionToken;
      }
    }
    if (!sessionToken) {
      sessionToken = await doLogin();
    }

    if (!BOT_NAME && fs.existsSync(SESSION_PATH)) {
      const sessData = JSON.parse(fs.readFileSync(SESSION_PATH, 'utf8'));
      BOT_NAME = sessData.username || 'IslandsBot';
    } else if (!BOT_NAME) {
      BOT_NAME = 'IslandsBot';
    }

    state._running = true;
    log('🔌', `Connecting to WebSocket game engine...`);
    state.ws = new WebSocket(`${GAME_WS}?token=${sessionToken}`);

    state.ws.on('open', () => { state.connected = true; log('🌐', 'WebSocket Connected!'); });
    state.ws.on('message', (data) => handleMsg(data.toString()));
    state.ws.on('close', () => { stopIntervals(); log('🔌', 'Disconnected.'); if (state._running) setTimeout(main, 5000); });
    state.ws.on('error', (err) => log('❌', `WS Error: ${err.message}`));

    process.on('SIGINT', () => {
      state._running = false; stopIntervals(); if (state.ws) state.ws.close();
      console.log('\n══════════════ FINAL STATS ══════════════');
      console.log(`  🌲 Wood:    +${state.session.wood}`);
      console.log(`  💰 Gold:    +${state.session.gold}`);
      console.log(`  🥩 Meat:    +${state.session.meat}`);
      console.log(`  💀 Kills:    ${state.session.kills}`);
      process.exit(0);
    });

  } catch (e) {
    console.error('❌ Login failed:', e.message);
    process.exit(1);
  }
}

main();
