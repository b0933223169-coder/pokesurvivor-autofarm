// ==UserScript==
// @name         PokéSurvivor 自動掛機 (PSBot)
// @name:en      PokéSurvivor Auto-Farm (PSBot)
// @namespace    https://github.com/b0933223169-coder/pokesurvivor-autofarm
// @version      9.0.0
// @description  PokéSurvivor 自動走位躲招、選卡、綁羈絆、進神祕裂縫、處理事件（Gholdengo、求救、祭壇…）、自動再開一局
// @description:en Auto movement & dodging, card picks, bonds, rifts, events (Gholdengo, rescues, altars…) and auto restart for PokéSurvivor
// @author       BoundlessEgret
// @license      MIT
// @match        https://pokesurvivor.com/*
// @match        https://www.pokesurvivor.com/*
// @run-at       document-start
// @grant        none
// @inject-into  page
// @homepageURL  https://github.com/b0933223169-coder/pokesurvivor-autofarm
// @supportURL   https://github.com/b0933223169-coder/pokesurvivor-autofarm/issues
// @updateURL    https://github.com/b0933223169-coder/pokesurvivor-autofarm/releases/latest/download/pokesurvivor-autofarm.user.js
// @downloadURL  https://github.com/b0933223169-coder/pokesurvivor-autofarm/releases/latest/download/pokesurvivor-autofarm.user.js
// ==/UserScript==

/* PokéSurvivor 自動掛機 — 在頁面世界 (MAIN) 於 document_start 執行。
 *
 * 遊戲把所有模組掛在一個內部命名空間物件上（Object.create(null)，再掛上 Game、Input、RunUI…），
 * 這個物件不會暴露到 window。舊版在 Object.prototype 上埋 'Game' setter 會污染所有物件、
 * 觸發遊戲的擴充功能偵測（顯示「A browser extension is not compatible with the game」），已移除。
 * 現在的做法：
 * 1. 載入前用 Proxy 暫時包住 Object.create，記下「沒有原型」的新物件，遊戲腳本跑完後
 *    挑出屬性最多、同時有 true（BUILT）和 18（LIFT）的那個，就是命名空間，立刻還原 Object.create。
 * 2. 新版連模組鍵名也混淆了（ns.Game 變成 ns._1524c2c，每次改版都換），所以不看鍵名，
 *    改看每個模組自己的方法 / 屬性來認（有 showLevelUp 的就是 RunUI、有 isFree 的就是 World…），
 *    再在命名空間上補不可列舉的明文別名給 bot 用。遊戲自己的程式碼照樣用混淆鍵名，互不干擾。
 */
(() => {
  'use strict';
  // 單一實例保護：擴充 + 油猴同時安裝時會跑兩份（包兩次 Object.create、補丁補兩次、面板兩個）。
  // 用 Symbol.for 放在 window 上（Object.keys 看不到 Symbol），第二份直接不跑。
  const GUARD = Symbol.for('psbot.guard');
  if (window[GUARD]) return;
  try { Object.defineProperty(window, GUARD, { value: 1, configurable: true }); } catch { window[GUARD] = 1; }

  const STORE_KEY = 'psbot.v1';
  const VERSION = '9.0.0';   // v9：死亡原因追蹤 + 狀態條件參數 + 寶可夢強弱 + 獎勵安全學習 + per-Pokémon brain
  const log = (...a) => console.log('%c[PSBot]', 'color:#ff8ad8', ...a);
  let capturedNs = null;

  // ---------- 0. 擴充警告兜底 ----------
  // 遊戲偵測到擴充 / 注入痕跡時會蓋一層警告（內有「browser extension is not compatible」字樣）。
  // 我們已盡量減少痕跡（不污染 Object.prototype、Object.create 用 Proxy 且立刻還原、window 不留明字鍵名），
  // 若警告還是出現，就把那一層移除，讓遊戲顯示出來。
  try {
    const stripWarn = root => {
      if (!root || !root.querySelectorAll) return;
      for (const d of root.querySelectorAll('div')) {
        const t = d.innerText || '';
        if (/browser extension is not compatible/i.test(t)) { d.remove(); }
      }
    };
    const mo = new MutationObserver(() => stripWarn(document));
    const startMo = () => { try { mo.observe(document.documentElement, { childList: true, subtree: true }); } catch {} };
    if (document.documentElement) startMo(); else document.addEventListener('DOMContentLoaded', startMo, { once: true });
    setTimeout(() => { try { mo.disconnect(); } catch {} }, 30000); // 只盯載入初期
  } catch {}

  // ---------- 1. 抓命名空間 ----------
  // 遊戲用 Object.create(null) 建一個命名空間物件，再把所有模組掛上去，不放到 window。
  // 新版連模組鍵名都混淆了，所以不能再用 BUILT / LIFT / Game 判斷，改成看「屬性最多、
  // 同時有 true（BUILT）和 18（LIFT）」的 null 物件。app.min.js 是同步執行的，
  // interval 看到它時一定已經填滿，不會抓到半成品。
  // 注意：
  // - 不碰 Object.prototype：null 命名空間掛不到它，污染所有物件也會觸發遊戲警告。
  // - 用 Proxy 包原生函數（而不是 JS function）：toString / length / name 都轉發給原生。
  // - 抓到就立刻還原 Object.create，把包住的時間縮到最短。
  let booted = false;
  const origCreate = Object.create, nullObjs = [];
  let wrappedCreate = null;
  const unhook = () => { if (wrappedCreate && Object.create === wrappedCreate) Object.create = origCreate; };
  const start = ns => {
    if (booted) return; booted = true;
    unhook();
    clearInterval(poll);
    capturedNs = ns;
    try { resolveNs(ns); } catch (e) { console.warn('[PSBot] resolve', e); }
    try { boot(ns); } catch (e) { console.error('[PSBot] boot failed', e); }
  };
  try {
    wrappedCreate = new Proxy(origCreate, {
      apply(target, thisArg, args) {
        const o = Reflect.apply(target, thisArg, args);
        if (args[0] === null && !booted && nullObjs.length < 64) nullObjs.push(o);
        return o;
      },
    });
    Object.create = wrappedCreate;
  } catch { wrappedCreate = null; }
  const looksLikeNs = o => {
    if (!o || typeof o !== 'object') return false;
    const vals = Object.values(o);
    if (vals.length < 20) return false;
    let hasTrue = false, hasLift = false;
    for (const v of vals) { if (v === true) hasTrue = true; else if (v === 18) hasLift = true; }
    return hasTrue && hasLift;
  };
  const poll = setInterval(() => {
    if (booted) return clearInterval(poll);
    const ns = nullObjs.find(looksLikeNs);
    if (ns) start(ns);
  }, 20);
  // 5 秒都沒抓到：還原 Object.create，不要一直留著包裝；抓到的候選還會繼續等一下
  setTimeout(() => { if (!booted) unhook(); }, 5000);
  setTimeout(() => { if (!booted) { clearInterval(poll); unhook(); console.warn('[PSBot] namespace not found — the game may have changed'); } }, 30000);

  // ---------- 1b. 用「形狀」認出混淆後的模組 ----------
  // 遊戲每個模組的鍵名都會改版換一次，但模組自己的方法不會。這裡逐個比對特徵方法，
  // 找到後在命名空間上補一個不可列舉的明文別名（ns.Game = ...），bot 就照舊用明文鍵名。
  // 遊戲自己的程式碼仍然用原本的混淆鍵名，兩邊互不干擾；別名不可列舉，也不會被列舉偵測看到。
  const isObj = v => v && (typeof v === 'object' || typeof v === 'function');
  const hasFns = (v, ...ks) => isObj(v) && ks.every(k => typeof v[k] === 'function');
  const hasKeys = (v, ...ks) => isObj(v) && ks.every(k => k in v);
  const alias = (ns, name, val) => {
    if (val === undefined || val === null) return;
    try { Object.defineProperty(ns, name, { value: val, writable: true, enumerable: false, configurable: true }); } catch {}
  };

  function resolveNs(ns) {
    const vals = Object.keys(ns).map(k => ns[k]);
    const find = test => vals.find(test);
    // 已經有明文鍵的模組（T、Stats、Items、UI、Gacha、Judgment、Ranking、Sprites、Upgrades…）不動
    const set = (name, test) => {
      if (ns[name] !== undefined) return;
      const v = find(test);
      if (v !== undefined) alias(ns, name, v);
    };

    set('Game',        v => hasFns(v, 'startRun', 'togglePause') && hasKeys(v, 'player', 'state', 'st'));
    set('RunUI',       v => hasFns(v, 'showLevelUp', 'showBond', 'showItemChoice', 'pick', 'pickBond'));
    set('LevelUp',     v => hasFns(v, 'offer') && hasKeys(v, 'STATS'));
    set('Input',       v => hasFns(v, 'axis') && !hasFns(v, 'showLevelUp'));
    set('EnemyMgr',    v => hasFns(v, 'all', 'bossAlive', 'queryCircle'));
    set('Pickups',     v => hasFns(v, 'all', 'dropXp', 'pullAll'));
    set('Projectiles', v => hasFns(v, 'all', 'spawn', 'spawnOrb'));
    set('Hazards',     v => hasFns(v, 'add', 'clear', 'inside') && !hasKeys(v, 'BY', 'SLOTS'));
    set('Orbs',        v => hasFns(v, 'use', 'useSelected') && hasKeys(v, 'BY', 'SLOTS'));
    set('Rift',        v => hasKeys(v, 'inArena', 'rift', 'arena') && hasFns(v, 'update'));
    set('Progress',    v => hasFns(v, 'checkAch', 'claim') && hasKeys(v, 'titles'));
    set('World',       v => hasFns(v, 'isFree', 'projectileBlock', 'specialsNear'));
    set('Types',       v => hasFns(v, 'mult') && hasKeys(v, 'CHART'));
    set('Weather',     v => hasFns(v, 'mult', 'speedFor') && hasKeys(v, 'KINDS'));
    set('Events',      v => hasFns(v, '_dbg') && hasKeys(v, 'golden'));
    set('Flow',        v => hasFns(v, 'goMenu', 'afterLogin'));
    // 多人房間（room 是 getter，沒在房間時是 null）
    set('Room',        v => hasKeys(v, 'room', 'uid', 'friends', 'invites', 'MAX_PLAYERS') && hasFns(v, 'createRoom', 'joinRoom', 'leaveRoom'));
    set('Tiles',       v => hasKeys(v, 'T', 'BIOMES') && hasFns(v, 'runBiome'));
    set('DB',          v => hasFns(v, 'commit', 'upgradesOf') && hasKeys(v, 'save'));
    set('Moves',       v => hasFns(v, 'poolFor') && hasKeys(v, 'BY_ID', 'EVO'));
    set('DEX',         v => Array.isArray(v) && v.length > 100 && v[0] && typeof v[0].dex === 'number' && 'bst' in v[0]);
    set('DEX_BY',      v => !Array.isArray(v) && isObj(v) && v[1] && v[1].dex === 1 && v[25] && v[25].dex === 25 && 'name' in v[25]);

    // 能力表：新版是「特性 → 圖鑑編號」的大表，bot 要的是反過來「圖鑑編號 → 特性」。
    // 特徵：鍵是 kebab-case 的特性名，值是圖鑑編號陣列。
    if (ns.DEX_ABIL === undefined) {
      const raw = find(v => isObj(v) && typeof v === 'object' && !Array.isArray(v)
        && Object.keys(v).length > 50
        && Object.keys(v).some(k => k.includes('-'))
        && Object.values(v).every(a => Array.isArray(a) && a.every(n => typeof n === 'number')));
      if (raw) {
        const inv = {};
        for (const [ab, dexes] of Object.entries(raw)) for (const d of dexes) (inv[d] = inv[d] || []).push(ab);
        alias(ns, 'DEX_ABIL', inv);
      }
    }

    // LIFT：命名空間裡唯一的數字 18（子彈 / 障礙物判定用的高度差）
    if (ns.LIFT === undefined) {
      const n = vals.find(v => typeof v === 'number' && v === 18);
      if (n !== undefined) alias(ns, 'LIFT', n);
    }

    // 開局招式：遊戲自己的 startChoices / baseStartOf 也是用 Moves + DEX_BY 算的，
    // 直接照同樣的規則補上，省得再猜哪個匿名函數是哪個。
    if (ns.Moves && ns.DEX_BY && ns.Moves.startFor) {
      const base = dex => { const mon = ns.DEX_BY[dex]; return mon ? ns.Moves.startFor(mon) : null; };
      if (ns.baseStartOf === undefined) alias(ns, 'baseStartOf', base);
      if (ns.startChoices === undefined) alias(ns, 'startChoices', dex => {
        const mon = ns.DEX_BY[dex];
        if (!mon) return [];
        const pool = ns.Moves.poolFor(mon).filter(id => ns.Moves.BY_ID[id] && ns.Moves.BY_ID[id].kind !== 'buff');
        const s = base(dex);
        if (s && !pool.includes(s)) pool.push(s);
        return pool;
      });
    }
    return ns;
  }

  // ---------- 2. 設定 ----------
  const DEFAULTS = {
    on: false,
    move: true,        // 自動走位
    cards: true,       // 自動選升級卡
    bonds: true,       // 自動羈絆
    items: true,       // 自動選攜帶道具
    rift: true,        // 主動走進神祕裂縫（羈絆來源）
    orbs: true,        // 危急 / 首領戰自動用寶珠
    restart: true,     // 結束後自動再來一局
    noRank: true,      // 掛機的局不上排行榜
    upgrade: false,    // 回主選單時自動花金幣買「強化」（會花掉金幣，預設關）
    gacha: false,      // 回主選單時自動用抽獎券抽獎（預設關）
    autoPartner: false,// 回主選單時自動換成最強的寶可夢出戰（預設關）
    // 想養的寶可夢（圖鑑編號）：抽獎優先抽有牠們的地區，抽到就優先出戰。預設蓋歐卡、超夢（實測最強的兩隻）
    favorites: [382, 150],
    passiveFirst: true,// 被動強化 > 主動招式升級
    farm: true,        // 養怪：有範圍招時繞小圈讓怪擠成一團，範圍招一次打一大片（場上 ≥54 隻時新怪變精英，經驗 ×1.6）
    lead: false,       // 預判射擊（實戰會描邊，預設關：直接打怪現在的位置，配合「拉開距離 / 站樁」走位）
    focus: true,       // 集火：接管遊戲的「手動瞄準」，單體彈一次只打一隻，挑打得死的先收
    // 記錄模式：由你自己打，bot 完全不介入，只記錄你選了哪些卡 / 羈絆 / 道具、走位離怪多遠、血壓多低。
    // 停止記錄後，下一局開始自動判斷就會參考這些偏好（參數會一直累積，可匯出 / 匯入）
    record: false,
    // 走位 / 戰鬥的可調參數（原本硬寫在 steer()，現在全部進入知識圖譜，可學習 / 匯出 / 匯入）
    steer: {
      fearLow: null, fearMid: null, fearK: null,          // 由學習覆寫
      retreatDist: 120,    // 首領/彈幕迴避距離
      springHp: 0.6,       // 補血泉觸發血量
      farmMinEnemies: 54,  // 養怪最少怪數
      farmHpOn: 0.65,      // 養怪開啟血量
      farmHpOff: 0.45,     // 養怪關閉血量
      orbHp: 0.35,         // 寶珠使用血量
      healCardHp: 0.35,    // 補血卡門檻（備援）
      magnetBase: 78,      // 磁鐵基礎半徑
      xpWeight: 74, atkWeight: 60, cdWeight: 55,         // 選卡權重
    },
    // 知識圖譜（腦）：所有參數都是節點，關係是邊
    brain: { v: 1, nodes: {}, edges: [], updatedAt: 0 },
    // 每隻寶可夢的腦（per-Pokémon brain profiles）
    brains: {},   // { [dex]: brain }
    // 生存 / 獎勵 / BOSS 參數
    surv: { healUrgent: 0.25, orbDanger: 0.4, retreatBoss: 330, rewardSafeHp: 0.5, rewardSafeDist: 200 },
    boss: { prioritizeLowHp: true, prioritizeHighDmg: true, arceusFocus: false },
    reward: { coinPriority: 2, xpPriority: 1, ticketPriority: 9 },
    // 傳送門 / 風險決策參數
    portal: { enterHp: 0.7, enterDist: 300, riskTolerance: 0.5, rewardThreshold: 1.5, lateGameBonus: 2.0 },
    // AI 自主學習：bot 自己打時也記錄並更新腦（不只學人類）
    selfLearn: true,
    exploreRate: 0.05,
    // 選卡評分權重（原 STAT_PRI / KIND_PRI，現在可調 / 可學習）
    statPri: { xp: 74, atk: 60, cd: 55, def: 45, hp: 40, rgn: 35, mag: 25, spd: 15, heal: 5 },
    kindPri: { homing: 13, nova: 12, aura: 12, orbit: 11, chain: 10, projectile: 9, boomerang: 8, beam: 8, meteor: 8, turret: 7, mine: 6, cone: 6, melee: 4, dash: 3, trail: 3 },
    learn: {
      v: 2,             // v2：加入 outcome-aware 學習（依局數品質加權）
      runs: 0,          // 總共記錄了幾局
      picks: 0,         // 總共記錄了幾次選擇（卡 / 羈絆 / 道具）
      cards: {},        // 卡牌 key（type:id）→ { n: 被選次數, t: 出現次數 }
      bonds: {},        // 招式 id → { n, t }
      items: {},        // 道具 id → { n, t }
      move: { n: 0, hp: 0, dist: 0, min: null },   // 走位樣本：樣本數、血量總和、最近怪距離總和、單局最低血量
      heal: { n: 0, hp: 0 },                       // 你選「補血」卡當下的血量（用來推 bot 的補血門檻）
      // outcome-aware：每張卡/羈絆/道具的「價值」EMA（依該局品質加權），取代純計數偏好
      values: { cards: {}, bonds: {}, items: {} },
      // outcome-aware：走位參數的 EMA（由成功局推導），可手動鎖定
      params: { fearLow: null, fearMid: null, fearK: null, healThr: null,
                cardStr: null, bondStr: null, itemStr: null, locked: {} },
      // 局歷史（最近 30 局）：用來算品質趨勢與除錯
      history: [],
      // 死亡原因追蹤：{ boss: N, mob: N, projectile: N, hazard: N, unknown: N }
      deathCauses: { boss: 0, mob: 0, projectile: 0, hazard: 0, unknown: 0 },
      // 獎勵安全追蹤：每次撿獎勵的結果 { safe: N, unsafe: N, died: N }
      rewardSafety: { safe: 0, unsafe: 0, died: 0, totalHpLost: 0 },
      // 狀態條件參數：依狀態桶儲存恐懼參數 { [bucket]: { fearLow, fearMid, fearK, n } }
      stateParams: {},
      // 寶可夢強弱追蹤：{ [dex]: { runs, avgTime, avgLevel, avgKills, bestTime } }
      pokeStrength: {},
      // per-decision eligibility traces：最近的決策序列
      decisions: [],
      last: null,       // 最後一局 { at, time, level, kills }
      updatedAt: 0,
    },
    // 每隻寶可夢的畢業配置：招式依序學習、依序建立羈絆；item = 想要的攜帶道具
    profiles: {
      // 超夢：精神強念（12 發追蹤、穿透）排在詭計前面：念力 + 精神強念每秒輸出約是念力 + 詭計的 1.8 倍，
      // 綁上去養怪模式就開始；詭計最後綁，+65% 一樣乘到兩招上
      150: { moves: ['confusion', 'harden', 'psychic', 'nasty-plot'], item: 'shellbell' }, // 超夢
    },
    panelX: null, panelY: null, collapsed: false,
  };
  let cfg;
  try { cfg = Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(STORE_KEY) || '{}')); }
  catch { cfg = Object.assign({}, DEFAULTS); }
  cfg.profiles = Object.assign({}, DEFAULTS.profiles, cfg.profiles);
  // 記錄模式的參數：舊存檔沒有就補預設；缺欄位（或匯入別人的舊檔）也一併補齊
  cfg.learn = Object.assign({}, DEFAULTS.learn, cfg.learn || {});
  for (const k of ['cards', 'bonds', 'items']) cfg.learn[k] = Object.assign({}, cfg.learn[k] || {});
  cfg.learn.move = Object.assign({}, DEFAULTS.learn.move, cfg.learn.move || {});
  cfg.learn.heal = Object.assign({}, DEFAULTS.learn.heal, cfg.learn.heal || {});
  cfg.learn.values = Object.assign({ cards: {}, bonds: {}, items: {} }, cfg.learn.values || {});
  for (const k of ['cards', 'bonds', 'items']) cfg.learn.values[k] = Object.assign({}, cfg.learn.values[k] || {});
  cfg.learn.params = Object.assign({}, DEFAULTS.learn.params, cfg.learn.params || {});
  cfg.learn.params.locked = Object.assign({}, cfg.learn.params.locked || {});
  if (!Array.isArray(cfg.learn.history)) cfg.learn.history = [];
  if (!cfg.learn.deathCauses || typeof cfg.learn.deathCauses !== 'object') cfg.learn.deathCauses = { boss: 0, mob: 0, projectile: 0, hazard: 0, unknown: 0 };
  if (!cfg.learn.rewardSafety || typeof cfg.learn.rewardSafety !== 'object') cfg.learn.rewardSafety = { safe: 0, unsafe: 0, died: 0, totalHpLost: 0 };
  if (!cfg.learn.stateParams || typeof cfg.learn.stateParams !== 'object') cfg.learn.stateParams = {};
  if (!cfg.learn.pokeStrength || typeof cfg.learn.pokeStrength !== 'object') cfg.learn.pokeStrength = {};
  if (!Array.isArray(cfg.learn.decisions)) cfg.learn.decisions = [];
  cfg.steer = Object.assign({}, DEFAULTS.steer, cfg.steer || {});
  cfg.brain = Object.assign({ v: 1, nodes: {}, edges: [], updatedAt: 0 }, cfg.brain || {});
  if (!cfg.brain.nodes || typeof cfg.brain.nodes !== 'object') cfg.brain.nodes = {};
  if (!Array.isArray(cfg.brain.edges)) cfg.brain.edges = [];
  if (!cfg.brains || typeof cfg.brains !== 'object') cfg.brains = {};
  cfg.selfLearn = (cfg.selfLearn !== undefined) ? !!cfg.selfLearn : true;
  cfg.statPri = Object.assign({}, DEFAULTS.statPri, cfg.statPri || {});
  cfg.kindPri = Object.assign({}, DEFAULTS.kindPri, cfg.kindPri || {});
  cfg.surv = Object.assign({}, DEFAULTS.surv, cfg.surv || {});
  cfg.boss = Object.assign({}, DEFAULTS.boss, cfg.boss || {});
  cfg.reward = Object.assign({}, DEFAULTS.reward, cfg.reward || {});
  cfg.portal = Object.assign({}, DEFAULTS.portal, cfg.portal || {});
  // 舊版內建的妙蛙種子 / 蓋歐卡配置不符合「開局招式 → 變硬 → 劍舞 / 詭計 → 範圍攻擊」，存檔裡還是原樣的就刪掉，改走自動模式
  for (const [dex, old] of Object.entries({ 1: 'energy-ball,nasty-plot,leaf-storm,giga-drain', 382: 'bubble,nasty-plot,aqua-ring,hydro-pump' }))
    if (cfg.profiles[dex] && (cfg.profiles[dex].moves || []).join() === old) delete cfg.profiles[dex];
  // 存檔裡還是舊的超夢內建順序（詭計在精神強念前面）就換成新的；自己改過的不動
  if (cfg.profiles[150] && (cfg.profiles[150].moves || []).join() === 'confusion,harden,nasty-plot,psychic') cfg.profiles[150] = Object.assign({}, cfg.profiles[150], { moves: DEFAULTS.profiles[150].moves.slice() });
  const save = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(cfg)); } catch {} };

  const stats = { runs: 0, kills: 0, coins: 0, best: 0, startedAt: Date.now() };

  // ---------- 3. 主程式 ----------
  function boot(ns) {
    // 除錯用：放在 Symbol 下，不可列舉，避免 window 上的明字鍵名觸發偵測
    try { Object.defineProperty(window, Symbol.for('psbot.debug'), { value: { ns, cfg, stats, S, learn: { exportLearn, importLearnFile, mergeLearn, resetLearn, cardBias, bondBias, itemBias, learnedMove, fearModel, healThreshold }, brain: { buildBrain, adaptBrain, exportBrain, importBrainFile, brainGet, brainSet, PARAM_REGISTRY } }, configurable: true }); } catch {}
    log('namespace captured, version', VERSION);
    // 核心模組都認出來、DOM 也好了才 patch。其他模組晚一點就緒沒關係（用到的地方都有防護）。
    const need = ['Game', 'Input', 'RunUI', 'LevelUp', 'Moves', 'DEX_BY', 'UI', 'T'];
    let waited = 0;
    const wait = setInterval(() => {
      const missing = need.filter(k => ns[k] === undefined || ns[k] === null);
      if (!missing.length && document.body) {
        clearInterval(wait);
        patch(ns);
        buildPanel(ns);
        return;
      }
      // 形狀辨識沒認出核心模組：再試一次（有些模組可能晚一點才填好），5 秒後把缺的清單印出來
      if ((waited += 50) % 500 === 0) try { resolveNs(ns); } catch {}
      if (waited === 5000) console.warn('[PSBot] still waiting for modules:', missing.join(', ') || '(document.body)');
    }, 50);
  }

  const S = { pickTimer: null, lastPos: null, stuckT: 0, unstickT: 0, unstickDir: null, wanderA: Math.random() * 6.28, lastSlotCheck: 0, lastOrb: 0, lastT: performance.now(), overAt: -1e9, againAt: -1e9, lobbyAt: -1e9, coopFull: true, fullLogAt: -1e9, lastPlay: -1e9, pausedAt: 0, userPausedAt: -1e9, lastDir: null, lastOffer: null, orbGoal: null, plan: null, seen: {}, ban: {}, noGo: {}, jCenter: null, holding: false, holdKey: null, holdSince: 0, wd: null, losBadT: 0, spin: 1, spinBlockT: 0, loopC: null, dirIdx: -1, holdT: 0, out: [1, 0], rec: { cards: null, runActive: false, runMin: 1, saveAt: 0, player: null, dex: null, runCards: [], runBonds: [], runItems: [], runHpSum: 0, runHpN: 0, runDistSum: 0, runDistN: 0, runStartedAt: 0 }, recMsg: '', recMsgAt: 0 };

  function patch(ns) {
    // --- 走位：接管 Input.axis()，玩家自己按方向鍵時讓玩家優先 ---
    const origAxis = ns.Input.axis.bind(ns.Input);
    ns.Input.axis = function () {
      const manual = origAxis();
      if (manual && (manual[0] || manual[1])) return manual;
      // 記錄模式：走位完全交給你
      if (!cfg.on || !cfg.move || cfg.record) return manual;
      try { return steer(ns); } catch (e) { console.warn('[PSBot] steer', e); return manual; }
    };

    // --- 升級選卡 ---
    // 記住最後一次發的卡（重抽時 RunUI 會再呼叫 LevelUp.offer，這裡也順便記下重抽後的新卡）
    const origOffer = ns.LevelUp.offer;
    ns.LevelUp.offer = function () {
      const r = origOffer.apply(this, arguments);
      S.lastOffer = r;
      if (cfg.record && Array.isArray(r)) learnOffer('cards', r.map(c => c.key));
      return r;
    };
    const R = ns.RunUI;
    const origLevel = R.showLevelUp;
    R.showLevelUp = function (level, cards, cb, coop) {
      const r = origLevel.apply(this, arguments);
      if (cfg.record) {
        // 記錄模式：不動手，只記下這次發了哪些卡；你按了哪張由下面的 pick 攔截
        S.rec.cards = cards;
        S.lastOffer = cards;
      } else if (cfg.on && cfg.cards) schedule(() => chooseCard(ns, cards), 700);
      return r;
    };
    const origPick = R.pick;
    R.pick = function (i) {
      if (cfg.record) {
        // 重抽後 S.lastOffer 才是畫面上真正顯示的卡
        const list = S.lastOffer || S.rec.cards;
        const c = list && list[i];
        if (c) {
          const p = ns.Game.player;
          learnPick('cards', c.key, p ? p.hp / p.maxHp : null);
        }
        S.rec.cards = null;
      }
      return origPick.apply(this, arguments);
    };

    // --- 羈絆 ---
    const origBond = R.showBond;
    R.showBond = function (opt, cb) {
      if (cfg.record) {
        // 你選完後遊戲會把選中的招式陣列交給 cb，在這裡攔下來記錄（pair 模式會是兩個）
        learnOffer('bonds', opt.loose.map(m => m.id));
        const wrapped = function (picked) {
          learnPicks('bonds', (picked || []).map(m => m.id));
          return cb.apply(this, arguments);
        };
        return origBond.call(this, opt, wrapped);
      }
      const r = origBond.apply(this, arguments);
      if (cfg.on && cfg.bonds) schedule(() => chooseBond(ns, opt), 700);
      return r;
    };

    // --- 攜帶道具二選一 ---
    const origItem = R.showItemChoice;
    R.showItemChoice = function (cur, next, cb) {
      if (cfg.record) {
        learnOffer('items', [cur, next]);
        const wrapped = function (picked) {
          learnPick('items', picked);
          return cb.apply(this, arguments);
        };
        return origItem.call(this, cur, next, wrapped);
      }
      const r = origItem.apply(this, arguments);
      if (cfg.on && cfg.items) schedule(() => {
        const keep = itemRank(ns, cur) <= itemRank(ns, next);
        if (cfg.selfLearn && cfg.on) { const chosen = keep ? cur : next; if (!S.rec.runItems.includes(chosen)) S.rec.runItems.push(chosen); }
        const el = document.querySelectorAll('#item-cards .card')[keep ? 0 : 1];
        el && el.click();
      }, 700);
      return r;
    };

    // --- 結算 / 自動再來一局 ---
    const origOver = R.showOver;
    R.showOver = function (d) {
      // 記錄模式 或 自主學習：這一局算一局樣本
      if (cfg.record || (cfg.on && cfg.selfLearn)) finishLearnRun(d);
      const r = origOver.apply(this, arguments);
      if (cfg.on) {
        stats.runs++; stats.kills += d.kills || 0; stats.coins += d.coins || 0;
        stats.best = Math.max(stats.best, d.time || 0);
        log(`run #${stats.runs}: ${Math.round(d.time)}s lv${d.level} kills ${d.kills} coins ${d.coins}`);
        // 結算畫面幾秒後就被自動重開蓋掉：存一份到設定裡（保留最近 20 局），面板上隨時看得到
        const j = d.judge;
        cfg.history = [{ at: Date.now(), dex: ns.Game.player && ns.Game.player.dex, time: d.time, level: d.level, kills: d.kills, bosses: d.bosses, coins: d.coins, record: !!d.record,
          judge: j ? { time: j.time, bosses: j.bosses, dmg: j.dmg } : null }].concat(cfg.history || []).slice(0, 20);
        save();
        S.overAt = now();
      }
      return r;
    };

    // --- 掛機局不上排行榜 ---
    if (ns.Ranking) for (const k of ['submitSolo', 'submitGroup']) {
      const orig = ns.Ranking[k];
      if (typeof orig !== 'function') continue;
      ns.Ranking[k] = function () {
        if (cfg.on && cfg.noRank) { log('ranking submit skipped'); return Promise.resolve(null); }
        return orig.apply(this, arguments);
      };
    }

    trackHazards(ns);

    // --- 每 200ms 的雜務：切換主動欄位、用寶珠、自動再開一局、被暫停就繼續 ---
    // coopFull：多人第一次開局要等房間滿。關掉 bot 就重置，下次開啟重新要求滿房。
    setInterval(() => {
      // 記錄模式：只取樣人類的走位，其他自動功能全部停手（由你自己打）
      if (cfg.record) { try { sampleHuman(ns); } catch (e) { console.warn('[PSBot] record', e); } return; }
      if (!cfg.on) { S.coopFull = true; return; }
      // per-Pokémon brain switch (runs regardless of selfLearn)
      try {
        const p = ns.Game.player;
        if (p && p.dex != null && S.rec.dex != null && S.rec.dex !== p.dex) {
          cfg.brains[S.rec.dex] = JSON.parse(JSON.stringify(cfg.brain));
          if (cfg.brains[p.dex]) cfg.brain = cfg.brains[p.dex];
          else { cfg.brain = { v: 1, nodes: {}, edges: [], updatedAt: 0 }; buildBrain(); }
          save();
          log('brain switched: ' + S.rec.dex + ' -> ' + p.dex);
        }
        if (p && p.dex != null) S.rec.dex = p.dex;
      } catch (e) {}
      // 自主學習：bot 自己打時也追蹤本局選擇與走位（供 finishLearnRun 使用）
      if (cfg.selfLearn) {
        try {
          const p = ns.Game.player;
          if (p && S.rec.player !== p) {
            S.rec.player = p; S.rec.runMin = 1;
            S.rec.runCards = []; S.rec.runBonds = []; S.rec.runItems = [];
            S.rec.runHpSum = 0; S.rec.runHpN = 0; S.rec.runDistSum = 0; S.rec.runDistN = 0;
            S.rec.runStartedAt = Date.now();
            // per-Pokémon brain switch
            try {
              const newDex = p.dex;
              if (S.rec.dex != null && S.rec.dex !== newDex) {
                // save current brain under old dex
                cfg.brains[S.rec.dex] = JSON.parse(JSON.stringify(cfg.brain));
                // load new dex brain or create
                if (cfg.brains[newDex]) {
                  cfg.brain = cfg.brains[newDex];
                } else {
                  cfg.brain = { v: 1, nodes: {}, edges: [], updatedAt: 0 };
                  buildBrain();
                }
                save();
                log('brain switched: ' + S.rec.dex + ' -> ' + newDex);
              }
              S.rec.dex = newDex;
            } catch (e) { console.warn('[PSBot] brain switch', e); }
          }
          if (p && !p.dead && ns.Game.state === 'playing') {
            const hp = Math.max(0, Math.min(1, p.hp / p.maxHp));
            if (hp < S.rec.runMin) S.rec.runMin = hp;
            S.rec.runHpSum += hp; S.rec.runHpN++;
            let d = 400;
            for (const e of ns.EnemyMgr.all()) {
              if (e.dead || e.silent || e.behavior === 'thief') continue;
              const dd = Math.hypot(e.x - p.x, e.y - p.y);
              if (dd < d) d = dd;
            }
            S.rec.runDistSum += d; S.rec.runDistN++;
          }
        } catch (e) {}
      }
      try {
        // 已經進場（不管是 bot 開的還是你手動開的）→ 這一輪就沿用這個組合，之後不再要求滿房
        if (ns.Room && ns.Room.room && ns.Game.state === 'playing') S.coopFull = false;
        housekeeping(ns); autoGacha(ns); autoPartner(ns); autoUpgrade(ns); autoRestart(ns); autoResume(ns);
      } catch (e) { console.warn('[PSBot] tick', e); }
    }, 200);
    log('patched');
  }

  function schedule(fn, ms) { setTimeout(() => { try { fn(); } catch (e) { console.warn('[PSBot]', e); } }, ms); }

  // ---------- 3b. 記錄模式：從人類的選擇 / 走位學參數 ----------
  // 卡牌 / 羈絆 / 道具用「偏好計數」：同一張卡出現 t 次、被人類選了 n 次，
  // 用 Laplace 平滑算偏好率（0.5 = 沒偏好），再換算成分數微調；樣本少於 3 次不影響判斷。
  // 走位只記平均值（血量、最近怪距離）與單局最低血量，換算成「恐懼係數」與補血門檻。
  const LEARN_BAGS = ['cards', 'bonds', 'items'];

  function learnOffer(bag, keys) {
    const B = cfg.learn[bag] || (cfg.learn[bag] = {});
    for (const k of new Set(keys.filter(Boolean))) {
      const e = B[k] || (B[k] = { n: 0, t: 0 });
      e.t++;
    }
    cfg.learn.updatedAt = Date.now();
  }
  function learnPick(bag, key, hp) {
    if (!key) return;
    const B = cfg.learn[bag] || (cfg.learn[bag] = {});
    const e = B[key] || (B[key] = { n: 0, t: 0 });
    e.n++;
    // 你選補血卡當下的血量：這是最直接的「什麼時候該補」訊號
    if (bag === 'cards' && key === 'stat:heal' && typeof hp === 'number' && isFinite(hp)) {
      const H = cfg.learn.heal;
      H.n++; H.hp += Math.max(0, Math.min(1, hp));
    }
    // 追蹤本局選了哪些（供 outcome-aware 學習）
    const arr = bag === 'cards' ? S.rec.runCards : bag === 'bonds' ? S.rec.runBonds : S.rec.runItems;
    if (arr && !arr.includes(key)) arr.push(key);
    cfg.learn.picks++;
    cfg.learn.updatedAt = Date.now();
  }
  function learnPicks(bag, keys) { for (const k of keys) learnPick(bag, k); }
  // 偏好率 -0.5 ~ +0.5（出現次數太少就當作沒意見）
  function prefOf(bag, key) {
    const e = cfg.learn[bag] && cfg.learn[bag][key];
    if (!e || (e.t | 0) < 3) return 0;
    return (e.n + 1) / (e.t + 2) - 0.5;
  }
  // outcome-aware 偏好：若有足夠的品質加權樣本，用 value EMA；否則退回計數偏好
  function valPref(bag, key) {
    const e = cfg.learn.values && cfg.learn.values[bag] && cfg.learn.values[bag][key];
    if (!e || (e.n | 0) < 3) return null;
    return e.v - 0.5;   // -0.5 ~ +0.5
  }
  function cardBias(key) {
    const vp = valPref('cards', key);
    const base = vp != null ? vp : prefOf('cards', key);
    const str = (cfg.learn.params && cfg.learn.params.cardStr != null) ? cfg.learn.params.cardStr : 400;
    return base * str;
  }
  function bondBias(id) {
    const vp = valPref('bonds', id);
    const base = vp != null ? vp : prefOf('bonds', id);
    const str = (cfg.learn.params && cfg.learn.params.bondStr != null) ? cfg.learn.params.bondStr : 6;
    return base * str;
  }
  function itemBias(id) {
    const vp = valPref('items', id);
    const base = vp != null ? vp : prefOf('items', id);
    const str = (cfg.learn.params && cfg.learn.params.itemStr != null) ? cfg.learn.params.itemStr : 6;
    return base * str;
  }

  // 每 200ms 取樣一次人類的走位（升級 / 選卡畫面遊戲會暫停，那段不算，但不會中斷這一局的統計）
  function sampleHuman(ns) {
    const p = ns.Game.player;
    if (!p) return;
    // per-Pokémon brain switch
    try {
      if (S.rec.dex != null && S.rec.dex !== p.dex) {
        cfg.brains[S.rec.dex] = JSON.parse(JSON.stringify(cfg.brain));
        if (cfg.brains[p.dex]) cfg.brain = cfg.brains[p.dex];
        else { cfg.brain = { v: 1, nodes: {}, edges: [], updatedAt: 0 }; buildBrain(); }
        save();
      }
      S.rec.dex = p.dex;
    } catch (e) {}
    // 換局（新的 player 物件）就重新計算單局最低血量與本局統計
    if (S.rec.player !== p) {
      S.rec.player = p; S.rec.runMin = 1;
      S.rec.runCards = []; S.rec.runBonds = []; S.rec.runItems = [];
      S.rec.runHpSum = 0; S.rec.runHpN = 0; S.rec.runDistSum = 0; S.rec.runDistN = 0;
    }
    const hp = Math.max(0, Math.min(1, p.hp / p.maxHp));
    if (hp < S.rec.runMin) S.rec.runMin = hp;
    // 本局統計
    S.rec.runHpSum += hp; S.rec.runHpN++;
    if (p.dead || ns.Game.state !== 'playing') return;
    let d = 400;   // 最近的怪（小偷不會打人，不算）
    for (const e of ns.EnemyMgr.all()) {
      if (e.dead || e.silent || e.behavior === 'thief') continue;
      const dd = Math.hypot(e.x - p.x, e.y - p.y);
      if (dd < d) d = dd;
    }
    const M = cfg.learn.move;
    M.n++; M.hp += hp; M.dist += d;
    S.rec.runDistSum += d; S.rec.runDistN++;
    cfg.learn.updatedAt = Date.now();
    // 每 5 秒存一次，瀏覽器當掉也只掉幾秒的樣本
    const t = performance.now();
    if (t - (S.rec.saveAt || 0) > 5000) { S.rec.saveAt = t; save(); }
  }
  // 死亡原因偵測：分析死亡時的遊戲狀態
  function detectDeathCause(ns, d) {
    if (!d.dead) return 'survived';
    try {
      const p = ns.Game.player;
      const judging = !!(ns.Judgment && ns.Judgment.active);
      // 檢查周圍敵人
      let nearBoss = false, nearMob = false, nearProjectile = false;
      for (const e of ns.EnemyMgr.all()) {
        if (e.dead) continue;
        const dd = Math.hypot(e.x - p.x, e.y - p.y);
        if (dd < 100) {
          if (e.boss || e.arceus) nearBoss = true;
          else nearMob = true;
        }
      }
      // 檢查是否有地面預警/彈幕
      // (簡化：如果 HP 非常低且周圍有 boss → boss kill)
      if (nearBoss) return 'boss';
      if (nearMob) return 'mob';
      // 檢查是否在審判中
      if (judging) return 'projectile';
      // 檢查 HP 是否極低（可能被彈幕/地面預警擊殺）
      if (p && p.hp <= 0) {
        // 如果周圍沒有敵人，可能是遠程攻擊
        let anyNear = false;
        for (const e of ns.EnemyMgr.all()) {
          if (!e.dead && Math.hypot(e.x - p.x, e.y - p.y) < 200) { anyNear = true; break; }
        }
        if (!anyNear) return 'projectile';
      }
      return 'unknown';
    } catch (e) { return 'unknown'; }
  }

  // 局品質：存活時間（秒）為主，加上等級/擊倒加權；正規化到 0~1（以 300 秒為滿分）
  function runQuality(d) {
    const t = Math.max(0, Math.min(300, d.time || 0));
    const lvl = Math.max(0, d.level || 0);
    const kills = Math.max(0, d.kills || 0);
    const raw = t + lvl * 3 + Math.min(kills, 200) * 0.3;
    return Math.max(0.05, Math.min(1, raw / 330));
  }
  function finishLearnRun(d) {
    const L = cfg.learn;
    const q = runQuality(d);
    // 本局平均走位
    const avgHp = S.rec.runHpN > 0 ? S.rec.runHpSum / S.rec.runHpN : null;
    const avgDist = S.rec.runDistN > 0 ? S.rec.runDistSum / S.rec.runDistN : null;
    const deathCause = detectDeathCause(ns, d);
    L.runs++;
    // 死亡原因追蹤
    if (d.dead && L.deathCauses) {
      const c = deathCause in L.deathCauses ? deathCause : 'unknown';
      L.deathCauses[c] = (L.deathCauses[c] || 0) + 1;
    }
    // 獎勵安全追蹤：minHp 低表示冒險撿獎勵
    if (L.rewardSafety) {
      if (S.rec.runMin != null && S.rec.runMin < 0.2) L.rewardSafety.unsafe++;
      else L.rewardSafety.safe++;
      if (d.dead) L.rewardSafety.died++;
      L.rewardSafety.totalHpLost += (1 - (S.rec.runMin || 1));
    }
    // 寶可夢強弱追蹤
    const dex = S.rec.dex || (ns.Game.player && ns.Game.player.dex);
    if (dex != null) {
      if (!L.pokeStrength[dex]) L.pokeStrength[dex] = { runs: 0, avgTime: 0, avgLevel: 0, avgKills: 0, bestTime: 0 };
      const ps = L.pokeStrength[dex];
      ps.runs++;
      ps.avgTime = ps.avgTime * 0.8 + (d.time || 0) * 0.2;
      ps.avgLevel = ps.avgLevel * 0.8 + (d.level || 0) * 0.2;
      ps.avgKills = ps.avgKills * 0.8 + (d.kills || 0) * 0.2;
      if ((d.time || 0) > ps.bestTime) ps.bestTime = d.time || 0;
    }
    if (S.rec.runMin != null) {
      const M = L.move;
      M.min = M.min == null ? S.rec.runMin : M.min * 0.7 + S.rec.runMin * 0.3;
    }
    // outcome-aware：更新 values（EMA，以局品質為權重）
    const lr = 0.15;   // 學習率
    const updateVal = (bag, key) => {
      const V = L.values[bag] || (L.values[bag] = {});
      const e = V[key] || (V[key] = { v: 0.5, n: 0 });
      // 沒品質資訊就不動；品質高就拉向 1，品質低就拉向 0
      e.v += lr * (q - e.v);
      e.n++;
    };
    for (const k of S.rec.runCards) updateVal('cards', k);
    for (const k of S.rec.runBonds) updateVal('bonds', k);
    for (const k of S.rec.runItems) updateVal('items', k);
    // 狀態條件參數：依狀態桶儲存恐懼參數
    const stateBucket = (avgHp != null) ? (avgHp < 0.4 ? 'low' : avgHp < 0.7 ? 'mid' : 'high') + (ns.Judgment && ns.Judgment.active ? '_boss' : '') : null;
    if (stateBucket && avgHp != null && q > 0.3) {
      if (!L.stateParams[stateBucket]) L.stateParams[stateBucket] = { fearLow: null, fearMid: null, fearK: null, n: 0 };
      const sp = L.stateParams[stateBucket];
      const targetLow = Math.max(0.2, Math.min(0.5, avgHp * 0.55));
      const targetMid = Math.max(0.45, Math.min(0.75, avgHp * 0.9));
      const targetK = Math.max(0.7, Math.min(1.4, 0.9 + ((avgDist || 140) - 140) / 400));
      sp.fearLow = sp.fearLow == null ? targetLow : sp.fearLow * 0.85 + targetLow * 0.15;
      sp.fearMid = sp.fearMid == null ? targetMid : sp.fearMid * 0.85 + targetMid * 0.15;
      sp.fearK = sp.fearK == null ? targetK : sp.fearK * 0.85 + targetK * 0.15;
      sp.n++;
    }
    // outcome-aware：走位參數 EMA（品質加權：品質高才更新，避免學壞習慣）
    if (avgHp != null && q > 0.3) {
      const P = L.params;
      if (!(P.locked && P.locked.fearLow)) P.fearLow = P.fearLow == null ? Math.max(0.2, Math.min(0.5, avgHp * 0.55)) : P.fearLow * 0.85 + Math.max(0.2, Math.min(0.5, avgHp * 0.55)) * 0.15;
      if (!(P.locked && P.locked.fearMid)) P.fearMid = P.fearMid == null ? Math.max(0.45, Math.min(0.75, avgHp * 0.9)) : P.fearMid * 0.85 + Math.max(0.45, Math.min(0.75, avgHp * 0.9)) * 0.15;
      if (!(P.locked && P.locked.fearK)) P.fearK = P.fearK == null ? Math.max(0.7, Math.min(1.4, 0.9 + ((avgDist || 140) - 140) / 400)) : P.fearK * 0.85 + Math.max(0.7, Math.min(1.4, 0.9 + ((avgDist || 140) - 140) / 400)) * 0.15;
    }
    if (S.rec.runMin != null && q > 0.3) {
      const P = L.params;
      const target = Math.max(0.25, Math.min(0.6, (S.rec.runMin || 0.35) * 1.1));
      if (!(P.locked && P.locked.healThr)) P.healThr = P.healThr == null ? target : P.healThr * 0.85 + target * 0.15;
    }
    // 知識圖譜：Hebbian + 獎勵調變更新
    const activeIds = []
      .concat(S.rec.runCards.map(k => 'pref:cards:' + k))
      .concat(S.rec.runBonds.map(k => 'pref:bonds:' + k))
      .concat(S.rec.runItems.map(k => 'pref:items:' + k))
      .concat(['steer.fearLow', 'steer.fearMid', 'steer.fearK', 'learn.healThr', 'steer.orbHp']);
    try { adaptBrain(q, activeIds); } catch (e) { console.warn('[PSBot] adaptBrain', e); }
    // 局歷史
    if (!Array.isArray(L.history)) L.history = [];
    L.history.push({ at: Date.now(), time: d.time || 0, level: d.level || 0, kills: d.kills || 0, q,
      minHp: S.rec.runMin, avgHp, avgDist, cards: S.rec.runCards.slice(), bonds: S.rec.runBonds.slice(), items: S.rec.runItems.slice(),
      bosses: d.bosses || 0, coins: d.coins || 0, dead: !!d.dead, breakdown: d.breakdown || '' });
    if (L.history.length > 30) L.history = L.history.slice(-30);
    S.rec.player = null;
    S.rec.runActive = false;
    S.rec.runCards = []; S.rec.runBonds = []; S.rec.runItems = [];
    S.rec.runHpSum = 0; S.rec.runHpN = 0; S.rec.runDistSum = 0; S.rec.runDistN = 0;
    L.last = { at: Date.now(), time: d.time || 0, level: d.level || 0, kills: d.kills || 0 };
    L.updatedAt = Date.now();
    save();
    log(`record: run ${L.runs} · min HP ${Math.round((S.rec.runMin || 0) * 100)}% · quality ${Math.round(q * 100)}`);
  }
  // 人類的平均走位（樣本夠才回傳；200 筆 = 約 40 秒）
  function learnedMove() {
    const M = cfg.learn.move;
    if (!M || (M.n | 0) < 200) return null;
    return { hp: M.hp / M.n, dist: Math.min(400, M.dist / M.n), min: M.min };
  }
  // 補血卡門檻：優先用 outcome-aware 參數；其次看你選補血卡時的血量；再來是你平常的血量
  // 死亡原因影響：如果經常被 mob 殺死，降低補血門檻
  function healThreshold() {
    const L = cfg.learn;
    let base = 0.35;
    if (L && L.deathCauses) {
      const total = Object.values(L.deathCauses).reduce((a, b) => a + b, 0);
      if (total > 0 && (L.deathCauses.mob || 0) / total > 0.5) base = 0.25; // 經常被 mob 殺，更早補血
      if (total > 0 && (L.deathCauses.boss || 0) / total > 0.5) base = 0.4;  // 經常被 boss 殺，稍微更早補血
    }
    const P = cfg.learn.params;
    if (P && typeof P.healThr === 'number' && isFinite(P.healThr) && !(P.locked && P.locked.healThr)) return P.healThr;
    if (P && typeof P.healThr === 'number' && isFinite(P.healThr)) return P.healThr;
    const H = cfg.learn.heal;
    if (H && (H.n | 0) >= 2) return Math.max(0.25, Math.min(0.6, H.hp / H.n + 0.05));
    const lm = learnedMove();
    return lm ? Math.max(0.25, Math.min(0.6, lm.hp * 0.6)) : base;
  }
  // 恐懼模型：人類平均血量高 / 站得遠 = 保守，門檻上移、恐懼放大；反過來就放寬
  function fearModel() {
    const P = cfg.learn.params;
    const lm = learnedMove();
    // 狀態條件：依當前 HP 和 boss 狀態選擇 bucket
    const p = ns.Game.player;
    const hpPct = p ? p.hp / p.maxHp : 0.5;
    const bucket = (hpPct < 0.4 ? 'low' : hpPct < 0.7 ? 'mid' : 'high') + (ns.Judgment && ns.Judgment.active ? '_boss' : '');
    const sp = cfg.learn.stateParams && cfg.learn.stateParams[bucket];
    let low = 0.35, mid = 0.6, k = 1;
    if (sp && sp.n >= 2) {
      if (typeof sp.fearLow === 'number') low = sp.fearLow;
      if (typeof sp.fearMid === 'number') mid = sp.fearMid;
      if (typeof sp.fearK === 'number') k = sp.fearK;
    } else if (lm) {
      const shift = Math.max(-0.12, Math.min(0.12, (lm.hp - 0.65) * 0.4));
      low = 0.35 + shift; mid = 0.6 + shift;
      k = Math.max(0.7, Math.min(1.4, 0.9 + (lm.dist - 140) / 400 + (lm.hp - 0.65) * 0.8));
    }
    // outcome-aware 參數覆寫（若已學到且未鎖定）
    if (P) {
      if (typeof P.fearLow === 'number' && isFinite(P.fearLow)) low = P.fearLow;
      if (typeof P.fearMid === 'number' && isFinite(P.fearMid)) mid = P.fearMid;
      if (typeof P.fearK === 'number' && isFinite(P.fearK)) k = P.fearK;
    }
    return { low, mid, k };
  }

  function learnMsg(t) { S.recMsg = t; S.recMsgAt = performance.now(); log(t); }
  // 匯出：下載一份 JSON，可以給別人匯入
  function exportLearn() {
    try {
      const data = { app: 'psbot', kind: 'learn', v: 2, at: new Date().toISOString(), learn: cfg.learn };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `psbot-learn-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      learnMsg(`已匯出參數（${cfg.learn.runs} 局）`);
    } catch (e) { learnMsg('匯出失敗：' + e.message); }
  }
  // 匯入：和現有參數「合併」，次數相加，所以可以一直累積
  function mergeLearn(src) {
    const L = cfg.learn;
    const num = v => (typeof v === 'number' && isFinite(v) ? Math.max(0, v) : 0);
    L.runs += num(src.runs);
    L.picks += num(src.picks);
    for (const bag of LEARN_BAGS) {
      const dst = L[bag] || (L[bag] = {});
      for (const [k, v] of Object.entries(src[bag] || {})) {
        if (!v || typeof v !== 'object') continue;
        const e = dst[k] || (dst[k] = { n: 0, t: 0 });
        e.n += num(v.n); e.t += num(v.t);
      }
    }
    const m = src.move;
    if (m && typeof m === 'object' && num(m.n) > 0) {
      const n = num(m.n), M = L.move;
      M.hp += num(m.hp); M.dist += num(m.dist);
      if (typeof m.min === 'number' && isFinite(m.min)) {
        const oldN = M.n | 0;
        M.min = M.min == null ? m.min : (M.min * oldN + m.min * n) / (oldN + n);
      }
      M.n += n;
    }
    const h = src.heal;
    if (h && typeof h === 'object' && num(h.n) > 0) {
      L.heal.n += num(h.n); L.heal.hp += num(h.hp);
    }
    // outcome-aware values: merge EMA (weighted by sample counts)
    const V = src.values;
    if (V && typeof V === 'object') {
      for (const bag of LEARN_BAGS) {
        const dv = L.values[bag] || (L.values[bag] = {});
        for (const [k, v] of Object.entries(V[bag] || {})) {
          if (!v || typeof v !== 'object') continue;
          const e = dv[k] || (dv[k] = { v: 0, n: 0 });
          const nv = num(v.n);
          // weighted average of value estimates
          const total = (e.n | 0) + nv;
          if (total > 0) e.v = (e.v * (e.n | 0) + (v.v || 0) * nv) / total;
          e.n = total;
        }
      }
    }
    // params: keep local unless local is null (import fills gaps); locked wins
    const P = src.params;
    if (P && typeof P === 'object') {
      for (const key of ['fearLow', 'fearMid', 'fearK', 'healThr', 'cardStr', 'bondStr', 'itemStr']) {
        if (L.params.locked && L.params.locked[key]) continue;
        if (L.params[key] == null && typeof P[key] === 'number' && isFinite(P[key])) L.params[key] = P[key];
      }
      if (P.locked && typeof P.locked === 'object') Object.assign(L.params.locked, P.locked);
    }
    // history: concat, keep last 30
    if (Array.isArray(src.history)) {
      L.history = (L.history || []).concat(src.history).slice(-30);
    }
    if (src.last && typeof src.last === 'object') {
      const n = v => (typeof v === 'number' && isFinite(v) ? v : 0);
      L.last = { at: n(src.last.at) || Date.now(), time: n(src.last.time), level: n(src.last.level), kills: n(src.last.kills) };
    }
    L.updatedAt = Date.now();
  }
  function importLearnFile(file) {
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const d = JSON.parse(String(rd.result));
        const src = d && d.learn ? d.learn : (d && d.cards ? d : null);
        if (!src || typeof src !== 'object') throw new Error('不是 PSBot 參數檔');
        mergeLearn(src);
        save();
        learnMsg(`已匯入：累計 ${cfg.learn.runs} 局`);
      } catch (e) { learnMsg('匯入失敗：' + e.message); }
    };
    rd.onerror = () => learnMsg('讀取檔案失敗');
    rd.readAsText(file);
  }
  function resetLearn() {
    cfg.learn = JSON.parse(JSON.stringify(DEFAULTS.learn));
    save();
    learnMsg('已清除學習參數');
  }

  // ---------- 3c. 知識圖譜（腦）：所有參數都是節點，關係是邊 ----------
  // 參數註冊表：每一個可調參數（cfg / learn / steer）都是知識圖譜的一個節點。
  // humanTrackable: 是否能從人類遊玩中自動推導；humanSource: 推導來源欄位。
  const PARAM_REGISTRY = [
    // --- 核心開關 ---
    { id: 'cfg.on', label: 'bot 開關', cat: 'core', type: 'bool', def: false, desc: '總開關' },
    { id: 'cfg.move', label: '自動走位', cat: 'core', type: 'bool', def: true, desc: '接管移動' },
    { id: 'cfg.cards', label: '自動選卡', cat: 'core', type: 'bool', def: true, desc: '升級選卡' },
    { id: 'cfg.bonds', label: '自動羈絆', cat: 'core', type: 'bool', def: true, desc: '羈絆選擇' },
    { id: 'cfg.items', label: '自動道具', cat: 'core', type: 'bool', def: true, desc: '攜帶道具' },
    { id: 'cfg.rift', label: '自動進裂縫', cat: 'core', type: 'bool', def: true, desc: '羈絆來源' },
    { id: 'cfg.orbs', label: '自動用寶珠', cat: 'core', type: 'bool', def: true, desc: '危急/首領' },
    { id: 'cfg.restart', label: '自動再來', cat: 'core', type: 'bool', def: true, desc: '結束後重開' },
    { id: 'cfg.noRank', label: '不上排行榜', cat: 'core', type: 'bool', def: true, desc: '掛機不上榜' },
    { id: 'cfg.farm', label: '養怪模式', cat: 'core', type: 'bool', def: true, desc: '繞圈聚怪' },
    { id: 'cfg.focus', label: '集火瞄準', cat: 'core', type: 'bool', def: true, desc: '單體優先' },
    { id: 'cfg.passiveFirst', label: '被動優先', cat: 'core', type: 'bool', def: true, desc: '被動>招式' },
    { id: 'cfg.record', label: '記錄模式', cat: 'core', type: 'bool', def: false, desc: '人類示範' },
    { id: 'cfg.selfLearn', label: '自主學習', cat: 'core', type: 'bool', def: true, desc: 'bot 自己學' },
    { id: 'cfg.exploreRate', label: '探索率', cat: 'brain', type: 'number', def: 0.05, min: 0, max: 0.3, step: 0.01, desc: 'epsilon-greedy 探索' },
    // --- 生存 / 獎勵 / BOSS ---
    { id: 'surv.healUrgent', label: '緊急補血線', cat: 'survival', type: 'number', def: 0.25, min: 0.1, max: 0.5, step: 0.01, desc: '低於此血量最優先補血' },
    { id: 'surv.orbDanger', label: '寶珠危險線', cat: 'survival', type: 'number', def: 0.4, min: 0.1, max: 0.7, step: 0.05, desc: '低於此血量用寶珠' },
    { id: 'surv.retreatBoss', label: 'BOSS迴避距離', cat: 'survival', type: 'number', def: 330, min: 200, max: 500, step: 10, desc: 'BOSS接近時保持距離' },
    { id: 'surv.rewardSafeHp', label: '撿獎勵最低血量', cat: 'survival', type: 'number', def: 0.5, min: 0.2, max: 0.8, step: 0.05, desc: '血量低於此不撿獎勵' },
    { id: 'surv.rewardSafeDist', label: '撿獎勵安全距離', cat: 'survival', type: 'number', def: 200, min: 100, max: 400, step: 10, desc: '周圍敵人距離超過此值才撿' },
    { id: 'boss.prioritizeLowHp', label: '優先低血BOSS', cat: 'boss', type: 'bool', def: true, desc: '優先攻擊血量最低的BOSS' },
    { id: 'boss.prioritizeHighDmg', label: '優先高傷BOSS', cat: 'boss', type: 'bool', def: true, desc: '優先攻擊傷害最高的BOSS' },
    { id: 'boss.arceusFocus', label: '阿爾宙斯優先', cat: 'boss', type: 'bool', def: false, desc: '審判時優先打阿爾宙斯' },
    { id: 'reward.coinPriority', label: '金幣優先度', cat: 'reward', type: 'number', def: 2, min: 0, max: 5, step: 0.5, desc: '金幣拾取優先度' },
    { id: 'reward.xpPriority', label: '經驗優先度', cat: 'reward', type: 'number', def: 1, min: 0, max: 5, step: 0.5, desc: '經驗球拾取優先度' },
    { id: 'reward.ticketPriority', label: '抽獎券優先度', cat: 'reward', type: 'number', def: 9, min: 0, max: 15, step: 1, desc: '抽獎券拾取優先度' },
    // 傳送門 / 風險決策
    { id: 'portal.enterHp', label: '進入傳送門血量', cat: 'portal', type: 'number', def: 0.7, min: 0.3, max: 1.0, step: 0.05, desc: '血量高於此才進傳送門' },
    { id: 'portal.enterDist', label: '傳送門安全距離', cat: 'portal', type: 'number', def: 300, min: 100, max: 500, step: 10, desc: '周圍敵人距離超過此值才進' },
    { id: 'portal.riskTolerance', label: '風險容忍度', cat: 'portal', type: 'number', def: 0.5, min: 0, max: 1, step: 0.05, desc: '高風險高回報決策閾值' },
    { id: 'portal.rewardThreshold', label: '獎勵門檻', cat: 'portal', type: 'number', def: 1.5, min: 0.5, max: 5, step: 0.1, desc: '預期獎勵超過此值才冒險' },
    { id: 'portal.lateGameBonus', label: '後期加成', cat: 'portal', type: 'number', def: 2.0, min: 1, max: 5, step: 0.1, desc: '後期（>20min）進入傳送門的回報加成' },
    // 死亡/獎勵學習參數
    { id: 'surv.deathBossPenalty', label: 'BOSS死亡懲罰', cat: 'survival', type: 'number', def: 0.5, min: 0, max: 1, step: 0.1, desc: '被BOSS殺死時的學習懲罰' },
    { id: 'surv.deathMobPenalty', label: '小怪死亡懲罰', cat: 'survival', type: 'number', def: 0.3, min: 0, max: 1, step: 0.1, desc: '被小怪殺死時的學習懲罰' },
    // --- 移動 / 戰鬥 ---
    { id: 'steer.fearLow', label: '恐懼門檻(低血)', cat: 'movement', type: 'number', def: 0.35, min: 0.15, max: 0.6, step: 0.01, humanTrackable: true, humanSource: 'learn.params.fearLow', desc: '低血量時恐懼係數切換點' },
    { id: 'steer.fearMid', label: '恐懼門檻(中血)', cat: 'movement', type: 'number', def: 0.6, min: 0.4, max: 0.8, step: 0.01, humanTrackable: true, humanSource: 'learn.params.fearMid', desc: '中血量時恐懼係數切換點' },
    { id: 'steer.fearK', label: '恐懼倍率', cat: 'movement', type: 'number', def: 1.0, min: 0.5, max: 1.8, step: 0.01, humanTrackable: true, humanSource: 'learn.params.fearK', desc: '整體恐懼放大/縮小' },
    { id: 'steer.retreatDist', label: '迴避距離', cat: 'movement', type: 'number', def: 120, min: 60, max: 240, step: 5, desc: '首領/彈幕迴避距離' },
    { id: 'steer.springHp', label: '補血泉觸發血量', cat: 'movement', type: 'number', def: 0.6, min: 0.3, max: 0.9, step: 0.05, humanTrackable: true, humanSource: 'learn.healThreshold', desc: '低於此血量走向補血泉' },
    { id: 'steer.farmMinEnemies', label: '養怪最少怪數', cat: 'movement', type: 'number', def: 54, min: 20, max: 80, step: 1, desc: '場上怪數達此值新生精英' },
    { id: 'steer.farmHpOn', label: '養怪開啟血量', cat: 'movement', type: 'number', def: 0.65, min: 0.4, max: 0.9, step: 0.05, desc: '血量高於此開養怪' },
    { id: 'steer.farmHpOff', label: '養怪關閉血量', cat: 'movement', type: 'number', def: 0.45, min: 0.2, max: 0.7, step: 0.05, desc: '血量低於此關養怪' },
    { id: 'steer.orbHp', label: '寶珠使用血量', cat: 'movement', type: 'number', def: 0.35, min: 0.1, max: 0.7, step: 0.05, humanTrackable: true, humanSource: 'learn.healThreshold', desc: '危急時用寶珠' },
    { id: 'steer.healCardHp', label: '補血卡門檻', cat: 'movement', type: 'number', def: 0.35, min: 0.2, max: 0.7, step: 0.01, humanTrackable: true, humanSource: 'learn.healThreshold', desc: 'bot 選補血卡的血量' },
    { id: 'steer.magnetBase', label: '磁鐵基礎半徑', cat: 'movement', type: 'number', def: 78, min: 40, max: 120, step: 2, desc: '吸取半徑' },
    // --- 學習強度 ---
    { id: 'learn.cardStr', label: '卡牌偏好強度', cat: 'learning', type: 'number', def: 400, min: 0, max: 800, step: 10, humanTrackable: true, humanSource: 'learn.params.cardStr', desc: '卡牌 bias 放大倍率' },
    { id: 'learn.bondStr', label: '羈絆偏好強度', cat: 'learning', type: 'number', def: 6, min: 0, max: 12, step: 0.5, humanTrackable: true, humanSource: 'learn.params.bondStr', desc: '羈絆 bias 放大倍率' },
    { id: 'learn.itemStr', label: '道具偏好強度', cat: 'learning', type: 'number', def: 6, min: 0, max: 12, step: 0.5, humanTrackable: true, humanSource: 'learn.params.itemStr', desc: '道具 bias 放大倍率' },
    { id: 'learn.healThr', label: '學習補血門檻', cat: 'learning', type: 'number', def: 0.35, min: 0.2, max: 0.7, step: 0.01, humanTrackable: true, humanSource: 'learn.params.healThr', desc: 'outcome-aware 推導' },
    // --- 選卡權重 ---
    { id: 'score.xpWeight', label: 'XP 卡權重', cat: 'scoring', type: 'number', def: 74, min: 0, max: 100, step: 1, desc: '經驗卡優先度' },
    { id: 'score.atkWeight', label: '攻擊卡權重', cat: 'scoring', type: 'number', def: 60, min: 0, max: 100, step: 1, desc: '攻擊卡優先度' },
    { id: 'score.cdWeight', label: '冷卻卡權重', cat: 'scoring', type: 'number', def: 55, min: 0, max: 100, step: 1, desc: '冷卻卡優先度' },
    { id: 'score.passiveFirst', label: '被動優先分數', cat: 'scoring', type: 'number', def: 400, min: 200, max: 700, step: 10, desc: '被動 vs 招式升級' },
    // STAT_PRI 個別權重
    { id: 'statPri.xp', label: 'XP stat 權重', cat: 'scoring', type: 'number', def: 74, min: 0, max: 100, step: 1, desc: '經驗卡優先度', humanTrackable: false },
    { id: 'statPri.atk', label: 'ATK stat 權重', cat: 'scoring', type: 'number', def: 60, min: 0, max: 100, step: 1, desc: '攻擊卡優先度' },
    { id: 'statPri.cd', label: 'CD stat 權重', cat: 'scoring', type: 'number', def: 55, min: 0, max: 100, step: 1, desc: '冷卻卡優先度' },
    { id: 'statPri.def', label: 'DEF stat 權重', cat: 'scoring', type: 'number', def: 45, min: 0, max: 100, step: 1, desc: '防禦卡優先度' },
    { id: 'statPri.hp', label: 'HP stat 權重', cat: 'scoring', type: 'number', def: 40, min: 0, max: 100, step: 1, desc: '血量卡優先度' },
    { id: 'statPri.rgn', label: 'RGN stat 權重', cat: 'scoring', type: 'number', def: 35, min: 0, max: 100, step: 1, desc: '回血卡優先度' },
    { id: 'statPri.mag', label: 'MAG stat 權重', cat: 'scoring', type: 'number', def: 25, min: 0, max: 100, step: 1, desc: '磁鐵卡優先度' },
    { id: 'statPri.spd', label: 'SPD stat 權重', cat: 'scoring', type: 'number', def: 15, min: 0, max: 100, step: 1, desc: '速度卡優先度' },
    { id: 'statPri.heal', label: 'HEAL stat 權重', cat: 'scoring', type: 'number', def: 5, min: 0, max: 100, step: 1, desc: '補血卡優先度' },
    // --- 知識圖譜超參數 ---
    { id: 'brain.emaLr', label: '學習率(EMA)', cat: 'brain', type: 'number', def: 0.15, min: 0.01, max: 0.5, step: 0.01, desc: 'Hebbian 更新速率' },
    { id: 'brain.decay', label: '衰減率', cat: 'brain', type: 'number', def: 0.85, min: 0.5, max: 0.99, step: 0.01, desc: 'EMA 舊值保留率' },
    { id: 'brain.minEvidence', label: '最小證據數', cat: 'brain', type: 'number', def: 3, min: 1, max: 10, step: 1, desc: '生效所需樣本' },
    { id: 'brain.historySize', label: '歷史局數', cat: 'brain', type: 'number', def: 30, min: 10, max: 100, step: 5, desc: '保留局數' },
  ];
  const BRAIN_CATS = ['core', 'movement', 'learning', 'scoring', 'survival', 'boss', 'reward', 'portal', 'brain'];
  const BRAIN_CAT_LABEL = { core: '核心開關', movement: '移動/戰鬥', learning: '學習強度', scoring: '選卡評分', survival: '生存/獎勵', boss: 'BOSS策略', reward: '獎勵優先', portal: '傳送門/風險', brain: '腦超參數' };

  // 取得參數當前值（依 id 路徑）
  function brainGet(id) {
    const parts = id.split('.');
    let o = (parts[0] === 'cfg') ? cfg : (parts[0] === 'learn') ? cfg.learn : (parts[0] === 'steer') ? cfg.steer : (parts[0] === 'score') ? null : (parts[0] === 'statPri') ? cfg.statPri : (parts[0] === 'surv') ? (cfg.surv || (cfg.surv = {})) : (parts[0] === 'boss') ? (cfg.boss || (cfg.boss = {})) : (parts[0] === 'reward') ? (cfg.reward || (cfg.reward = {})) : (parts[0] === 'portal') ? (cfg.portal || (cfg.portal = {})) : (parts[0] === 'brain') ? cfg.brain : null;
    // score 特殊：cfg 沒有 score，用 cfg.learn.params 或 cfg.steer
    if (parts[0] === 'score') {
      if (parts[1] === 'passiveFirst') return cfg.passiveFirst;
      if (parts[1] === 'xpWeight') return cfg.steer.xpWeight;
      if (parts[1] === 'atkWeight') return cfg.steer.atkWeight;
      if (parts[1] === 'cdWeight') return cfg.steer.cdWeight;
    }
    if (!o) return undefined;
    return parts.slice(1).reduce((a, k) => (a == null ? undefined : a[k]), o);
  }
  function brainSet(id, v) {
    const parts = id.split('.');
    if (parts[0] === 'score') {
      if (parts[1] === 'passiveFirst') { cfg.passiveFirst = v; return; }
      if (parts[1] === 'xpWeight') { cfg.steer.xpWeight = v; return; }
      if (parts[1] === 'atkWeight') { cfg.steer.atkWeight = v; return; }
      if (parts[1] === 'cdWeight') { cfg.steer.cdWeight = v; return; }
      return;
    }
    let o = (parts[0] === 'cfg') ? cfg : (parts[0] === 'learn') ? cfg.learn : (parts[0] === 'steer') ? cfg.steer : (parts[0] === 'statPri') ? cfg.statPri : (parts[0] === 'surv') ? (cfg.surv || (cfg.surv = {})) : (parts[0] === 'boss') ? (cfg.boss || (cfg.boss = {})) : (parts[0] === 'reward') ? (cfg.reward || (cfg.reward = {})) : (parts[0] === 'portal') ? (cfg.portal || (cfg.portal = {})) : (parts[0] === 'brain') ? cfg.brain : null;
    if (!o) return;
    const keys = parts.slice(1);
    for (let i = 0; i < keys.length - 1; i++) { if (o[keys[i]] == null) o[keys[i]] = {}; o = o[keys[i]]; }
    o[keys[keys.length - 1]] = v;
  }

  // 人類值：從 learn 資料推導（若 humanTrackable）
  function brainHumanValue(reg) {
    if (!reg.humanTrackable) return null;
    const src = reg.humanSource;
    if (!src) return null;
    const v = brainGet(src.replace(/^learn\./, 'learn.').replace(/^steer\./, 'steer.'));
    // brainGet 用 id 路徑，humanSource 已是 learn.xxx / steer.xxx 但 id 前綴是 learn./steer.；直接取 cfg.learn/cfg.steer
    const parts = src.split('.');
    let o = cfg;
    for (const k of parts) { if (o == null) return null; o = o[k]; }
    return (typeof o === 'number' && isFinite(o)) ? o : null;
  }

  // 建立 / 重建知識圖譜（所有參數 = 節點；依分類 + 因果關係建邊）
  function buildBrain() {
    const B = cfg.brain;
    B.nodes = B.nodes || {};
    // 節點：每個註冊參數
    for (const reg of PARAM_REGISTRY) {
      const cur = brainGet(reg.id);
      const hum = brainHumanValue(reg);
      B.nodes[reg.id] = {
        id: reg.id, label: reg.label, cat: reg.cat, type: reg.type,
        value: (cur == null ? reg.def : cur),
        def: reg.def, human: hum,
        min: reg.min, max: reg.max, step: reg.step,
        desc: reg.desc || '', humanTrackable: !!reg.humanTrackable,
        locked: (cfg.learn && cfg.learn.params && cfg.learn.params.locked && cfg.learn.params.locked[reg.id]) || false,
        updatedAt: Date.now(),
      };
    }
    // 額外節點：學習到的偏好（卡牌/羈絆/道具）與概念節點
    const L = cfg.learn;
    for (const bag of ['cards', 'bonds', 'items']) {
      const V = L.values && L.values[bag] || {};
      const C = L[bag] || {};
      const keys = new Set([...Object.keys(V), ...Object.keys(C)]);
      for (const k of keys) {
        const id = 'pref:' + bag + ':' + k;
        const v = V[k]; const c = C[k];
        const conf = (v && v.n >= 3) ? v.v : (c && c.t >= 3 ? (c.n + 1) / (c.t + 2) : 0.5);
        B.nodes[id] = { id, label: k, cat: 'preference', type: 'pref', value: conf, def: 0.5, human: null,
          desc: `${bag} 偏好 (n=${(v && v.n) || (c && c.t) || 0})`, humanTrackable: true, updatedAt: Date.now() };
      }
    }
    // 概念節點
    for (const c of ['survival', 'damage', 'xp_gain', 'safety', 'efficiency']) {
      if (!B.nodes['concept:' + c]) B.nodes['concept:' + c] = { id: 'concept:' + c, label: c, cat: 'concept', type: 'concept', value: 0.5, def: 0.5, human: null, desc: '概念節點', updatedAt: Date.now() };
    }
    // 邊：同分類內的參數互相影響（全連接，權重 0.3）
    B.edges = [];
    const nodeIds = Object.keys(B.nodes);
    // 分類內邊
    const byCat = {};
    for (const n of nodeIds) { const c = B.nodes[n].cat; (byCat[c] = byCat[c] || []).push(n); }
    for (const c in byCat) {
      const ns = byCat[c];
      for (let i = 0; i < ns.length; i++) for (let j = i + 1; j < ns.length; j++) {
        B.edges.push({ from: ns[i], to: ns[j], rel: 'same_category', w: 0.2, evidence: 0 });
      }
    }
    // 因果邊：恐懼參數 -> 移動安全
    const causal = [
      ['steer.fearLow', 'concept:safety'], ['steer.fearMid', 'concept:safety'], ['steer.fearK', 'concept:safety'],
      ['steer.retreatDist', 'concept:safety'], ['steer.orbHp', 'concept:survival'],
      ['steer.healCardHp', 'concept:survival'], ['learn.healThr', 'concept:survival'],
      ['score.xpWeight', 'concept:xp_gain'], ['cfg.farm', 'concept:efficiency'],
      ['learn.cardStr', 'concept:efficiency'],
      ['steer.springHp', 'concept:survival'], ['steer.magnetBase', 'concept:efficiency'],
      ['steer.farmHpOn', 'concept:efficiency'], ['steer.farmHpOff', 'concept:safety'],
      ['cfg.focus', 'concept:efficiency'], ['cfg.passiveFirst', 'concept:xp_gain'],
      ['surv.healUrgent', 'concept:survival'], ['surv.orbDanger', 'concept:survival'],
      ['surv.retreatBoss', 'concept:safety'], ['surv.rewardSafeHp', 'concept:survival'],
      ['boss.prioritizeLowHp', 'concept:efficiency'], ['boss.arceusFocus', 'concept:survival'],
      ['reward.xpPriority', 'concept:xp_gain'], ['reward.coinPriority', 'concept:efficiency'],
      ['portal.enterHp', 'concept:survival'], ['portal.riskTolerance', 'concept:efficiency'],
      ['portal.rewardThreshold', 'concept:efficiency'], ['portal.lateGameBonus', 'concept:efficiency'],
    ];
    // 組合邊：參數交互（fearLow × retreatDist → safety 等）
    const combos = [
      ['steer.fearLow', 'steer.retreatDist', 'concept:safety'],
      ['steer.fearK', 'steer.farmHpOff', 'concept:safety'],
      ['learn.cardStr', 'score.xpWeight', 'concept:xp_gain'],
      ['learn.bondStr', 'learn.itemStr', 'concept:efficiency'],
      ['steer.orbHp', 'steer.healCardHp', 'concept:survival'],
      ['portal.enterHp', 'portal.riskTolerance', 'concept:survival'],
      ['surv.rewardSafeHp', 'surv.rewardSafeDist', 'concept:survival'],
      ['boss.prioritizeLowHp', 'boss.prioritizeHighDmg', 'concept:efficiency'],
    ];
    for (const [a, b, c] of combos) {
      if (B.nodes[a] && B.nodes[b] && B.nodes[c]) {
        B.edges.push({ from: a, to: c, rel: 'combo', w: 0.5, evidence: 0 });
        B.edges.push({ from: b, to: c, rel: 'combo', w: 0.5, evidence: 0 });
        B.edges.push({ from: a, to: b, rel: 'interacts', w: 0.4, evidence: 0 });
      }
    }
    for (const [a, b] of causal) {
      if (B.nodes[a] && B.nodes[b]) B.edges.push({ from: a, to: b, rel: 'influences', w: 0.6, evidence: 0 });
    }
    // 偏好 -> 概念
    for (const bag of ['cards', 'bonds', 'items']) {
      const V = L.values && L.values[bag] || {};
      for (const k of Object.keys(V)) {
        const id = 'pref:' + bag + ':' + k;
        if (B.nodes[id]) {
          const target = bag === 'cards' ? 'concept:xp_gain' : 'concept:efficiency';
          B.edges.push({ from: id, to: target, rel: 'improves', w: (V[k].v || 0.5) * 0.8, evidence: V[k].n || 0 });
        }
      }
    }
    B.updatedAt = Date.now();
    save();
  }

  // Hebbian + 獎勵調變更新：一局結束後，依品質強化/削弱活躍邊
  function adaptBrain(q, activeIds) {
    const B = cfg.brain;
    if (!B || !B.edges) return;
    const lr = (cfg.brain.emaLr != null ? cfg.brain.emaLr : (cfg.steer.brainLr || 0.15));
    const decay = (cfg.brain.decay != null ? cfg.brain.decay : 0.85);
    const delta = (q - 0.5) * 2;   // -1 ~ +1
    const activeSet = new Set(activeIds || []);
    for (const e of B.edges) {
      if (activeSet.has(e.from) || activeSet.has(e.to)) {
        e.w = Math.max(0, Math.min(1, e.w + lr * delta * 0.3));
        e.evidence = (e.evidence || 0) + 1;
      } else {
        e.w = e.w * decay + (1 - decay) * 0.3;
      }
    }
    // 節點 value EMA（對 human-trackable 參數，拉向 human 值）
    for (const reg of PARAM_REGISTRY) {
      const node = B.nodes[reg.id];
      if (!node || !reg.humanTrackable) continue;
      const hum = brainHumanValue(reg);
      if (hum == null) continue;
      const cur = node.value;
      node.value = cur * decay + hum * (1 - decay);
      node.human = hum;
    }
    B.updatedAt = Date.now();
    save();
  }

  // 匯出腦（完整圖譜 + 參數 + 學習資料）
  function exportBrain() {
    try {
      buildBrain();
      const data = { app: 'psbot', kind: 'brain', v: 1, at: new Date().toISOString(),
        cfg: { on: cfg.on, move: cfg.move, cards: cfg.cards, bonds: cfg.bonds, items: cfg.items, rift: cfg.rift, orbs: cfg.orbs, restart: cfg.restart, noRank: cfg.noRank, farm: cfg.farm, focus: cfg.focus, passiveFirst: cfg.passiveFirst, record: cfg.record, selfLearn: cfg.selfLearn, exploreRate: cfg.exploreRate, steer: cfg.steer, statPri: cfg.statPri, surv: cfg.surv, boss: cfg.boss, reward: cfg.reward, portal: cfg.portal, profiles: cfg.profiles },
        learn: cfg.learn, brain: cfg.brain, brains: cfg.brains };
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const a = document.createElement('a'); a.href = URL.createObjectURL(blob);
      a.download = `psbot-brain-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      learnMsg(`已匯出腦（${Object.keys(cfg.brain.nodes).length} 節點）`);
    } catch (e) { learnMsg('匯出失敗：' + e.message); }
  }

  // 匯入腦（合併：節點 union、邊 union、值加權平均、學習資料 merge）
  function importBrainFile(file) {
    const rd = new FileReader();
    rd.onload = () => {
      try {
        const d = JSON.parse(String(rd.result));
        const src = d && d.brain ? d : (d && d.learn ? { brain: null, learn: d.learn, cfg: d.cfg } : null);
        if (!src) throw new Error('不是 PSBot 腦檔案');
        if (src.cfg && typeof src.cfg === 'object') {
          if (src.cfg.steer) Object.assign(cfg.steer, src.cfg.steer);
          if (src.cfg.statPri) Object.assign(cfg.statPri, src.cfg.statPri);
          if (src.cfg.surv) Object.assign(cfg.surv, src.cfg.surv);
          if (src.cfg.boss) Object.assign(cfg.boss, src.cfg.boss);
          if (src.cfg.reward) Object.assign(cfg.reward, src.cfg.reward);
          if (src.cfg.portal) Object.assign(cfg.portal, src.cfg.portal);
          for (const k of ['move','cards','bonds','items','rift','orbs','restart','noRank','farm','focus','passiveFirst','selfLearn']) {
            if (typeof src.cfg[k] === 'boolean') cfg[k] = src.cfg[k];
          }
          if (typeof src.cfg.exploreRate === 'number' && isFinite(src.cfg.exploreRate)) cfg.exploreRate = src.cfg.exploreRate;
        }
        if (src.learn) mergeLearn(src.learn);
        if (src.brains && typeof src.brains === 'object') {
          for (const [dex, b] of Object.entries(src.brains)) {
            if (!b || typeof b !== 'object') continue;
            if (!cfg.brains[dex]) cfg.brains[dex] = JSON.parse(JSON.stringify(b));
            else {
              // merge brains
              const ex = cfg.brains[dex];
              for (const [id, n] of Object.entries(b.nodes || {})) {
                if (!ex.nodes[id]) ex.nodes[id] = JSON.parse(JSON.stringify(n));
                else {
                  const w1 = ex.nodes[id].evidence || 1, w2 = n.evidence || 1;
                  ex.nodes[id].value = (ex.nodes[id].value * w1 + (n.value || ex.nodes[id].value) * w2) / (w1 + w2);
                  ex.nodes[id].evidence = (ex.nodes[id].evidence || 0) + (n.evidence || 0);
                }
              }
              const key = e => e.from + '|' + e.to + '|' + e.rel;
              const idx = new Map(ex.edges.map((e, i) => [key(e), i]));
              for (const e of (b.edges || [])) {
                if (!e || !e.from || !e.to) continue;
                const i = idx.get(key(e));
                if (i == null) { ex.edges.push(JSON.parse(JSON.stringify(e))); idx.set(key(e), ex.edges.length - 1); }
                else { const ex2 = ex.edges[i]; const w1 = ex2.evidence || 1, w2 = e.evidence || 1; ex2.w = (ex2.w * w1 + (e.w || ex2.w) * w2) / (w1 + w2); ex2.evidence = (ex2.evidence || 0) + (e.evidence || 0); }
              }
            }
          }
        }
        if (src.brain && src.brain.nodes) {
          const B = cfg.brain;
          // 節點：union，值加權平均
          for (const [id, n] of Object.entries(src.brain.nodes)) {
            if (!n || typeof n !== 'object') continue;
            const ex = B.nodes[id];
            if (!ex) { B.nodes[id] = JSON.parse(JSON.stringify(n)); }
            else {
              // 加權平均 value
              const w1 = ex.evidence || 1, w2 = n.evidence || 1;
              ex.value = (ex.value * w1 + (n.value || ex.value) * w2) / (w1 + w2);
              ex.evidence = (ex.evidence || 0) + (n.evidence || 0);
              if (n.human != null) ex.human = n.human;
            }
          }
          // 邊：union（相同 from-to-rel 合併權重）
          const key = e => e.from + '|' + e.to + '|' + e.rel;
          const idx = new Map(B.edges.map((e, i) => [key(e), i]));
          for (const e of (src.brain.edges || [])) {
            if (!e || !e.from || !e.to) continue;
            const i = idx.get(key(e));
            if (i == null) { B.edges.push(JSON.parse(JSON.stringify(e))); idx.set(key(e), B.edges.length - 1); }
            else {
              const ex = B.edges[i];
              const w1 = ex.evidence || 1, w2 = e.evidence || 1;
              ex.w = (ex.w * w1 + (e.w || ex.w) * w2) / (w1 + w2);
              ex.evidence = (ex.evidence || 0) + (e.evidence || 0);
            }
          }
        }
        buildBrain();
        save();
        learnMsg(`已匯入腦：${Object.keys(cfg.brain.nodes).length} 節點`);
      } catch (e) { learnMsg('匯入失敗：' + e.message); }
    };
    rd.onerror = () => learnMsg('讀取檔案失敗');
    rd.readAsText(file);
  }

  // Canvas 力導向圖渲染
  function renderBrainGraph(canvas) {
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    const B = cfg.brain;
    buildBrain();
    const nodes = Object.values(B.nodes);
    const edges = B.edges || [];
    // 初始化位置（若沒有）
    if (!canvas._pos) canvas._pos = {};
    const pos = canvas._pos;
    for (const n of nodes) {
      if (!pos[n.id]) { pos[n.id] = { x: W/2 + (Math.random()-0.5)*W*0.6, y: H/2 + (Math.random()-0.5)*H*0.6, vx:0, vy:0 }; }
    }
    // 力導向迭代
    for (let iter = 0; iter < 40; iter++) {
      // 斥力
      for (let i = 0; i < nodes.length; i++) for (let j = i+1; j < nodes.length; j++) {
        const a = pos[nodes[i].id], b = pos[nodes[j].id];
        let dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.max(1, Math.hypot(dx, dy));
        const f = 800 / (d * d);
        a.vx -= (dx/d)*f; a.vy -= (dy/d)*f;
        b.vx += (dx/d)*f; b.vy += (dy/d)*f;
      }
      // 引力（邊）
      for (const e of edges) {
        const a = pos[e.from], b = pos[e.to];
        if (!a || !b) continue;
        let dx = b.x - a.x, dy = b.y - a.y;
        const d = Math.max(1, Math.hypot(dx, dy));
        const f = (d - 60) * 0.02 * (e.w || 0.5);
        a.vx += (dx/d)*f; a.vy += (dy/d)*f;
        b.vx -= (dx/d)*f; b.vy -= (dy/d)*f;
      }
      // 向心力 + 阻尼
      for (const n of nodes) {
        const p = pos[n.id];
        p.vx += (W/2 - p.x) * 0.001;
        p.vy += (H/2 - p.y) * 0.001;
        p.vx *= 0.85; p.vy *= 0.85;
        p.x = Math.max(10, Math.min(W-10, p.x + p.vx));
        p.y = Math.max(10, Math.min(H-10, p.y + p.vy));
      }
    }
    // 繪製
    ctx.clearRect(0, 0, W, H);
    ctx.fillStyle = 'rgba(14,18,32,1)'; ctx.fillRect(0, 0, W, H);
    // 邊
    for (const e of edges) {
      const a = pos[e.from], b = pos[e.to];
      if (!a || !b) continue;
      ctx.strokeStyle = e.rel === 'influences' ? 'rgba(255,138,216,0.5)' : e.rel === 'improves' ? 'rgba(90,200,120,0.5)' : 'rgba(100,120,180,0.25)';
      ctx.lineWidth = 0.5 + (e.w || 0.3) * 2;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    // 節點
    const catColor = { core: '#ff8ad8', movement: '#4aa3ff', learning: '#ffd23f', scoring: '#9fb1c9', survival: '#ff6b6b', boss: '#ff9f43', reward: '#54a0ff', portal: '#a29bfe', brain: '#c084fc', preference: '#5ac878', concept: '#ee5a24' };
    for (const n of nodes) {
      const p = pos[n.id];
      if (!p) continue;
      const r = n.type === 'concept' ? 8 : n.type === 'pref' ? 5 : 6;
      ctx.fillStyle = catColor[n.cat] || '#888';
      ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI*2); ctx.fill();
      ctx.fillStyle = '#e8ecf6';
      ctx.font = '9px system-ui';
      ctx.textAlign = 'center';
      ctx.fillText((n.label || n.id).slice(0, 12), p.x, p.y - r - 2);
    }
    // 圖例
    ctx.font = '9px system-ui'; ctx.textAlign = 'left';
    let lx = 8, ly = H - 8;
    for (const [c, col] of Object.entries(catColor)) {
      ctx.fillStyle = col; ctx.fillRect(lx, ly - 8, 8, 8);
      ctx.fillStyle = '#9fb1c9'; ctx.fillText(c, lx + 10, ly);
      lx += 70;
      if (lx > W - 60) { lx = 8; ly -= 12; }
    }
  }

  // ---------- 4. 選卡邏輯 ----------
  // 學習（經驗 ×1.12，最多 8 張 = ×2.48）越早拿越賺，排第一；磁鐵（吸取範圍 ×1.3）拿到約 260px 前也很優先，
  // 範圍大了光球會自己飛過來，不用一顆一顆跑去撿，省下來的時間都在打怪
  const STAT_PRI = Object.assign({ xp: 74, atk: 60, cd: 55, def: 45, hp: 40, rgn: 35, mag: 25, spd: 15, heal: 5 }, cfg.statPri || {});
  const KIND_PRI = Object.assign({ homing: 13, nova: 12, aura: 12, orbit: 11, chain: 10, projectile: 9, boomerang: 8, beam: 8, meteor: 8, turret: 7, mine: 6, cone: 6, melee: 4, dash: 3, trail: 3 }, cfg.kindPri || {});

  function profileOf(ns) {
    const p = ns.Game.player;
    const prof = p && cfg.profiles[p.dex];
    return prof && prof.moves && prof.moves.length ? prof : null;
  }

  function scoreNewMove(ns, p, id) {
    const prof = profileOf(ns);
    if (prof) {
      const i = prof.moves.indexOf(id);
      // 配置外的招式一律不拿：綁完羈絆空出欄位也不拿。多學的招會在下次拿到羈絆時被遊戲強制綁成沒用的第二組
      return i >= 0 ? 900 - i * 5 : -100;
    }
    // 自動模式（沒有設定配置的寶可夢）：
    // 開局招式 → 變硬 → 第二招攻擊（範圍越大越好）→ 劍舞（物攻）/ 詭計（特攻）。
    // 範圍招排在增益前面：潮旋吸住 1 隻怪的輸出就超過水槍，詭計加在水槍上只多約 +65% 單體；
    // 範圍招綁上主動欄位養怪模式才會開始，早一個秘境綁就早一個秘境滾雪球。
    // 變硬、劍舞、詭計是一般系招式，每隻都學得到；其他增益不拿，第二招攻擊要留位置給還沒拿到的變硬 / 強化
    const m = ns.Moves.BY_ID[id];
    if (!m) return 0;
    const buffId = atkBuffOf(ns, p);
    if (id === 'harden') return 870;
    if (id === buffId) return 865;
    if (m.kind === 'buff') return -100;
    const atk = p.moves.filter(x => x.kind !== 'buff').length;
    const need = ['harden', buffId].filter(x => !p.hasMove(x)).length;
    if (atk === 0) return 860;
    if (p.maxMoves - p.slots.length - need < 1) return -100;
    if (atk >= 2) return -100;  // 4 招都齊了就不再學：綁羈絆後空出欄位也不拿（多學的招會被遊戲強制綁成沒用的第二組）
    // 只有「持續打一個區域」的範圍招（潮旋會把怪吸成一團、光環、繞身）排在劍舞 / 詭計（865）前面、變硬（870）後面；
    // 放射狀（泡沫）、連鎖、彈跳之類前期怪少時大多打空、也不聚怪，照舊排在增益後面
    const aoe = aoeScore(ns, p, m);
    return aoe >= 20 && EARLY_AOE.includes(m.kind) ? 868 : 800 + aoe;
  }

  // 主力增益：物攻用劍舞、特攻用詭計
  function atkBuffOf(ns, p) { return ns.Stats.sideOf(p.mon) === 'physical' ? 'swords-dance' : 'nasty-plot'; }
  // 第二招攻擊挑範圍大的：放射狀 / 光環 / 落石 / 漩渦 / 繞身 / 旋轉 > 彈跳 / 連鎖 / 推開 > 扇形 / 光束 > 單體。
  // 同屬性加分；太爛的（近戰、衝刺、拖尾）給 450，低於重抽門檻，有重抽次數時會先重抽等更好的
  const AOE_PRI = { vortex: 45, nova: 40, aura: 38, meteor: 36, orbit: 34, spin: 33, bounce: 31, chain: 30, shove: 29, quake: 27, cone: 26, charge: 24, stun: 22, beam: 22, boomerang: 20, homing: 18, projectile: 12, turret: 12, mine: 8 };
  const EARLY_AOE = ['vortex', 'aura', 'orbit'];
  function aoeScore(ns, p, m) {
    if (!(m.kind in AOE_PRI)) return -350;
    const fit = m.cat ? ns.Stats.fit(p.mon, m.cat) : 1;
    if (fit < 0.9) return -350;   // 物攻 / 特攻對不上（例：特攻型拿到物理招）打不痛，寧可重抽等下一張
    return AOE_PRI[m.kind] + (fit >= 0.999 ? 0 : -15) + ((p.mon.types || []).includes(m.type) ? 8 : 0);
  }

  function countOwned(p, ids) { return ids.filter(id => p.hasMove(id)).length; }

  function scoreCard(ns, p, c) {
    const [type, id] = [c.type, String(c.key).split(':').slice(1).join(':')];
    const lowHp = p.hp / p.maxHp < healThreshold();   // 記錄模式會依人類習慣調整補血時機
    if (type === 'evo') return 1000;
    if (type === 'new') return scoreNewMove(ns, p, id);
    // 招式進化 = 招式升到滿級 + 拿過一次指定的被動（例：念力要「反應」、精神強念要「磁鐵」）
    const EVO = ns.Moves.EVO || {};
    const evoNeeds = new Set(p.moves.filter(m => !m.evolved && EVO[m.id] && !(p.statsTaken || {})[EVO[m.id]]).map(m => EVO[m.id]));
    if (type === 'stat') {
      if (id === 'heal') return lowHp ? 950 : 10;
      if (c.color === '#ffd23f') return 980;          // 拿了馬上進化，只輸給「進化」本身
      if (evoNeeds.has(id)) return 700;               // 先拿好進化要的被動，招式滿級時就能直接進化
      // 學習 > 磁鐵（範圍小時）> 護甲（每張 -6% 受到傷害，上限 70%，撐到第 30 分鐘要靠它）
      // 輸出溢出（怪一出來就被清光、場上平均不到 25 隻）：多的傷害換不到經驗，學習（經驗 ×1.12）排到招式升級前面，
      // 只輸給進化和進化要的被動
      if (id === 'xp' && S.spawnLimited) return 660;
      const pri = id === 'def' && (p.dmgReduce || 0) < 0.69 ? 70 : id === 'mag' && (p.magnet || 78) < 260 ? 72 : ((cfg.statPri && cfg.statPri[id]) || STAT_PRI[id] || 20);
      // 寫回 cfg.statPri 以便腦節點反映（學習時更新）
      try { if (cfg.statPri) cfg.statPri[id] = STAT_PRI[id]; } catch (e) {}
      return (cfg.passiveFirst ? 500 : 300) + pri;
    }
    if (type === 'up') {
      const prof = profileOf(ns);
      const i = prof ? prof.moves.indexOf(id) : -1;
      const m = p.moves.find(x => x.id === id);
      const inActive = p.activeGroup().some(x => x.id === id);
      // 還能進化的招式：升級是在往進化前進，排在一般被動前面；越接近滿級越急
      if (m && !m.evolved && EVO[id] && (i >= 0 || inActive)) {
        const maxLvl = (m.def && m.def.maxLvl) || 5;
        return 600 + Math.round(40 * (m.lvl || 1) / maxLvl) + (inActive ? 10 : 0);
      }
      return (cfg.passiveFirst ? 400 : 600) + (inActive ? 30 : 0) + (i >= 0 ? 20 - i * 3 : 0);
    }
    return 0;
  }

  function chooseCard(ns, cards) {
    const p = ns.Game.player;
    if (!p || !ns.UI.isOpen('scr-levelup')) return;
    let best = 0, bestS = -Infinity;
    // 記錄模式學到的偏好只微調分數（±200），不會蓋掉進化 / 配置招式這些硬規則
    cards.forEach((c, i) => { const s = scoreCard(ns, p, c) + cardBias(c.key); if (s > bestS) { bestS = s; best = i; } });
    // 自主學習探索：偶爾隨機選卡，探索參數空間
    if (cfg.selfLearn && cfg.on && cfg.exploreRate > 0 && Math.random() < cfg.exploreRate) {
      best = Math.floor(Math.random() * cards.length);
      log('explore pick', cards[best].key);
    }
    // 沒有任何有用的卡（進化、配置招式、被動、往進化前進的升級都沒有）→ 有重抽次數就重抽
    const rr = document.getElementById('lvl-reroll');
    if (bestS < 500 && rr && !rr.classList.contains('hidden')) {
      log('reroll'); ns.RunUI.reroll();
      return schedule(() => chooseCard(ns, S.lastOffer || cards), 300);
    }
    log('pick', cards[best].key, bestS);
    if (cfg.selfLearn && cfg.on) { if (!S.rec.runCards.includes(cards[best].key)) S.rec.runCards.push(cards[best].key); }
    ns.RunUI.pick(best);
  }
  // ---------- 5. 羈絆 ----------
  function bondRank(ns, p, mv) {
    const prof = profileOf(ns);
    if (prof) { const i = prof.moves.indexOf(mv.id); return i >= 0 ? i : 50; }
    // 自動：開局招式（第一個學到的攻擊招）→ 變硬 → 潮旋類（持續範圍）→ 劍舞 / 詭計 → 其他攻擊招
    const first = p.moves.find(x => x.kind !== 'buff');
    if (first && mv.id === first.id) return 0;
    if (mv.id === 'harden') return 1;
    if (EARLY_AOE.includes(mv.kind)) return 2;
    if (mv.id === atkBuffOf(ns, p)) return 3;
    return mv.kind === 'buff' ? 10 : 4;
  }
  function chooseBond(ns, opt) {
    const p = ns.Game.player;
    if (!p || !ns.UI.isOpen('scr-bond')) return;
    const order = opt.loose.map((m, i) => ({ m, i })).sort((a, b) =>
      (bondRank(ns, p, a.m) - bondBias(a.m.id)) - (bondRank(ns, p, b.m) - bondBias(b.m.id)));
    if (opt.mode === 'add') { log('bond add', order[0].m.id); if (cfg.selfLearn && cfg.on) { if (!S.rec.runBonds.includes(order[0].m.id)) S.rec.runBonds.push(order[0].m.id); } return ns.RunUI.pickBond(order[0].i); }
    // pair：先選第一個，清單會重繪（扣掉第一個），再選第二個
    const first = order[0].m, second = order[1].m;
    log('bond pair', first.id, second.id);
    if (cfg.selfLearn && cfg.on) { if (!S.rec.runBonds.includes(first.id)) S.rec.runBonds.push(first.id); if (!S.rec.runBonds.includes(second.id)) S.rec.runBonds.push(second.id); }
    ns.RunUI.pickBond(order[0].i);
    schedule(() => {
      const list = opt.loose.filter(m => m !== first);
      ns.RunUI.pickBond(list.indexOf(second));
    }, 250);
  }

  // ---------- 6. 道具 ----------
  const ITEM_PRI = ['shellbell', 'luckyegg', 'leftovers', 'quickclaw', 'focussash', 'assaultvest', 'rockyhelmet', 'amuletcoin', 'choicescarf', 'lifeorb', 'choiceband'];
  function itemRank(ns, id) {
    const prof = profileOf(ns);
    if (prof && prof.item === id) return -1;
    const i = ITEM_PRI.indexOf(id);
    return (i < 0 ? 99 : i) - itemBias(id);   // 記錄模式學到的偏好：名次往前挪最多 3
  }

  // ---------- 7. 雜務：主動欄位 / 寶珠 ----------
  function groupScore(g, prof) {
    let dmg = 0, buff = 0, rank = 0;
    for (const m of g) {
      if (m.kind === 'buff') buff++; else dmg += 10 + (m.lvl || 1) + (m.evolved ? 5 : 0);
      // 有配置：照配置順序，越前面的招式越重要（超夢 = 念力那格最優先）
      const i = prof ? prof.moves.indexOf(m.id) : -1;
      if (i >= 0 && m.kind !== 'buff') rank += 100 - i * 20;
    }
    if (!dmg) return 0;                       // 單獨的增益招不打人，不要停在那格
    return prof ? rank + buff * 30 + g.length * 5 : dmg + buff * 6;
  }
  function housekeeping(ns) {
    const p = ns.Game.player;
    if (!p || p.dead || ns.Game.state !== 'playing') return;
    hookAim(ns, p);
    const now = performance.now();
    // 場上怪數的平滑平均（約 20 秒）：平均不到 25 隻 = 輸出溢出、經驗卡在出怪速度
    const cnt = ns.EnemyMgr.count ?? ns.EnemyMgr.all().length;
    const busy = (ns.Rift && ns.Rift.inArena) || (ns.Judgment && ns.Judgment.active);
    if (!busy) { S.fieldAvg = S.fieldAvg == null ? cnt : S.fieldAvg + (cnt - S.fieldAvg) * 0.01; S.spawnLimited = ns.Game.st.time > 60 && S.fieldAvg < 25; }
    if (now - S.lastSlotCheck > 600 && p.slots.length > 1 && !p.hasItem?.('choiceband')) {
      S.lastSlotCheck = now;
      const prof = profileOf(ns);
      let best = p.active, bs = groupScore(p.slots[p.active] || [], prof);
      p.slots.forEach((g, i) => { const s = groupScore(g, prof); if (s > bs + 0.5) { bs = s; best = i; } });
      if (best !== p.active) p.setActive(best);
    }
    if (cfg.orbs && ns.Orbs && p.orbs && now - S.lastOrb > 1500) {
      let around = 0;
      for (const e of ns.EnemyMgr.all()) if (!e.dead && e.behavior !== 'thief' && Math.abs(e.x - p.x) < 90 && Math.abs(e.y - p.y) < 90) around++;
      const danger = p.hp / p.maxHp < 0.4 || around >= 8;   // 快沒血，或被 8 隻以上的怪貼身包圍
      const boss = (ns.EnemyMgr.bossAlive && ns.EnemyMgr.bossAlive()) || (ns.Judgment && ns.Judgment.active);
      p.orbs.forEach((o, i) => {
        if (!o || now - S.lastOrb < 1500) return;
        const kind = ns.Orbs.BY && ns.Orbs.BY[o.id] && ns.Orbs.BY[o.id].kind;
        if ((kind === 'foe' && danger) || (kind === 'buff' && boss)) { ns.Orbs.use(p, i); S.lastOrb = now; }
      });
    }
  }

  // ---------- 7b. 集火瞄準 ----------
  // 遊戲的自動瞄準：330px 內有首領打首領 > 貼身的 > 最近的。潮旋把怪吸成一團後「最近的」每幀都在換，
  // 水槍每隻打一點、誰都沒打死，殺得慢經驗就少。遊戲本身有「手動瞄準」（設定 > 無障礙），
  // 方向來自 Player.handAim()；這裡接管它：沿每個方向模擬子彈會先打到誰（會穿透 pierce 隻），
  // 一發打得死的最優先，其次是剩越少血的，已經在打的那隻加分，打到死才換。首領 / 審判照遊戲原本的規則
  function hookAim(ns, p) {
    if (S.aimHooked) return;
    const proto = Object.getPrototypeOf(p);
    if (!proto || typeof proto.handAim !== 'function') return;
    const orig = proto.handAim;
    proto.handAim = function () {
      // 集火開著時滑鼠完全不參與：focusAim 讓出（首領 / 審判 / 沒有目標）就交回遊戲的自動瞄準，
      // 不是交給「手動瞄準」的滑鼠方向。關掉 bot 或集火才恢復遊戲原本的行為
      if (cfg.on && cfg.focus && this === ns.Game.player && !this.remote) {
        try { return focusAim(ns, this); } catch (e) { console.warn('[PSBot] aim', e); return null; }
      }
      return orig.call(this);
    };
    // 遊戲拿到方向後會自己挑「那個方向上最近的怪」當鎖定目標（潮旋放在牠身上）；改成直接鎖集火的那隻
    const origAlong = proto.enemyAlong;
    if (typeof origAlong === 'function') proto.enemyAlong = function (all, a) {
      const fe = S.focusEnemy;
      if (cfg.on && cfg.focus && this === ns.Game.player && fe && !fe.dead) return fe;
      return origAlong.call(this, all, a);
    };
    S.aimHooked = true;
  }
  // 審判：阿爾宙斯打不死（只記 5% → 1% 的傷害給傷害排行），傳說每 5 秒來一隻、沒有上限、血一隻比一隻多 25%，
  // 而且跑得至少有你 80% 快。不打掉就越積越多，把人逼到牆邊。所以只集火傳說：挑最快打得死的
  //（通常是先來的，血比較少），子彈路線上擋著阿爾宙斯的方向扣分（牠會把子彈吃掉）
  function focusAim(ns, p) {
    if (!cfg.on || !cfg.focus || ns.Game.state !== 'playing') return null;
    const judging = !!(ns.Judgment && ns.Judgment.active);
    const m = p.activeMove && p.activeMove();
    if (!m || m.kind !== 'projectile') return null;
    const reach = Math.min(520, (m.speed || 300) * (m.life || 1.5));
    const list = [];
    let arc = null;
    for (const e of ns.EnemyMgr.all()) {
      if (e.dead || e.silent) continue;
      const dx = e.x - p.x, dy = e.y - p.y, d = Math.hypot(dx, dy);
      if (e.arceus) { if (d > 1) arc = { e, dx, dy, d }; continue; }
      if (judging && !e.boss) continue;
      if (!judging && e.boss && d < 330) return null;
      if (d > 1 && d < reach) list.push({ e, dx, dy, d });
    }
    if (!list.length) return null;
    // 只集火「子彈打得到」的怪：被樹 / 石頭 / 牆擋住的不選（不然會為了打牠一直跑去找角度，光球都不撿）
    const W = ns.World;
    if (W && W.projectileBlock) {
      const lift = ns.LIFT || 0;
      const clear = c => { const n = Math.ceil(c.d / 16); for (let i = 1; i < n; i++) if (W.projectileBlock(p.x + c.dx * i / n, p.y + c.dy * i / n - lift, 4)) return false; return true; };
      list.sort((a, b) => a.d - b.d);
      const vis = list.slice(0, 24).filter(clear);
      if (!vis.length) return null;   // 一隻都打不到：交回遊戲的自動瞄準，走位那邊會去找射擊角度
      list.length = 0; list.push(...vis);
    }
    if (judging && arc) list.push(Object.assign(arc, { block: true }));
    const dmg = (m.dmg || 10) * (p.atkFor ? p.atkFor(m) : 1);
    const mult = e => (ns.Types && ns.Types.mult ? ns.Types.mult(m.type, e.types) : 1) * (ns.Weather && ns.Weather.mult ? ns.Weather.mult(m.type) : 1);
    const pierce = (m.pierce | 0) + 1, w = m.size || 6;
    let best = null, bs = -Infinity;
    for (const c of list) {
      const ux = c.dx / c.d, uy = c.dy / c.d, hits = [];
      if (c.block) continue;
      for (const o of list) {
        const al = o.dx * ux + o.dy * uy;
        if (al > 0 && Math.abs(o.dx * uy - o.dy * ux) < (o.e.r || 12) + w + (o.block ? 18 : 0)) hits.push([al, o.e]);
      }
      hits.sort((a, b) => a[0] - b[0]);
      let s = -c.d / 3000;
      for (const [, e] of hits.slice(0, pierce)) {
        if (e.arceus) { s -= 1; break; }
        const hd = dmg * mult(e), hp = Math.max(1, e.hp || 1);
        s += hd >= hp ? 1.2 : 0.6 * hd / hp;
        if (e.id === S.focusId) s += 0.02 + 0.6 * Math.min(1, hd / hp);   // 正在打的那隻：照進度加分，快死的黏住，打不動的不會死咬
      }
      if (s > bs) { bs = s; best = c; }
    }
    S.focusId = best.e.id; S.focusEnemy = best.e;
    if (!cfg.lead) return Math.atan2(best.e.y - p.y, best.e.x - p.x);
    // 預判：子彈飛過去要 距離 ÷ 子彈速度 秒，怪在動就往牠到時候的位置打（速度用前幾幀的位置估）
    const ev = S.ev || (S.ev = new Map()), now = performance.now(), e = best.e;
    const o = ev.get(e.id);
    // 速度取約 0.25 秒的平滑平均，另外記「速率」的平均：穩定往一個方向走時兩者差不多（一致度≈1），
    // 被潮旋吸住原地亂晃時平均速度會互相抵銷（一致度≈0）。只照一致的那部分預判，亂晃的就打牠現在的位置
    // 一致度用比較長的 0.6 秒平均算（短週期的亂晃在長平均裡會抵銷），速度本身用 0.25 秒的
    let vx = 0, vy = 0, sx = 0, sy = 0, sp = 0;
    if (o && now - o.t > 0 && now - o.t < 300) {
      const dts = (now - o.t) / 1000, ix = (e.x - o.x) / dts, iy = (e.y - o.y) / dts, a = 1 - Math.exp(-dts / 0.25), b = 1 - Math.exp(-dts / 0.6);
      vx = o.vx + (ix - o.vx) * a; vy = o.vy + (iy - o.vy) * a;
      sx = o.sx + (ix - o.sx) * b; sy = o.sy + (iy - o.sy) * b; sp = o.sp + (Math.hypot(ix, iy) - o.sp) * b;
    }
    ev.set(e.id, { x: e.x, y: e.y, t: now, vx, vy, sx, sy, sp });
    const cons = sp > 1 ? Math.min(1, Math.hypot(sx, sy) / sp) : 0;
    const lead = cons > 0.7 ? (cons - 0.7) / 0.3 : 0;
    vx *= lead; vy *= lead;
    if (ev.size > 200) ev.clear();
    // 會追人的怪（大部分小怪）不是照原本的方向走，而是一直轉向「你下一刻的位置」：
    // 人往側邊閃，牠跟著轉，照牠前幾幀的方向預判反而整排打到牠背後（人體描邊機）。
    // 所以追人的怪改成：算出子彈飛到時你在哪、牠朝那裡追了多遠；遠程 / 小偷才用看到的速度
    const pp = S.pPrev;
    let pvx = 0, pvy = 0;
    if (pp && now - pp.t > 0 && now - pp.t < 300) { const k = 1000 / (now - pp.t); pvx = (p.x - pp.x) * k; pvy = (p.y - pp.y) * k; }
    S.pPrev = { x: p.x, y: p.y, t: now };
    // 被潮旋吸住、卡在怪群裡的怪不會照速度追過來：看到的速度真的是「朝你跑」才用追人模型
    const ov = Math.hypot(vx, vy), ed = Math.hypot(p.x - e.x, p.y - e.y) || 1;
    const chaser = e.spd > 0 && !['ranged', 'thief', 'turret'].includes(e.behavior) && lead > 0.5 && ov > 0.3 * e.spd && (vx * (p.x - e.x) + vy * (p.y - e.y)) / (ov * ed) > 0.5;
    const spd = m.speed || 300;
    let tx = e.x, ty = e.y;
    for (let i = 0; i < 3; i++) {
      const t = Math.min(m.life || 1.5, Math.hypot(tx - p.x, ty - p.y) / spd);
      if (chaser) {
        const fx = p.x + pvx * t, fy = p.y + pvy * t, gx = fx - e.x, gy = fy - e.y, gd = Math.hypot(gx, gy) || 1;
        // 用實際觀察到的速度（緩速、地形、天氣、擠在怪群裡都會變慢），不是怪的標準速度
        const step = Math.min(Math.min(e.spd, sp) * t, Math.max(0, gd - (e.r || 12) - (p.r || 12)));
        tx = e.x + gx / gd * step; ty = e.y + gy / gd * step;
      } else { tx = e.x + vx * t; ty = e.y + vy * t; }
    }
    return Math.atan2(ty - p.y, tx - p.x);
  }

  // ---------- 8. 走位 AI ----------
  // 每幀取樣 16 個方向 × 2 種距離，預測走過去之後的位置，算「危險 − 收益」成本，挑最低的。
  // 比單純的推力合成更會從怪群縫隙鑽出去，也不容易被夾在兩群怪中間。
  const FARM_KINDS = ['vortex', 'nova', 'aura', 'orbit', 'spin', 'meteor', 'quake'];
  const PICK_W = { xp: 1, xpBig: 3, coin: 2, magnet: 5, bomb: 2.5, ticket: 9, ticket10: 12, item: 9, sphere: 6, candy: 6, heal: 0.4 };
  const DIRS = Array.from({ length: 16 }, (_, i) => [Math.cos(i * Math.PI / 8), Math.sin(i * Math.PI / 8)]);
  const hazards = [];
  function trackHazards(ns) {
    if (!ns.Hazards || !ns.Hazards.add) return;
    const orig = ns.Hazards.add;
    ns.Hazards.add = function () { const h = orig.apply(this, arguments); if (h) hazards.push(h); return h; };
    const origClear = ns.Hazards.clear;
    ns.Hazards.clear = function () { hazards.length = 0; return origClear.apply(this, arguments); };
  }
  function inHazard(h, x, y, r) {
    if (h.kind === 'zone') return (x - h.x) ** 2 + (y - h.y) ** 2 < (h.r + r) ** 2;
    const c = Math.cos(h.angle || 0), s = Math.sin(h.angle || 0), dx = x - h.x, dy = y - h.y, along = dx * c + dy * s;
    return along > -r && along < (h.len || 0) + r && Math.abs(-dx * s + dy * c) <= (h.w || 0) / 2 + r;
  }

  // ---------- 8a. 尋路（A*，用遊戲自己的地形格子） ----------
  // 局部取樣只看得到身邊 200px，目標在牆 / 狹縫另一邊時會在牆前打轉；
  // 所以重要目標一律先用 A* 算出真正走得到的路線，再沿著路線上的點走
  // 液體（遊戲的 isFree 預設把液體當牆，要傳第 4 個參數才算可走，所以舊版以為河對面的光球吃不到）：
  // - 水 / 沼澤：只會變慢（×0.6 / ×0.45），走得過去；岩漿 / 毒池 / 電池：會扣血；冰：會滑
  // - 屬性免疫：水系不怕水和沼澤、火系不怕岩漿、毒 / 鋼不怕毒池、電 / 地面不怕電池、冰系不怕冰（遊戲的 liquidEffect 已經算進去）
  // - 特性：漂浮 = 完全不算進入液體；柔軟 / 我行我素 / 遲鈍 / 精神力這類「不受地形影響」= 不會變慢；魔法防守 / 水幕 = 不怕岩漿和毒
  const liquidOf = (ns, p) => {
    const W = ns.World, ab = p.abil || {};
    if (!W || !W.liquidEffect || ab.levitate) return {};
    const e = Object.assign({}, W.liquidEffect((p.mon && p.mon.types) || []) || {});
    if (ab.lavaProof) delete e.dmg;
    if (ab.steady) delete e.slow;
    return e;
  };
  const wetOk = (ns, p) => !liquidOf(ns, p).dmg;               // 不會扣血的液體就當成可以走
  const wetSlow = (ns, p) => liquidOf(ns, p).slow || 1;         // 走在液體裡的速度倍率（1 = 不受影響）
  const trapsNear = (W, x, y, r) => ((W && W.specialsNear && W.specialsNear(x, y, r)) || []).filter(t => t.type === 'trap');
  function findPath(ns, p, tx, ty, goalTol) {
    const W = ns.World, TS = W.TS || 32;
    if (!W.isFree) return null;
    const sx = Math.floor(p.x / TS), sy = Math.floor(p.y / TS), gx = Math.floor(tx / TS), gy = Math.floor(ty / TS);
    const span = Math.max(Math.abs(gx - sx), Math.abs(gy - sy)) + 20;
    if (span > 120) return null;                                   // 太遠了，不值得
    const traps = trapsNear(W, (p.x + tx) / 2, (p.y + ty) / 2, Math.hypot(tx - p.x, ty - p.y) / 2 + 200);
    const wet = wetOk(ns, p), wetCost = 1 / wetSlow(ns, p);   // 走水裡比較慢：成本照速度放大，太遠就繞、近的直接涉水
    const walk = new Map();
    const K = (x, y) => (x + 50000) * 100000 + (y + 50000);
    const ok = (x, y) => {
      const k = K(x, y);
      let v = walk.get(k);
      if (v === undefined) {
        const cx = x * TS + TS / 2, cy = y * TS + TS / 2;
        v = Math.abs(x - sx) <= span && Math.abs(y - sy) <= span && W.isFree(cx, cy, Math.min(p.r, TS * 0.45), wet)
          && !traps.some(t => (cx - t.x) ** 2 + (cy - t.y + 8) ** 2 < 26 * 26);
        walk.set(k, v);
      }
      return v;
    };
    const isGoal = (x, y) => Math.max(Math.abs(x - gx), Math.abs(y - gy)) <= goalTol;
    const h = (x, y) => { const dx = Math.abs(x - gx), dy = Math.abs(y - gy); return Math.max(dx, dy) + 0.414 * Math.min(dx, dy); };
    // 二元堆積
    const heap = [], push = n => { heap.push(n); let i = heap.length - 1; while (i) { const j = (i - 1) >> 1; if (heap[j].f <= n.f) break; heap[i] = heap[j]; i = j; } heap[i] = n; };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { let i = 0; for (;;) { let c = 2 * i + 1; if (c >= heap.length) break; if (c + 1 < heap.length && heap[c + 1].f < heap[c].f) c++; if (heap[c].f >= last.f) break; heap[i] = heap[c]; i = c; } heap[i] = last; } return top; };
    const g = new Map(), from = new Map();
    g.set(K(sx, sy), 0); push({ x: sx, y: sy, f: h(sx, sy) });
    let end = null, n = 0;
    while (heap.length && n++ < 8000) {
      const c = pop(), ck = K(c.x, c.y), cg = g.get(ck);
      if (isGoal(c.x, c.y)) { end = c; break; }
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        if (!dx && !dy) continue;
        const nx = c.x + dx, ny = c.y + dy;
        if (!ok(nx, ny) && !isGoal(nx, ny)) continue;
        if (dx && dy && (!ok(c.x + dx, c.y) || !ok(c.x, c.y + dy))) continue;   // 不切牆角
        const wetMul = wet && W.isLiquid && W.isLiquid(nx * TS + TS / 2, ny * TS + TS / 2) ? wetCost : 1;
        const ng = cg + (dx && dy ? 1.414 : 1) * wetMul, nk = K(nx, ny);
        if (ng < (g.get(nk) ?? Infinity)) { g.set(nk, ng); from.set(nk, ck); push({ x: nx, y: ny, f: ng + h(nx, ny) }); }
      }
    }
    if (!end) return null;
    const pts = [];
    for (let k = K(end.x, end.y); k !== undefined; k = from.get(k)) {
      const x = Math.floor(k / 100000) - 50000, y = (k % 100000) - 50000;
      pts.push([x * TS + TS / 2, y * TS + TS / 2]);
    }
    pts.reverse();
    pts[pts.length - 1] = [tx, ty];
    return { pts, len: g.get(K(end.x, end.y)) * TS + Math.hypot(tx - pts[pts.length - 1][0], ty - pts[pts.length - 1][1]) };
  }
  // 沿路線往前看：挑「直線走得到」的最遠那個點當作下一步要去的地方
  function waypoint(ns, p, path) {
    const W = ns.World, traps = trapsNear(W, p.x, p.y, 320);
    // 終點可能是實心的（祭壇、寶箱），只檢查到離終點 26px 為止，讓它能貼過去碰到
    const clear = (x, y) => {
      const d = Math.hypot(x - p.x, y - p.y), n = Math.ceil(d / 8);
      for (let i = 1; i <= n; i++) {
        if (d * (1 - i / n) < 26) break;
        const sx = p.x + (x - p.x) * i / n, sy = p.y + (y - p.y) * i / n;
        if (!W.isFree(sx, sy, p.r, wetOk(ns, p)) || traps.some(t => (sx - t.x) ** 2 + (sy - t.y + 8) ** 2 < 23 * 23)) return false;
      }
      return true;
    };
    // 先找路線上離自己最近的點，丟掉已經走過的
    let near = 0, nd = Infinity;
    path.pts.forEach(([x, y], i) => { const d = Math.hypot(x - p.x, y - p.y); if (d < nd) { nd = d; near = i; } });
    path.pts.splice(0, near);
    let wp = path.pts[0];
    for (let i = 1; i < Math.min(path.pts.length, 14); i++) {
      const [x, y] = path.pts[i];
      if (Math.hypot(x - p.x, y - p.y) > 260 || !clear(x, y)) break;
      wp = path.pts[i];
    }
    return { x: wp[0], y: wp[1], offPath: nd };
  }

  // ---------- 8b. 目標規劃：值多少 / 實際要走多遠 / 消失前趕不趕得到，選定後堅持到底 ----------
  function candidates(ns, p, hpPct) {
    const out = [], now = ns.Game.st.time, W = ns.World;
    if (hpPct > 0.2) for (const e of ns.EnemyMgr.all()) {
      if (e.dead || e.behavior !== 'thief') continue;
      // 小偷：Gholdengo 掉十連抽券、喵喵掉金幣；不打人、會逃（速度 92），出現 15 秒後消失
      S.seen[e.id] = S.seen[e.id] ?? now;
      const gold = (e.def && e.def.loot === 'ticket10') || e.dex === 1000;
      out.push({ key: 'thief' + e.id, x: e.x, y: e.y, tier: gold ? 5 : 3, value: gold ? 14 : 3, left: 15 - (now - S.seen[e.id]), mode: gold ? '追 Gholdengo' : '追喵喵', goalTol: 2, chase: true, flee: e.spd || 92 });
    }
    const rift = ns.Rift && ns.Rift.rift;
    // 裂縫只給羈絆。第一組已經綁滿 4 招就不用再進（再拿到羈絆只會被強制綁第二組），省時間也少冒險
    const bondDone = p.slots.some(g => g.length >= 4);
    const portalHp = (cfg.portal && cfg.portal.enterHp != null) ? cfg.portal.enterHp : 0.7;
    const portalDist = (cfg.portal && cfg.portal.enterDist != null) ? cfg.portal.enterDist : 300;
    const nearEnemyDist = (function(){ let d=9999; for(const e of ns.EnemyMgr.all()){ if(e.dead) continue; d=Math.min(d,Math.hypot(e.x-p.x,e.y-p.y)); } return d; })();
    // 回血池安全評估：周圍敵人距離
    const springSafeDist = nearEnemyDist;
    const springSafe = springSafeDist > 150 || hpPct < 0.25;  // 安全距離或緊急
    const lateGame = (ns.Game.st.time || 0) > 1200;
    const portalBonus = lateGame ? ((cfg.portal && cfg.portal.lateGameBonus) || 2.0) : 1.0;
    const portalSafe = hpPct > portalHp && nearEnemyDist > portalDist * 0.5;
    if (cfg.rift && rift && !ns.Rift.inArena && hpPct > 0.2 && !bondDone && (portalSafe || (cfg.portal && cfg.portal.riskTolerance > 0.7)))
      out.push({ key: 'rift', tier: 4, x: rift.x, y: rift.y - 10, value: 12 * portalBonus, left: rift.ttl ?? 45, mode: '進裂縫', goalTol: 0, chase: true, direct: true });
    const lost = ns.Events && ns.Events._dbg && ns.Events._dbg();
    if (lost && hpPct > 0.25 && !ns.Rift.inArena) {
      if (lost.state === 'wait') out.push({ key: 'lost', tier: 3, x: lost.x, y: lost.y, value: 8, left: 90, mode: '去救援', goalTol: 1, chase: true });
      else out.push({ key: 'escort', tier: 3, x: lost.tx, y: lost.ty, value: 9, left: 90, mode: '護送中', goalTol: 0, chase: true, hold: 20, escort: true });
    }
    // 對著牆打超過 0.4 秒：在被鎖定的那隻怪周圍找「看得到牠、又站得住」的點，用 A* 繞過去
    const lt = S.losTarget;
    if (lt && !lt.dead && !lt.arceus && !(ns.Judgment && ns.Judgment.active) && S.losBadT > 0.25 && W && W.isFree && W.projectileBlock) {
      const clearShot = (x, y) => { const d = Math.hypot(lt.x - x, lt.y - y), n = Math.ceil(d / 12); for (let i = 1; i < n; i++) if (W.projectileBlock(x + (lt.x - x) * i / n, y + (lt.y - y) * i / n - (ns.LIFT || 0), 4)) return false; return true; };
      const spots = [];
      for (const r of [140, 220, 300]) for (let k = 0; k < 24; k++) {
        const a = k / 24 * 6.2832, x = lt.x + Math.cos(a) * r, y = lt.y + Math.sin(a) * r;
        if (W.isFree(x, y, p.r + 4, wetOk(ns, p)) && clearShot(x, y)) spots.push({ x, y, d: Math.hypot(x - p.x, y - p.y) });
      }
      spots.sort((a, b) => a.d - b.d);
      for (const sp of spots.slice(0, 2)) out.push({ key: 'los' + Math.round(sp.x / 64) + ',' + Math.round(sp.y / 64), tier: 1, x: sp.x, y: sp.y, value: 6, left: Infinity, mode: '找射擊角度', goalTol: 0, chase: true });
    }
    if (!ns.Rift.inArena && W && W.specialsNear) for (const o of W.specialsNear(p.x, p.y, 700)) {
      // 祭壇（25 秒 buff：傷害×2 / 速度 / 磁吸×4 / 冷卻-40%）、泉水（回血）、大寶箱（站 3.5 秒開箱）
      if (o.type === 'altar' && !o.used) out.push({ key: 'altar' + o.id, tier: 2, x: o.x, y: o.y, value: 5, left: Infinity, mode: '吃 buff', goalTol: 1, chase: true });
      else if (o.type === 'spring' && hpPct < (((cfg.steer && cfg.steer.springHp) || 0.6)) && (o.charge ?? 1) > 0.2 && (springSafe || hpPct < 0.25)) out.push({ key: 'spring' + o.id, tier: 2, x: o.x, y: o.y - 8, value: 7, left: Infinity, mode: '泉水回血', goalTol: 0, hold: 20, until: () => p.hp >= p.maxHp * 0.95 });
      else if (o.type === 'bigchest' && hpPct > 0.5) {
        // 遊戲的判定：站在離寶箱中心 46px 內滿 3.5 秒。寶箱本身是實心的，旁邊又常有樹，
        // 舊版走向寶箱中心、要求 34px 內才停，被樹擋住就一直蹭樹開不到。
        // 改成先在寶箱周圍 22~34px 找一個站得下的空位，走到那個點站著（離空位 10px 內 = 離寶箱 44px 內）
        let spot = null, sd = Infinity;
        for (const r of [22, 28, 34]) for (let k = 0; k < 16; k++) {
          const a = k / 16 * 6.2832, x = o.x + Math.cos(a) * r, y = o.y + Math.sin(a) * r;
          if (!W.isFree || W.isFree(x, y, p.r + 2)) { const d = Math.hypot(x - p.x, y - p.y); if (d < sd) { sd = d; spot = { x, y }; } }
        }
        if (spot) out.push({ key: 'chest' + o.id, tier: 2, x: spot.x, y: spot.y, value: 3, left: Infinity, mode: '開寶箱', goalTol: 0, hold: 10 });
      }
    }
    return out;
  }
  function plan(ns, p, hpPct) {
    const now = performance.now();
    const pSpd = (p.baseSpd || 100) * (p.spdMul || 1);
    const cur = S.plan;
    const gt = ns.Game.st.time;
    const cands = candidates(ns, p, hpPct).filter(c => !(S.ban[c.key] > gt));
    // 目前的計畫還在就更新目標位置（小偷會跑、護送會從「去救援」變成「去標記」）
    const live = cur && cands.find(c => c.key === cur.key);
    const higher = cur && cands.some(c => c.tier > cur.c.tier && !(S.noGo[c.key] > now));
    const stale = !live || higher || now - cur.at > 600 || Math.hypot(live.x - cur.c.x, live.y - cur.c.y) > 48 || (cur.path && cur.path.pts.length < 2);
    if (!stale) { cur.c = Object.assign(cur.c, live, { x: cur.c.x, y: cur.c.y }); return cur; }
    // 重新評估：每個候選都真的算一次路線
    // 先比等級，同一級才比「價值 ÷ 要走多久」：Gholdengo(5) > 裂縫(4) > 求救 / 喵喵(3) > 祭壇 / 泉水 / 寶箱(2) > 找射擊角度(1)。
    // 以前全部混在一起比分數，旁邊一步就到的小事（例如換射擊角度）會贏過遠一點的裂縫
    let best = null, bestScore = 0, bestTier = -1;
    const order = cands.sort((a, b) => (b.tier - a.tier) || (b.value / Math.hypot(b.x - p.x, b.y - p.y) - a.value / Math.hypot(a.x - p.x, a.y - p.y)));
    for (const c of order) {
      if (c.tier < bestTier) break;                    // 已經有更高一級、而且趕得到的目標

      const path = findPath(ns, p, c.x, c.y, c.goalTol);
      if (!path) { S.noGo[c.key] = now + 1000; continue; }   // 走不到：1 秒內不再重算
      // 趕不趕得到：小偷要追進念力射程（約 220px），它也在跑，只能靠速度差慢慢拉近
      const eta = c.flee ? Math.max(0, path.len - 220) / Math.max(8, pSpd - c.flee) : path.len / pSpd;
      if (eta > c.left - 1) { S.noGo[c.key] = now + 1000; continue; }   // 趕不到
      const score = c.value / (eta + 4) * (cur && cur.key === c.key ? 1.8 : 1);   // 同一級裡，已經在做的事加分，不會被半路拉走
      if (c.tier > bestTier || score > bestScore) { bestTier = c.tier; bestScore = score; best = { key: c.key, c, path, at: now, eta }; }
    }
    S.plan = best;
    return best;
  }

  function pickTarget(ns, p, enemies, hpPct, fear) {
    let pl = plan(ns, p, hpPct);
    // 找射擊角度是最低優先：附近有光球可撿就先撿（經驗比較重要），撿完還打不到才去換位置
    if (pl && pl.key.startsWith('los') && !S.losDefer) {
      S.losDefer = true;
      const orb = pickTarget(ns, p, enemies, hpPct, fear);
      S.losDefer = false;
      if (orb && orb.orb) return orb;
    }
    if (pl && S.losDefer && pl.key.startsWith('los')) pl = null;
    if (pl) {
      const c = pl.c;
      const wp = waypoint(ns, p, pl.path);
      if (wp.offPath > 3 * (ns.World.TS || 32)) pl.at = 0;   // 被技能擠離路線太遠：下一幀重算
      return { x: wp.x, y: wp.y, fx: c.x, fy: c.y, w: 6, mode: c.mode, chase: c.chase, hold: c.hold, until: c.until, escort: c.escort, direct: c.direct };
    }
    const W = ns.World;
    // 撿光球：挑一團「總價值 / 距離」最高的，把那一團的位置固定下來一路走過去，
    // 走到磁吸範圍蓋住它（或撿完、或超時）才換下一團。
    // 舊版每幀把目標改成「那一團裡離我最近的那顆」，光球一被吸走目標就跳一次，人就左右抽搐
    const mag = p.magnet || 78;
    const gt = ns.Game.st.time;
    const pSpd = (p.baseSpd || 100) * (p.spdMul || 1);
    const traps = ((W && W.specialsNear && W.specialsNear(p.x, p.y, 600)) || []).filter(t => t.type === 'trap');
    const onTrap = k => traps.some(t => (k.x - t.x) ** 2 + (k.y - t.y + 8) ** 2 < 23 * 23);
    // 掉在陷阱上的球不撿（走進磁吸範圍就會自己飛過來，不用踩上去）。
    // 撿光球永遠比遛怪優先，畫面外的也去撿（光球不會消失，放著就是白白浪費經驗）；
    // 路上的怪和招式交給走位的扣血成本去閃
    S.orbBan = (S.orbBan || []).filter(b => b.until > gt);
    const banned = k => S.orbBan.some(b => Math.abs(k.x - b.x) < 70 && Math.abs(k.y - b.y) < 70);
    const all = ns.Pickups.all();
    // 「磁鐵」道具會把全地圖的光球一次吸過來：地上光球越多越值得去撿
    let loose = 0;
    for (const k of all) if (!k.pulled && (k.kind === 'xp' || k.kind === 'xpBig')) loose += k.kind === 'xpBig' ? 3 : 1;
    const wOf = k => k.kind === 'heal' ? (hpPct < 0.7 ? 8 : 0.2) : k.kind === 'magnet' ? 5 + loose * 0.4 : (PICK_W[k.kind] ?? 1);
    // 已經被磁吸住、在後面追的光球：飛行速度約 240 + 1400/距離 px/s，移速點高之後跟人差不多快，
    // 一直跑就一直追不上（只有甩尾轉彎時才一次吸進來）。累積夠多、又落在後面時，往那團光球迎上去，
    // 兩邊對衝一下就吸完
    let pv = 0, px = 0, py = 0;
    for (const k of all) if (k.pulled && (k.kind === 'xp' || k.kind === 'xpBig')) { const w = k.kind === 'xpBig' ? 3 : 1; pv += w; px += k.x * w; py += k.y * w; }
    if (pv >= 6 && !(ns.Judgment && ns.Judgment.active)) {
      px /= pv; py /= pv;
      if (Math.hypot(px - p.x, py - p.y) > 60) return { x: px, y: py, w: 2.5, mode: '收經驗', orb: true };
    }
    const items = all.filter(k => !k.pulled && !(k.kind === 'heal' && hpPct >= 0.95) && !onTrap(k) && !banned(k));
    const clR = Math.max(90, mag * 0.8);   // 一團的範圍：站在中心時磁吸大概蓋得住
    const g = S.orbGoal;
    if (g && gt < g.until) {
      const d = Math.hypot(g.x - p.x, g.y - p.y);
      // 走了 3 秒還沒靠近 40px（被牆 / 岩壁擋住）：這一團 20 秒內不撿，換下一團
      // 在閃招 / 突圍時本來就走不過去，不算「被擋住」
      if (d < g.bestD - 40 || S.mode !== '撿光球') { g.bestD = Math.min(g.bestD, d); g.at = gt; }
      else if (gt - g.at > 3) { S.orbBan.push({ x: g.x, y: g.y, until: gt + 20 }); S.orbGoal = null; return pickTarget(ns, p, enemies, hpPct, fear); }
      let left = 0;
      for (const k of items) if (Math.abs(k.x - g.x) < clR && Math.abs(k.y - g.y) < clR) left += wOf(k);
      // 那一團的中心進到磁吸範圍就夠了，剩下的會自己飛過來，不用再走過去
      if (left > 0 && d > mag * 0.85 && !(S.farm && d > 440)) return { x: g.x, y: g.y, w: 2, mode: '撿光球', orb: true };
    }
    let best = null, bestS = 0;
    const [ox, oy] = S.out || [0, 0];
    // 地上可能有好幾百顆：只拿最近的 120 顆當候選（每團的價值還是用全部的球算）
    const seeds = items.length > 120 ? items.map(k => [Math.hypot(k.x - p.x, k.y - p.y), k]).sort((a, b) => a[0] - b[0]).slice(0, 120).map(x => x[1]) : items;
    for (const k of seeds) {
      const dx = k.x - p.x, dy = k.y - p.y, d = Math.hypot(dx, dy);
      if (d < mag * 0.9) continue;   // 已經在磁吸範圍內 / 邊上：會自己飛過來，不用刻意去撿
      if (S.farm && d > 400) continue;   // 養怪中不跑遠：光球掉在怪群旁邊，繞圈時就吸到了；遠的等怪少了再撿
      let cluster = 0;
      for (const o of items) if (Math.abs(o.x - k.x) < clR && Math.abs(o.y - k.y) < clR) cluster += wOf(o);
      let crowd = 0;
      for (const e of enemies) if (!e.dead && Math.abs(e.x - k.x) < 70 && Math.abs(e.y - k.y) < 70) crowd += e.boss ? 5 : 1;
      // 順路的稍微加分（同樣價值時先撿前面的，少折返），身後的照樣會去撿
      const ahead = (ox * dx + oy * dy) / (d || 1);
      const s = cluster / (d + 120) / (1 + crowd * 0.35 * fear) * (1 + 0.3 * ahead);
      if (s > bestS) { bestS = s; best = k; }
    }
    if (best) {
      const d = Math.hypot(best.x - p.x, best.y - p.y);
      S.orbGoal = { x: best.x, y: best.y, until: gt + 1.5 + 2 * d / pSpd, bestD: d, at: gt };
      return { x: best.x, y: best.y, w: 2, mode: '撿光球', orb: true };
    }
    S.orbGoal = null;
    // 沒東西撿：主動去找最近的怪群（停在安全距離外讓招式打），越快清怪經驗越多
    if (hpPct > 0.5) {
      let hunt = null, hd = Infinity;
      for (const e of ns.EnemyMgr.all()) {
        if (e.dead || e.silent) continue;
        const d = Math.hypot(e.x - p.x, e.y - p.y);
        if (d < hd) { hd = d; hunt = e; }
      }
      // 畫面內（600px）還有怪就不去找，交給遛怪讓牠們跟上來。遛怪時怪本來就會落後一段，
      // 門檻太近會變成「往前遛 → 怪落後 → 回頭找 → 怪又靠近 → 往前遛」一直來回跑
      if (hunt && hd > 600) return { x: hunt.x, y: hunt.y, w: 0.8, mode: '找怪' };
    }
    return null;
  }

  function steer(ns) {
    const p = ns.Game.player;
    if (!p || p.dead) return [0, 0];
    const now = performance.now();
    const dt = Math.min(0.1, (now - S.lastT) / 1000); S.lastT = now;
    const gt = ns.Game.st.time;
    const hpPct = p.hp / p.maxHp;
    // 血量健康時幾乎不躲小怪（超夢打得死），只躲首領 / 彈幕 / 地面預警；越殘越怕。
    // 門檻與倍率會依「記錄模式學到的人類走位」微調；沒樣本時就是原本的 0.35 / 0.6 / ×1
    const fm = fearModel();
    let fear = hpPct < fm.low ? 2.5 : hpPct < fm.mid ? 1 : 0.25;
    if (fm.k !== 1) fear *= fm.k;
    // 養怪：手上有範圍招、血量健康時，繞小圈讓怪全部擠在圈裡，範圍招一次打一整團。
    // 怪越多範圍招越賺（貝殼之鈴照傷害回血，打越多回越多），場上 ≥54 隻時新生的怪是精英（經驗 ×1.6）。
    // 血掉到 45% 以下就退回一般走位，回到 65% 再開
    const aoe = p.activeGroup && p.activeGroup().some(m => FARM_KINDS.includes(m.kind));
    const farmOff = (cfg.steer && cfg.steer.farmHpOff != null) ? cfg.steer.farmHpOff : 0.45;
    const farmOn = (cfg.steer && cfg.steer.farmHpOn != null) ? cfg.steer.farmHpOn : 0.65;
    S.farm = cfg.farm && aoe && !(ns.Rift && ns.Rift.inArena) && !(ns.Judgment && ns.Judgment.active) && (S.farm ? hpPct > farmOff : hpPct > farmOn);
    // 養怪時要待在怪群旁邊：小怪的危險度降一點，不然一靠近就切去「躲避」，圈繞不起來。
    // 但不能降太多（v1.8.0 降到 0.08 會直接衝進怪潮邊緣硬扛）；血越少越怕。首領、地面預警照樣躲
    if (S.farm) fear = Math.min(fear, hpPct > 0.8 ? 0.15 : 0.2);

    const near = [];
    for (const e of ns.EnemyMgr.all()) {
      if (e.dead || e.silent) continue;
      if (e.behavior === 'thief') continue;   // 小偷不會打人，不用躲
      if (Math.abs(e.x - p.x) < 360 && Math.abs(e.y - p.y) < 360) near.push(e);
    }
    const shots = ns.Projectiles.all().filter(s => !s.friendly && Math.abs(s.x - p.x) < 300 && Math.abs(s.y - p.y) < 300);
    for (let i = hazards.length - 1; i >= 0; i--) { const h = hazards[i]; if (h.hit && h.t >= h.delay + h.end) hazards.splice(i, 1); }

    // 阿爾宙斯的審判（第 30 分鐘）：被傳送到半徑約 22.6 格的遺跡，阿爾宙斯打不死、會一直追，
    // 速度是「你的速度 × 0.74 → 1.22」（約 20 秒後就比你快），碰到扣 40% 最大 HP；
    // 光柱雨 / 十字光束 / 衝擊波各扣 30~40%，全部無視防禦。只能閃，所以照秘境的方式繞場地邊緣。
    // 場地中心不會直接給：動畫期間玩家被放在「中心往下 3 格」，在那時記下來
    const J = ns.Judgment;
    const unitPx = (ns.Tiles && ns.Sprites) ? ns.Tiles.T * ns.Sprites.PX : 32;
    const judging = !!(J && J.active);
    if (!judging) S.jCenter = null;
    else {
      const wa = ns.World && ns.World.arena;   // 遊戲自己記的場地：{tx, ty, r, type:'judgment'}（格子座標）
      if (wa && wa.type === 'judgment') S.jCenter = { x: wa.tx * unitPx + unitPx / 2, y: wa.ty * unitPx + unitPx / 2 };
      else if (!S.jCenter) S.jCenter = { x: p.x, y: p.y - 3 * unitPx };   // 備用：開打時玩家在中心往下 3 格
    }
    const arceus = judging ? ns.EnemyMgr.all().find(e => e.arceus) : null;

    let target = pickTarget(ns, p, near, hpPct, fear);
    if (target && target.escort) fear = Math.max(fear, 1);   // 護送時跟在後面的寶可夢會被怪碰傷，要繞開怪群
    // 審判中只撿就在旁邊、而且阿爾宙斯離很遠的光球；不然光球（常掉在神獸旁邊）會把人拉進危險
    if (judging && target && !(target.orb && Math.hypot(target.x - p.x, target.y - p.y) < 140 && (!arceus || Math.hypot(arceus.x - p.x, arceus.y - p.y) > 320))) target = null;
    const arena = (ns.Rift && ns.Rift.inArena) || judging;
    const W = ns.World;

    const pSpd = (p.baseSpd || 100) * (p.spdMul || 1);
    // 小怪的危險度乘 fear（血多就不太躲）；首領本體、彈幕、地面預警不管血量都要躲
    const bigFear = Math.max(1, fear);
    // 實際會扣多少血（佔最大 HP 的比例）。遊戲規則：
    // - 被碰到 / 被子彈打到後有 0.45 秒無敵，同時被 10 隻碰也只扣一次 → 只算「最痛的那一下」，不是怪越多越痛
    // - 地面預警（落石、首領招式）打下來會先清掉無敵，一定扣、而且會疊加 → 一個一個加起來
    // 後期招式密到一定躲不掉時，靠這個挑「扣最少血」的位置；躲得掉的話成本是 0，自然選完全躲開的位置
    const red = 1 - Math.min(0.8, p.reduction ?? p.dmgReduce ?? 0);
    const hitFrac = (dmg, pure) => Math.min(1, (dmg || 0) * (pure ? 1 : red) / p.maxHp);
    const hazFrac = h => Math.min(1, (h.pct ? Math.max(h.dmg || 0, p.maxHp * h.pct) : (h.dmg || 0)) * (h.pure ? 1 : red) / p.maxHp);
    // 扣 10% 血 ≈ 成本 9~16，血越少越在意。被小怪碰一下（有無敵時間、不會疊加）在血量健康時不太在意，
    // 不然撿光球時每隻迎面走來的怪都會讓人轉頭閃一下又轉回來（抽搐）
    const DMG_W = hpPct < 0.6 ? 160 : 90, TOUCH_W = S.farm ? (hpPct > 0.8 ? 16 : 24) : hpPct < 0.35 ? 160 : hpPct < 0.6 ? 100 : 30;
    // 子彈的危險度：養怪時照實際傷害打折（小怪的子彈扣 2% 血只算三成多），痛的（首領）照舊
    const shotW = sh => S.farm ? Math.min(1, 0.2 + 8 * hitFrac(sh.dmg, false)) : 1;
    const danger = (x, y, tAhead) => {
      let c = 0, big = 0, worst = 0, haz = 0;
      for (const e of near) {
        // 敵人也會往我們走：預測它追上來的距離。跑得快（像 runner 會預判衝刺）的範圍放大，
        // 撞一下很痛的權重加重
        // 阿爾宙斯在遊戲裡是「傷害 0、速度 0」的假敵人（真正的移動和扣血另外算），要手動當成最危險的首領
        const spd = e.arceus ? pSpd * 1.2 : e.spd || 40, fast = Math.min(2, spd / pSpd);
        const d = Math.hypot(x - e.x, y - e.y) - (e.r || 10) - p.r - spd * tAhead * 0.8;
        const reach = (e.arceus ? 140 : e.boss ? 90 : 35) + 45 * fast;
        const w = e.arceus ? 8 : (e.boss ? 4 : 1) * Math.min(3, Math.max(0.5, (e.dmg || 10) / (p.maxHp * 0.12)));
        const v = w * Math.exp(-Math.max(d, -20) / reach);
        if (e.boss || e.arceus) big += v; else c += v;
        // 碰到的機率：已經貼著 = 1，越遠越低
        const touch = Math.exp(-Math.max(0, d) / 18);
        worst = Math.max(worst, touch * (e.arceus ? 0.4 : hitFrac(e.dmg, false)));
      }
      for (const s of shots) {
        const sx = s.x + (s.vx || 0) * tAhead, sy = s.y + (s.vy || 0) * tAhead;
        const d = Math.hypot(x - sx, y - sy) - (s.r || 6) - p.r;
        big += 6 * shotW(s) * Math.exp(-Math.max(d, -10) / 30);
        worst = Math.max(worst, Math.exp(-Math.max(0, d) / 20) * Math.max(0.03, hitFrac(s.dmg, false)));
      }
      for (const h of hazards) if (!h.hit && inHazard(h, x, y, p.r)) { big += 25; haz += hazFrac(h); }
      return c * fear + big * bigFear + worst * TOUCH_W + haz * DMG_W;
    };

    // 障礙物：沿路每 12px 檢查一次能不能走；終點周圍越多牆（死角、窄縫）扣越多分，
    // 免得被小怪逼進樹叢和石頭之間卡死
    const wet = wetOk(ns, p), slowWet = wet && wetSlow(ns, p) < 1 && W && W.isLiquid;
    const free = (x, y) => !W || !W.isFree || W.isFree(x, y, p.r, wet);
    // 地上的陷阱（扁平、不擋路，踩到才觸發；遊戲判定點在 y-8、半徑 13）。當成「不能走的格子」處理，
    // 再多留 10px 安全距離
    const traps = ((W && W.specialsNear && W.specialsNear(p.x, p.y, 400)) || []).filter(t => t.type === 'trap');
    const onTrap = (x, y) => traps.some(t => (x - t.x) ** 2 + (y - t.y + 8) ** 2 < 23 * 23);
    const pathLen = (dx, dy, step) => {
      for (let t = 12; t <= step; t += 12) {
        const x = p.x + dx * t, y = p.y + dy * t;
        if (!free(x, y) || onTrap(x, y)) return t - 12;
      }
      return step;
    };
    const RING = DIRS.filter((_, i) => i % 2 === 0);
    const cramped = (x, y) => { let n = 0; for (const [rx, ry] of RING) if (!free(x + rx * 45, y + ry * 45)) n++; return n; };

    // 念力的鎖定規則：330px 內有首領就打首領，否則打 520px 內最近的。子彈會被牆、樹、石頭擋掉，
    // 所以站的位置要讓「會被鎖定的那隻」跟自己之間沒有障礙物，不然只是在打牆
    const los = (x1, y1, x2, y2) => {
      if (!W || !W.projectileBlock) return true;
      const d = Math.hypot(x2 - x1, y2 - y1), n = Math.ceil(d / 12);
      for (let i = 1; i < n; i++) if (W.projectileBlock(x1 + (x2 - x1) * i / n, y1 + (y2 - y1) * i / n - (ns.LIFT || 0), 4)) return false;
      return true;
    };
    const aimTargets = near.slice().sort((a, b) => Math.hypot(a.x - p.x, a.y - p.y) - Math.hypot(b.x - p.x, b.y - p.y)).slice(0, 10);
    const lockedFrom = (x, y) => {
      const fe = cfg.focus && S.focusEnemy && !S.focusEnemy.dead && !S.focusEnemy.arceus ? S.focusEnemy : null;
      if (fe && Math.hypot(fe.x - x, fe.y - y) < 520) return fe;   // 集火中：看的是正在打的那隻
      let boss = null, bossScore = -Infinity, nearest = null, nd = 520;
      for (const e of aimTargets) {
        if (e.arceus) continue;   // 阿爾宙斯打不死，不為了打牠去換位置（舊版會在牠身邊找射擊角度，直接走過去送死）
        const d = Math.hypot(e.x - x, e.y - y);
        if (e.boss && d < 330) {
          // 優先攻擊：血量最低（最容易擊殺）+ 傷害最高（最危險）的 boss
          // 不是「第一支打完才打第二支」，而是同時考慮所有 boss 的威脅
          const hpRatio = e.maxHp > 0 ? (e.hp || 0) / e.maxHp : 1;
          const threat = (e.dmg || 10) * (1 - hpRatio * 0.5) / Math.max(1, d);
          if (threat > bossScore) { bossScore = threat; boss = e; }
        }
        if (d < nd) { nd = d; nearest = e; }
      }
      return boss || nearest;
    };
    const blockedShot = (x, y) => { const e = lockedFrom(x, y); return e && !los(x, y, e.x, e.y) ? 1 : 0; };
    // 範圍招（放射狀、連鎖…）不只打鎖定的那隻：也看最近 6 隻裡有幾隻被岩壁 / 樹擋住
    const shootable = aimTargets.filter(e => !e.arceus && Math.hypot(e.x - p.x, e.y - p.y) < 520).slice(0, 6);
    const blockedFrac = (x, y) => { if (!shootable.length) return 0; let b = 0; for (const e of shootable) if (!los(x, y, e.x, e.y)) b++; return b / shootable.length; };
    S.losTarget = lockedFrom(p.x, p.y);
    S.losBadT = blockedShot(p.x, p.y) || blockedFrac(p.x, p.y) >= 0.5 ? (S.losBadT || 0) + dt : 0;
    if (S.losBadT === 0 && S.plan && S.plan.key.startsWith('los')) S.plan = null;   // 已經打得到了，不用再往那個點走
    // 打不到就沒經驗：對著牆打超過 0.25 秒就積極換位置（比閃小傷害重要），除非正在做更重要的事（plan 會先選它們）
    const losW = S.losBadT > 0.25 ? 6 : 2;

    const here = danger(p.x, p.y, 0);

    // 遛狗：繞一個固定的大圈一直跑，怪全部排在身後當尾巴，念力自動往後打；
    // 怪死在路上掉的光球，下一圈經過時順便吸走。
    // 圈心固定（S.loopC），方向固定（S.spin）。追小偷 / 進裂縫回來後，或圈上被擋住，就以目前位置重新畫圈
    let kite = null;
    S.stand = false;
    // 有目標（光球、事件…）就專心走過去，不同時繞圈；只有真的沒事做、或正在被圍攻時才遛怪。
    // 兩股力量同時拉，就會前後來回跑
    const hadTarget = S.hadTarget; S.hadTarget = !!target && here <= 2;
    const ar = judging ? (S.jCenter && { x: S.jCenter.x, y: S.jCenter.y, r: 24, judge: true }) : arena && ns.Rift.arena;
    if (ar) {
      // 秘境（裂縫）打神獸：神獸會輪流切換「遠距 / 近身」模式，近身時直接追人（暴怒後比玩家快），
      // 125px 內放重擊、320px 內放衝撞，被貼臉打一套就死。場地只有半徑約 300px，直線後退一定撞牆，
      // 所以沿著場地邊緣內側那一圈跑，永遠往「讓神獸留在場地對面」的方向繞；預警範圍照樣閃
      const boss = ar.judge ? arceus : (ar.bossId && ns.EnemyMgr.get && ns.EnemyMgr.get(ar.bossId)) || near.find(e => e.boss);
      const unit = unitPx;
      const edge = Math.max(80, (ar.r - 1.4) * unit - p.r - 6);   // 場地內可站的最大半徑
      // 秘境繞邊緣（0.82）；審判的神獸會在離中心 18~21 格的邊緣出現，繞太外面會一直撞上剛出生的神獸，
      // 模擬比較過 0.82 / 0.65 / 0.55 / 0.45，0.55 最穩
      const ring = edge * (ar.judge ? 0.55 : 0.82);
      let px0 = p.x - ar.x, py0 = p.y - ar.y; const pr = Math.hypot(px0, py0) || 1;
      const pa = Math.atan2(py0, px0);
      let kx = 0, ky = 0, w = 1.8;
      if (boss && !boss.dead) {
        const ba = Math.atan2(boss.y - ar.y, boss.x - ar.x);
        let delta = pa - ba; while (delta > Math.PI) delta -= 2 * Math.PI; while (delta < -Math.PI) delta += 2 * Math.PI;
        // 往增加「跟神獸的角度差」的方向繞；已經在正對面附近就維持原方向，避免左右猶豫
        if (Math.abs(delta) < Math.PI * 0.85) S.spin = delta >= 0 ? 1 : -1;
        const aim = pa + S.spin * 0.55;
        kx = ar.x + Math.cos(aim) * ring - p.x; ky = ar.y + Math.sin(aim) * ring - p.y;
        const bd = Math.hypot(p.x - boss.x, p.y - boss.y);
        if (bd < (ar.judge ? 240 : 180)) {                   // 已經被貼近：先拉開距離最重要（阿爾宙斯碰一下 40%，留更多空間）
          const ux = (p.x - boss.x) / (bd || 1), uy = (p.y - boss.y) / (bd || 1);
          const kl0 = Math.hypot(kx, ky) || 1;
          kx = kx / kl0 + ux * 1.5; ky = ky / kl0 + uy * 1.5;
          w = 3.5;
        }
      } else if (!ar.judge) {
        kx = ar.x - p.x; ky = ar.y - p.y;                   // 秘境的神獸還沒出來：先站中間
        if (pr < 40) kx = ky = 0;
      }                                                     // 審判裡找不到阿爾宙斯：先不動（牠就降在中間附近）
      const kl = Math.hypot(kx, ky);
      if (kl > 0.01) kite = { x: kx / kl, y: ky / kl, w };
    } else if ((!target || here > 2) && !(target && target.hold) && !(target && target.chase && here < 4)) {
      if (hadTarget) S.loopC = null;   // 剛撿完光球 / 辦完事：以目前的前進方向重新畫圈，不要被拉回舊的圈上（會掉頭）
      let R = 380, c = S.loopC;
      const v = S.out || [1, 0];
      const anchor = () => ({ x: p.x - R * S.spin * v[1], y: p.y + R * S.spin * v[0] }); // 讓目前位置剛好在圈上、前進方向是切線
      // 養怪：圈心放在怪群中心、半徑 = 怪群半徑 + 130，沿著怪群外圍繞，怪往內擠成一團給範圍招打，
      // 人保持在外面。圈心慢慢跟著怪群移動（不要每幀跳）
      let herd = null;
      if (S.farm) {
        let n = 0, hx = 0, hy = 0;
        for (const e of near) if (!e.boss && Math.hypot(e.x - p.x, e.y - p.y) < 400) { n++; hx += e.x; hy += e.y; }
        if (n >= 6) {
          hx /= n; hy /= n;
          let sp = 0;
          for (const e of near) if (!e.boss && Math.hypot(e.x - p.x, e.y - p.y) < 400) sp += Math.hypot(e.x - hx, e.y - hy);
          herd = { x: hx, y: hy, r: sp / n };
        }
      }
      // 怪稀疏時（400px 內不到 6 隻）不繞圈：繞圈 = 一直側移，追過來的怪相對你是橫向移動，水槍（直線、不追蹤）
      // 很容易描邊；側移撞牆時還會原地抽搐找角度被貼臉。改成：太近就往正後方拉開，中距離站著打
      //（怪直線朝你走過來，幾乎必中），太遠才慢慢靠近。後面被牆擋住才退回繞圈
      let sparse = null;
      if (!herd) {
        let n = 0, cx = 0, cy = 0, ws = 0, dmin = Infinity;
        for (const e of near) {
          const d = Math.hypot(e.x - p.x, e.y - p.y);
          if (d > 450) continue;
          if (!e.boss) n++;
          const w = (e.boss ? 3 : 1) / Math.max(40, d);
          cx += e.x * w; cy += e.y * w; ws += w; dmin = Math.min(dmin, d - (e.r || 10));
        }
        if (n < 6 && ws > 0) {
          cx /= ws; cy /= ws;
          let ax = p.x - cx, ay = p.y - cy; const al = Math.hypot(ax, ay) || 1; ax /= al; ay /= al;
          // 三個狀態之間有緩衝（退到 300 才停、靠近到 340 才停），而且每個狀態至少維持 0.6 秒，
          // 不然怪在門檻附近一進一出，就會「退、停、退、停」一直抽
          const st = S.sparseSt, held = gt - (S.sparseAt || 0) < 0.6;
          let want = st || 'stand';
          if (!held) {
            if (dmin < 200 || (st === 'back' && dmin < 300)) want = 'back';
            else if (dmin > 430 || (st === 'near' && dmin > 340)) want = 'near';
            else want = 'stand';
          }
          if (dmin < 120) want = 'back';   // 已經快被貼臉：不管停留時間，馬上退
          if (want === 'back' && pathLen(ax, ay, 120) < 60) want = null;   // 後面是牆：退回繞圈
          if (want !== st) { S.sparseSt = want; S.sparseAt = gt; }
          if (want === 'back') sparse = { k: { x: ax, y: ay, w: 2.4 }, label: '拉開距離' };
          else if (want === 'near') sparse = { k: { x: -ax, y: -ay, w: 0.6 }, label: '靠近' };
          else if (want === 'stand') { S.stand = true; sparse = { k: { x: ax, y: ay, w: 0.3 }, label: '站樁輸出' }; }
        }
      }
      if (sparse) { kite = sparse.k; S.kiteLabel = sparse.label; }
      else {
        S.kiteLabel = S.farm ? '養怪' : '遛怪';
        if (herd) {
          R = Math.max(140, Math.min(240, herd.r + (hpPct > 0.8 ? 80 : 120)));   // 貼著怪群邊緣：太遠潮旋放不到主群、怪死的位置磁鐵也吸不到
          c = S.loopC = S.loopC && S.herdLoop ? { x: S.loopC.x + (herd.x - S.loopC.x) * Math.min(1, dt * 2), y: S.loopC.y + (herd.y - S.loopC.y) * Math.min(1, dt * 2) } : { x: herd.x, y: herd.y };
          S.herdLoop = true;
        } else {
          if (S.herdLoop) { S.herdLoop = false; c = S.loopC = null; }
          if (S.farm) R = 220;
          if (!c || Math.abs(Math.hypot(p.x - c.x, p.y - c.y) - R) > R * 0.6) c = S.loopC = anchor();
        }
        let rx = p.x - c.x, ry = p.y - c.y; const rd = Math.hypot(rx, ry) || 1; rx /= rd; ry /= rd;
        // 往圈上「前方 0.5 弧度」的那一點跑：自然沿著圓走，偏離時會被拉回圈上
        const ang = Math.atan2(ry, rx) + S.spin * 0.5;
        let kx = c.x + Math.cos(ang) * R - p.x, ky = c.y + Math.sin(ang) * R - p.y;
        const kl = Math.hypot(kx, ky) || 1; kx /= kl; ky /= kl;
        kite = { x: kx, y: ky, w: 1.6 + Math.min(1.5, here * 0.4) };
        // 圈上前方被牆 / 陷阱 / 水擋住超過 0.6 秒：反方向繞，並以目前位置重新畫圈
        S.spinBlockT = pathLen(kx, ky, 90) < 60 ? S.spinBlockT + dt : 0;
        if (S.spinBlockT > 0.6) { S.spin *= -1; S.spinBlockT = 0; S.loopC = null; }
      }
    }

    // 地面預警用「落下的那一刻我人在哪」來判斷：沿這個方向直走，每個預警倒數結束時的位置在範圍內才算中招。
    // 只看「走到某點時那裡有沒有預警」不夠：落石雨有 4~6 個先後落下的點，會往暫時沒事、等一下才被砸的地方走
    const hazardHits = (dx, dy) => {
      if (!hazards.length) return 0;
      const reach = pathLen(dx, dy, 240);
      let hit = 0, frac = 0;
      for (const h of hazards) {
        if (h.hit) continue;
        const tr = Math.max(0, (h.delay || 0) - (h.t || 0));
        const t2 = Math.min(tr * pSpd * 0.9, reach);   // 0.9：轉向和加速的損耗
        if (inHazard(h, p.x + dx * t2, p.y + dy * t2, p.r + 4)) { hit += 1; frac += hazFrac(h); }
      }
      // 每個躲不掉的預警都扣分（能完全躲開就躲開）；都躲不掉時，挑加起來扣血最少的方向
      return hit * 30 * bigFear + frac * DMG_W * 1.5;
    };

    // 每個方向的成本 = 三種步長裡最好的那個
    const cost = DIRS.map(([dx, dy]) => {
      let bestStep = Infinity;
      for (const step of [55, 120, 200]) {
        const reach = pathLen(dx, dy, step);
        if (reach < 12) continue;                       // 正前方就是牆 / 陷阱
        const x = p.x + dx * reach, y = p.y + dy * reach;
        // 優先序：躲技能（首領招式 / 彈幕 / 預警，權重最大）> 避開障礙物 > 撿光球 / 進裂縫
        let c = danger(x, y, reach / pSpd);
        c += (reach < step ? 6 + 6 * (1 - reach / step) : 0) + cramped(x, y) * 1.2 + (slowWet && W.isLiquid(x, y) ? 1.2 : 0);   // 水裡會變慢，能走陸地就走陸地
        if (target) {
          const before = Math.hypot(target.x - p.x, target.y - p.y), after = Math.hypot(target.x - x, target.y - y);
          c -= target.w * (before - after) / step;   // 被牆擋住只走得到一半，收益也只算一半
        }
        bestStep = Math.min(bestStep, c);
      }
      if (bestStep === Infinity) return Infinity;
      bestStep += hazardHits(dx, dy);
      bestStep += losW * (blockedShot(p.x + dx * 90, p.y + dy * 90) + blockedFrac(p.x + dx * 90, p.y + dy * 90));
      if (kite) bestStep -= kite.w * (dx * kite.x + dy * kite.y);
      else if (!target && !arena) bestStep -= 0.3 * (dx * Math.cos(S.wanderA) + dy * Math.sin(S.wanderA)); // 閒著：沿大圈慢慢繞
      return bestStep;
    });
    // 跟左右鄰居平均一下，分數不會因為一點點差距就跳來跳去
    const sm = cost.map((c, i) => c === Infinity ? Infinity : 0.5 * c + 0.25 * (Math.min(cost[(i + 15) % 16], c + 3) + Math.min(cost[(i + 1) % 16], c + 3)));
    let bi = -1;
    for (let i = 0; i < 16; i++) if (sm[i] < Infinity && (bi < 0 || sm[i] < sm[bi])) bi = i;
    if (!target) S.wanderA += dt * 0.35;
    S.mode = judging ? (here > 2 ? '審判：閃避' : '審判：繞場') : arena ? (here > 2 ? '秘境：閃避' : '秘境：打 BOSS') : here > 2 ? '躲避' : target && (target.chase || target.hold) ? target.mode : kite ? (S.kiteLabel || '遛怪') : target ? target.mode : '閒逛';
    // 每個方向 12px 內都被判定擋住（被擠進樹石縫裡）：不要站著等死，往最空的方向硬擠出去
    const escape = () => {
      let bd = null, bs = -Infinity;
      for (const [dx, dy] of DIRS) {
        let r = pathLen(dx, dy, 120);
        if (r < 12) for (let t2 = 6; t2 <= 40; t2 += 6) { if (W && W.isFree && !W.isFree(p.x + dx * t2, p.y + dy * t2, p.r * 0.5, wet)) break; r = t2 * 0.5; }
        const sc = r - cramped(p.x + dx * r, p.y + dy * r) * 15 - danger(p.x + dx * r, p.y + dy * r, 0.5) * 20;
        if (sc > bs) { bs = sc; bd = [dx, dy]; }
      }
      return bd || DIRS[(Math.random() * 16) | 0];
    };
    if (bi < 0) { S.unstickT = Math.max(S.unstickT, 0.4); S.unstickDir = escape(); bi = 0; }

    // 遲滯：新方向要明顯比較好（或舊方向被擋 / 已經在挨打）才換，而且至少維持 0.15 秒
    // 緊急 = 彈幕 / 地面預警就要打到了（BOSS 本體離得近不算，那個交給保持距離處理）。
    // 緊急時選定一個閃避方向就維持 0.25 秒，除非那個方向明顯變更危險；
    // 以前緊急時會每幀重選，兩個差不多的閃避方向來回跳，人就原地抽搐吃招
    let urgent = 0;
    for (const sh of shots) urgent += 6 * shotW(sh) * Math.exp(-Math.max(Math.hypot(p.x - sh.x, p.y - sh.y) - (sh.r || 6) - p.r, -10) / 30);
    for (const h of hazards) if (!h.hit && inHazard(h, p.x, p.y, p.r + 4)) urgent += 25;
    const emergency = urgent > 4;
    S.holdT -= dt;
    const keep = S.dirIdx >= 0 && sm[S.dirIdx] < Infinity && (emergency ? sm[S.dirIdx] - sm[bi] < 3 && S.holdT > 0 : S.holdT > 0 || sm[S.dirIdx] - sm[bi] < (S.farm ? 1.2 : 0.6));
    if (keep) bi = S.dirIdx;
    else if (bi !== S.dirIdx) { S.dirIdx = bi; S.holdT = emergency ? 0.25 : S.farm ? 0.3 : 0.15; }   // 養怪時方向至少維持 0.3 秒，不要躁
    let best = DIRS[bi];
    // 泉水 / 寶箱：到了就站著（有危險還是照躲）
    // 站著等有時間上限（泉水 10 秒、寶箱 6 秒、護送 20 秒），超過就放棄這個目標 30 秒，
    // 例如求救的寶可夢被卡在牆後跟不上，就不會在標記旁站到死
    S.holding = false;
    if (target && target.hold && here < 4) {
      const d = Math.hypot((target.fx ?? target.x) - p.x, (target.fy ?? target.y) - p.y);
      if (d < target.hold && !(target.until && target.until())) {
        const key = S.plan && S.plan.key;
        if (S.holdKey !== key) { S.holdKey = key; S.holdSince = gt; }
        const limit = target.escort ? 20 : target.mode === '開寶箱' ? 6 : 10;
        if (gt - S.holdSince < limit) { S.holding = true; S.wd = null; return [0, 0]; }
        if (key) { S.ban[key] = gt + 30; S.plan = null; log('give up', key); }
      }
    }

    // 有規劃路線的目標：路線上的下一個點保證直線走得到，沒有立即危險就直接朝它走，
    // 不讓局部取樣在牆前面猶豫打轉；有技能 / 彈幕逼近時才交給上面的取樣去閃
    if (target && target.fx !== undefined && here < 2) {
      const dx = target.x - p.x, dy = target.y - p.y, d = Math.hypot(dx, dy) || 1;
      const safe = !hazards.some(h => !h.hit && inHazard(h, p.x + dx / d * 30, p.y + dy / d * 30, p.r));
      if (safe && d > 4) best = [dx / d, dy / d];
    }

    // 站樁輸出：怪稀疏、在中距離、沒有危險和預警、打得到 → 站著不動，讓怪直線走過來吃水槍
    if (S.stand && !emergency && here < 1.5 && !S.losBadT && !(target && target.orb) && !hazards.some(h => !h.hit && inHazard(h, p.x, p.y, p.r + 10))) {
      S.mode = '站樁輸出'; S.wd = null; S.stuckT = 0; S.lastPos = [p.x, p.y];
      return [0, 0];
    }

    // 被小怪包圍（身邊 70px 內 5 隻以上、8 個方位有 6 個被佔）：取樣會在幾個差不多爛的方向之間跳來跳去，
    // 人就原地抽搐挨打。改成挑「怪最稀、又沒被牆擋」的方向直接衝出去，寧可撞一兩隻也要出圈。
    // 方向選定後一路衝到身邊 70px 內剩不到 3 隻（最多 2.5 秒），中途不重選，不然又會在圈裡繞
    if (!arena && !emergency && !(S.farm && hpPct > 0.5)) {
      let close = 0; const sect = new Set();
      for (const e of near) {
        if (e.boss) continue;
        if (Math.hypot(e.x - p.x, e.y - p.y) - (e.r || 10) - p.r > 70) continue;
        close++; sect.add((Math.round(Math.atan2(e.y - p.y, e.x - p.x) / (Math.PI / 4)) + 8) % 8);
      }
      if (S.breakT > 0 && close >= 3 && pathLen(S.breakDir[0], S.breakDir[1], 40) >= 24) { S.breakT -= dt; best = S.breakDir; S.mode = '突圍'; }
      else {
        S.breakT = 0;
        if (close >= 5 && sect.size >= 6) {
          let bd = null, bs = Infinity;
          for (const [dx, dy] of DIRS) {
            const reach = pathLen(dx, dy, 160);
            if (reach < 40) continue;
            let c = (160 - reach) / 20 + hazardHits(dx, dy);   // 前面很快就撞牆、或會衝進預警的方向不好
            for (const e of near) {
              const ex = e.x - p.x, ey = e.y - p.y, d = Math.hypot(ex, ey) || 1, cos = (ex * dx + ey * dy) / d;
              // 往越痛的怪那邊衝越不好（同樣擋路，寧可撞弱的）
              if (cos > 0) c += (e.boss ? 4 : 1) * (0.5 + 10 * hitFrac(e.dmg, false)) * cos * cos * 100 / Math.max(30, d);
            }
            if (target) c -= 0.5 * (dx * (target.x - p.x) + dy * (target.y - p.y)) / (Math.hypot(target.x - p.x, target.y - p.y) || 1);
            if (c < bs) { bs = c; bd = [dx, dy]; }
          }
          if (bd) { S.breakDir = bd; S.breakT = 2.5; best = bd; S.mode = '突圍'; S.dirIdx = -1; }
        }
      }
    }

    // 審判突圍：被傳說逼到場地邊緣、或 220px 內有 3 隻以上傳說時，趁地面預警少、血量還有一半以上，
    // 挑「前方傳說最少、絕對不碰阿爾宙斯、往場地中間」的方向直接衝出去，衝 1.2 秒中途不重選。
    // 繞場閃避在牆邊會被一路夾著打，越拖越難出來
    if (judging && arceus && !emergency) {
      const ax = arceus.x - p.x, ay = arceus.y - p.y, ad = Math.hypot(ax, ay) || 1;
      if (S.jBreakT > 0) {
        S.jBreakT -= dt;
        const [dx, dy] = S.jBreakDir;
        if (pathLen(dx, dy, 40) < 24 || (ad < 170 && (ax * dx + ay * dy) / ad > 0.4) || hazardHits(dx, dy) > 0) S.jBreakT = 0;
        else { best = S.jBreakDir; S.mode = '審判：突圍'; }
      } else if (S.jCenter && hpPct >= 0.5) {
        const maxR = (24 - 1.4) * unitPx - p.r - 6;
        const edgeD = Math.hypot(p.x - S.jCenter.x, p.y - S.jCenter.y);
        const legs = near.filter(e => e.boss && !e.arceus && Math.hypot(e.x - p.x, e.y - p.y) < 220);
        const hazNear = hazards.filter(h => !h.hit && inHazard(h, p.x, p.y, 200)).length;
        if (((edgeD > maxR - 110 && legs.length >= 1) || legs.length >= 3) && hazNear <= 1) {
          let bd = null, bs = Infinity;
          for (const [dx, dy] of DIRS) {
            const reach = pathLen(dx, dy, 160);
            if (reach < 60) continue;
            if ((ax * dx + ay * dy) / ad > 0.2 && ad < 320) continue;   // 阿爾宙斯碰一下 40% 以上，那一側不衝
            let c = (160 - reach) / 20 + hazardHits(dx, dy);
            for (const e of legs) {
              const ex = e.x - p.x, ey = e.y - p.y, d = Math.hypot(ex, ey) || 1, cos = (ex * dx + ey * dy) / d;
              if (cos > 0) c += (0.5 + 10 * hitFrac(e.dmg, false)) * cos * cos * 100 / Math.max(30, d);
            }
            c -= 1.5 * (dx * (S.jCenter.x - p.x) + dy * (S.jCenter.y - p.y)) / (edgeD || 1);   // 往中間
            if (c < bs) { bs = c; bd = [dx, dy]; }
          }
          if (bd) { S.jBreakDir = bd; S.jBreakT = 1.2; best = bd; S.mode = '審判：突圍'; S.dirIdx = -1; }
        }
      }
    }

    // 卡牆偵測：一直按方向卻沒移動 → 換到最空曠的方向 0.5 秒
    if (S.lastPos) {
      const moved = Math.hypot(p.x - S.lastPos[0], p.y - S.lastPos[1]);
      S.stuckT = moved < 0.3 ? S.stuckT + dt : 0;
    }
    S.lastPos = [p.x, p.y];
    // 看門狗：3 秒內移動不到 10px（又不是在故意等）→ 強制脫困，並放棄目前的目標 15 秒
    if (!S.wd || S.holding) S.wd = { x: p.x, y: p.y, t: gt };
    else if (gt - S.wd.t > 3) {
      if (Math.hypot(p.x - S.wd.x, p.y - S.wd.y) < 10) {
        log('watchdog: stuck, escaping');
        if (S.plan) { S.ban[S.plan.key] = gt + 15; S.plan = null; }
        S.loopC = null; S.unstickT = 0.8; S.unstickDir = escape();
      }
      S.wd = { x: p.x, y: p.y, t: gt };
    }
    if (S.stuckT > 0.4) { S.stuckT = 0; S.unstickT = 0.5; S.unstickDir = escape(); }   // 卡住了：往最空曠、又不危險的方向脫困
    if (S.unstickT > 0) { S.unstickT -= dt; best = S.unstickDir; }
    // 輸出再做一點平滑（約 80ms），轉向變成弧線；緊急閃避時不平滑
    const reversing = S.out[0] * best[0] + S.out[1] * best[1] < -0.2;   // 要往反方向轉時直接轉，平均起來會抵銷成 0 而停住
    const a = emergency || reversing || S.unstickT > 0 ? 1 : Math.min(1, dt * 12);
    let ox = S.out[0] * (1 - a) + best[0] * a, oy = S.out[1] * (1 - a) + best[1] * a;
    const ol = Math.hypot(ox, oy) || 1;
    S.out = [ox / ol, oy / ol];
    // 保險：任何一步算出 NaN，遊戲都會當成「不動」→ 改走脫困方向
    if (!isFinite(S.out[0]) || !isFinite(S.out[1])) { S.out = escape(); S.loopC = null; S.plan = null; }
    return S.out;
  }

  // ---------- 8a'. 養成：回主選單時自動買「強化」 ----------
  // 強化是每隻寶可夢各自的（存檔 pupg[圖鑑編號]），價格 = 10 × round(base × grow^等級 / 10)。
  // 1. 「初始招式」：畢業配置第一招跟預設開局招式不同時先買，並設定開局招式（存檔 pstart）。
  //    例：妙蛙種子預設藤鞭，換成能量球，配置才排得下 4 招
  // 2. 「招式庫」(1500)+「第二初始招式」：回主選單時錢夠就先買，第二招設成配置裡下一個能當開局的招式（存檔 pstart2）
  // 3. 其他：每次挑「價值 ÷ 價格」最高、買得起的一項，一直買到錢不夠
  const UPG_VALUE = { def: 1.2, xp: 1.15, atk: 1.1, cd: 1.1, coins: 1.1, reroll: 1.0, hp: 0.9, magnet: 0.9, crit: 0.8, regen: 0.8, spd: 0.4 };
  const UPG_CAP = { coins: 5, reroll: 3 };   // 這幾項只升到這裡就夠了
  let lastUpgrade = 0;
  function autoUpgrade(ns) {
    if (!cfg.upgrade || ns.Game.state !== 'ui' || !ns.Upgrades || !ns.DB || !ns.DB.save) return;
    if (performance.now() - lastUpgrade < 3000) return;
    lastUpgrade = performance.now();
    const sv = ns.DB.save, dex = sv.partner;
    if (!dex || !ns.DEX_BY[dex]) return;
    const upg = ns.DB.upgradesOf(dex), U = ns.Upgrades, prof = cfg.profiles[dex];
    const choices = ns.startChoices ? ns.startChoices(dex) : [];
    const bought = [];
    const buy = id => {
      const lvl = upg[id] || 0, def = U.BY[id];
      if (!def || lvl >= def.max || (def.needs && !upg[def.needs])) return false;
      const cost = U.cost(id, lvl);
      if (sv.coins < cost) return false;
      sv.coins -= cost; upg[id] = lvl + 1; bought.push(`${def.name} ${lvl + 1}`);
      return true;
    };
    // 開局招式
    // 沒有畢業配置的寶可夢：開局一定挑「單體」攻擊招（水槍、念力、火花…），索敵穩、後期打首領收尾靠它；
    // 範圍招留到第四招。單體招裡挑每秒傷害最高、物攻 / 特攻對得上的，會追蹤 / 同屬性再加一點
    const single = m => (m.kind === 'projectile' && (m.count || 1) <= 2) || m.kind === 'homing' || m.kind === 'beam';
    const autoPick = exclude => {
      const mon = ns.DEX_BY[dex];
      let best = null, bs = -Infinity;
      for (const id of choices) {
        const m = ns.Moves.BY_ID[id];
        if (!m || m.kind === 'buff' || id === exclude) continue;
        const fit = m.cat ? ns.Stats.fit(mon, m.cat) : 1;
        const sc = (single(m) ? 1000 : 0) + (m.dmg || 10) / (m.cd || 1) * fit * ((mon.types || []).includes(m.type) ? 1.2 : 1) + (m.homing || m.kind === 'homing' ? 3 : 0);
        if (sc > bs) { bs = sc; best = id; }
      }
      return best;
    };
    // 只改 bot 自己設過的開局招式：玩家自己在遊戲裡改過（跟 bot 記下的不一樣）就不再碰。
    // 舊版沒有記錄、而且設成範圍招的（例：蓋歐卡被設成泡沫），當成 bot 設的，換成單體招一次
    cfg.botStart = cfg.botStart || {}; cfg.botStart2 = cfg.botStart2 || {};
    const mine = (store, rec, legacyOk) => store[dex] === undefined || store[dex] === rec[dex] || (rec[dex] === undefined && legacyOk(store[dex]));
    const want1 = prof ? prof.moves.find(id => choices.includes(id)) : autoPick();
    sv.pstart = sv.pstart || {};
    if (want1 && mine(sv.pstart, cfg.botStart, id => !ns.Moves.BY_ID[id] || !single(ns.Moves.BY_ID[id]))) {
      if (want1 !== ns.baseStartOf(dex) && !upg.start) buy('start');
      if (upg.start && sv.pstart[dex] !== want1 && !(sv.pstart[dex] === undefined && want1 === ns.baseStartOf(dex))) {
        sv.pstart[dex] = want1; bought.push('開局招式→' + want1);
      }
      if (sv.pstart[dex] !== undefined) cfg.botStart[dex] = sv.pstart[dex];
    }
    // 第二開局招式照學招順序：自動模式是變硬（可以當開局招式的話），不行才挑第二招攻擊
    const want2 = prof ? prof.moves.find(id => choices.includes(id) && id !== want1) : choices.includes('harden') ? 'harden' : autoPick(want1);
    sv.pstart2 = sv.pstart2 || {};
    if (want2 && mine(sv.pstart2, cfg.botStart2, () => false)) {
      if (!upg.moves) buy('moves');
      if (upg.moves && !upg.start2) buy('start2');
      if (upg.start2 && sv.pstart2[dex] !== want2) { sv.pstart2[dex] = want2; cfg.botStart2[dex] = want2; bought.push('第二開局招式→' + want2); }
    }
    save();
    for (let guard = 0; guard < 50; guard++) {
      let best = null, bs = 0;
      for (const [id, v] of Object.entries(UPG_VALUE)) {
        const def = U.BY[id], lvl = upg[id] || 0;
        if (!def || lvl >= Math.min(def.max, UPG_CAP[id] ?? def.max)) continue;
        const cost = U.cost(id, lvl);
        if (cost > sv.coins) continue;
        const sc = v / cost;
        if (sc > bs) { bs = sc; best = id; }
      }
      if (!best || !buy(best)) break;
    }
    if (bought.length) {
      ns.DB.commit(true);
      ns.UI.refreshCoins && ns.UI.refreshCoins();
      log('upgrade', ns.DEX_BY[dex].name, bought.join(', '), '剩', sv.coins);
      S.lastUpgradeMsg = bought.slice(-3).join('、');
    }
  }

  // ---------- 8a''. 自動抽獎 ----------
  // 抽獎規則（遊戲原始碼）：一次 10 抽 = 10 張普通券或 1 張 ×10 券；普通 45% / 少見 30% / 稀有 17% / 史詩 6.5% / 傳說 1.5%；
  // 每個地區 70 抽保底一隻傳說；抽到重複的退金幣。走遊戲自己的 Gacha.pull → 成就檢查 → 存檔，只是跳過動畫。
  // 卡池：先抽保底進度最高的地區（集中拿傳說）；都沒進度時抽「還沒抽到的傳說最強」的地區
  let lastGacha = 0;
  function gachaBanner(ns, sv) {
    const G = ns.Gacha;
    let best = null, bs = -Infinity;
    for (const b of G.BANNERS) {
      if (!G.isOpen(b.gen)) continue;
      const pity = (sv.pity || {})[b.gen] || 0;
      // 還沒抽到的傳說裡最強那隻的能力總和（例：神奧的阿爾宙斯 720、關都的超夢 680）
      const missing = (G.featured(b.gen) || []).filter(d => !sv.owned[d]).map(d => ns.DEX_BY[d].bst || 0);
      const top = missing.length ? Math.max(...missing) : 0;
      // 這個地區還有沒抽到的「想養的寶可夢」：最優先（例：蓋歐卡在豐緣、超夢在關都）
      const wantHere = (cfg.favorites || []).some(d => !sv.owned[d] && ns.DEX_BY[d] && ns.DEX_BY[d].gen === b.gen);
      const sc = pity * 3 + (top ? 40 + (top - 600) / 5 : 0) + (wantHere ? 200 : 0);
      if (sc > bs) { bs = sc; best = b.gen; }
    }
    return best;
  }
  function autoGacha(ns) {
    if (!cfg.gacha || ns.Game.state !== 'ui' || !ns.Gacha || !ns.DB || !ns.DB.save) return;
    if (performance.now() - lastGacha < 5000) return;
    lastGacha = performance.now();
    const sv = ns.DB.save, t = sv.tickets || {};
    const got = [];
    let pulls = 0;
    for (let i = 0; i < 30; i++) {
      const type = (t.t10 || 0) >= 1 ? 't10' : (t.t1 || 0) >= 10 ? 't1' : null;
      if (!type) break;
      const gen = gachaBanner(ns, sv);
      const res = gen && ns.Gacha.pull(sv, 10, gen, type);
      if (!res) break;
      pulls++;
      for (const r of res) if (r.isNew || r.rarity >= 4) got.push(`${ns.DEX_BY[r.dex].name}${r.shiny ? '✨' : ''}${r.rarity >= 5 ? '★' : ''}`);
    }
    if (!pulls) return;
    ns.Progress && ns.Progress.checkAch && ns.Progress.checkAch();
    ns.DB.commit(true);
    ns.UI.refreshCoins && ns.UI.refreshCoins();
    log('gacha', pulls * 10, '抽', got.join(', '));
    if (got.length) S.lastGachaMsg = got.slice(-4).join('、');
  }

  // ---------- 8a'''. 自動換最強的寶可夢出戰 ----------
  // 傷害公式（遊戲原始碼）：招式威力 × 攻擊倍率 × 物攻/特攻合不合 × 增益 × 單屬性同屬性招式 1.2 × 天氣（雨天水系 1.5…）。
  // 所以強度看「最好的那招掛機招能打多痛」，不是能力總和：蓋歐卡（特攻 1.52 × 純水 1.2 × 自帶降雨 1.5 = 2.74）
  // 遠勝能力總和最高的阿爾宙斯（1.36）。再乘耐久、速度、已投資的強化；想養的寶可夢再加 30%。
  // 強化是每隻分開的，新的要強 15% 以上才換
  const WEATHER_OF = { drizzle: 'water', drought: 'fire', 'sand-stream': 'rock', 'snow-warning': 'ice' };
  const WEATHER_MUL = { water: 1.5, fire: 1.5, rock: 1.3, ice: 1.3 };
  const AFK_KINDS = ['homing', 'aura', 'orbit', 'nova'];
  function power(ns, sv, dex) {
    const mon = ns.DEX_BY[dex];
    if (!mon) return 0;
    let pool = [];
    try { pool = ns.startChoices ? ns.startChoices(dex) : []; } catch {}
    const abil = ((ns.DEX_ABIL && ns.DEX_ABIL[dex]) || []).filter(Boolean);
    let off = 0;
    for (const id of pool) {
      const m = ns.Moves.BY_ID[id];
      if (!m || !(AFK_KINDS.includes(m.kind) || (m.kind === 'projectile' && m.homing))) continue;   // 念力是「會追蹤的投射物」
      let v = (mon.atk || 1) * (m.cat ? ns.Stats.fit(mon, m.cat) : 1);
      if (mon.types.length === 1 && m.type === mon.types[0]) v *= 1.2;
      for (const a of abil) if (WEATHER_OF[a] === m.type) v *= WEATHER_MUL[m.type];
      off = Math.max(off, v);
    }
    if (!off) off = (mon.atk || 1) * 0.6;   // 沒有不用瞄準的招
    const tough = Math.sqrt((mon.hp || 80) / 100 * (((mon.df || 60) + (mon.sd || 60)) / 180));
    const u = (sv.pupg || {})[dex] || {};
    const inv = 0.04 * (u.atk || 0) + 0.03 * (u.cd || 0) + 0.02 * (u.def || 0) + 0.01 * (u.hp || 0) + 0.015 * (u.crit || 0) + 0.01 * (u.regen || 0);
    const fav = (cfg.favorites || []).includes(dex) ? 1.3 : 1;
    return off * Math.sqrt(tough) * (0.8 + 0.2 * (mon.spd || 100) / 110) * (1 + inv) * fav;
  }
  let lastPartner = 0;
  function autoPartner(ns) {
    if (!cfg.autoPartner || ns.Game.state !== 'ui' || !ns.DB || !ns.DB.save) return;
    // 在多人房間裡不要換夥伴：換完會呼叫 Flow.goMenu()，把房間畫面蓋掉，房主就開不了下一局
    if (ns.Room && ns.Room.room) return;
    if (performance.now() - lastPartner < 5000) return;
    lastPartner = performance.now();
    const sv = ns.DB.save, cur = sv.partner;
    let best = cur, bp = power(ns, sv, cur);
    for (const d of Object.keys(sv.owned || {})) {
      const pw = power(ns, sv, +d);
      if (pw > bp) { bp = pw; best = +d; }
    }
    if (best === cur || bp < power(ns, sv, cur) * 1.15) return;
    sv.partner = best;
    sv.partnerShiny = !!(sv.shiny && sv.shiny[best]);
    ns.DB.commit();
    log('partner', ns.DEX_BY[cur] && ns.DEX_BY[cur].name, '→', ns.DEX_BY[best].name);
    S.lastPartnerMsg = `換成 ${ns.T ? ns.T(ns.DEX_BY[best].name) : ns.DEX_BY[best].name}`;
    ns.Flow && ns.Flow.goMenu && ns.Flow.goMenu();
  }

  // ---------- 8b. 結算後回主選單 / 回房間 → 自動再開一局 ----------
  function autoRestart(ns) {
    if (!cfg.on || !cfg.restart || !['ui', 'over'].includes(ns.Game.state)) return;
    const open = id => { const e = document.getElementById(id); return e && !e.classList.contains('hidden'); };
    // 回主選單途中可能跳出的提示，一律按「稍後 / 關閉」
    if (open('scr-test')) { const opt = document.querySelector('#scr-test button'); if (opt) { opt.click(); return; } }
    for (const [scr, btn] of [['scr-savenote', 'savenote-ok'], ['scr-news', 'news-close'], ['scr-nick', 'nick-later'], ['scr-recover', 'rec-later']]) {
      if (open(scr)) { document.getElementById(btn)?.click(); return; }
    }
    if (open('scr-over')) {
      if (now() - S.overAt > 4000 && now() - (S.againAt || 0) > 2000) { S.againAt = now(); document.getElementById('btn-again')?.click(); }
      return;
    }
    // 多人：跑完會回到房間（scr-lobby），只有房主能開下一局。
    // 遊戲自己會把 lobby-start 隱藏（訪客）或 disable（人數不足 / 有人還在連線），照它的判斷走就好。
    if (open('scr-lobby')) {
      const btn = document.getElementById('lobby-start');
      const room = ns.Room && ns.Room.room;
      // 第一次（bot 剛開啟）一定要等房間滿才自動開：邀請好友時房間已經存在，
      // 如果不等滿，房主會自己一個人進去，朋友就只能在房間乾等。
      // 只要進過一次場（bot 開的或你手動開的），這一輪就沿用當時的組合，之後照當下人數直接開。
      if (S.coopFull && room && room.isHost) {
        const cap = ns.Room.MAX_PLAYERS || 4;
        const n = room.members ? room.members.length : 0;
        if (n < cap) {
          if (now() - (S.fullLogAt || 0) > 10000) {
            S.fullLogAt = now();
            log(`co-op: waiting for full room (${n}/${cap})`);
          }
          return;
        }
      }
      if (btn && !btn.classList.contains('hidden') && !btn.disabled && now() - (S.lobbyAt || 0) > 5000) {
        S.lobbyAt = now();
        btn.click();
        log('co-op: start next run');
      }
      return;
    }
    // 還在房間裡就別去點單人的「開始」——那會直接開一場單人、把房間丟掉。
    // 訪客在房間裡唯一能做的就是等房主，這裡什麼都不做才是對的。
    const inRoom = !!(ns.Room && ns.Room.room);
    if (!inRoom && open('scr-menu') && now() - S.lastPlay > 6000 && now() - S.overAt > 5000) {
      S.lastPlay = now();
      document.querySelector('#scr-menu [data-go=play]')?.click();
    }
  }
  const now = () => performance.now();

  // 遊戲失焦時會自己暫停；只要不是玩家按 Esc / P 暫停的，就自動繼續
  addEventListener('keydown', e => {
    if ((e.key === 'Escape' || e.code === 'KeyP') && capturedNs && capturedNs.Game && capturedNs.Game.state === 'playing') S.userPausedAt = now();
  }, true);
  function autoResume(ns) {
    const st = ns.Game.state;
    if (st === 'playing') { if (now() - S.userPausedAt > 1000) S.userPausedAt = -1e9; S.pausedAt = 0; return; }
    if (st !== 'paused' || S.userPausedAt > 0 || document.visibilityState !== 'visible') { S.pausedAt = 0; return; }
    if (!S.pausedAt) S.pausedAt = now();
    else if (now() - S.pausedAt > 1500) { S.pausedAt = 0; log('auto resume'); ns.Game.togglePause(); }
  }

  // ---------- 9. 控制面板 ----------
  // ---------- 新版提示（只有 Chrome 擴充版需要：油猴會自己更新） ----------
  // 每 6 小時最多問一次 GitHub 最新的 Release，有更新的版本就在面板上顯示下載連結
  const REPO = 'b0933223169-coder/pokesurvivor-autofarm';
  const newer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };
  async function checkUpdate(link) {
    if (typeof GM_info !== 'undefined') return;   // 油猴腳本
    let cache = {};
    try { cache = JSON.parse(localStorage.getItem('psbot.update') || '{}'); } catch {}
    if (!cache.at || Date.now() - cache.at > 6 * 3600e3) {
      try {
        const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, { headers: { Accept: 'application/vnd.github+json' } });
        if (r.ok) { const j = await r.json(); cache = { at: Date.now(), latest: String(j.tag_name || '').replace(/^v/, ''), url: j.html_url }; }
        else cache = { at: Date.now(), latest: cache.latest, url: cache.url };
        localStorage.setItem('psbot.update', JSON.stringify(cache));
      } catch {}
    }
    if (cache.latest && newer(cache.latest, VERSION)) {
      link.href = cache.url || `https://github.com/${REPO}/releases/latest`;
      link.textContent = `有新版本 v${cache.latest}（目前 v${VERSION}），點這裡下載`;
      link.style.display = 'block';
      log('update available', cache.latest);
    }
  }

  function buildPanel(ns) {
    const css = `
#pss{position:fixed;z-index:2147483000;top:${cfg.panelY ?? 64}px;left:${cfg.panelX ?? 12}px;width:230px;color:#e8ecf6;background:rgba(14,18,32,.9);border:1px solid #3a4466;border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.45);user-select:none}
#pss,#pss *{box-sizing:border-box;margin:0;font:11px/1.4 system-ui,-apple-system,"PingFang TC",sans-serif!important;letter-spacing:0!important;text-transform:none!important;text-shadow:none!important;min-height:0!important}
#pss .hd{display:flex;align-items:center;gap:4px;padding:4px 6px;cursor:move}
#pss .hd b{flex:1;font-weight:700!important}
#pss button{color:#e8ecf6;background:#2a3355;border:1px solid #46527e;border-radius:5px;padding:1px 6px;cursor:pointer}
#pss button.on{background:#c2357a;border-color:#ff8ad8}
#pss .bd{padding:4px 6px 6px;display:grid;gap:4px;border-top:1px solid #2a3150}
#pss.min .bd{display:none}
#pss .st{color:#9fb1c9;white-space:pre-line!important}
#pss details{border-top:1px solid #2a3150;padding-top:3px}
#pss summary{cursor:pointer;color:#ff8ad8}
#pss .opts{display:grid;gap:1px;padding:3px 0 0}
#pss label{display:flex;align-items:center;gap:5px;padding:0!important;cursor:pointer}
#pss input[type=checkbox]{width:12px;height:12px;flex:none}
#pss .chips{display:flex;flex-wrap:wrap;gap:3px;padding:3px 0}
#pss .chip{background:#33406a;border-radius:9px;padding:0 6px;cursor:pointer}
#pss .chip:hover{background:#7a2a55}
#pss select{color:#e8ecf6;background:#1b2240;border:1px solid #46527e;border-radius:5px;padding:1px 2px}
#pss .row{display:flex;gap:4px;align-items:center;margin-top:3px}
#pss .row select{flex:1;min-width:0}`;
    const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
    const el = document.createElement('div'); el.id = 'pss'; if (cfg.collapsed) el.classList.add('min');
    el.innerHTML = `
<div class="hd"><b>PSBot 自動掛機 <span style="opacity:.6;font-weight:400">v${VERSION}</span></b><button data-k="toggle">OFF</button><button data-k="home" title="面板回到左上角（Shift+F8）">⌂</button><button data-k="min">–</button></div>
<div class="bd">
  <div class="st" data-k="status"></div>
  <details data-k="optsBox"><summary>設定</summary><div class="opts">
    <label><input type="checkbox" data-o="move">自動走位</label>
    <label><input type="checkbox" data-o="cards">自動選卡（被動 > 主動升級）</label>
    <label><input type="checkbox" data-o="bonds">自動羈絆（照配置順序）</label>
    <label><input type="checkbox" data-o="items">自動選攜帶道具</label>
    <label><input type="checkbox" data-o="rift">主動進神祕裂縫</label>
    <label><input type="checkbox" data-o="orbs">自動用寶珠</label>
    <label><input type="checkbox" data-o="farm">養怪（範圍招把怪聚成一團再打）</label>
    <label><input type="checkbox" data-o="focus">集火瞄準（打得死的先收）</label>
    <label><input type="checkbox" data-o="lead">預判射擊（實驗中，可能描邊）</label>
    <label><input type="checkbox" data-o="restart">結束後自動再開一局</label>
    <label><input type="checkbox" data-o="noRank">掛機局不上排行榜</label>
    <label><input type="checkbox" data-o="upgrade">回主選單時自動買強化（花金幣）</label>
    <label><input type="checkbox" data-o="gacha">回主選單時自動抽獎（用抽獎券）</label>
    <label><input type="checkbox" data-o="autoPartner">自動換最強的寶可夢出戰</label>
  </div></details>
  <details data-k="recBox" open><summary>記錄模式（你打，bot 學）</summary>
    <div class="row"><button data-k="rec">● 開始記錄</button></div>
    <div class="row"><button data-k="recExport">匯出參數</button><button data-k="recImport">匯入參數</button><button data-k="recClear">清除</button></div>
    <div class="st" data-k="recInfo"></div>
    <input type="file" data-k="recFile" accept=".json,application/json" style="display:none">
  </details>
  <details data-k="dashBox"><summary>學習儀表板（偏好 / 參數 / 品質趨勢）</summary>
    <div class="st" data-k="dashInfo"></div>
    <div class="row" style="flex-wrap:wrap;gap:6px">
      <label style="font-size:10px">fearLow <input type="range" min="0.15" max="0.6" step="0.01" data-p="fearLow" style="width:90px"><span data-v="fearLow"></span></label>
      <label style="font-size:10px">fearMid <input type="range" min="0.4" max="0.8" step="0.01" data-p="fearMid" style="width:90px"><span data-v="fearMid"></span></label>
      <label style="font-size:10px">fearK <input type="range" min="0.5" max="1.8" step="0.01" data-p="fearK" style="width:90px"><span data-v="fearK"></span></label>
      <label style="font-size:10px">healThr <input type="range" min="0.2" max="0.7" step="0.01" data-p="healThr" style="width:90px"><span data-v="healThr"></span></label>
    </div>
    <div class="row" style="flex-wrap:wrap;gap:6px">
      <label style="font-size:10px">cardStr <input type="range" min="0" max="800" step="10" data-p="cardStr" style="width:90px"><span data-v="cardStr"></span></label>
      <label style="font-size:10px">bondStr <input type="range" min="0" max="12" step="0.5" data-p="bondStr" style="width:90px"><span data-v="bondStr"></span></label>
      <label style="font-size:10px">itemStr <input type="range" min="0" max="12" step="0.5" data-p="itemStr" style="width:90px"><span data-v="itemStr"></span></label>
      <button data-k="lockToggle">🔒 鎖定學習</button>
    </div>
  </details>
  <details data-k="histBox"><summary>戰績（最近 5 局）</summary><div class="st" data-k="hist"></div></details>
  <details data-k="brainBox"><summary>🧠 腦知識圖譜（所有參數）</summary>
    <canvas data-k="brainCanvas" width="220" height="180" style="width:100%;border:1px solid #3a4466;border-radius:4px;background:#0a0e1a"></canvas>
    <div class="row"><button data-k="brainExport">匯出腦</button><button data-k="brainImport">匯入腦</button><button data-k="brainRebuild">重建</button></div>
    <input type="text" data-k="brainSearch" placeholder="搜尋參數..." style="width:100%;padding:2px 4px;background:#1a2040;color:#e8ecf6;border:1px solid #3a4466;border-radius:4px">
    <div class="st" data-k="brainInfo" style="max-height:260px;overflow:auto"></div>
    <input type="file" data-k="brainFile" accept=".json,application/json" style="display:none">
  </details>
  <details data-k="buildBox" open><summary data-k="ptitle">畢業配置</summary>
    <div class="chips" data-k="build"></div>
    <div class="row"><select data-k="pool"></select><button data-k="add">加入</button></div>
    <div class="row"><select data-k="item"></select><button data-k="clear">清空</button></div>
  </details>
  <a data-k="update" target="_blank" rel="noopener" style="display:none;color:#ffd23f!important;text-decoration:underline"></a>
  <div class="st">F8 開關 · 分頁要保持可見</div>
</div>`;
    document.body.appendChild(el);
    checkUpdate(el.querySelector('[data-k="update"]'));
    const $ = k => el.querySelector(`[data-k="${k}"]`);

    const setOn = v => { cfg.on = v; save(); $('toggle').textContent = v ? 'ON' : 'OFF'; $('toggle').classList.toggle('on', v); };
    setOn(cfg.on);
    $('toggle').onclick = () => setOn(!cfg.on);
    // F8 開關；Shift+F8 把面板叫回左上角（拖出畫面外時用）
    addEventListener('keydown', e => {
      if (e.key !== 'F8') return;
      e.preventDefault();
      e.shiftKey ? resetPos() : setOn(!cfg.on);
    }, true);
    $('min').onclick = () => { cfg.collapsed = !cfg.collapsed; el.classList.toggle('min', cfg.collapsed); save(); };
    el.querySelectorAll('[data-o]').forEach(i => { i.checked = !!cfg[i.dataset.o]; i.onchange = () => { cfg[i.dataset.o] = i.checked; save(); }; });

    // 記錄模式：開啟後 bot 全部停手，由你自己打；只記錄你的選擇與走位
    function renderRec() {
      const on = !!cfg.record, L = cfg.learn, lm = learnedMove();
      $('rec').textContent = on ? '■ 停止記錄（錄影中）' : '● 開始記錄';
      $('rec').classList.toggle('on', on);
      const lines = [
        `已記錄 ${L.runs} 局 · ${L.picks} 次選擇${on ? '（錄影中）' : ''}`,
        lm ? `人類平均 HP ${Math.round(lm.hp * 100)}% · 離怪 ${Math.round(lm.dist)}px` +
          ` · 補血門檻 ${Math.round(healThreshold() * 100)}%` : '走位樣本不足，再打一局',
        L.last ? `上一局 ${Math.round(L.last.time)}s Lv${L.last.level} 擊倒 ${L.last.kills}` : '',
        S.recMsg && performance.now() - S.recMsgAt < 8000 ? S.recMsg : '',
      ].filter(Boolean);
      $('recInfo').replaceChildren(...lines.map(t => Object.assign(document.createElement('div'), { textContent: t })));
    }
    $('rec').onclick = () => { cfg.record = !cfg.record; S.rec.runActive = false; S.rec.player = null; save(); renderRec(); };
    $('recExport').onclick = exportLearn;
    $('recImport').onclick = () => $('recFile').click();
    $('recFile').onchange = e => { const f = e.target.files && e.target.files[0]; if (f) importLearnFile(f); e.target.value = ''; };
    $('recClear').onclick = () => { if (confirm('清除所有已學習的參數？（已匯出的檔案不受影響）')) resetLearn(); };
    renderRec();
    // ---------- 學習儀表板 ----------
    function fmt(v, d) { return (v == null || !isFinite(v)) ? '—' : Number(v).toFixed(d == null ? 2 : d); }
    function topEntries(bag, n) {
      const V = cfg.learn.values && cfg.learn.values[bag] || {};
      const C = cfg.learn[bag] || {};
      const keys = new Set([...Object.keys(V), ...Object.keys(C)]);
      return [...keys].map(k => {
        const v = V[k] || { v: 0.5, n: 0 };
        const c = C[k] || { n: 0, t: 0 };
        const pref = (v.n >= 3) ? (v.v - 0.5) : ((c.t >= 3) ? (c.n + 1) / (c.t + 2) - 0.5 : 0);
        return { key: k, pref, n: v.n || c.t, t: c.t };
      }).sort((a, b) => Math.abs(b.pref) - Math.abs(a.pref)).slice(0, n);
    }
    function renderDash() {
      const L = cfg.learn, P = L.params || {};
      const lines = [];
      // 參數
      lines.push(`fearLow=${fmt(P.fearLow,2)} fearMid=${fmt(P.fearMid,2)} fearK=${fmt(P.fearK,2)} healThr=${fmt(healThreshold(),2)}`);
      lines.push(`strengths: card=${fmt(P.cardStr != null ? P.cardStr : 400,0)} bond=${fmt(P.bondStr != null ? P.bondStr : 6,1)} item=${fmt(P.itemStr != null ? P.itemStr : 6,1)}  locked=${Object.keys(P.locked||{}).filter(k=>P.locked[k]).length}`);
      // 品質趨勢
      const hist = (L.history || []).slice(-12);
      if (hist.length) {
        const qs = hist.map(h => Math.round((h.q || 0) * 100));
        lines.push('品質趨勢: ' + qs.map(q => q >= 70 ? '█' : q >= 40 ? '▄' : '▁').join('') + ` (${qs[qs.length-1]}%)`);
        const last = hist[hist.length-1];
        lines.push(`上局: ${Math.round(last.time)}s Lv${last.level} 擊倒${last.kills} minHP${Math.round((last.minHp||0)*100)}%`);
      } else {
        lines.push('品質趨勢: 尚無局數');
      }
      // 偏好 top
      const sec = (title, bag) => {
        const es = topEntries(bag, 5).filter(e => Math.abs(e.pref) > 0.01);
        if (!es.length) return;
        lines.push(title);
        for (const e of es) {
          const bar = e.pref > 0 ? '█'.repeat(Math.round(e.pref * 8)) : '░'.repeat(Math.round(-e.pref * 8));
          lines.push(`  ${e.key} ${e.pref > 0 ? '+' : ''}${e.pref.toFixed(2)} ${bar} (n=${e.n})`);
        }
      };
      sec('卡牌偏好:', 'cards');
      sec('羈絆偏好:', 'bonds');
      sec('道具偏好:', 'items');
      // 同步 slider 顯示值
      for (const p of ['fearLow','fearMid','fearK','healThr']) {
        const el = document.querySelector('#pss [data-p="' + p + '"]');
        if (el) {
          const v = (P[p] != null) ? P[p] : (p === 'fearLow' ? 0.35 : p === 'fearMid' ? 0.6 : p === 'fearK' ? 1 : healThreshold());
          el.value = v;
          const sp = document.querySelector('#pss [data-v="' + p + '"]');
          if (sp) sp.textContent = Number(v).toFixed(2);
        }
      }
      for (const p of ['cardStr','bondStr','itemStr']) {
        const el = document.querySelector('#pss [data-p="' + p + '"]');
        if (el) {
          const def = p === 'cardStr' ? 400 : 6;
          const v = (P[p] != null) ? P[p] : def;
          el.value = v;
          const sp = document.querySelector('#pss [data-v="' + p + '"]');
          if (sp) sp.textContent = (p === 'cardStr') ? Math.round(v) : Number(v).toFixed(1);
        }
      }
      const lb = document.querySelector('#pss [data-k="lockToggle"]');
      if (lb) lb.textContent = (P.locked && Object.values(P.locked).some(Boolean)) ? '🔓 解鎖學習' : '🔒 鎖定學習';
      const __di = document.querySelector('#pss [data-k="dashInfo"]');
      try { window.__dashDi = !!__di; window.__dashLines = lines.slice(); } catch (e) {}
      if (__di) __di.replaceChildren(...lines.map(t => Object.assign(document.createElement('div'), { textContent: t })));
      try { window.__dashAfter = __di ? __di.innerText : 'null'; } catch (e) {}
    }
    // slider 事件
    el.querySelectorAll('[data-p]').forEach(sl => {
      sl.oninput = () => {
        const key = sl.dataset.p;
        const v = parseFloat(sl.value);
        cfg.learn.params = cfg.learn.params || {};
        cfg.learn.params[key] = v;
        cfg.learn.params.locked = cfg.learn.params.locked || {};
        cfg.learn.params.locked[key] = true;
        const sp = document.querySelector('#pss [data-v="' + key + '"]');
        if (sp) sp.textContent = (key === 'cardStr') ? Math.round(v) : (key === 'bondStr' || key === 'itemStr') ? Number(v).toFixed(1) : Number(v).toFixed(2);
        save();
      };
    });
    $('lockToggle').onclick = () => {
      const P = cfg.learn.params || (cfg.learn.params = {});
      P.locked = P.locked || {};
      const anyLocked = Object.values(P.locked).some(Boolean);
      for (const k of ['fearLow','fearMid','fearK','healThr','cardStr','bondStr','itemStr']) {
        if (anyLocked) delete P.locked[k]; else P.locked[k] = true;
      }
      save(); renderDash();
    };
    renderDash();
    try { window.__renderDash = renderDash; } catch (e) {}

    // ---------- 腦知識圖譜 UI ----------
    function renderBrain() {
      try { buildBrain(); } catch (e) {}
      const canvas = document.querySelector('#pss [data-k="brainCanvas"]');
      if (canvas) renderBrainGraph(canvas);
      const info = document.querySelector('#pss [data-k="brainInfo"]');
      const q = (document.querySelector('#pss [data-k="brainSearch"]') || {}).value || '';
      if (!info) return;
      const B = cfg.brain;
      const nodes = Object.values(B.nodes || {});
      const filtered = q ? nodes.filter(n => (n.label + ' ' + n.id + ' ' + (n.desc||'')).toLowerCase().includes(q.toLowerCase())) : nodes;
      // group by cat
      const groups = {};
      for (const n of filtered) { (groups[n.cat] = groups[n.cat] || []).push(n); }
      const lines = [];
      const curDex = (S.rec && S.rec.dex) || (ns.Game.player && ns.Game.player.dex) || '?';
      lines.push(`當前寶可夢 dex=${curDex} · 已存 ${Object.keys(cfg.brains||{}).length} 隻的腦 · 節點 ${nodes.length} · 邊 ${ (B.edges||[]).length }`);
      // 死亡原因統計
      const dc = cfg.learn.deathCauses || {};
      const dcTotal = Object.values(dc).reduce((a, b) => a + b, 0);
      if (dcTotal > 0) {
        lines.push(`死亡原因: boss=${dc.boss||0} mob=${dc.mob||0} proj=${dc.projectile||0} hazard=${dc.hazard||0} unknown=${dc.unknown||0}`);
      }
      // 寶可夢強弱
      const ps = cfg.learn.pokeStrength || {};
      const psKeys = Object.keys(ps);
      if (psKeys.length > 0) {
        lines.push('寶可夢強弱:');
        for (const dex of psKeys) {
          const p = ps[dex];
          lines.push(`  dex=${dex}: ${p.runs}局 avgTime=${Math.round(p.avgTime)}s avgLv=${p.avgLevel.toFixed(1)} best=${Math.round(p.bestTime)}s`);
        }
      }
      // 獎勵安全
      const rs = cfg.learn.rewardSafety || {};
      if ((rs.safe||0)+(rs.unsafe||0) > 0) {
        lines.push(`獎勵安全: safe=${rs.safe||0} unsafe=${rs.unsafe||0} died=${rs.died||0}`);
      }
      for (const cat of BRAIN_CATS) {
        const ns = groups[cat];
        if (!ns || !ns.length) continue;
        lines.push(`【${BRAIN_CAT_LABEL[cat] || cat}】`);
        for (const n of ns.slice(0, 40)) {
          const diff = (n.human != null && n.value != null) ? (n.human - n.def) : 0;
          const adapt = (n.human != null && Math.abs(diff) > 0.001) ? ` →人${Number(n.human).toFixed(3)}` : '';
          const lock = n.locked ? '🔒' : '';
          lines.push(`${lock}${n.label}: ${fmtNum(n.value, n.type)} (預設 ${fmtNum(n.def, n.type)})${adapt} ${n.humanTrackable ? '🧍' : ''}`);
        }
      }
      // preference nodes
      const prefNodes = filtered.filter(n => n.cat === 'preference');
      if (prefNodes.length) {
        lines.push('【偏好】');
        for (const n of prefNodes.slice(0, 20)) lines.push(`${n.label}: ${Number(n.value).toFixed(2)} ${n.desc}`);
      }
      info.replaceChildren(...lines.map(t => Object.assign(document.createElement('div'), { textContent: t })));
    }
    function fmtNum(v, type) {
      if (type === 'bool') return v ? 'ON' : 'OFF';
      if (typeof v !== 'number' || !isFinite(v)) return String(v);
      return (Math.abs(v) < 10 ? v.toFixed(3) : Math.round(v));
    }
    const brainExportBtn = document.querySelector('#pss [data-k="brainExport"]');
    if (brainExportBtn) brainExportBtn.onclick = exportBrain;
    const brainImportBtn = document.querySelector('#pss [data-k="brainImport"]');
    const brainFile = document.querySelector('#pss [data-k="brainFile"]');
    if (brainImportBtn && brainFile) brainImportBtn.onclick = () => brainFile.click();
    if (brainFile) brainFile.onchange = e => { const f = e.target.files && e.target.files[0]; if (f) importBrainFile(f); e.target.value = ''; };
    const brainRebuild = document.querySelector('#pss [data-k="brainRebuild"]');
    if (brainRebuild) brainRebuild.onclick = () => { buildBrain(); save(); renderBrain(); };
    const brainSearch = document.querySelector('#pss [data-k="brainSearch"]');
    if (brainSearch) brainSearch.oninput = renderBrain;
    renderBrain();
    try { window.__renderBrain = renderBrain; } catch (e) {}
    // canvas click to toggle lock (simple: click node nearest center locks its param)
    const canvas = document.querySelector('#pss [data-k="brainCanvas"]');
    if (canvas) {
      canvas.addEventListener('click', (e) => {
        const rect = canvas.getBoundingClientRect();
        const x = (e.clientX - rect.left) * (canvas.width / rect.width);
        const y = (e.clientY - rect.top) * (canvas.height / rect.height);
        const pos = canvas._pos || {};
        let best = null, bd = 1e9;
        for (const n of Object.values(cfg.brain.nodes || {})) {
          const p = pos[n.id]; if (!p) continue;
          const d = Math.hypot(p.x - x, p.y - y);
          if (d < bd) { bd = d; best = n; }
        }
        if (best && bd < 14 && best.id.startsWith('steer.') || best && bd < 14 && best.id.startsWith('learn.') || best && bd < 14 && best.id.startsWith('cfg.')) {
          // toggle lock in learn.params.locked (for tracked) — store in node
          best.locked = !best.locked;
          if (cfg.learn && cfg.learn.params && cfg.learn.params.locked) cfg.learn.params.locked[best.id] = best.locked;
          save(); renderBrain();
        }
      });
    }
    // 定期刷新腦圖
    setInterval(() => { try { renderBrain(); } catch (e) {} }, 2000);
    // 面板不要把按鍵 / 點擊漏給遊戲
    for (const t of ['pointerdown', 'mousedown', 'click', 'touchstart']) el.addEventListener(t, e => e.stopPropagation());

    // 拖曳
    let drag = null;
    $('toggle').parentElement.addEventListener('pointerdown', e => { if (e.target.tagName === 'BUTTON') return; drag = [e.clientX - el.offsetLeft, e.clientY - el.offsetTop]; });
    addEventListener('pointermove', e => { if (!drag) return; el.style.left = (e.clientX - drag[0]) + 'px'; el.style.top = (e.clientY - drag[1]) + 'px'; });
    addEventListener('pointerup', () => { if (!drag) return; drag = null; clampPos(); });
    // 標題列至少留 40px 在畫面內，拖不出去；視窗縮小時也一起拉回來
    function clampPos() {
      const x = Math.min(Math.max(el.offsetLeft, 40 - el.offsetWidth), innerWidth - 40);
      const y = Math.min(Math.max(el.offsetTop, 0), innerHeight - 28);
      el.style.left = x + 'px'; el.style.top = y + 'px';
      cfg.panelX = x; cfg.panelY = y; save();
    }
    function resetPos() { el.style.left = '12px'; el.style.top = '64px'; clampPos(); }
    $('home').onclick = resetPos;
    addEventListener('resize', clampPos);
    clampPos();

    // 配置編輯：以「目前出戰的寶可夢」為準
    let shownDex = null;
    const curDex = () => (ns.Game.player && ns.Game.player.dex) || menuDex(ns) || shownDex;
    const prof = dex => (cfg.profiles[dex] = cfg.profiles[dex] || { moves: [], item: '' });
    const mvName = id => { const m = ns.Moves.BY_ID[id]; return m ? ns.T(m.name, 'move') : id; };
    function renderBuild(force) {
      const dex = curDex();
      if (!dex || (!force && dex === shownDex)) return;
      shownDex = dex;
      const mon = (ns.Game.player && ns.Game.player.dex === dex && ns.Game.player.mon) || (ns.DEX_BY && ns.DEX_BY[dex]);
      const name = mon ? (ns.T ? ns.T(mon.name) : mon.name) : '#' + dex;
      const pr = cfg.profiles[dex];
      $('ptitle').textContent = `畢業配置 · ${name}${pr && pr.moves.length ? '' : '（自動模式）'}`;
      $('build').innerHTML = '';
      (pr ? pr.moves : []).forEach((id, i) => {
        const c = document.createElement('span'); c.className = 'chip'; c.title = '點一下移除';
        c.textContent = `${i + 1}. ${mvName(id)}`;
        c.onclick = () => { prof(dex).moves.splice(i, 1); save(); renderBuild(true); };
        $('build').appendChild(c);
      });
      let pool = [];
      try { pool = mon ? ns.Moves.poolFor(mon) : []; } catch {}
      if (!pool || !pool.length) pool = Object.keys(ns.Moves.BY_ID);
      $('pool').innerHTML = pool.filter(id => !(pr && pr.moves.includes(id)))
        .map(id => `<option value="${id}">${mvName(id)}${ns.Moves.BY_ID[id]?.kind === 'buff' ? '（增益）' : ''}</option>`).join('');
      const items = (ns.Items && (ns.Items.LIST || Object.values(ns.Items.BY || {}))) || [];
      $('item').innerHTML = '<option value="">道具：預設優先序</option>' + items.map(it => `<option value="${it.id}">道具：${ns.T ? ns.T(it.name) : it.name}</option>`).join('');
      $('item').value = (pr && pr.item) || '';
    }
    $('add').onclick = () => { const dex = curDex(); const v = $('pool').value; if (!dex || !v) return; const pr = prof(dex); if (pr.moves.length < 4 && !pr.moves.includes(v)) pr.moves.push(v); save(); renderBuild(true); };
    $('clear').onclick = () => { const dex = curDex(); if (!dex) return; prof(dex).moves = []; save(); renderBuild(true); };
    $('item').onchange = () => { const dex = curDex(); if (!dex) return; prof(dex).item = $('item').value; save(); };

    setInterval(() => {
      renderRec();
      try { renderDash(); } catch (e) {}
      renderBuild(false);
      const p = ns.Game.player, inRun = p && ns.Game.state !== 'ui';
      const xpLine = inRun ? `經驗 ×${(p.xpMul || 1).toFixed(2)} · 場上 ${ns.EnemyMgr.count ?? ns.EnemyMgr.all().length}/64${S.spawnLimited ? ' · 怪不夠打（學習優先）' : ''}\n` : '';
      const run = inRun ? xpLine + `Lv${p.level} · HP ${Math.round(p.hp)}/${Math.round(p.maxHp)} · 擊倒 ${p.kills} · 羈絆券 ${p.bonds} · ${cfg.record ? '記錄中（bot 停手）' : cfg.on ? S.mode || '' : '暫停'}\n欄位：${p.slots.map((g, i) => (i === p.active ? '▶' : '') + g.map(m => mvName(m.id)).join('+')).join(' | ')}` : '不在遊戲中';
      const mins = Math.round((Date.now() - stats.startedAt) / 60000);
      // 遊戲的 CSS 會吃掉換行，所以一行一個 div
      const extra = [S.lastPartnerMsg && '夥伴：' + S.lastPartnerMsg, S.lastUpgradeMsg && '強化：' + S.lastUpgradeMsg, S.lastGachaMsg && '抽到：' + S.lastGachaMsg].filter(Boolean);
      const lines = `${run}\n本次掛機 ${mins} 分：${stats.runs} 局，擊倒 ${stats.kills}，金幣 ${stats.coins}`.split('\n').concat(extra);
      $('status').replaceChildren(...lines.map(t => Object.assign(document.createElement('div'), { textContent: t })));
      const mmss = t => `${Math.floor((t || 0) / 60)}:${String(Math.floor((t || 0) % 60)).padStart(2, '0')}`;
      const runLine = h => `${mmss(h.time)} Lv${h.level} · 擊倒 ${h.kills} · 金幣 ${h.coins}${h.record ? ' · 新紀錄' : ''}` +
        (h.judge ? `\n　審判 ${mmss(h.judge.time)} · ${h.judge.bosses} 隻傳說 · 傷害 ${(h.judge.dmg || 0).toLocaleString()}` : '');
      const hist = (cfg.history || []).slice(0, 5).flatMap(h => runLine(h).split('\n'));
      if ($('hist').childElementCount !== hist.length || $('hist').textContent !== hist.join('')) $('hist').replaceChildren(...(hist.length ? hist : ['還沒有完成的局']).map(t => Object.assign(document.createElement('div'), { textContent: t })));
    }, 500);
  }

  // 主選單時的出戰夥伴：優先讀存檔，讀不到再用名稱反查
  function menuDex(ns) {
    if (ns.DB && ns.DB.save && ns.DB.save.partner) return ns.DB.save.partner;
    const n = document.getElementById('menu-partner-name');
    const txt = n && n.textContent.trim();
    if (!txt || !ns.DEX) return null;
    const m = ns.DEX.find(d => d.name === txt || (ns.T && ns.T(d.name) === txt));
    return m ? m.dex : null;
  }
})();
