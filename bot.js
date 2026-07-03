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

// ── LOGIKA PROXY TERBARU ──
const { SocksProxyAgent } = require('socks-proxy-agent');
const { HttpsProxyAgent } = require('https-proxy-agent');

const PROXY_PATH = path.join(__dirname, 'proxy.txt');
let proxies = [];
let currentProxyIndex = 0;

// Membaca daftar proxy dari proxy.txt
if (fs.existsSync(PROXY_PATH)) {
  proxies = fs.readFileSync(PROXY_PATH, 'utf8')
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0);
  console.log(`[PROXY] Berhasil memuat ${proxies.length} proxy dari proxy.txt`);
} else {
  console.warn(`[PROXY] File proxy.txt tidak ditemukan. Berjalan tanpa proxy.`);
}

function getNextProxyAgent() {
  if (proxies.length === 0) return null;
  
  const proxyUrl = proxies[currentProxyIndex];
  console.log(`[PROXY] Mencoba menggunakan proxy [${currentProxyIndex + 1}/${proxies.length}]: ${proxyUrl}`);
  
  // Rotasi index ke proxy berikutnya untuk percobaan selanjutnya jika gagal
  currentProxyIndex = (currentProxyIndex + 1) % proxies.length;

  try {
    if (proxyUrl.startsWith('socks4') || proxyUrl.startsWith('socks5')) {
      return { agent: new SocksProxyAgent(proxyUrl), url: proxyUrl };
    } else if (proxyUrl.startsWith('http')) {
      return { agent: new HttpsProxyAgent(proxyUrl), url: proxyUrl };
    } else {
      // Jika di proxy.txt tidak ada protocolnya, default ke http
      return { agent: new HttpsProxyAgent(`http://${proxyUrl}`), url: `http://${proxyUrl}` };
    }
  } catch (e) {
    console.error(`[PROXY] Error membuat agent proxy: ${e.message}`);
    return null;
  }
}

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
// Map<gridKey, { type: string, x: number, y: number, lastSeen: number, lastVisited: number }>
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
    // Group into 200x200 grids
    const gx = Math.round(m.x / 200) * 200;
    const gy = Math.round(m.y / 200) * 200;
    const key = `${gx},${gy}`;
    
    if (!knownMobSpawns[key]) {
      knownMobSpawns[key] = { type: m.type, x: gx, y: gy, lastSeen: now, lastVisited: 0 };
      changed = true;
    } else {
      knownMobSpawns[key].lastSeen = now;
      // If a rare mob type spawns here, update the type so we prioritize it
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

// Helper: get CLI arg value
function arg(flag, fallback) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
function hasArg(flag) { return process.argv.includes(flag); }

// ── Focus ──
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

// ── Skill ──
const SKILL_MODE = arg('--skill', cfg.autoSkill?.mode || 'priority').toLowerCase();
const SKILL_PRIO = arg('--prio',  (cfg.autoSkill?.priority || ['vit','str','agi']).join(',')).split(',');
const SKILL_STAT = arg('--stat',  cfg.autoSkill?.single?.stat || 'vit').toLowerCase();
const SKILL_VIT  = parseInt(arg('--vit', cfg.autoSkill?.percent?.vit  ?? 60));
const SKILL_STR  = parseInt(arg('--str', cfg.autoSkill?.percent?.str  ?? 30));
const SKILL_AGI  = parseInt(arg('--agi', cfg.autoSkill?.percent?.agi  ?? 10));

// ── Player ──
let BOT_NAME  = arg('--name', null);
if (!BOT_NAME && cfg.player?.name && cfg.player?.name !== 'IslandsBot') {
  BOT_NAME = cfg.player.name;
}
const BOT_COLOR = arg('--color', cfg.player?.color || 'Blue');

// ── Performance ──
const ATK_INTERVAL = parseInt(arg('--speed', cfg.settings?.attackIntervalMs || 200));
const ST_INTERVAL  = 100;
const MAX_CHASE    = parseInt(arg('--chase', cfg.settings?.maxMobChaseDist  || 400));
const FAST_MODE    = hasArg('--fast');
const MOVE_STEP    = FAST_MODE ? 500 : 80;
// BOSS_TYPES no longer needed — server now sends mob.boss = true on boss mobs directly
// Level requirements added in update:
const GOLD_LEVEL_REQ    = 25;  // Gold mining unlocked at level 25
const DIAMOND_LEVEL_REQ = 60;  // Diamond mining unlocked at level 60

const BASE_URL = 'https://islands.games';
const SIGN_MSG = 'islands: verify wallet ownership';
const GAME_WS  = 'wss://game-production-87db.up.railway.app/';
const TILE     = 64;

// ─────────────────────────────────────────────
// WALLET — auto-detect phrase or base58 key
// ─────────────────────────────────────────────
function loadKeypair() {
  const wData = JSON.parse(fs.readFileSync(WALLET_PATH, 'utf8'));

  // Support both simple { "wallet": "..." } and legacy { "secretKeyBase58": "..." }
  const input = (wData.wallet || wData.secretKeyBase58 || '').trim();

  if (!input) {
    console.error('\n❌ wallet.json is empty!');
    console.error('   Add your phrase or private key:\n');
    console.error('   { "wallet": "word1 word2 ... word12" }');
    console.error('   { "wallet": "base58privatekey..." }\n');
    process.exit(1);
  }

  const words = input.split(/\s+/);

  // 12 or 24 word mnemonic
  if (words.length === 12 || words.length === 24) {
    if (!bip39.validateMnemonic(input)) {
      console.error('\n❌ Invalid mnemonic phrase — check your words.\n');
      process.exit(1);
    }
    const seed    = bip39.mnemonicToSeedSync(input);
    const derived = derivePath("m/44'/501'/0'/0'", seed.toString('hex')).key;
    return Keypair.fromSeed(derived);
  }

  // base58 private key
  try {
    const raw = bs58.decode(input);
    if (raw.length !== 64) throw new Error('Expected 64-byte key');
    return Keypair.fromSecretKey(raw);
  } catch (e) {
    console.error('\n❌ Invalid wallet value in wallet.json');
    console.error('   Must be a 12/24-word phrase or base58 private key.\n');
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
// HTTP AUTH
// ─────────────────────────────────────────────
async function doLogin() {
  const sig = signAuthMessage();

  log('🔐', `Signing auth message...`);
  
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  // Ambil proxy aktif
  const currentProxy = getNextProxyAgent();
  const fetchOptions = {
    method:  'POST',
    headers: { 
      'Content-Type': 'application/json', 
      'Origin': BASE_URL,
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    },
    body: JSON.stringify({ walletAddress: WALLET, walletType: 'phantom', signature: sig, message: SIGN_MSG }),
    signal: controller.signal
  };

  // Jika ada proxy, pasangkan ke fetch
  if (currentProxy && currentProxy.agent) {
    fetchOptions.agent = currentProxy.agent;
  }

  try {
    const res = await fetch(`${BASE_URL}/api/auth/connect`, fetchOptions);
    clearTimeout(timeoutId);

    const data = await res.json();
    if (!res.ok || !data.sessionToken) {
      throw new Error(`Login failed: ${data.error || JSON.stringify(data)}`);
    }

    log('✅', `Login OK  — isNew: ${data.isNew}  char: ${data.char}`);
    fs.writeFileSync(SESSION_PATH, JSON.stringify({ walletAddress: WALLET, sessionToken: data.sessionToken, ...data }, null, 2));
    return data.sessionToken;
  } catch (err) {
    clearTimeout(timeoutId);
    console.error(`❌ Gagal koneksi HTTP via proxy: ${err.message}`);
    // Jika gagal, lempar error agar fungsi utama bot tahu dan memicu login ulang menggunakan proxy b, c, dst.
    throw err;
  }
}

// ─────────────────────────────────────────────
// DASHBOARD / DISPLAY
// ─────────────────────────────────────────────
let lastRender = 0;
const RENDER_INTERVAL = 500; // ms between full redraws

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
  const w   = state.world;
  const sess= state.session;

  // Clear screen
  process.stdout.write('\x1b[2J\x1b[H');

  const line = (s = '') => console.log(s);
  const sep  = (c = '─', n = 62) => console.log(c.repeat(n));

  sep('═');
  console.log(`  🏝️  ISLANDS BOT v3   │  Wallet: ${WALLET.slice(0,8)}...${WALLET.slice(-6)}`);
  sep('═');

  // ── Player ──
  line(`  👤 Player: \x1b[1m${BOT_NAME}\x1b[0m   ID: ${p.id || '—'}   Level: \x1b[33m${xp.level}\x1b[0m`);
  line(`  ❤️  HP  ${hpBar(p.hpPct)}`);
  line(`  ⭐ XP  ${xpBar(xp.xp, xp.cur, xp.next)}   Total: ${xp.xp}`);
  line(`  ⚡ Skills  STR:\x1b[31m${xp.str}\x1b[0m  VIT:\x1b[32m${xp.vit}\x1b[0m  AGI:\x1b[36m${xp.agi}\x1b[0m  Free:\x1b[33m${xp.free}\x1b[0m  Speed:${xp.speedMult}x`);
  line(`  📍 Pos: (${p.x}, ${p.y})   Facing: ${p.facing > 0 ? '→' : '←'}   Boat: ${p.boat ? '⛵' : '🚶'}`);

  sep();

  // ── Inventory ──
  line(`  🎒 INVENTORY`);
  line(`     🌲 Wood:    \x1b[32m${inv.wood.toString().padStart(6)}\x1b[0m   (+${sess.wood} this session)`);
  line(`     💰 Gold:    \x1b[33m${inv.gold.toString().padStart(6)}\x1b[0m   (+${sess.gold} this session)`);
  line(`     🥩 Meat:    \x1b[31m${inv.meat.toString().padStart(6)}\x1b[0m   (+${sess.meat} this session)`);
  line(`     💎 Diamond: \x1b[96m${(inv.diamond || 0).toString().padStart(6)}\x1b[0m   (+${(sess.extra && sess.extra.diamond) || 0} this session)`);
  if (inv.usdc > 0) line(`     💵 USDC:    \x1b[32m${inv.usdc.toFixed(2).padStart(6)}\x1b[0m`);

  const extraItems = [
    { key: 'fish', label: '🐟 Fish' },
    { key: 'shard', label: '🔮 Void Shard' },
    { key: 'sigil', label: '🛡️ War Sigil' },
    { key: 'tome', label: '📖 Tome of Ref.' },
    { key: 'awakening_stone', label: '✨ Awk. Stone' },
    { key: 'old_boat', label: '🛶 Old Boat' },
    { key: 'old_shoe', label: '👞 Old Shoe' },
    { key: 'fish_manual', label: '📘 Fish Manual' },
    { key: 'rune_sharpness', label: '🗡️ Sharpness' },
    { key: 'rune_leeching', label: '🩸 Leeching' },
    { key: 'rune_bulwark', label: '🛡️ Bulwark' },
    { key: 'rune_slayer', label: '💀 Slayer' },
    { key: 'rune_mining', label: '⛏️ Mining' },
    { key: 'rune_fortune', label: '🍀 Fortune' },
    { key: 'rune_insight', label: '👁️ Insight' },
    { key: 'rune_swift', label: '⚡ Swift' }
  ];

  for (let i = 0; i < extraItems.length; i += 2) {
    const left = extraItems[i];
    const right = extraItems[i + 1];
    
    const sessLeft = (sess.extra && sess.extra[left.key]) || 0;
    let row = `     ${left.label.padEnd(16)}: \x1b[35m${(inv[left.key] || 0).toString().padStart(4)}\x1b[0m (+${sessLeft})`.padEnd(43);
    
    if (right) {
      const sessRight = (sess.extra && sess.extra[right.key]) || 0;
      row += `   ${right.label.padEnd(16)}: \x1b[35m${(inv[right.key] || 0).toString().padStart(4)}\x1b[0m (+${sessRight})`;
    }
    line(row);
  }

  sep();

  // ── World ──
  console.log(`  🌍 WORLD STATE`);
  const knownSpawnsCount = Object.keys(knownMobSpawns).length;
  console.log(`     ⚔️  Mobs: ${String(state.world.mobs.length).padEnd(3)} (Bosses: ${state.world.mobs.filter(m=>m.boss).length})  │  🗺️ Known Spawns: ${knownSpawnsCount}`);
  console.log(`     👁️  Far Mobs: ${String((state.world.farMobs || []).length).padEnd(3)} (Far Bosses: ${(state.world.farBosses || []).length})`);
  console.log(`     🌲 Trees (full): ${state.world.trees.length} / ${chunks.trees.length}`);
  console.log(`     ⛏️  Gold nodes:   ${chunks.golds.length} available`);
  console.log(`     💎 Diamond:      ${chunks.diamonds.length} available`);
  console.log(`     👥 Players:      ${state.world.players.length}`);
  console.log(``);

  // Current target
  if (state.currentTarget) {
    const t = state.currentTarget;
    let distVal = '?';
    if (t.wx !== undefined && t.wy !== undefined) {
      distVal = distTo(t.wx, t.wy).toFixed(0);
    } else if (t.dist !== undefined) {
      distVal = t.dist.toFixed(0);
    }
    
    let liveHpPct = t.hpPct ?? 1;
    const ttype = (t.type || '').toLowerCase();
    if (t._near) {
      const key = `${ttype.startsWith('gold') ? 'gold' : ttype.startsWith('diamond') ? 'diamond' : ttype === 'tree' ? 'tree' : 'mob'}:`;
      if (key.startsWith('gold:')) {
        const node = state.world.golds.find(g => g.x === t._near.x && g.y === t._near.y);
        if (node) liveHpPct = (node.pct / 1000);
      } else if (key.startsWith('diamond:')) {
        const node = state.world.diamonds.find(d => d.x === t._near.x && d.y === t._near.y);
        if (node) liveHpPct = (node.pct / 1000);
      } else if (key.startsWith('tree:')) {
        const hit = state.world.treeHits.find(h => h.x === t._near.x && h.y === t._near.y);
        liveHpPct = hit ? (hit.pct / 1000) : 1;
      } else if (key.startsWith('mob:')) {
        const mob = state.world.mobs.find(m => m.id === t._near.id);
        if (mob) liveHpPct = mob.hpPct ?? 1;
      }
    }
    
    line('');
    let hpStr = `HP: ${hpBar(liveHpPct, 12)}`;
    if (ttype.includes('gold') || ttype.includes('diamond')) {
      hpStr = `HP: [???] (Hidden)`;
    }
    line(`  🎯 TARGET: \x1b[33m${t.type || t.kind || '?'}\x1b[0m  ${hpStr}  dist: ${distVal}`);
  }

  sep();

  // ── Stats ──
  line(`  📊 SESSION STATS`);
  line(`     Kills:   ${sess.kills}   Attacks: ${sess.attacks}   Skill-ups: ${sess.skillUps}`);
  line(`     Mode:    \x1b[1m\x1b[36m${state.mode.toUpperCase()}\x1b[0m   Focus: \x1b[33m${modeStr()}\x1b[0m`);
  line(`     Uptime:  ${formatTime(Date.now() - state.startTime)}`);

  if (state.equipment && Object.keys(state.equipment).length) {
    sep();
    line(`  🛡️  EQUIPMENT`);
    for (const [slot, itemId] of Object.entries(state.equipment)) {
      if (itemId) {
        const itemObj = typeof itemId === 'string'
          ? (state.inventoryItems || []).find(i => i.id === itemId) || { id: itemId }
          : itemId;
        line(`     ${slot.padEnd(8)}: ${itemObj.name || itemObj.id || '?'} (Lv${itemObj.level || 1})`);
      }
    }
  }

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
  // Print below dashboard area when possible
  const ts = new Date().toLocaleTimeString();
  process.stdout.write(`\x1b[0m${icon}  [${ts}] ${msg}\n`);
}

function sendAttack(tx, ty) {
  const isMoving = Date.now() < state.movingUntil;

  // Calculate bd (break direction) based on player position relative to target node.
  let bd = state.player.bd || 'left';
  if (tx !== undefined) {
    if (tx > state.player.x) {
      bd = 'right';
      state.player.facing = 1;
    } else {
      bd = 'left';
      state.player.facing = -1;
    }
    state.player.bd = bd; // Save to state so sendState uses the same bd
  }

  const payload = {
    t: 'state', x: Math.round(state.player.x), y: Math.round(state.player.y),
    moving: isMoving, facing: state.player.facing > 0 ? 1 : -1,
    boat: state.player.boat, bd: bd,
    vcx: Math.round(state.player.x), vcy: Math.round(state.player.y), vr: 830,
  };
  log('DEBUG', `WS_OUT: ${JSON.stringify(payload)}`);
  send(payload);

  log('DEBUG', `WS_OUT: {"t":"attack"}`);
  send({ t: 'attack' });
  state.session.attacks++;
  state.attacksOnCurrentTarget++;
}

// ─────────────────────────────────────────────
// GAME STATE
// ─────────────────────────────────────────────
const state = {
  ws:        null,
  connected: false,
  authed:    false,
  mode:      Object.keys(MODES).find(k => MODES[k]) || 'tree',
  modeIdx:   0,
  modeList:  Object.keys(MODES).filter(k => MODES[k]),
  startTime: Date.now(),

  player: { id: null, x: 16000, y: 16000, facing: 1, boat: false, hpPct: 1, bd: 'right', vcx: 16000, vcy: 16000, vr: 3275 },
  inv:    { wood: 0, gold: 0, meat: 0, diamond: 0, usdc: 0 },
  xp:     { level: 1, xp: 0, cur: 0, next: 100, str: 0, vit: 0, agi: 0, free: 0, speedMult: 1 },
  world:  { mobs: [], trees: [], golds: [], diamonds: [], players: [], treeHits: [], farMobs: [] },
  equipment: {},
  inventoryItems: [], // items with id/slot/name for auto-equip

  currentTarget: null,
  movingUntil:   0,       // timestamp until which we consider ourselves "in motion"
  lockMobId:     null,
  lockResource:  null,    // { type: 'tree'|'gold'|'diamond', x, y, wx, wy }
  currentTargetKey: null, // string key of current target
  attacksOnCurrentTarget: 0,
  lastTargetProgressValue: 0,
  lastLootTotal: 0,
  gotLoot:       false,
  failedResources: new Map(),
  failedMobs:      new Map(),

  session: { wood: 0, gold: 0, meat: 0, kills: 0, attacks: 0, skillUps: 0, extra: {} },
  _killsBaseline: null,   // lifetime kill count at session start (to compute delta)

  reconnects:    0,
  maxReconnects: cfg.settings?.maxReconnects || 10,
  _pingTimer:    null,
  _stateTimer:   null,
  _atkTimer:     null,
  _dashTimer:    null,
  _running:      false,
  worldReceived: false,
  playerPosInitialized: false,
};

// --- Minimal land detection for auto-boat ---
const landCache = new Set();
const TILE_SIZE = 64;

function markLand(wx, wy) {
  const cx = Math.floor(wx / TILE_SIZE);
  const cy = Math.floor(wy / TILE_SIZE);
  landCache.add(`${cx},${cy}`);
}

function isLikelyLand(wx, wy) {
  if (landCache.size < 30) return true; // Default to land until map loads
  const cx = Math.floor(wx / TILE_SIZE);
  const cy = Math.floor(wy / TILE_SIZE);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (landCache.has(`${cx+dx},${cy+dy}`)) return true;
    }
  }
  return false;
}
// ─────────────────────────────────────────────

// ─────────────────────────────────────────────
// WS SEND
// ─────────────────────────────────────────────
function send(msg) {
  if (state.ws && state.ws.readyState === WebSocket.OPEN) {
    state.ws.send(JSON.stringify(msg));
  }
}

function sendState() {
  if (state.player.hpPct <= 0) return;
  // CRITICAL FIX: As per the manual browser dumps, when attacking (not moving), 
  // vcx and vcy must equal the player's exact X and Y coordinates. 
  // They should NOT equal the target node's coordinates.
  const isMoving = Date.now() < state.movingUntil;
  let vcx = Math.round(state.player.x);
  let vcy = Math.round(state.player.y);
  if (state.currentTarget) {
    vcx = Math.round(state.currentTarget.wx || state.player.x);
    vcy = Math.round(state.currentTarget.wy || state.player.y);
  } else if (!isMoving && state.player.vcx !== undefined && state.player.vcy !== undefined) {
    vcx = state.player.vcx;
    vcy = state.player.vcy;
  }
  const vr = 830; // Matches user's client
  
  const payload = {
    t: 'state', x: Math.round(state.player.x), y: Math.round(state.player.y),
    moving: isMoving, facing: state.player.facing > 0 ? 1 : -1,
    boat: state.player.boat, bd: state.player.bd,
    vcx, vcy, vr,
  };
  
  const payloadStr = JSON.stringify(payload);
  if (state._lastStatePayload === payloadStr && Date.now() - (state._lastStateTime || 0) < 5000) {
    return; // Heartbeat every 5s if unchanged
  }
  
  state._lastStatePayload = payloadStr;
  state._lastStateTime = Date.now();
  
  state.player.vcx = vcx;
  state.player.vcy = vcy;
  state.player.vr = vr;
  send(payload);
}


function allocSkill(stat) {
  send({ t: 'allocate', stat });
  state.session.skillUps++;
  state.xp.free--;
  log('🎯', `Skill UP → ${stat.toUpperCase()} (free left: ${state.xp.free})`);
}

// ─────────────────────────────────────────────
// WS MESSAGE HANDLER
// ─────────────────────────────────────────────
function handleMsg(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }

  switch (msg.t) {
    case 'welcome':
      state.player.id   = msg.id;
      state.authed      = true;
      state.reconnects  = 0; // reset on successful auth
      log('✅', `Authenticated! Player ID: ${msg.id}`);
      startIntervals();
      break;

    case 'hp':
      state.player.hpPct = msg.pct ?? msg.hp ?? 1;
      break;

    case 'spawn':
      state.spawnPoint = { x: msg.x, y: msg.y };
      break;

    case 'fishCast':
      log('🎣', `Bobber cast successfully! (Baited: ${msg.baited})`);
      break;

    case 'fishCaught':
      log('✨', `CAUGHT A ${msg.item.toUpperCase()}! (x${msg.qty})`);
      onLoot(msg.item, msg.qty);
      send({ t: 'fishStop' });
      break;

    case 'inv':
      state.inv = {
        ...state.inv, // keep other items intact
        wood:    msg.wood    ?? state.inv.wood,
        gold:    msg.gold    ?? state.inv.gold,
        meat:    msg.meat    ?? state.inv.meat,
        diamond: msg.diamond ?? state.inv.diamond,
        usdc:    msg.usdc    ?? state.inv.usdc
      };
      break;

    case 'items':
      if (msg.items) {
        state.inv = { ...state.inv, ...msg.items };
      }
      break;

    case 'xp': {
      const prevFree = state.xp.free;
      const prevLv   = state.xp.level;
      state.xp = {
        level: msg.level ?? state.xp.level, xp: msg.xp ?? state.xp.xp, cur: msg.cur ?? state.xp.cur, next: msg.next ?? state.xp.next,
        str: msg.str ?? state.xp.str, vit: msg.vit ?? state.xp.vit, agi: msg.agi ?? state.xp.agi,
        free: msg.free ?? state.xp.free, speedMult: msg.speedMult ?? state.xp.speedMult,
      };
      if (msg.level > prevLv) log('⬆️', `LEVEL UP! → ${msg.level}`);
      if (msg.free > 0 && msg.free !== prevFree && cfg.autoSkill?.enabled !== false) {
        setTimeout(() => autoAllocSkills(), 600);
      }
      break;
    }

    case 'stats': {
      const totalKills = msg.mobKills || 0;
      // First stats packet: record the lifetime baseline so session starts at 0
      if (state._killsBaseline === null) {
        state._killsBaseline = totalKills;
        log('📊', `Kill baseline: ${totalKills} lifetime kills (session starts at 0)`);
      }
      const sessionKills = totalKills - state._killsBaseline;
      if (sessionKills > state.session.kills) {
        const delta = sessionKills - state.session.kills;
        state.session.kills = sessionKills;
        log('💀', `Mob killed! Session: +${delta}  Total this run: ${sessionKills}`);
        if ((state.mode === 'monster' || state.mode === 'boss') && !state.gotLoot) {
          state.gotLoot = true;
          if (state.modeList.length > 1) advanceMode();
        }
      }
      break;
    }

    case 'nodeLocked':
      // Server sends this when player level is too low to mine node
      // { t:'nodeLocked', kind:'gold'|'diamond', need: <levelRequired> }
      log('🔒', `Node locked! ${msg.kind} requires Level ${msg.need}. Current: Lv${state.xp.level}`);
      // Skip this node type and advance mode
      if (msg.kind === 'gold' && state.mode === 'gold') {
        log('⚠️', 'Skipping gold — need Level 25. Advancing mode.');
        advanceMode();
      } else if (msg.kind === 'diamond' && state.mode === 'diamond') {
        log('⚠️', 'Skipping diamond — need Level 60. Advancing mode.');
        advanceMode();
      }
      break;

    case 'farmobs':
      // New packet: far mob overview { t:'farmobs', mobs: [[x,y,type], ...] }
      // Update far mobs so boss mode can see bosses beyond normal view range
      if (Array.isArray(msg.mobs)) {
        state.world.farMobs = msg.mobs.map(m => ({ x: m[0], y: m[1], type: m[2] }));
        updateSpawnMemory(state.world.farMobs);
      }
      break;

    case 'loot':
      onLoot(msg.item, msg.qty);
      break;

    case 'world':
      if (!state._loggedWorld) {
        log('DEBUG', `FIRST WORLD PACKET: ${JSON.stringify(msg).substring(0, 500)}...`);
        if (msg.trees) log('DEBUG', `TREES: ${JSON.stringify(msg.trees.slice(0, 2))}`);
        state._loggedWorld = true;
      }
      if (!state.worldReceived) {
        state.worldReceivedTime = Date.now();
      }
      state.worldReceived = true;
      if (msg.mobs) {
        state.world.mobs = msg.mobs.map(m => {
          let mob = m;
          if (Array.isArray(m)) {
            mob = { id: m[0], x: m[1], y: m[2], facing: m[3], hp: m[4], hpPct: m[4]/100, state: m[5], type: m[6] };
          }
          const mType = (mob.type || '').toLowerCase();
          mob.boss = mob.boss || mType.includes('boss') || mType === 'minotaur' || mType === 'dragon' || mType === 'kraken' || mType === 'demon' || mType === 'yeti' || mType === 'reaper' || mType === 'king';
          if (mob.hpPct === undefined && mob.hp !== undefined) mob.hpPct = mob.hp / 100;
          if (mob.x !== undefined && mob.y !== undefined) markLand(mob.x, mob.y);
          return mob;
        });
        updateSpawnMemory(state.world.mobs);
      }
      if (msg.trees)    { state.world.trees    = msg.trees.map(t => Array.isArray(t) ? { x: t[0], y: t[1] } : t); state.world.trees.forEach(t => markLand(t.x * TILE_SIZE + 32, t.y * TILE_SIZE + 32)); }
      if (msg.golds)    { state.world.golds    = msg.golds.map(g => Array.isArray(g) ? { x: g[0], y: g[1], pct: g[2] } : g); state.world.golds.forEach(g => markLand(g.x * TILE_SIZE + 32, g.y * TILE_SIZE + 32)); }
      if (msg.diamonds) { state.world.diamonds = msg.diamonds.map(d => Array.isArray(d) ? { x: d[0], y: d[1], pct: d[2] } : d); state.world.diamonds.forEach(d => markLand(d.x * TILE_SIZE + 32, d.y * TILE_SIZE + 32)); }
      if (msg.treeHits !== undefined) {
        state.world.treeHits = msg.treeHits.map(h => Array.isArray(h) ? { x: h[0], y: h[1], pct: h[2] } : h);
        log('DEBUG', `treeHits received: ${JSON.stringify(msg.treeHits)}`);
      }
      if (msg.players) {
        state.world.players = msg.players;
        msg.players.forEach(p => markLand(p.x, p.y));
        if (state.player.id) {
          const me = msg.players.find(p => p.id === state.player.id);
          if (me) {
            if (!state.playerPosInitialized && me.x > 1000 && me.y > 1000) {
              state.player.x = Math.round(me.x);
              state.player.y = Math.round(me.y);
              state.playerPosInitialized = true;
              log('📍', `Initialized player position from server: (${state.player.x}, ${state.player.y})`);
            } else if (state.playerPosInitialized && Date.now() > state.movingUntil + 500) {
              // When not moving, correct any drift from server's authoritative position
              state.player.x = Math.round(me.x);
              state.player.y = Math.round(me.y);
            }
          }
        }
      }
      break;

    case 'equipment':
      // Server: { t:'equipment', equipment: [...items], equipped: {slot: item} }
      log('🐛', `DEBUG equipment: ${JSON.stringify(msg)}`);
      if (Array.isArray(msg.equipment)) state.inventoryItems = msg.equipment;
      if (msg.equipped && typeof msg.equipped === 'object') state.equipment = msg.equipped;
      break;

    case 'items':
      // Server: { t:'items', items: {id: item, ...} }
      for (const [key, item] of Object.entries(msg.items || {})) {
        log('DEBUG', `Item spawned: ${JSON.stringify(item)}`);
      }
      if (msg.items && typeof msg.items === 'object') {
        const newItems = Object.values(msg.items);
        if (newItems.length > 0) {
          // Append new items instead of overwriting the equipment array
          state.inventoryItems = [...(state.inventoryItems || []), ...newItems];
        }
      }
      break;

    case 'spawn':
    case 'respawn':
      state.player.x = msg.x;
      state.player.y = msg.y;
      state.player.vcx = msg.x;
      state.player.vcy = msg.y;
      state.player.hpPct = 1; // Reset HP to 100% on spawn/respawn
      state.playerPosInitialized = true;
      log('📍', `Spawned/Respawned at position: (${msg.x}, ${msg.y})`);
      ensureNearbyChunks(); // trigger pre-loading chunks
      break;

    case 'kicked':
      log('⛔', `Kicked: ${msg.reason}`);
      // Track kick reason for smarter reconnect
      state._lastKickReason = msg.reason;
      break;

    case 'islandsDelta': case 'islandsFull':
      if (msg.o && Array.isArray(msg.o)) {
        msg.o.forEach(id => {
          if (state.world.mobs) {
            state.world.mobs = state.world.mobs.filter(m => m.id !== id);
          }
        });
      }
      if (msg.i && Array.isArray(msg.i)) {
        if (!state.world.mobs) state.world.mobs = [];
        msg.i.forEach(m => {
          if (Array.isArray(m) && m.length >= 7) {
            const id = m[0];
            if (typeof id === 'string' && id.length < 30) { // Likely a mob
              const typeStr = (m[6] || '').toLowerCase();
              const mob = {
                id: m[0], x: m[1], y: m[2], facing: m[3], hp: m[4], hpPct: m[4]/100, state: m[5], type: m[6],
                boss: typeStr.includes('boss') || ['minotaur','dragon','kraken','demon','yeti','reaper','king'].includes(typeStr)
              }
              if (mob.hpPct === undefined && mob.hp !== undefined) mob.hpPct = mob.hp / 100;
              const idx = state.world.mobs.findIndex(x => x.id === id);
              if (idx >= 0) {
                state.world.mobs[idx] = { ...state.world.mobs[idx], ...mob };
              } else {
                state.world.mobs.push(mob);
              }
            }
          }
        });
      }
      break;
    case 'boosts': case 'buffs':
    case 'market': case 'myUnits':
    case 'marketList': case 'pdens': case 'quests':
      break;

    case 'goldGone':
      state.failedResources.set(`gold:${msg.x},${msg.y}`, Date.now() + 300000);
      if (state.lockResource && state.lockResource.type === 'gold' && state.lockResource.x === msg.x && state.lockResource.y === msg.y) {
        log('ℹ️', `Gold at [${msg.x},${msg.y}] was mined completely!`);
        state.lockResource = null;
      }
      break;

    case 'diamondGone':
      state.failedResources.set(`diamond:${msg.x},${msg.y}`, Date.now() + 600000);
      if (state.lockResource && state.lockResource.type === 'diamond' && state.lockResource.x === msg.x && state.lockResource.y === msg.y) {
        log('ℹ️', `Diamond at [${msg.x},${msg.y}] was mined completely!`);
        state.lockResource = null;
      }
      break;

    case 'died':
      if (state.player.hpPct !== 0) {
        state.player.hpPct = 0; // Set HP to 0 when dead
        log('💀', 'Player died! Waiting to revive...');
      }
      break;
    case 'error':
      log('❌', `Server error: ${msg.message || msg.reason || JSON.stringify(msg)}`);
      break;

    case 'bossMarks':
      log('👑', `BOSS MARKS: ${JSON.stringify(msg.m)}`);
      if (Array.isArray(msg.m)) {
        state.world.farBosses = msg.m.map(b => ({ x: b[0], y: b[1], type: 'boss_mark' }));
      }
      break;

    default:
      if (!['move', 'pos', 'p', 'leave', 'join', 'chat'].includes(msg.t)) {
        log('📡', `Unknown msg: ${msg.t} keys: ${Object.keys(msg).join(',')}`);
      }
      break;
  }
}

function onLoot(item, qty) {
  if (!state.session.extra) state.session.extra = {};
  switch (item) {
    case 'wood':    state.session.wood += qty; log('🌲', `Wood  +${qty}  (session: +${state.session.wood})`); break;
    case 'gold':    state.session.gold += qty; log('⛏️', `Gold  +${qty}  (session: +${state.session.gold})`); break;
    case 'meat':    state.session.meat += qty; log('🥩', `Meat  +${qty}  (session: +${state.session.meat})`); break;
    case 'diamond': state.session.extra.diamond = (state.session.extra.diamond || 0) + qty; log('💎', `Diamond +${qty}!`); break;
    default:
      state.session.extra[item] = (state.session.extra[item] || 0) + qty;
      log('🎁', `Loot: ${item} x${qty}`);
      
      // Learn which mob dropped a rare item
      if (state.currentTarget && RARE_ITEMS.has(item)) {
        const mobType = state.currentTarget.type.toLowerCase();
        if (!rareMobTypes[mobType]) {
          rareMobTypes[mobType] = { drops: 0, lastSeen: 0 };
        }
        rareMobTypes[mobType].drops += qty;
        rareMobTypes[mobType].lastSeen = Date.now();
        fs.writeFileSync(RARE_MOBS_PATH, JSON.stringify(rareMobTypes, null, 2));
        log('🌟', `Learned that [${mobType}] drops ${item}! Added to priority list.`);
      }
      break;
  }
  if ((state.mode === 'tree' && item === 'wood') ||
      (state.mode === 'gold' && item === 'gold') ||
      (state.mode === 'diamond' && item === 'diamond')) {
    if (!state.gotLoot) {
      state.gotLoot = true;
      if (state.modeList.length > 1) advanceMode();
    }
  }
}

// ─────────────────────────────────────────────
// SKILL AUTO-ALLOC  (mode: priority | percent | single)
// ─────────────────────────────────────────────

// Tracks total allocated this session for percent mode
const skillAllocated = { vit: 0, str: 0, agi: 0 };

function autoAllocSkills() {
  if (cfg.autoSkill?.enabled === false) return;
  if (state.xp.free <= 0) return;

  // ── SINGLE ──
  if (SKILL_MODE === 'single') {
    const stat = SKILL_STAT;
    if (!['vit','str','agi'].includes(stat)) { log('⚠️', `Bad --stat: ${stat}`); return; }
    while (state.xp.free > 0) allocSkill(stat);
    return;
  }

  // ── PERCENT ──
  if (SKILL_MODE === 'percent') {
    const pct   = { vit: SKILL_VIT, str: SKILL_STR, agi: SKILL_AGI };
    const total = SKILL_VIT + SKILL_STR + SKILL_AGI;
    if (total === 0) { log('⚠️', '--vit/--str/--agi all 0'); return; }
    const norm = { vit: pct.vit/total, str: pct.str/total, agi: pct.agi/total };
    
    while (state.xp.free > 0) {
      const totalAlloc = skillAllocated.vit + skillAllocated.str + skillAllocated.agi + 1;
      const deficit = {};
      for (const s of ['vit','str','agi']) {
        deficit[s] = norm[s] - (skillAllocated[s] / Math.max(totalAlloc, 1));
      }
      const pick = Object.entries(deficit).sort((a,b) => b[1]-a[1])[0][0];
      allocSkill(pick); 
      skillAllocated[pick]++;
      log('📊', `PERCENT → ${pick.toUpperCase()}  (V:${SKILL_VIT}% S:${SKILL_STR}% A:${SKILL_AGI}%)`);
    }
    return;
  }

  // ── PRIORITY (default) ──
  while (state.xp.free > 0) {
    let allocated = false;
    for (const stat of SKILL_PRIO) {
      if (state.xp.free > 0) { 
        allocSkill(stat); 
        allocated = true;
        break; 
      }
    }
    if (!allocated) break; // safeguard
  }
}

let lastHealTime = 0;
function checkHeal() {
  const hpPct = state.player.hpPct ?? 1;
  const meatCount = state.inv.meat ?? 0;
  if (hpPct <= 0.80 && meatCount > 0 && Date.now() - lastHealTime > 2000) {
    log('🍖', `Auto-healing! HP: ${(hpPct*100).toFixed(0)}%  Meat: ${meatCount}`);
    // Correct packet from game JS: { t: 'heal' }
    send({ t: 'heal' });
    lastHealTime = Date.now();
  }
}

let lastReviveTime = 0;
function checkRevive() {
  const hpPct = state.player.hpPct ?? 1;
  if (hpPct <= 0 && Date.now() - lastReviveTime > 5000) {
    log('💀', `Player is dead (HP: 0%). Sending revive packet...`);
    send({ t: 'revive' });
    lastReviveTime = Date.now();
    
    // Auto-skip the mob type that killed us!
    if (state.lockMobId && state.world.mobs) {
      const killer = state.world.mobs.find(m => m.id === state.lockMobId);
      if (killer && killer.type) {
        const kType = killer.type.toLowerCase();
        log('🛡️', `Auto-skipping future '${killer.type}' encounters because it killed you!`);
        if (!skipMobs.includes(kType)) {
          skipMobs.push(kType);
        }
      }
    }
    state.lockMobId = null;
  }
}

let lastEquipTime = 0;

function getItemScore(item) {
  if (!item) return -1;
  let score = (item.level || 0) * 1000;
  score += (item.str || 0) * 10;
  score += (item.agi || 0) * 10;
  score += (item.vit || 0) * 10;
  const rarities = { "common": 0, "uncommon": 1, "rare": 2, "epic": 3, "legendary": 4 };
  if (item.rarity) score += (rarities[item.rarity.toLowerCase()] || 0) * 100;
  return score;
}

function checkEquip() {
  const items = state.inventoryItems || [];
  if (items.length === 0) return;

  // Determine what weapon/tool we need for this mode
  const wantSlot = (state.mode === 'gold' || state.mode === 'diamond') ? 'tool' : 'weapon';

  // Group items by slot and find the best one (highest score)
  const bestBySlot = {};
  for (const item of items) {
    if (!item || !item.slot) continue;
    
    // For tool/weapon, we only care about the one matching wantSlot
    if ((item.slot === 'tool' || item.slot === 'weapon') && item.slot !== wantSlot) continue;

    const currentBest = bestBySlot[item.slot];
    if (!currentBest || getItemScore(item) > getItemScore(currentBest)) {
      bestBySlot[item.slot] = item;
    }
  }

  for (const slot in bestBySlot) {
    const bestItem = bestBySlot[slot];
    const equippedId = state.equipment && state.equipment[slot];
    
    const isEquipped = equippedId === bestItem.id;
    if (isEquipped) continue;

    const currentlyEquippedItem = items.find(i => i.id === equippedId);

    const currentScore = getItemScore(currentlyEquippedItem);
    const bestScore = getItemScore(bestItem);

    // Equip if the slot is empty OR the new item has a higher score
    if (slot === wantSlot || bestScore > currentScore) {
      if (Date.now() - lastEquipTime > 3000) {
        send({ t: 'equipItem', id: bestItem.id });
        log('🎒', `Auto-Equip: ${bestItem.name || bestItem.id} (${slot}) [Score: ${bestScore}]`);
        lastEquipTime = Date.now();
        return; // Equip one item per check to avoid spamming
      }
    }
  }
}

function skillPlanStr() {
  if (SKILL_MODE === 'single')  return `SINGLE → ${SKILL_STAT.toUpperCase()}`;
  if (SKILL_MODE === 'percent') return `PERCENT  VIT:${SKILL_VIT}%  STR:${SKILL_STR}%  AGI:${SKILL_AGI}%`;
  return `PRIORITY  ${SKILL_PRIO.join(' > ').toUpperCase()}`;
}

// ─────────────────────────────────────────────
// HELPER GEOMETRY
// ─────────────────────────────────────────────
function dist(x1, y1, x2, y2) {
  return Math.hypot(x2 - x1, y2 - y1);
}

function distTo(x, y) {
  return dist(state.player.x, state.player.y, x, y);
}

const VIEWPORT_RANGE = 350; // pixels

function isResourceDepleted(type, rx, ry, wx, wy) {
  if (!state.worldReceived) {
    return false; // haven't received world state yet, assume not depleted
  }
  const d = distTo(wx, wy);
  if (d > VIEWPORT_RANGE) {
    return false; // too far to see, assume not depleted
  }
  if (type === 'tree') {
    return !state.world.trees.some(t => t.x === rx && t.y === ry);
  }
    // Gold and Diamond depletion is now handled by goldGone and diamondGone WS events.
  return false;
}

function getTargetProgress(key, near) {
  if (!key || !near) return 0;
  if (key.startsWith('tree:')) {
    const hit = state.world.treeHits.find(h => h.x === near.x && h.y === near.y);
    return hit ? hit.pct : 0;
  }
  if (key.startsWith('gold:')) {
    const node = state.world.golds.find(g => g.x === near.x && g.y === near.y);
    return node ? node.pct : 0;
  }
  if (key.startsWith('diamond:')) {
    const node = state.world.diamonds.find(d => d.x === near.x && d.y === near.y);
    return node ? node.pct : 0;
  }
  if (key.startsWith('mob:')) {
    const mob = state.world.mobs.find(m => m.id === near.id);
    return mob ? (mob.hpPct ?? 1.0) : 1.0;
  }
  return 0;
}

function checkRealign(key, near) {
  const currentLoot = state.session.wood + state.session.gold + state.session.meat + state.session.kills;
  const progress = getTargetProgress(key, near);

  if (!state.lastProgressTime) {
    state.lastProgressTime = Date.now();
  }

  if (key !== state.currentTargetKey) {
    state.currentTargetKey = key;
    state.attacksOnCurrentTarget = 0;
    state.lastTargetProgressValue = progress;
    state.lastLootTotal = currentLoot;
    state.lastProgressTime = Date.now();
    return false;
  }

  let progressMade = false;
  if (currentLoot > state.lastLootTotal) {
    progressMade = true;
  } else if (progress < state.lastTargetProgressValue) {
    progressMade = true;
  }

  if (progressMade) {
    state.attacksOnCurrentTarget = 0;
    state.lastTargetProgressValue = progress;
    state.lastLootTotal = currentLoot;
    state.lastProgressTime = Date.now();
    state.currentTargetStrikes = 0;
    return false;
  }

  let timeoutMs = 5000;
  let minAttacks = 15;
  if (key.startsWith('mob:')) {
    timeoutMs = 10000;
    minAttacks = 20;
  } else if (key.startsWith('gold:') || key.startsWith('diamond:')) {
    timeoutMs = 600000; // 10 minutes for high HP nodes
    minAttacks = 1000;
  }

  // Only declare a miss if we have been trying without any progress
  if (Date.now() - state.lastProgressTime > timeoutMs && state.attacksOnCurrentTarget >= minAttacks) {
    log('⚠️', `Attacks on ${key} not registering (no progress in ${timeoutMs/1000}s). Re-aligning...`);
    state.attacksOnCurrentTarget = 0;
    state.lastProgressTime = Date.now();
    state.playerPosInitialized = false; // Actually resync position with server
    return true;
  }
  return false;
}

function moveToward(tx, ty, defaultStep = 80, stopDist = 0) {
  const dx = tx - state.player.x;
  const dy = ty - state.player.y;
  const d  = Math.hypot(dx, dy);

  if (d <= stopDist + 5) {
    state.movingUntil = 0;
    return;
  }

  if (FAST_MODE) {
    const nx = Math.round(state.player.x + (dx / d) * (d - stopDist));
    const ny = Math.round(state.player.y + (dy / d) * (d - stopDist));
    state.player.x = nx;
    state.player.y = ny;
    state.movingUntil = 0;
    faceTarget(tx);
    // Auto boat detection based on landCache
    if (landCache.size >= 30) state.player.boat = !isLikelyLand(nx, ny);
    sendState();
    return;
  }

  const step = defaultStep;
  const moveDist = Math.min(step, d - stopDist);
  if (moveDist <= 0) { state.movingUntil = 0; return; }

  const nx = Math.round(state.player.x + (dx / d) * moveDist);
  const ny = Math.round(state.player.y + (dy / d) * moveDist);
  
  state.player.x = nx;
  state.player.y = ny;

  // Auto boat detection based on landCache
  if (landCache.size >= 30) {
    const onLand = isLikelyLand(nx, ny);
    if (state.player.boat !== !onLand) {
      state.player.boat = !onLand;
      if (state.player.boat) log('⛵', 'On water — boat mode ON');
      else log('🚶', 'On land — walk mode');
    }
  }

  state.player.facing = dx > 0 ? 1 : -1;
  state.player.bd     = dx > 0 ? 'right' : 'left';
  // Block next attack tick until after state syncs to server (one step = ~100ms)
  state.movingUntil = Date.now() + ST_INTERVAL + 30;
}

function moveAwayFrom(tx, ty, step = 80) {
  const dx = state.player.x - tx;
  const dy = state.player.y - ty;
  const d  = Math.hypot(dx, dy);

  if (d === 0) {
    state.player.x += step;
  } else {
    state.player.x = Math.round(state.player.x + (dx / d) * step);
    state.player.y = Math.round(state.player.y + (dy / d) * step);
  }

  // Auto boat detection based on landCache
  if (landCache.size >= 30) {
    const onLand = isLikelyLand(state.player.x, state.player.y);
    if (state.player.boat !== !onLand) {
      state.player.boat = !onLand;
      if (state.player.boat) log('⛵', 'On water — boat mode ON');
      else log('🚶', 'On land — walk mode');
    }
  }

  // Face the target while retreating
  state.player.facing = -dx > 0 ? 1 : -1;
  state.player.bd     = -dx > 0 ? 'right' : 'left';
  state.movingUntil = Date.now() + ST_INTERVAL + 30;
}

function faceTarget(tx) {
  const dx = tx - state.player.x;
  if (dx === 0) return;
  const newFacing = dx > 0 ? 1 : -1;
  const newBd     = dx > 0 ? 'right' : 'left';
  if (state.player.facing !== newFacing) {
    state.player.facing = newFacing;
    state.player.bd     = newBd;
  }
}

function wander(radius = 200) {
  const a        = Math.random() * Math.PI * 2;
  state.player.x = Math.round(state.player.x + Math.cos(a) * radius);
  state.player.y = Math.round(state.player.y + Math.sin(a) * radius);
  sendState();
  // Don't block isMoving — just reposition so next attack tick fires normally
}

function toWorldCenter(v) {
  return v > 1000 ? v : v * TILE + 32;
}

const chunks = {
  loaded: new Set(),
  trees: [],
  golds: [],
  diamonds: [],
};

const chunkFailTimes = {};

async function loadChunk(cx, cy) {
  const key = `${cx},${cy}`;
  if (chunks.loaded.has(key)) return;

  const lastFail = chunkFailTimes[key] || 0;
  if (Date.now() - lastFail < 15000) return;

  chunks.loaded.add(key);

  const url = `${BASE_URL}/api/world/chunk?cx=${cx}&cy=${cy}`;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (data && data.t) {
      let treeCount = 0;
      let goldCount = 0;
      let dmdCount = 0;
      for (const t of data.t) {
        const x = t[0];
        const y = t[1];
        const tileData = t[2] || {};
        const objects = tileData.o || {};
        for (const [tier, obj] of Object.entries(objects)) {
          if (obj) {
            const cleanObj = obj.split('|')[0];
            if (cleanObj.startsWith('tree:')) {
              chunks.trees.push({ x, y, wx: x * 64 + 32, wy: y * 64 + 32 });
              markLand(x * 64 + 32, y * 64 + 32);
              treeCount++;
            } else if (cleanObj.startsWith('gold')) {
              chunks.golds.push({ x, y, wx: x * 64 + 32, wy: y * 64 + 32 });
              markLand(x * 64 + 32, y * 64 + 32);
              goldCount++;
            } else if (cleanObj.startsWith('diamond')) {
              chunks.diamonds.push({ x, y, wx: x * 64 + 32, wy: y * 64 + 32 });
              markLand(x * 64 + 32, y * 64 + 32);
              dmdCount++;
            }
          }
        }
      }
      log('🌍', `Loaded map chunk (${cx}, ${cy}) — Found ${treeCount} trees, ${goldCount} gold, ${dmdCount} diamonds`);
    }
  } catch (err) {
    log('⚠️', `Failed to load map chunk (${cx}, ${cy}): ${err.message}`);
    chunks.loaded.delete(key);
    chunkFailTimes[key] = Date.now();
  }
}

async function ensureNearbyChunks() {
  const cx = Math.max(0, Math.min(9, Math.floor(state.player.x / 3200)));
  const cy = Math.max(0, Math.min(9, Math.floor(state.player.y / 3200)));
  
  const promises = [];
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const ccx = cx + dx;
      const ccy = cy + dy;
      if (ccx >= 0 && ccx <= 9 && ccy >= 0 && ccy <= 9) {
        promises.push(loadChunk(ccx, ccy));
      }
    }
  }
  await Promise.all(promises);
}

// ─────────────────────────────────────────────
// FARMING MODES
// ─────────────────────────────────────────────
function findBestResource(type) {
  const now = Date.now();
  if (type === 'tree') {
    const candidateList = chunks.trees.filter(item => {
      const key = `tree:${item.x},${item.y}`;
      if (state.failedResources.has(key) && now - state.failedResources.get(key) < 300000) return false;
      if (distTo(item.wx, item.wy) <= VIEWPORT_RANGE) {
        return state.world.trees.some(t => t.x === item.x && t.y === item.y);
      }
      return true;
    });

    if (candidateList.length > 0) {
      let best = null;
      let bestDist = Infinity;
      for (const item of candidateList) {
        const d = distTo(item.wx, item.wy);
        if (d < bestDist) {
          bestDist = d;
          best = { x: item.x, y: item.y, wx: item.wx, wy: item.wy, type };
        }
      }
      return best;
    }
    return null;
  }

  // 1. Check server's active list first (gold, diamond)
  let activeList = [];
  if (type === 'gold') {
    // pct=0 means untouched fresh node, pct>0 means already being mined (closer to dropping).
    // Prefer nodes with pct>0 (actively being mined = about to drop).
    // Also accept pct=0 nodes (fresh - need to mine from scratch).
    const allGolds = (state.world.golds || []).filter(g => {
      const key = `gold:${g.x},${g.y}`;
      return !(state.failedResources.has(key) && now - state.failedResources.get(key) < 300000);
    });
    // Prefer already-damaged nodes first (non-zero pct)
    const damaged = allGolds.filter(g => g.pct > 0);
    activeList = damaged.length > 0 ? damaged : allGolds;
    if (Date.now() - (state._lastActiveListLog || 0) > 5000) {
      log('🐛', `DEBUG: gold total=${allGolds.length} damaged=${damaged.length} targeting=${activeList.length}`);
      state._lastActiveListLog = Date.now();
    }
  } else if (type === 'diamond') {
    activeList = (state.world.diamonds || []).filter(d => {
      const key = `diamond:${d.x},${d.y}`;
      if (state.failedResources.has(key) && now - state.failedResources.get(key) < 300000) return false;
      return true;
    });
  }

  if (activeList.length > 0) {
    // Find the closest active resource
    let best = null;
    let bestDist = Infinity;
    for (const item of activeList) {
      const wx = item.x * 64 + 32;
      const wy = item.y * 64 + 32;
      const d = distTo(wx, wy);
      if (d < bestDist) {
        bestDist = d;
        best = { x: item.x, y: item.y, wx, wy, type };
      }
    }
    if (best) return best;
  }

  // 2. Fall back to static chunk list (gold, diamond)
  let staticList = [];
  if (type === 'gold') {
    staticList = chunks.golds.filter(item => {
      const key = `gold:${item.x},${item.y}`;
      if (state.failedResources.has(key) && now - state.failedResources.get(key) < 300000) return false;
      if (distTo(item.wx, item.wy) <= VIEWPORT_RANGE) {
        return state.world.golds.some(g => g.x === item.x && g.y === item.y);
      }
      return true;
    });
  } else if (type === 'diamond') {
    staticList = chunks.diamonds.filter(item => {
      const key = `diamond:${item.x},${item.y}`;
      if (state.failedResources.has(key) && now - state.failedResources.get(key) < 300000) return false;
      if (distTo(item.wx, item.wy) <= VIEWPORT_RANGE) {
        return state.world.diamonds.some(d => d.x === item.x && d.y === item.y);
      }
      return true;
    });
  }

  // Filter out any static resource that is within viewport range (since if it were active, it would have been in the activeList)
  const candidateList = staticList.filter(item => {
    const d = distTo(item.wx, item.wy);
    return d > VIEWPORT_RANGE;
  });

  if (candidateList.length > 0) {
    let best = null;
    let bestDist = Infinity;
    for (const item of candidateList) {
      const d = distTo(item.wx, item.wy);
      if (d < bestDist) {
        bestDist = d;
        best = { x: item.x, y: item.y, wx: item.wx, wy: item.wy, type };
      }
    }
    return best;
  }

  return null;
}

function doTree() {
  if (state.lockResource && state.lockResource.type === 'tree') {
    if (isResourceDepleted('tree', state.lockResource.x, state.lockResource.y, state.lockResource.wx, state.lockResource.wy)) {
      log('ℹ️', `Tree at [${state.lockResource.x}, ${state.lockResource.y}] is depleted. Blacklisting.`);
      state.failedResources.set(`tree:${state.lockResource.x},${state.lockResource.y}`, Date.now());
      state.lockResource = null;
    }
  }

  if (!state.lockResource || state.lockResource.type !== 'tree') {
    state.lockResource = findBestResource('tree');
    if (!state.lockResource) {
      doMonster(false);
      return;
    }
  }

  const near = state.lockResource;
  const d = distTo(near.wx, near.wy);
  const key = `tree:${near.x},${near.y}`;
  const realign = checkRealign(key, near);

  const hit = state.world.treeHits.find(h => h.x === near.x && h.y === near.y);
  const hpPct = hit ? (hit.pct / 1000) : 1;
  state.currentTarget = { type: 'Tree', hpPct, wx: near.wx, wy: near.wy, _near: near };

  if (realign) {
    log('⚠️', `Attacks on ${key} not registering. Blacklisting and releasing lock.`);
    state.failedResources.set(key, Date.now());
    state.lockResource = null;
    return;
  } else if (d > 35) {
    moveToward(near.wx, near.wy, 70, 20);
  } else {
    state.movingUntil = 0;
    faceTarget(near.wx);
    sendAttack(near.wx, near.wy);
  }
}

function doGold() {
  if (state.xp.level < GOLD_LEVEL_REQ) {
    log('🔒', `Gold requires Level ${GOLD_LEVEL_REQ}. You are Level ${state.xp.level}. Skipping.`);
    if (state.modeList.length > 1) advanceMode();
    else doTree();
    return;
  }

  if (state.lockResource && state.lockResource.type === 'gold') {
    if (isResourceDepleted('gold', state.lockResource.x, state.lockResource.y, state.lockResource.wx, state.lockResource.wy)) {
      log('ℹ️', `Gold at [${state.lockResource.x}, ${state.lockResource.y}] is depleted. Blacklisting.`);
      state.failedResources.set(`gold:${state.lockResource.x},${state.lockResource.y}`, Date.now());
      state.lockResource = null;
    }
  }

  if (!state.lockResource || state.lockResource.type !== 'gold') {
    state.lockResource = findBestResource('gold');
    if (!state.lockResource) {
      // No gold nearby yet — just wait/walk, don't switch to tree
      log('🔍', 'No gold node available yet, waiting...');
      return;
    }
  }

  const near = state.lockResource;
  const d = distTo(near.wx, near.wy);
  const key = `gold:${near.x},${near.y}`;
  const realign = checkRealign(key, near);

  const stateNode = state.world.golds.find(sg => sg.x === near.x && sg.y === near.y);
  const nodePct = stateNode ? stateNode.pct : 1000;
  state.currentTarget = { type: 'Gold Node', hpPct: (nodePct / 1000), wx: near.wx, wy: near.wy, _near: near };

  // Stand close to the node to ensure attacks register
  const standX = near.wx + 15;
  const standY = near.wy + 15;
  const dToStand = Math.hypot(standX - state.player.x, standY - state.player.y);

  if (!state._walkStartTime) state._walkStartTime = Date.now();
  if (Date.now() - state._walkStartTime > 20000 && dToStand > 5) {
    log('⚠️', `Cannot reach ${key} after 20s (stuck on obstacle?). Blacklisting.`);
    state.failedResources.set(key, Date.now());
    state.lockResource = null;
    state._walkStartTime = 0;
    return;
  }

  if (realign) {
    log('⚠️', `Attacks on ${key} not registering. Blacklisting and releasing lock.`);
    state.failedResources.set(key, Date.now());
    state.lockResource = null;
    state._walkStartTime = 0;
    return;
  } else if (dToStand > 5) {
    if (Date.now() - (state._lastTargetLog || 0) > 2000) {
       log('🎯', `WALKING TO: Gold [${near.x},${near.y}] | stand=(${standX},${standY}) | dist=${Math.round(dToStand)}px | pct=${nodePct}`);
       state._lastTargetLog = Date.now();
    }
    moveToward(standX, standY, 70, 0);
  } else {
    state._walkStartTime = 0;
    state.movingUntil = 0;

    // Match manual player exactly: stand RIGHT of node, face LEFT, bd:"left"
    // From log: player at (+69px right, +7px below) node center, facing:-1, bd:"left"
    state.player.facing = -1;
    state.player.bd = 'left';

    // Rate limit attacks to overcome regeneration, with JITTER to bypass anti-cheat
    if (!state._currentAttackDelay) state._currentAttackDelay = ATK_INTERVAL + Math.random() * 200 - 100; // +/- 100ms jitter
    if (Date.now() - (state._lastAttackTime || 0) < state._currentAttackDelay) return;
    state._lastAttackTime = Date.now();
    state._currentAttackDelay = ATK_INTERVAL + Math.random() * 200 - 100; // Pick new delay for next attack

    // Log pct every 5 attacks
    if (state.attacksOnCurrentTarget % 5 === 0) {
      log('⛏️', `Gold [${near.x},${near.y}] pct=${nodePct} | atk#${state.attacksOnCurrentTarget} | player=(${Math.round(state.player.x)},${Math.round(state.player.y)}) | stand=(${standX},${standY})`);
    }

    // Gold nodes: pct counts down from ~1000 to 0, then gold drops.
    // Gold takes 2-4 minutes to mine (up to 600-800 hits).
    // If still no progress/drop after 1500 hits, declare ghost.
    if (state.attacksOnCurrentTarget > 1500) {
      log('⚠️', `Node [${near.x},${near.y}] took 1500 hits with no progress. Blacklisting.`);
      state.failedResources.set(key, Date.now());
      state.lockResource = null;
      return;
    }

    sendAttack();
  }
}


function doDiamond() {
  if (state.xp.level < DIAMOND_LEVEL_REQ) {
    log('🔒', `Diamond requires Level ${DIAMOND_LEVEL_REQ}. You are Level ${state.xp.level}. Skipping.`);
    if (state.modeList.length > 1) advanceMode();
    else doTree();
    return;
  }

  if (state.lockResource && state.lockResource.type === 'diamond') {
    if (isResourceDepleted('diamond', state.lockResource.x, state.lockResource.y, state.lockResource.wx, state.lockResource.wy)) {
      log('ℹ️', `Diamond at [${state.lockResource.x}, ${state.lockResource.y}] is depleted. Blacklisting.`);
      state.failedResources.set(`diamond:${state.lockResource.x},${state.lockResource.y}`, Date.now());
      state.lockResource = null;
    }
  }

  if (!state.lockResource || state.lockResource.type !== 'diamond') {
    state.lockResource = findBestResource('diamond');
    if (!state.lockResource) {
      doMonster(false);
      return;
    }
  }

  const near = state.lockResource;
  const d = distTo(near.wx, near.wy);
  const key = `diamond:${near.x},${near.y}`;
  const realign = checkRealign(key, near);

  const stateNode = state.world.diamonds.find(d => d.x === near.x && d.y === near.y);
  const hpPct = stateNode ? (stateNode.pct / 1000) : 1;
  state.currentTarget = { type: 'Diamond Node', hpPct, wx: near.wx, wy: near.wy, _near: near };

  if (realign) {
    log('⚠️', `Attacks on ${key} not registering. Blacklisting and releasing lock.`);
    state.failedResources.set(key, Date.now());
    state.lockResource = null;
    return;
  } else if (d > 45) {
    moveToward(near.wx, near.wy, 60, 35);
  } else {
    state.movingUntil = 0;
    state.player.facing = near.wx > state.player.x ? 1 : -1;
    sendAttack(near.wx, near.wy);
  }
}

function doFishing() {
  const targetX = 15555;
  const targetY = 16122;
  const d = distTo(targetX, targetY);

  if (d > 5) {
    if (Date.now() - (state._lastTargetLog || 0) > 5000) {
       log('🎯', `WALKING TO: Fishing Spot [${targetX},${targetY}] | dist=${Math.round(d)}px`);
       state._lastTargetLog = Date.now();
    }
    moveToward(targetX, targetY, 70, 0);
  } else {
    state._walkStartTime = 0;
    state.movingUntil = 0;
    state.player.facing = 1; // Face right towards the water

    if (!state._currentFishDelay) state._currentFishDelay = 2000 + Math.random() * 200 - 100;
    if (Date.now() - (state._lastFishTime || 0) < state._currentFishDelay) return;
    
    state._lastFishTime = Date.now();
    state._currentFishDelay = 2000 + Math.random() * 200 - 100;
    
    if (!state._fishLogTime || Date.now() - state._fishLogTime > 5000) {
      log('🎣', `FISHING at [${targetX},${targetY}]...`);
      state._fishLogTime = Date.now();
    }
    
    sendState(); // Tell server we stopped and are facing right
    const bait = (state.inv.fish || 0) > 0 ? 'fish' : 'meat';
    send({ t: 'fish', bait });
  }
}

function doMonster(bossOnly = false) {
  const now = Date.now();
  const alive = state.world.mobs.filter(m => {
    if (m.state === 'dead') return false;
    if (state.failedMobs.has(m.id) && now - state.failedMobs.get(m.id) < 300000) return false;
    const mType = (m.type || '').toLowerCase();
    if (mType && skipMobs.includes(mType)) return false;
    return m.hp > 0;
  });
  let pool  = bossOnly
    ? alive.filter(m => m.boss === true && m.hpPct > 0)
    : alive.filter(m => !m.boss && m.hpPct > 0);

  if (bossOnly && pool.length === 0) {
    let farBosses = (state.world.farMobs || []).filter(m => {
      const t = (m.type || '').toLowerCase();
      return t.includes('boss') || t === 'minotaur' || t === 'dragon' || t === 'kraken' || t === 'demon' || t === 'yeti' || t === 'reaper' || t === 'king';
    });
    if (state.world.farBosses && state.world.farBosses.length > 0) {
      farBosses = farBosses.concat(state.world.farBosses);
    }
    if (farBosses.length > 0) {
      const near = farBosses.reduce((b, m) => distTo(m.x, m.y) < distTo(b.x, b.y) ? m : b, farBosses[0]);
      const d = distTo(near.x, near.y);
      if (!state._lastFarBossLog || now - state._lastFarBossLog > 5000) {
        log('👑', `Far boss detected: ${near.type} at dist ${d.toFixed(0)}`);
        state._lastFarBossLog = now;
      }
      
      if (near.type === 'boss_mark' && d <= 120) {
        // We are waiting at the spawn location for the boss to appear.
        // Wander gently to avoid looking completely frozen/AFK.
        if (Math.random() < 0.1) wander(40);
        return;
      }
      
      moveToward(near.x, near.y, 80, 100);
      return;
    }
    // No bosses anywhere -> fall back to regular monsters!
    log('👑', 'No bosses found anywhere. Falling back to regular monsters...');
    pool = alive.filter(m => !m.boss && m.hpPct > 0);
  }

  if (!bossOnly && pool.length === 0) {
    // Find far normal mobs!
    let farNormalMobs = (state.world.farMobs || []).filter(m => {
      const t = (m.type || '').toLowerCase();
      return !skipMobs.includes(t) && !t.includes('boss') && t !== 'minotaur' && t !== 'dragon' && t !== 'kraken' && t !== 'demon' && t !== 'yeti' && t !== 'reaper' && t !== 'king';
    });
    if (farNormalMobs.length > 0) {
      const farRare = farNormalMobs.filter(m => rareMobTypes[(m.type || '').toLowerCase()]);
      const farTarget = farRare.length > 0
        ? farRare.reduce((b, m) => distTo(m.x, m.y) < distTo(b.x, b.y) ? m : b, farRare[0])
        : farNormalMobs.reduce((b, m) => distTo(m.x, m.y) < distTo(b.x, b.y) ? m : b, farNormalMobs[0]);
      
      const tag = rareMobTypes[(farTarget.type || '').toLowerCase()] ? '🌟' : '⚔️';
      log(tag, `Far mob detected: ${farTarget.type} at dist ${distTo(farTarget.x, farTarget.y).toFixed(0)}${tag === '🌟' ? ' [RARE-DROP TYPE!]' : ''}`);
      moveToward(farTarget.x, farTarget.y, 80, 20);
      return;
    }
  }

  if (state.lockMobId) {
    const cur = pool.find(m => m.id === state.lockMobId);
    if (cur) {
      const key = `mob:${cur.id}`;
      const realign = checkRealign(key, cur);
      state.currentTarget = { type: cur.type, hpPct: cur.hpPct ?? 1.0, wx: cur.x, wy: cur.y };
      if (realign) {
        state.currentTargetStrikes = (state.currentTargetStrikes || 0) + 1;
        if (state.currentTargetStrikes >= 3) {
          log('⚠️', `Attacks on ${key} failed 3 times. Blacklisting and releasing lock.`);
          state.failedMobs.set(cur.id, Date.now());
          state.lockMobId = null;
          state.currentTarget = null;
          state.currentTargetStrikes = 0;
        } else {
          log('⚠️', `Attacks on ${key} not registering. Resyncing position (Strike ${state.currentTargetStrikes}/3)...`);
        }
        return;
      }
      const d = distTo(cur.x, cur.y);
      const isBoss = cur.boss;
      const targetDist = isBoss ? 60 : 20;

      if (d > targetDist) {
        moveToward(cur.x, cur.y, 80, targetDist - 5);
        if (distTo(cur.x, cur.y) <= 65) {
          faceTarget(cur.x);
          sendAttack(cur.x, cur.y);
        }
      } else if (isBoss && d < targetDist - 10) {
        // Kite the boss smoothly!
        moveAwayFrom(cur.x, cur.y, 25);
        faceTarget(cur.x);
        sendAttack(cur.x, cur.y);
      } else {
        state.movingUntil = 0;
        faceTarget(cur.x);
        sendAttack(cur.x, cur.y);
      }
      return;
    }
    const worldMob = (state.world.mobs || []).find(m => m.id === state.lockMobId);
    if (worldMob) {
      log('❓', `Dropped target! It is in world.mobs but not in pool! HP: ${worldMob.hpPct}`);
    } else {
      log('❓', `Dropped target! It completely vanished from state.world.mobs!`);
    }
    state.lockMobId = null;
    state.currentTarget = null;
  }

  if (pool.length > 0) { state._scanTarget = null;
    state.zeroMobsSince = 0;
    const near = pool.reduce((b, m) => distTo(m.x, m.y) < distTo(b.x, b.y) ? m : b, pool[0]);
    state.lockMobId = near.id;
    const key = `mob:${near.id}`;
    const realign = checkRealign(key, near);
    state.currentTarget = { type: near.type, hpPct: near.hpPct ?? 1.0, wx: near.x, wy: near.y };
    log(bossOnly ? '👑' : '⚔️', `Locked: ${near.type}  HP:${((near.hpPct ?? 1.0)*100).toFixed(0)}%  dist:${distTo(near.x, near.y).toFixed(0)}`);
    if (realign) {
      state.currentTargetStrikes = (state.currentTargetStrikes || 0) + 1;
      if (state.currentTargetStrikes >= 3) {
        log('⚠️', `Attacks on ${key} failed 3 times. Blacklisting and releasing lock.`);
        state.failedMobs.set(near.id, Date.now());
        state.lockMobId = null;
        state.currentTarget = null;
        state.currentTargetStrikes = 0;
      } else {
        log('⚠️', `Attacks on ${key} not registering. Resyncing position (Strike ${state.currentTargetStrikes}/3)...`);
      }
      return;
    }
    
    const d = distTo(near.x, near.y);
    const isBoss = near.boss;
    const targetDist = isBoss ? 60 : 20;

    if (d > targetDist) {
      moveToward(near.x, near.y, 80, targetDist - 5);
      if (distTo(near.x, near.y) <= 65) {
        faceTarget(near.x);
        sendAttack(near.x, near.y);
      }
    } else if (isBoss && d < targetDist - 10) {
      // Kite the boss smoothly!
      moveAwayFrom(near.x, near.y, 25);
      faceTarget(near.x);
      sendAttack(near.x, near.y);
    } else {
      state.movingUntil = 0;
      faceTarget(near.x);
      sendAttack(near.x, near.y);
    }
  } else {
    state.currentTarget = null;
    if (state.modeList.length === 1 && state.modeList[0] === 'monster' && alive.length === 0 && state.worldReceived && (Date.now() - (state.worldReceivedTime || 0) > 5000)) {
      if (!state.zeroMobsSince) {
        state.zeroMobsSince = Date.now();
      } else if (Date.now() - state.zeroMobsSince > 45000) {
        log('🔄', 'World state seems stuck (45s with no mobs). Forcing a fresh reset...');
        state.zeroMobsSince = 0;
        state._lastKickReason = 'swap-server';
        if (state.ws) state.ws.close();
        return;
      }
    }
    // If no mobs and no far mobs, use global spawn memory to path to a known spawn!
    const now = Date.now();
    let bestSpawn = null;
    let bestDist = Infinity;
    
    // If we already picked a scan target and haven't reached it, stick to it
    if (state._scanTarget && now - state._scanTarget.pickedAt < 30000) {
      if (distTo(state._scanTarget.x, state._scanTarget.y) > 200) {
        moveToward(state._scanTarget.x, state._scanTarget.y, 80, 20);
        return;
      } else {
        // We reached it. In FAST_MODE, we arrive instantly, but the server needs time to load the chunk.
        // Wait up to 2 seconds before abandoning this location.
        if (!state._scanTarget.reachedAt) {
          state._scanTarget.reachedAt = now;
        }
        if (now - state._scanTarget.reachedAt < 2000) {
          return; // Just wait here
        }
        
        // Waited 2 seconds, still no mobs. Mark it visited so we can pick a new one
        if (knownMobSpawns[state._scanTarget.key]) {
          knownMobSpawns[state._scanTarget.key].lastVisited = now;
        }
        state._scanTarget = null;
      }
    }
    
    for (const key of Object.keys(knownMobSpawns)) {
      const spawn = knownMobSpawns[key];
      // Skip if visited in last 60 seconds
      if (now - spawn.lastVisited < 60000) continue;
      // In boss mode, only care about boss spawns
      if (bossOnly && !spawn.type.includes('boss') && spawn.type !== 'minotaur' && spawn.type !== 'dragon' && spawn.type !== 'kraken' && spawn.type !== 'demon' && spawn.type !== 'yeti' && spawn.type !== 'reaper' && spawn.type !== 'king') continue;
      
      const d = distTo(spawn.x, spawn.y);
      let score = d;
      // Prioritize rare mob types heavily
      if (rareMobTypes[spawn.type.toLowerCase()]) {
        score -= 5000;
      }
      if (score < bestDist) {
        bestDist = score;
        bestSpawn = spawn;
        bestSpawn.key = key;
      }
    }
    
    if (bestSpawn) {
      const tag = rareMobTypes[bestSpawn.type.toLowerCase()] ? '🌟' : '🗺️';
      log(tag, `[SCAN] Local empty. Picked known spawn area for [${bestSpawn.type}] at dist ${distTo(bestSpawn.x, bestSpawn.y).toFixed(0)}`);
      state._scanTarget = { ...bestSpawn, pickedAt: now };
      // Prevent 45s timeout while we are actively pathing across the map
      state.zeroMobsSince = now; 
      moveToward(bestSpawn.x, bestSpawn.y, 80, 20);
    } else {
      // Fallback if absolutely no known spawns (e.g. brand new account/map)
      if (Math.random() < 0.3) wander(600);
    }
  }
}

// ─────────────────────────────────────────────
// MODE CYCLING
// ─────────────────────────────────────────────
const MODE_TIMEOUT_MS = 60_000; // Switch mode after 60s if no loot
let modeEnteredAt = Date.now();

function advanceMode() {
  state.modeIdx   = (state.modeIdx + 1) % state.modeList.length;
  state.mode      = state.modeList[state.modeIdx];
  state.gotLoot   = false;
  state.lockMobId = null;
  state.lockResource = null;
  state.currentTarget = null;
  modeEnteredAt   = Date.now();
  log('🔄', `Mode → ${state.mode.toUpperCase()}`);
}

// ─────────────────────────────────────────────
// ATTACK TICK
// ─────────────────────────────────────────────
function attackTick() {
  if (!state.authed) return;

  // Remove level-locked resources from rotation, or add fallbacks
  if (state.xp.level < GOLD_LEVEL_REQ && state.modeList.includes('gold')) {
    if (state.modeList.length === 1) {
      log('⚠️', `GOLD requires Level ${GOLD_LEVEL_REQ} (current: Lv${state.xp.level}). Adding TREE as fallback.`);
      state.modeList.push('tree');
    }
    state.modeList = state.modeList.filter(m => m !== 'gold');
    log('🔒', `Removed GOLD from rotation (requires Lv${GOLD_LEVEL_REQ})`);
    if (state.mode === 'gold') advanceMode();
  }
  if (state.xp.level < DIAMOND_LEVEL_REQ && state.modeList.includes('diamond')) {
    if (state.modeList.length === 1) {
      log('⚠️', `DIAMOND requires Level ${DIAMOND_LEVEL_REQ} (current: Lv${state.xp.level}). Adding TREE as fallback.`);
      state.modeList.push('tree');
    }
    state.modeList = state.modeList.filter(m => m !== 'diamond');
    log('🔒', `Removed DIAMOND from rotation (requires Lv${DIAMOND_LEVEL_REQ})`);
    if (state.mode === 'diamond') advanceMode();
  }

  // Restore unlocked modes if player leveled up
  if (MODES.gold && state.xp.level >= GOLD_LEVEL_REQ && !state.modeList.includes('gold')) {
    state.modeList.push('gold');
    log('🔓', `Level ${state.xp.level} reached! Added GOLD back to rotation.`);
    if (!MODES.tree && state.modeList.includes('tree')) {
      state.modeList = state.modeList.filter(m => m !== 'tree');
      if (state.mode === 'tree') advanceMode();
    }
  }
  if (MODES.diamond && state.xp.level >= DIAMOND_LEVEL_REQ && !state.modeList.includes('diamond')) {
    state.modeList.push('diamond');
    log('🔓', `Level ${state.xp.level} reached! Added DIAMOND back to rotation.`);
    if (!MODES.tree && state.modeList.includes('tree')) {
      state.modeList = state.modeList.filter(m => m !== 'tree');
      if (state.mode === 'tree') advanceMode();
    }
  }

  checkRevive();
  if (state.player.hpPct <= 0) return;
  checkHeal();
  checkEquip();

  // Load nearby chunks if needed
  const curCx = Math.max(0, Math.min(9, Math.floor(state.player.x / 3200)));
  const curCur = Math.max(0, Math.min(9, Math.floor(state.player.y / 3200)));
  if (!chunks.loaded.has(`${curCx},${curCur}`)) {
    ensureNearbyChunks();
  }

  // Time-based mode rotation: if stuck in one mode too long, force advance
  let timeoutMs = MODE_TIMEOUT_MS;
  if (state.mode === 'gold') timeoutMs = 240000; // 4 minutes

  if (state.modeList.length > 1 && Date.now() - modeEnteredAt > timeoutMs) {
    log('⏰', `Mode timeout (${timeoutMs/1000}s) — rotating from ${state.mode.toUpperCase()}`);
    advanceMode();
  }

  // Don't farm if we just moved — wait for server to sync position
  if (Date.now() < state.movingUntil) return;
  switch (state.mode) {
    case 'tree':    doTree();           break;
    case 'gold':    doGold();           break;
    case 'diamond': doDiamond();        break;
    case 'monster': doMonster(false);   break;
    case 'boss':    doMonster(true);    break;
    case 'fishing': doFishing();        break;
    default:        doTree();           break;
  }
}

// ─────────────────────────────────────────────
// INTERVALS
// ─────────────────────────────────────────────
function startIntervals() {
  state._stateTimer = setInterval(sendState,    ST_INTERVAL);
  
  function jitteredAttackTick() {
    attackTick();
    const jitter = Math.random() * 200 - 100; // +/- 100ms
    state._atkTimer = setTimeout(jitteredAttackTick, Math.max(100, ATK_INTERVAL + jitter));
  }
  jitteredAttackTick();
  state._dashTimer  = setInterval(() => renderDashboard(state), 300);
  log('▶️', `Bot running! Focus: ${modeStr()}`);
}

function stopIntervals() {
  clearInterval(state._stateTimer);
  clearTimeout(state._atkTimer);
  clearInterval(state._dashTimer);
  clearInterval(state._pingTimer);
  state._stateTimer = state._atkTimer = state._dashTimer = state._pingTimer = null;
}

// ─────────────────────────────────────────────
// WS CONNECT WITH PROXY SUPPORT
// ─────────────────────────────────────────────
function connect(sessionToken) {
  // 1. Ambil proxy aktif dari file proxy.txt
  const currentProxy = getNextProxyAgent();
  const wsOptions = {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    }
  };

  if (currentProxy && currentProxy.agent) {
    wsOptions.agent = currentProxy.agent;
    log('🌐', `Connecting to: ${GAME_WS} via PROXY [${currentProxy.url}]`);
  } else {
    log('🔌', `Connecting to: ${GAME_WS} (WITHOUT PROXY)`);
  }

  // 2. Buat koneksi WebSocket dengan opsi proxy agent
  state.ws = new WebSocket(GAME_WS, wsOptions);

  state.ws.on('open', () => {
    state.connected    = true;
    state.reconnects   = 0;
    state.worldReceived = false;
    
    // Reset world state so old server entities don't linger
    state.world = { mobs: [], trees: [], golds: [], diamonds: [], players: [], treeHits: [], farMobs: [] };
    
    // Clear blacklisted targets so we can hunt/mine fresh on this new server
    state.failedResources.clear();
    state.failedMobs.clear();
    log('✅', 'WebSocket connected!');

    // Ping keepalive
    state._pingTimer = setInterval(() => {
      if (state.ws?.readyState === WebSocket.OPEN) state.ws.ping();
    }, 15000);

    // Hello
    send({
      t:    'hello',
      auth: { walletAddress: WALLET, sessionToken },
      name:  BOT_NAME,
      color: BOT_COLOR,
      fmt: 2
    });
  });

  state.ws.on('message', data => handleMsg(data));
  state.ws.on('pong',    ()   => {});

  state.ws.on('error', err => {
    log('❌', `WS error: ${err.message}`);
  });

  state.ws.on('close', async (code) => {
    log('🔌', `Disconnected (${code})`);
    state.connected = false;
    state.authed    = false;
    stopIntervals();

    if (!state._running) return;

    // If kicked by another session of the same wallet — wait longer before retrying
    const kickReason = state._lastKickReason;
    state._lastKickReason = null;

    if (kickReason === 'swap-server') {
      log('🔄', 'Relogging: waiting 12s before reconnecting to swap servers...');
      state.reconnects = 0; // Don't penalize maxReconnects for intentional server hops
      await sleep(12000);
      log('🔄', `Reconnecting (Server Swap) now...`);
    } else if (kickReason === 'another-session') {
      log('⚠️', 'Kicked: another session took over. Waiting 15s before reconnect...');
      await sleep(15000);
      log('🔄', `Reconnecting (Session Takeover) now...`);
    } else {
      if (state.reconnects >= state.maxReconnects) {
        log('❌', 'Max reconnect attempts reached. Stopping.');
        state._running = false;
        return;
      }

      state.reconnects++;
      // Exponential backoff: 3s, 6s, 12s, 24s... max 60s
      const delay = Math.min(3000 * Math.pow(2, state.reconnects - 1), 60000);
      log('🔄', `Reconnecting (${state.reconnects}/${state.maxReconnects}) in ${(delay/1000).toFixed(0)}s...`);
      await sleep(delay);
    }

    // Retry login up to 3 times (handles rate limit: "Please wait a moment")
    let tok = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        tok = await doLogin();
        break;
      } catch (e) {
        if (e.message.includes('wait') || e.message.includes('TOO_FAST') || e.message.includes('moment')) {
          log('⏳', `Rate limited — waiting 10s (attempt ${attempt}/3)...`);
          await sleep(10000);
        } else {
          log('❌', `Login failed: ${e.message}`);
          break;
        }
      }
    }

    if (tok) {
      // Karena dipanggil kembali, getNextProxyAgent() otomatis mengambil proxy baris selanjutnya
      connect(tok);
    } else {
      log('❌', 'Could not reconnect after retries.');
    }
  });
}

// ─────────────────────────────────────────────
// UTILS
// ─────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ─────────────────────────────────────────────
// MAIN
// ─────────────────────────────────────────────
async function main() {
  console.clear();
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║  🏝️  ISLANDS.GAMES AUTO-BOT v3                   ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`  Wallet   : ${WALLET.slice(0, 16)}...${WALLET.slice(-8)}`);
  console.log(`  Focus    : ${modeStr()}`);
  console.log(`  Modes    : ${state.modeList.join(' → ')}`);
  console.log(`  Skills   : ${skillPlanStr()}`);
  console.log('──────────────────────────────────────────────────');
  console.log('');

  // Auto login
  let sessionToken;
  try {
    if (fs.existsSync(SESSION_PATH)) {
      const sessData = JSON.parse(fs.readFileSync(SESSION_PATH, 'utf8'));
      if (sessData.sessionToken && sessData.walletAddress === WALLET) {
        console.log('✅ Loaded existing session token (bypassing login fetch)');
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
  } catch (e) {
    console.error('❌ Login failed:', e.message);
    console.error('   Make sure wallet has 5000+ $ISLAND tokens.');
    process.exit(1);
  }

  state._running = true;

  // Graceful exit
  process.on('SIGINT', () => {
    console.log('\n\n[BOT] Stopping...');
    state._running = false;
    stopIntervals();
    if (state.ws) state.ws.close();

    console.log('\n══════════════ FINAL STATS ══════════════');
    console.log(`  🌲 Wood:    +${state.session.wood}`);
    console.log(`  💰 Gold:    +${state.session.gold}`);
    console.log(`  🥩 Meat:    +${state.session.meat}`);
    console.log(`  💀 Kills:    ${state.session.kills}`);
    console.log(`  ⚔️  Attacks:  ${state.session.attacks}`);
    console.log(`  🎯 Skill-ups: ${state.session.skillUps}`);
    console.log(`  ⏱️  Uptime:   ${formatTime(Date.now() - state.startTime)}`);
    console.log('═════════════════════════════════════════\n');
    process.exit(0);
  });

  connect(sessionToken);
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
