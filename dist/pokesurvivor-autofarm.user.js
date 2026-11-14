// ==UserScript==
// @name         PokéSurvivor 自動掛機 (PSBot)
// @name:en      PokéSurvivor Auto-Farm (PSBot)
// @namespace    https://github.com/b0933223169-coder/pokesurvivor-autofarm
// @version      11.0.0
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

(() => {
  'use strict';
  const GUARD = Symbol.for('psbot.guard');
  if (window[GUARD]) return;
  try { Object.defineProperty(window, GUARD, { value: 1, configurable: true }); } catch { window[GUARD] = 1; }

  const STORE_KEY = 'psbot.v1';
  const VERSION = '11.0.0';   // v11.0.0：適配小山豬吃樹果、新道具/被動/消耗品、完全移除RL、強化穩定度
  const log = (...a) => console.log('%c[PSBot]', 'color:#ff8ad8', ...a);
  let capturedNs = null;

  // ---------- 0. 擴充警告兜底 ----------
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
    setTimeout(() => { try { mo.disconnect(); } catch {} }, 30000);
  } catch {}

  // ---------- 1. 抓命名空間 ----------
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
  setTimeout(() => { if (!booted) unhook(); }, 5000);
  setTimeout(() => { if (!booted) { clearInterval(poll); unhook(); console.warn('[PSBot] namespace not found'); } }, 30000);

  // ---------- 1b. 用特徵認出混淆後的模組 ----------
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
    set('Room',        v => hasKeys(v, 'room', 'uid', 'friends', 'invites', 'MAX_PLAYERS') && hasFns(v, 'createRoom', 'joinRoom', 'leaveRoom'));
    set('Tiles',       v => hasKeys(v, 'T', 'BIOMES') && hasFns(v, 'runBiome'));
    set('DB',          v => hasFns(v, 'commit', 'upgradesOf') && hasKeys(v, 'save'));
    set('Moves',       v => hasFns(v, 'poolFor') && hasKeys(v, 'BY_ID', 'EVO'));
    set('DEX',         v => Array.isArray(v) && v.length > 100 && v[0] && typeof v[0].dex === 'number' && 'bst' in v[0]);
    set('DEX_BY',      v => !Array.isArray(v) && isObj(v) && v[1] && v[1].dex === 1 && v[25] && v[25].dex === 25 && 'name' in v[25]);

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

    if (ns.LIFT === undefined) {
      const n = vals.find(v => typeof v === 'number' && v === 18);
      if (n !== undefined) alias(ns, 'LIFT', n);
    }

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

  // ---------- 2. 設定（全面包含新被動、新道具、新物件權重） ----------
  const DEFAULTS = {
    on: false,
    move: true,        // 自動走位
    cards: true,       // 自動選升級卡
    bonds: true,       // 自動羈絆
    items: true,       // 自動選攜帶道具
    rift: true,        // 主動走進神祕裂縫
    orbs: true,        // 危急 / 首領戰自動用寶珠
    restart: true,     // 結束後自動再來一局
    noRank: true,      // 掛機局不上排行榜
    upgrade: false,    // 回主選單時自動買強化
    gacha: false,      // 回主選單時自動抽獎
    autoPartner: false,// 回主選單時自動換最強夥伴
    favorites: [382, 150], // 蓋歐卡、超夢
    passiveFirst: true,// 被動強化 > 主動招式升級
    farm: true,        // 養怪模式
    lead: false,       // 預判射擊
    focus: true,       // 集火瞄準
    portal: { alwaysEnter: false, enterHp: 0.7, enterDist: 300 },
    steer: {
      fearLow: 0.35, fearMid: 0.6, fearK: 1.0,
      retreatDist: 120, springHp: 0.6,
      farmMinEnemies: 54, farmHpOn: 0.65, farmHpOff: 0.45,
      orbHp: 0.35, healCardHp: 0.35, magnetBase: 78,
    },
    // 選卡屬性權重（包含新增被動：critd, hunt, dodge, pwr, luck）
    statPri: {
      xp: 74, atk: 60, cd: 55, def: 52, dodge: 50, hunt: 48, pwr: 45,
      hp: 40, rgn: 35, critd: 32, crit: 30, mag: 25, luck: 20, spd: 15, heal: 10
    },
    // 招式類型優先級
    kindPri: {
      vortex: 45, nova: 40, aura: 38, meteor: 36, orbit: 34, spin: 33, bounce: 31,
      chain: 30, shove: 29, quake: 27, cone: 26, charge: 24, stun: 22, beam: 22,
      boomerang: 20, homing: 18, projectile: 12, turret: 12, mine: 8, melee: 4, dash: 3, trail: 3
    },
    // 24 種攜帶道具優先級（數字越小越優先）
    itemPri: {
      shellbell: 0, luckyegg: 1, leftovers: 2, covertcloak: 3, focussash: 4,
      assaultvest: 5, heavydutyboots: 6, quickclaw: 7, loadeddice: 8, punchingglove: 9,
      choicescarf: 10, choiceband: 11, lifeorb: 12, rockyhelmet: 13, amuletcoin: 14,
      metronome: 15, throatspray: 16, superpads: 17, mirrorherb: 18, safetygoggles: 19,
      radargoggles: 20, expcharm: 21, luckincense: 22, rareincense: 23
    },
    // 地面拾取物優先級（加入新拾取物 treat: expcandy, sitrus, atania, meloc, mochi...）
    pickupPri: {
      ticket10: 14, ticket: 11, item: 10, treat: 9.5, sphere: 8, candy: 7,
      magnet: 6, bomb: 3.5, coin: 2.5, xpBig: 3, xp: 1, healUrgent: 12, healNormal: 0.5
    },
    // 局外強化項目權重（包含新增項目 dodge, hunt, pwr, luck 等）
    upgradePri: {
      hunt: 1.3, dodge: 1.25, def: 1.2, xp: 1.15, atk: 1.1, cd: 1.1, coins: 1.1,
      luck: 1.05, pwr: 1.0, reroll: 1.0, hp: 0.9, magnet: 0.9, crit: 0.8, critd: 0.8,
      regen: 0.8, spd: 0.4
    },
    upgradeCap: { coins: 5, reroll: 3 },
    profiles: {
      150: { moves: ['confusion', 'harden', 'psychic', 'nasty-plot'], item: 'shellbell' }
    },
    history: [],
    panelX: null, panelY: null, collapsed: false,
  };

  let cfg;
  try { cfg = Object.assign({}, DEFAULTS, JSON.parse(localStorage.getItem(STORE_KEY) || '{}')); }
  catch { cfg = Object.assign({}, DEFAULTS); }
  cfg.statPri = Object.assign({}, DEFAULTS.statPri, cfg.statPri || {});
  cfg.kindPri = Object.assign({}, DEFAULTS.kindPri, cfg.kindPri || {});
  cfg.itemPri = Object.assign({}, DEFAULTS.itemPri, cfg.itemPri || {});
  cfg.pickupPri = Object.assign({}, DEFAULTS.pickupPri, cfg.pickupPri || {});
  cfg.upgradePri = Object.assign({}, DEFAULTS.upgradePri, cfg.upgradePri || {});
  cfg.steer = Object.assign({}, DEFAULTS.steer, cfg.steer || {});
  cfg.portal = Object.assign({}, DEFAULTS.portal, cfg.portal || {});
  cfg.profiles = Object.assign({}, DEFAULTS.profiles, cfg.profiles || {});

  // 清除舊有的 RL / Brain 殘留物件，確保乾淨純粹
  delete cfg.rl;
  delete cfg.brain;
  delete cfg.brains;
  delete cfg.learn;

  const save = () => {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(cfg)); return true; }
    catch (e) { console.warn('[PSBot] Save failed', e); return false; }
  };

  const stats = { runs: 0, kills: 0, coins: 0, best: 0, startedAt: Date.now() };
  let liveNs = null;

  // ---------- 3. 主程式 ----------
  function boot(ns) {
    liveNs = ns;
    log('namespace captured, version', VERSION);
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
      if ((waited += 50) % 500 === 0) try { resolveNs(ns); } catch {}
      if (waited === 5000) console.warn('[PSBot] waiting for modules:', missing.join(', '));
    }, 50);
  }

  const S = {
    pickTimer: null, lastPos: null, stuckT: 0, unstickT: 0, unstickDir: null,
    wanderA: Math.random() * 6.28, lastSlotCheck: 0, lastOrb: 0, lastT: performance.now(),
    overAt: -1e9, againAt: -1e9, lobbyAt: -1e9, coopFull: true, fullLogAt: -1e9,
    lastPlay: -1e9, pausedAt: 0, userPausedAt: -1e9, lastDir: null, lastOffer: null,
    orbGoal: null, plan: null, seen: {}, ban: {}, noGo: {}, jCenter: null, holding: false,
    holdKey: null, holdSince: 0, wd: null, losBadT: 0, spin: 1, spinBlockT: 0,
    loopC: null, dirIdx: -1, holdT: 0, out: [1, 0],
    focusId: null, focusEnemy: null, bossLockId: null
  };

  function patch(ns) {
    // 走位控制
    const origAxis = ns.Input.axis.bind(ns.Input);
    ns.Input.axis = function () {
      const manual = origAxis();
      if (manual && (manual[0] || manual[1])) return manual;
      if (!cfg.on || !cfg.move) return manual;
      try { return steer(ns); } catch (e) { console.warn('[PSBot] steer', e); return manual; }
    };

    // 升級選卡
    const origOffer = ns.LevelUp.offer;
    ns.LevelUp.offer = function () {
      const r = origOffer.apply(this, arguments);
      S.lastOffer = r;
      return r;
    };
    const R = ns.RunUI;
    const origLevel = R.showLevelUp;
    R.showLevelUp = function (level, cards, cb, coop) {
      const r = origLevel.apply(this, arguments);
      if (cfg.on && cfg.cards) schedule(() => chooseCard(ns, cards), 700);
      return r;
    };

    // 羈絆選擇
    const origBond = R.showBond;
    R.showBond = function (opt, cb) {
      const r = origBond.apply(this, arguments);
      if (cfg.on && cfg.bonds) schedule(() => chooseBond(ns, opt), 700);
      return r;
    };

    // 攜帶道具二選一
    const origItem = R.showItemChoice;
    R.showItemChoice = function (cur, next, cb) {
      const r = origItem.apply(this, arguments);
      if (cfg.on && cfg.items) schedule(() => {
        const keep = itemRank(cur) <= itemRank(next);
        const el = document.querySelectorAll('#item-cards .card')[keep ? 0 : 1];
        el && el.click();
      }, 700);
      return r;
    };

    // 結算處理
    const origOver = R.showOver;
    R.showOver = function (d) {
      const r = origOver.apply(this, arguments);
      if (cfg.on) {
        stats.runs++; stats.kills += d.kills || 0; stats.coins += d.coins || 0;
        stats.best = Math.max(stats.best, d.time || 0);
        log(`run #${stats.runs}: ${Math.round(d.time)}s lv${d.level} kills ${d.kills} coins ${d.coins}`);
        const j = d.judge;
        cfg.history = [{
          at: Date.now(), dex: ns.Game.player && ns.Game.player.dex,
          time: d.time, level: d.level, kills: d.kills, bosses: d.bosses, coins: d.coins,
          judge: j ? { time: j.time, bosses: j.bosses, dmg: j.dmg } : null
        }].concat(cfg.history || []).slice(0, 30);
        save();
        S.overAt = now();
      }
      return r;
    };

    // 掛機局跳過上傳排行榜
    if (ns.Ranking) for (const k of ['submitSolo', 'submitGroup']) {
      const orig = ns.Ranking[k];
      if (typeof orig !== 'function') continue;
      ns.Ranking[k] = function () {
        if (cfg.on && cfg.noRank) { log('ranking submit skipped'); return Promise.resolve(null); }
        return orig.apply(this, arguments);
      };
    }

    trackHazards(ns);

    // 每 200ms 常規排程工作
    setInterval(() => {
      if (!cfg.on) { S.coopFull = true; return; }
      try {
        if (ns.Room && ns.Room.room && ns.Game.state === 'playing') S.coopFull = false;
        for (const fn of [housekeeping, autoGacha, autoPartner, autoUpgrade, autoRestart, autoResume]) {
          try { fn(ns); } catch (e) { console.warn('[PSBot] ' + fn.name, e); }
        }
      } catch (e) { console.warn('[PSBot] tick', e); }
    }, 200);

    log('patched successfully without RL dependencies');
  }

  function schedule(fn, ms) { setTimeout(() => { try { fn(); } catch (e) { console.warn('[PSBot]', e); } }, ms); }

  // ---------- 4. 選卡邏輯 ----------
  function profileOf(ns) {
    const p = ns.Game.player;
    const prof = p && cfg.profiles[p.dex];
    return prof && prof.moves && prof.moves.length ? prof : null;
  }

  function atkBuffOf(ns, p) { return ns.Stats.sideOf(p.mon) === 'physical' ? 'swords-dance' : 'nasty-plot'; }

  const EARLY_AOE = ['vortex', 'aura', 'orbit'];
  function aoeScore(ns, p, m) {
    const kindScore = cfg.kindPri && cfg.kindPri[m.kind] != null ? Number(cfg.kindPri[m.kind]) : 0;
    const fit = m.cat ? ns.Stats.fit(p.mon, m.cat) : 1;
    if (fit < 0.9) return -350;
    return kindScore + (fit >= 0.999 ? 0 : -15) + ((p.mon.types || []).includes(m.type) ? 8 : 0);
  }

  function scoreNewMove(ns, p, id) {
    const prof = profileOf(ns);
    if (prof) {
      const i = prof.moves.indexOf(id);
      return i >= 0 ? 900 - i * 5 : -100;
    }
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
    if (atk >= 2) return -100;
    const aoe = aoeScore(ns, p, m);
    return aoe >= 20 && EARLY_AOE.includes(m.kind) ? 868 : 800 + aoe;
  }

  function scoreCard(ns, p, c) {
    const [type, id] = [c.type, String(c.key).split(':').slice(1).join(':')];
    const hpRatio = p.hp / p.maxHp;
    const lowHp = hpRatio < (cfg.steer.healCardHp || 0.35);
    if (type === 'evo') return 1000;
    if (type === 'new') return scoreNewMove(ns, p, id);

    const EVO = ns.Moves.EVO || {};
    const evoNeeds = new Set(p.moves.filter(m => !m.evolved && EVO[m.id] && !(p.statsTaken || {})[EVO[m.id]]).map(m => EVO[m.id]));
    if (type === 'stat') {
      if (id === 'heal') return lowHp ? 950 : 10;
      if (c.color === '#ffd23f') return 980;
      if (evoNeeds.has(id)) return 700;
      if (id === 'xp' && S.spawnLimited) return 660;
      const pri = id === 'def' && (p.dmgReduce || 0) < 0.69 ? 70 : id === 'mag' && (p.magnet || cfg.steer.magnetBase || 78) < 260 ? 72 : (cfg.statPri[id] ?? 20);
      return (cfg.passiveFirst ? 500 : 300) + pri;
    }
    if (type === 'up') {
      const prof = profileOf(ns);
      const i = prof ? prof.moves.indexOf(id) : -1;
      const m = p.moves.find(x => x.id === id);
      const inActive = p.activeGroup().some(x => x.id === id);
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
    const scores = cards.map(c => scoreCard(ns, p, c));
    let best = 0, bestS = -Infinity;
    scores.forEach((s, i) => { if (s > bestS) { bestS = s; best = i; } });

    const rr = document.getElementById('lvl-reroll');
    if (bestS < 500 && rr && !rr.classList.contains('hidden')) {
      log('reroll cards'); ns.RunUI.reroll();
      return schedule(() => chooseCard(ns, S.lastOffer || cards), 300);
    }
    log('pick card', cards[best].key, bestS);
    ns.RunUI.pick(best);
  }

  // ---------- 5. 羈絆選擇 ----------
  function bondRank(ns, p, mv) {
    const prof = profileOf(ns);
    if (prof) { const i = prof.moves.indexOf(mv.id); return i >= 0 ? i : 50; }
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
    const candidates = opt.loose;
    const order = candidates.map((m, i) => ({ m, i, rank: bondRank(ns, p, m) })).sort((a, b) => a.rank - b.rank);
    if (opt.mode === 'add') {
      log('bond add', order[0].m.id);
      return ns.RunUI.pickBond(order[0].i);
    }
    const first = order[0].m, second = order[1].m;
    log('bond pair', first.id, second.id);
    ns.RunUI.pickBond(order[0].i);
    schedule(() => {
      const list = opt.loose.filter(m => m !== first);
      ns.RunUI.pickBond(list.indexOf(second));
    }, 250);
  }

  // ---------- 6. 道具順序 ----------
  function itemRank(id) {
    return cfg.itemPri[id] !== undefined ? cfg.itemPri[id] : 99;
  }

  // ---------- 7. 雜務：主動欄位 / 寶珠 ----------
  function groupScore(g, prof) {
    let dmg = 0, buff = 0, rank = 0;
    for (const m of g) {
      if (m.kind === 'buff') buff++; else dmg += 10 + (m.lvl || 1) + (m.evolved ? 5 : 0);
      const i = prof ? prof.moves.indexOf(m.id) : -1;
      if (i >= 0 && m.kind !== 'buff') rank += 100 - i * 20;
    }
    if (!dmg) return 0;
    return prof ? rank + buff * 30 + g.length * 5 : dmg + buff * 6;
  }

  function housekeeping(ns) {
    const p = ns.Game.player;
    if (!p || p.dead || ns.Game.state !== 'playing') return;
    hookAim(ns, p);
    const now = performance.now();
    const cnt = ns.EnemyMgr.count ?? ns.EnemyMgr.all().length;
    const busy = (ns.Rift && ns.Rift.inArena) || (ns.Judgment && ns.Judgment.active);
    if (!busy) {
      S.fieldAvg = S.fieldAvg == null ? cnt : S.fieldAvg + (cnt - S.fieldAvg) * 0.01;
      S.spawnLimited = (ns.Game.st && ns.Game.st.time > 60) && S.fieldAvg < 25;
    }
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
      const danger = p.hp / p.maxHp < (cfg.steer.orbHp || 0.35) || around >= 8;
      const boss = (ns.EnemyMgr.bossAlive && ns.EnemyMgr.bossAlive()) || (ns.Judgment && ns.Judgment.active);
      p.orbs.forEach((o, i) => {
        if (!o || now - S.lastOrb < 1500) return;
        const kind = ns.Orbs.BY && ns.Orbs.BY[o.id] && ns.Orbs.BY[o.id].kind;
        if ((kind === 'foe' && danger) || (kind === 'buff' && boss)) { ns.Orbs.use(p, i); S.lastOrb = now; }
      });
    }
  }

  // ---------- 7b. 集火瞄準 ----------
  function hookAim(ns, p) {
    if (S.aimHooked) return;
    const proto = Object.getPrototypeOf(p);
    if (!proto || typeof proto.handAim !== 'function') return;
    const orig = proto.handAim;
    proto.handAim = function () {
      if (cfg.on && cfg.focus && this === ns.Game.player && !this.remote) {
        try { return focusAim(ns, this); } catch (e) { console.warn('[PSBot] aim', e); return null; }
      }
      return orig.call(this);
    };
    const origAlong = proto.enemyAlong;
    if (typeof origAlong === 'function') proto.enemyAlong = function (all, a) {
      const fe = S.focusEnemy;
      if (cfg.on && cfg.focus && this === ns.Game.player && fe && !fe.dead) return fe;
      return origAlong.call(this, all, a);
    };
    S.aimHooked = true;
  }

  function committedBoss(ns) {
    const bosses = [];
    for (const e of ns.EnemyMgr.all()) {
      if (!e || e.dead || e.silent || e.arceus || !e.boss) continue;
      bosses.push(e);
    }
    if (!bosses.length) { S.bossLockId = null; return null; }
    const locked = bosses.find(e => e.id === S.bossLockId);
    if (locked) return locked;
    bosses.sort((a, b) => (a.id | 0) - (b.id | 0));
    S.bossLockId = bosses[0].id;
    return bosses[0];
  }

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
      if (e.boss) {
        const lock = committedBoss(ns);
        if (!lock || e !== lock) continue;
      } else if (judging) continue;
      if (d > 1 && d < reach) list.push({ e, dx, dy, d });
    }
    if (!list.length) return null;

    const W = ns.World;
    if (W && W.projectileBlock) {
      const lift = ns.LIFT || 0;
      const clear = c => {
        const n = Math.ceil(c.d / 16);
        for (let i = 1; i < n; i++) if (W.projectileBlock(p.x + c.dx * i / n, p.y + c.dy * i / n - lift, 4)) return false;
        return true;
      };
      list.sort((a, b) => a.d - b.d);
      const vis = list.slice(0, 24).filter(clear);
      if (!vis.length) return null;
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
        if (e.id === S.focusId) s += 0.02 + 0.6 * Math.min(1, hd / hp);
      }
      if (s > bs) { bs = s; best = c; }
    }
    if (!best) return null;
    S.focusId = best.e.id; S.focusEnemy = best.e;
    return Math.atan2(best.e.y - p.y, best.e.x - p.x);
  }

  // ---------- 8. 走位 AI ----------
  const FARM_KINDS = ['vortex', 'nova', 'aura', 'orbit', 'spin', 'meteor', 'quake'];
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

  const liquidOf = (ns, p) => {
    const W = ns.World, ab = p.abil || {};
    if (!W || !W.liquidEffect || ab.levitate) return {};
    const e = Object.assign({}, W.liquidEffect((p.mon && p.mon.types) || []) || {});
    if (ab.lavaProof) delete e.dmg;
    if (ab.steady) delete e.slow;
    return e;
  };
  const wetOk = (ns, p) => !liquidOf(ns, p).dmg;
  const wetSlow = (ns, p) => liquidOf(ns, p).slow || 1;
  const trapsNear = (W, x, y, r) => ((W && W.specialsNear && W.specialsNear(x, y, r)) || []).filter(t => t.type === 'trap');

  function findPath(ns, p, tx, ty, goalTol) {
    const W = ns.World, TS = W.TS || 32;
    if (!W.isFree) return null;
    const sx = Math.floor(p.x / TS), sy = Math.floor(p.y / TS), gx = Math.floor(tx / TS), gy = Math.floor(ty / TS);
    const span = Math.max(Math.abs(gx - sx), Math.abs(gy - sy)) + 20;
    if (span > 120) return null;
    const traps = trapsNear(W, (p.x + tx) / 2, (p.y + ty) / 2, Math.hypot(tx - p.x, ty - p.y) / 2 + 200);
    const wet = wetOk(ns, p), wetCost = 1 / wetSlow(ns, p);
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
        if (dx && dy && (!ok(c.x + dx, c.y) || !ok(c.x, c.y + dy))) continue;
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
    const startDistance = Math.hypot(p.x - pts[0][0], p.y - pts[0][1]);
    const center = pts[pts.length - 1];
    const endDistance = Math.hypot(tx - center[0], ty - center[1]);
    pts[pts.length - 1] = [tx, ty];
    return { pts, len: startDistance + g.get(K(end.x, end.y)) * TS + endDistance };
  }

  function waypoint(ns, p, path) {
    const W = ns.World, traps = trapsNear(W, p.x, p.y, 320);
    const clear = (x, y) => {
      const d = Math.hypot(x - p.x, y - p.y), n = Math.ceil(d / 8);
      for (let i = 1; i <= n; i++) {
        if (d * (1 - i / n) < 26) break;
        const sx = p.x + (x - p.x) * i / n, sy = p.y + (y - p.y) * i / n;
        if (!W.isFree(sx, sy, p.r, wetOk(ns, p)) || traps.some(t => (sx - t.x) ** 2 + (sy - t.y + 8) ** 2 < 23 * 23)) return false;
      }
      return true;
    };
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

  // ---------- 8b. 目標規劃（支援小山豬事件 Munchlax 及小偷 Gholdengo 等） ----------
  function candidates(ns, p, hpPct) {
    const out = [], now = (ns.Game.st && ns.Game.st.time) || 0, W = ns.World;

    // 1. 小偷怪（喵喵、Gholdengo）
    if (hpPct > 0.2) for (const e of ns.EnemyMgr.all()) {
      if (e.dead || e.behavior !== 'thief') continue;
      S.seen[e.id] = S.seen[e.id] ?? now;
      const gold = (e.def && e.def.loot === 'ticket10') || e.dex === 1000;
      out.push({
        key: 'thief' + e.id, x: e.x, y: e.y, tier: gold ? 5 : 3,
        value: gold ? 14 : 3, left: 15 - (now - S.seen[e.id]),
        mode: gold ? '追 Gholdengo' : '追喵喵', goalTol: 2, chase: true, flee: e.spd || 92
      });
    }

    // 2. 裂縫傳送門
    const rift = ns.Rift && ns.Rift.rift;
    const bondDone = p.slots.some(g => g.length >= 4);
    const portalHp = cfg.portal.enterHp != null ? cfg.portal.enterHp : 0.7;
    const portalDist = cfg.portal.enterDist != null ? cfg.portal.enterDist : 300;
    const portalForced = !!cfg.portal.alwaysEnter;
    let nearEnemyDist = 9999;
    for (const e of ns.EnemyMgr.all()) { if (!e.dead) nearEnemyDist = Math.min(nearEnemyDist, Math.hypot(e.x - p.x, e.y - p.y)); }
    const portalSafe = hpPct > portalHp && nearEnemyDist > portalDist;

    if ((cfg.rift || portalForced) && rift && !ns.Rift.inArena && (portalForced || (now < 1680 && hpPct > 0.2 && !bondDone && portalSafe))) {
      out.push({
        key: 'rift', tier: portalForced ? 99 : 4, x: rift.x, y: rift.y - 10,
        value: portalForced ? 1000 : 12, left: rift.ttl ?? 45,
        mode: '進裂縫', goalTol: 0, chase: true, direct: true
      });
    }

    // 3. 事件：迷路求救與護送
    const lost = ns.Events && ns.Events._dbg && ns.Events._dbg();
    if (lost && hpPct > 0.25 && !ns.Rift.inArena) {
      if (lost.state === 'wait') out.push({ key: 'lost', tier: 3, x: lost.x, y: lost.y, value: 8, left: 90, mode: '去救援', goalTol: 1, chase: true });
      else out.push({ key: 'escort', tier: 3, x: lost.tx, y: lost.ty, value: 9, left: 90, mode: '護送中', goalTol: 0, chase: true, hold: 20, escort: true });
    }

    // 4. 新事件：小山豬 Munchlax 吃樹果
    const munch = ns.Events && ns.Events._munch && ns.Events._munch();
    if (munch && hpPct > 0.3 && !ns.Rift.inArena) {
      const myCarry = (munch.carry && munch.carry.get(p.uid)) || 0;
      if (myCarry > 0) {
        // 身手已有相應樹果 -> 走去小山豬身邊餵食 (距離24px內觸發)
        out.push({
          key: 'munch_feed', tier: 4, x: munch.x, y: munch.y,
          value: 10, left: 120 - (munch.t || 0), mode: '餵食小山豬', goalTol: 0, chase: true, hold: 10
        });
      } else if (Array.isArray(munch.bushes)) {
        // 前往未搖晃且符合需求（或任一未搖晃）的灌木叢 (距離20px內觸發搖樹)
        const bushes = munch.bushes.filter(b => !b.shaken);
        const matchBush = bushes.find(b => b.kind === munch.want) || bushes[0];
        if (matchBush) {
          out.push({
            key: 'munch_bush_' + matchBush.x + '_' + matchBush.y, tier: 3,
            x: matchBush.x, y: matchBush.y, value: 8, left: 120 - (munch.t || 0),
            mode: '搖灌木獲取樹果', goalTol: 0, chase: true, hold: 5
          });
        }
      }
    }

    // 5. 地圖特異物件：祭壇、泉水、大寶箱
    if (!ns.Rift.inArena && W && W.specialsNear) for (const o of W.specialsNear(p.x, p.y, 700)) {
      if (o.type === 'altar' && !o.used) {
        out.push({ key: 'altar' + o.id, tier: 2, x: o.x, y: o.y, value: 5, left: Infinity, mode: '吃祭壇buff', goalTol: 1, chase: true });
      } else if (o.type === 'spring' && hpPct < (cfg.steer.springHp || 0.6) && (o.charge ?? 1) > 0.2) {
        out.push({ key: 'spring' + o.id, tier: 2, x: o.x, y: o.y - 8, value: 7, left: Infinity, mode: '泉水回血', goalTol: 0, hold: 20, until: () => p.hp >= p.maxHp * 0.95 });
      } else if (o.type === 'bigchest' && hpPct > 0.5) {
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
    const gt = (ns.Game.st && ns.Game.st.time) || 0;
    const cands = candidates(ns, p, hpPct).filter(c => !(S.ban[c.key] > gt));
    const live = cur && cands.find(c => c.key === cur.key);
    const higher = cur && cands.some(c => c.tier > cur.c.tier && !(S.noGo[c.key] > now));
    const stale = !live || higher || now - cur.at > 600 || Math.hypot(live.x - cur.c.x, live.y - cur.c.y) > 48 || (cur.path && cur.path.pts.length < 2);
    if (!stale) { cur.c = Object.assign(cur.c, live, { x: cur.c.x, y: cur.c.y }); return cur; }

    let best = null, bestScore = 0, bestTier = -1;
    const order = cands.sort((a, b) => (b.tier - a.tier) || (b.value / Math.hypot(b.x - p.x, b.y - p.y) - a.value / Math.hypot(a.x - p.x, a.y - p.y)));
    for (const c of order) {
      if (c.tier < bestTier) break;
      const path = findPath(ns, p, c.x, c.y, c.goalTol);
      if (!path) { S.noGo[c.key] = now + 1000; continue; }
      const eta = c.flee ? Math.max(0, path.len - 220) / Math.max(8, pSpd - c.flee) : path.len / pSpd;
      if (eta > c.left - 1) { S.noGo[c.key] = now + 1000; continue; }
      const score = c.value / (eta + 4) * (cur && cur.key === c.key ? 1.8 : 1);
      if (c.tier > bestTier || score > bestScore) { bestTier = c.tier; bestScore = score; best = { key: c.key, c, path, at: now, eta }; }
    }
    S.plan = best;
    return best;
  }

  function pickTarget(ns, p, enemies, hpPct, fear) {
    let pl = plan(ns, p, hpPct);
    if (pl) {
      const c = pl.c;
      const wp = waypoint(ns, p, pl.path);
      if (wp.offPath > 3 * (ns.World.TS || 32)) pl.at = 0;
      return { x: wp.x, y: wp.y, fx: c.x, fy: c.y, w: 6, mode: c.mode, chase: c.chase, hold: c.hold, until: c.until, escort: c.escort, direct: c.direct };
    }

    const mag = p.magnet || cfg.steer.magnetBase || 78;
    const gt = (ns.Game.st && ns.Game.st.time) || 0;
    const pSpd = (p.baseSpd || 100) * (p.spdMul || 1);
    const W = ns.World;
    const traps = ((W && W.specialsNear && W.specialsNear(p.x, p.y, 600)) || []).filter(t => t.type === 'trap');
    const onTrap = k => traps.some(t => (k.x - t.x) ** 2 + (k.y - t.y + 8) ** 2 < 23 * 23);

    S.orbBan = (S.orbBan || []).filter(b => b.until > gt);
    const banned = k => S.orbBan.some(b => Math.abs(k.x - b.x) < 70 && Math.abs(k.y - b.y) < 70);
    const all = ns.Pickups.all();

    let loose = 0;
    for (const k of all) if (!k.pulled && (k.kind === 'xp' || k.kind === 'xpBig')) loose += k.kind === 'xpBig' ? 3 : 1;
    const wOf = k => {
      if (k.kind === 'heal') return hpPct < 0.7 ? cfg.pickupPri.healUrgent : cfg.pickupPri.healNormal;
      if (k.kind === 'magnet') return cfg.pickupPri.magnet + loose * 0.4;
      return cfg.pickupPri[k.kind] ?? 1;
    };

    let pv = 0, px = 0, py = 0;
    for (const k of all) if (k.pulled && (k.kind === 'xp' || k.kind === 'xpBig')) { const w = k.kind === 'xpBig' ? 3 : 1; pv += w; px += k.x * w; py += k.y * w; }
    if (pv >= 6 && !(ns.Judgment && ns.Judgment.active)) {
      px /= pv; py /= pv;
      if (Math.hypot(px - p.x, py - p.y) > 60) return { x: px, y: py, w: 2.5, mode: '收經驗', orb: true };
    }

    const items = all.filter(k => !k.pulled && !(k.kind === 'heal' && hpPct >= 0.95) && !onTrap(k) && !banned(k));
    const clR = Math.max(90, mag * 0.8);
    const g = S.orbGoal;
    if (g && gt < g.until) {
      const d = Math.hypot(g.x - p.x, g.y - p.y);
      if (d < g.bestD - 40 || S.mode !== '撿光球') { g.bestD = Math.min(g.bestD, d); g.at = gt; }
      else if (gt - g.at > 3) { S.orbBan.push({ x: g.x, y: g.y, until: gt + 20 }); S.orbGoal = null; return pickTarget(ns, p, enemies, hpPct, fear); }
      let left = 0;
      for (const k of items) if (Math.abs(k.x - g.x) < clR && Math.abs(k.y - g.y) < clR) left += wOf(k);
      if (left > 0 && d > mag * 0.85 && !(S.farm && d > 440)) return { x: g.x, y: g.y, w: 2, mode: '撿光球', orb: true };
    }

    let best = null, bestS = 0;
    const [ox, oy] = S.out || [0, 0];
    const seeds = items.length > 120 ? items.map(k => [Math.hypot(k.x - p.x, k.y - p.y), k]).sort((a, b) => a[0] - b[0]).slice(0, 120).map(x => x[1]) : items;
    for (const k of seeds) {
      const dx = k.x - p.x, dy = k.y - p.y, d = Math.hypot(dx, dy);
      if (d < mag * 0.9) continue;
      if (S.farm && d > 400) continue;
      let cluster = 0;
      for (const o of items) if (Math.abs(o.x - k.x) < clR && Math.abs(o.y - k.y) < clR) cluster += wOf(o);
      let crowd = 0;
      for (const e of enemies) if (!e.dead && Math.abs(e.x - k.x) < 70 && Math.abs(e.y - k.y) < 70) crowd += e.boss ? 5 : 1;
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

    if (hpPct > 0.5) {
      let hunt = null, hd = Infinity;
      for (const e of ns.EnemyMgr.all()) {
        if (e.dead || e.silent) continue;
        const d = Math.hypot(e.x - p.x, e.y - p.y);
        if (d < hd) { hd = d; hunt = e; }
      }
      if (hunt && hd > 600) return { x: hunt.x, y: hunt.y, w: 0.8, mode: '找怪' };
    }
    return null;
  }

  function steer(ns) {
    const p = ns.Game.player;
    if (!p || p.dead) return [0, 0];
    const now = performance.now();
    const dt = Math.min(0.1, (now - S.lastT) / 1000); S.lastT = now;
    const gt = (ns.Game.st && ns.Game.st.time) || 0;
    const hpPct = p.hp / p.maxHp;

    const low = cfg.steer.fearLow || 0.35, mid = cfg.steer.fearMid || 0.6;
    let fear = hpPct < low ? 2.5 : hpPct < mid ? 1.0 : 0.25;
    if (cfg.steer.fearK) fear *= cfg.steer.fearK;

    const aoe = p.activeGroup && p.activeGroup().some(m => FARM_KINDS.includes(m.kind));
    const farmOff = cfg.steer.farmHpOff || 0.45, farmOn = cfg.steer.farmHpOn || 0.65;
    const population = ns.EnemyMgr.count ?? ns.EnemyMgr.all().length;
    const farmNeed = cfg.steer.farmMinEnemies || 54;
    S.farm = cfg.farm && aoe && population >= farmNeed && !(ns.Rift && ns.Rift.inArena) && !(ns.Judgment && ns.Judgment.active) && (S.farm ? hpPct > farmOff : hpPct > farmOn);
    if (S.farm) fear = Math.min(fear, hpPct > 0.8 ? 0.15 : 0.2);

    const near = [];
    for (const e of ns.EnemyMgr.all()) {
      if (e.dead || e.silent || e.behavior === 'thief') continue;
      if (Math.abs(e.x - p.x) < 360 && Math.abs(e.y - p.y) < 360) near.push(e);
    }
    const shots = ns.Projectiles.all().filter(s => !s.friendly && Math.abs(s.x - p.x) < 300 && Math.abs(s.y - p.y) < 300);
    for (let i = hazards.length - 1; i >= 0; i--) { const h = hazards[i]; if (h.hit && h.t >= h.delay + h.end) hazards.splice(i, 1); }

    const J = ns.Judgment;
    const unitPx = (ns.Tiles && ns.Sprites) ? ns.Tiles.T * ns.Sprites.PX : 32;
    const judging = !!(J && J.active);
    if (!judging) S.jCenter = null;
    else {
      const wa = ns.World && ns.World.arena;
      if (wa && wa.type === 'judgment') S.jCenter = { x: wa.tx * unitPx + unitPx / 2, y: wa.ty * unitPx + unitPx / 2 };
      else if (!S.jCenter) S.jCenter = { x: p.x, y: p.y - 3 * unitPx };
    }
    const arceus = judging ? ns.EnemyMgr.all().find(e => e.arceus) : null;

    let target = pickTarget(ns, p, near, hpPct, fear);
    if (target && target.escort) fear = Math.max(fear, 1);
    if (judging && target && !(target.orb && Math.hypot(target.x - p.x, target.y - p.y) < 140 && (!arceus || Math.hypot(arceus.x - p.x, arceus.y - p.y) > 320))) target = null;
    const arena = (ns.Rift && ns.Rift.inArena) || judging;
    const W = ns.World;

    const pSpd = (p.baseSpd || 100) * (p.spdMul || 1);
    const bigFear = Math.max(1, fear);
    const red = 1 - Math.min(0.8, p.reduction ?? p.dmgReduce ?? 0);
    const hitFrac = (dmg, pure) => Math.min(1, (dmg || 0) * (pure ? 1 : red) / p.maxHp);
    const hazFrac = h => Math.min(1, (h.pct ? Math.max(h.dmg || 0, p.maxHp * h.pct) : (h.dmg || 0)) * (h.pure ? 1 : red) / p.maxHp);
    const DMG_W = hpPct < 0.6 ? 160 : 90, TOUCH_W = S.farm ? (hpPct > 0.8 ? 16 : 24) : hpPct < 0.35 ? 160 : hpPct < 0.6 ? 100 : 30;
    const shotW = sh => S.farm ? Math.min(1, 0.2 + 8 * hitFrac(sh.dmg, false)) : 1;

    const danger = (x, y, tAhead) => {
      let c = 0, big = 0, worst = 0, haz = 0;
      for (const e of near) {
        const spd = e.arceus ? pSpd * 1.2 : e.spd || 40, fast = Math.min(2, spd / pSpd);
        const d = Math.hypot(x - e.x, y - e.y) - (e.r || 10) - p.r - spd * tAhead * 0.8;
        const reach = (e.arceus ? 140 : e.boss ? 100 : 35) + 45 * fast;
        const w = e.arceus ? 8 : (e.boss ? 4 : 1) * Math.min(3, Math.max(0.5, (e.dmg || 10) / (p.maxHp * 0.12)));
        const v = w * Math.exp(-Math.max(d, -20) / reach);
        if (e.boss || e.arceus) big += v; else c += v;
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

    const wet = wetOk(ns, p), slowWet = wet && wetSlow(ns, p) < 1 && W && W.isLiquid;
    const free = (x, y) => !W || !W.isFree || W.isFree(x, y, p.r, wet);
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

    const here = danger(p.x, p.y, 0);
    let kite = null;
    S.stand = false;
    const hadTarget = S.hadTarget; S.hadTarget = !!target && here <= 2;
    const ar = judging ? (S.jCenter && { x: S.jCenter.x, y: S.jCenter.y, r: 24, judge: true }) : arena && ns.Rift.arena;

    if (ar) {
      const boss = ar.judge ? arceus : (ar.bossId && ns.EnemyMgr.get && ns.EnemyMgr.get(ar.bossId)) || near.find(e => e.boss);
      const edge = Math.max(80, (ar.r - 1.4) * unitPx - p.r - 6);
      const ring = edge * (ar.judge ? 0.55 : 0.82);
      let px0 = p.x - ar.x, py0 = p.y - ar.y; const pr = Math.hypot(px0, py0) || 1;
      const pa = Math.atan2(py0, px0);
      let kx = 0, ky = 0, w = 1.8;
      if (boss && !boss.dead) {
        const ba = Math.atan2(boss.y - ar.y, boss.x - ar.x);
        let delta = pa - ba; while (delta > Math.PI) delta -= 2 * Math.PI; while (delta < -Math.PI) delta += 2 * Math.PI;
        if (Math.abs(delta) < Math.PI * 0.85) S.spin = delta >= 0 ? 1 : -1;
        const aim = pa + S.spin * 0.55;
        kx = ar.x + Math.cos(aim) * ring - p.x; ky = ar.y + Math.sin(aim) * ring - p.y;
        const bd = Math.hypot(p.x - boss.x, p.y - boss.y);
        if (bd < (ar.judge ? 240 : 180)) {
          const ux = (p.x - boss.x) / (bd || 1), uy = (p.y - boss.y) / (bd || 1);
          const kl0 = Math.hypot(kx, ky) || 1;
          kx = kx / kl0 + ux * 1.5; ky = ky / kl0 + uy * 1.5;
          w = 3.5;
        }
      } else if (!ar.judge) {
        kx = ar.x - p.x; ky = ar.y - p.y;
        if (pr < 40) kx = ky = 0;
      }
      const kl = Math.hypot(kx, ky);
      if (kl > 0.01) kite = { x: kx / kl, y: ky / kl, w };
    } else if ((!target || here > 2) && !(target && target.hold) && !(target && target.chase && here < 4)) {
      if (hadTarget) S.loopC = null;
      let R = 380, c = S.loopC;
      const v = S.out || [1, 0];
      const anchor = () => ({ x: p.x - R * S.spin * v[1], y: p.y + R * S.spin * v[0] });
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
          const st = S.sparseSt, held = gt - (S.sparseAt || 0) < 0.6;
          let want = st || 'stand';
          if (!held) {
            if (dmin < 200 || (st === 'back' && dmin < 300)) want = 'back';
            else if (dmin > 430 || (st === 'near' && dmin > 340)) want = 'near';
            else want = 'stand';
          }
          if (dmin < 120) want = 'back';
          if (want === 'back' && pathLen(ax, ay, 120) < 60) want = null;
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
          R = Math.max(140, Math.min(240, herd.r + (hpPct > 0.8 ? 80 : 120)));
          c = S.loopC = S.loopC && S.herdLoop ? { x: S.loopC.x + (herd.x - S.loopC.x) * Math.min(1, dt * 2), y: S.loopC.y + (herd.y - S.loopC.y) * Math.min(1, dt * 2) } : { x: herd.x, y: herd.y };
          S.herdLoop = true;
        } else {
          if (S.herdLoop) { S.herdLoop = false; c = S.loopC = null; }
          if (S.farm) R = 220;
          if (!c || Math.abs(Math.hypot(p.x - c.x, p.y - c.y) - R) > R * 0.6) c = S.loopC = anchor();
        }
        let rx = p.x - c.x, ry = p.y - c.y; const rd = Math.hypot(rx, ry) || 1; rx /= rd; ry /= rd;
        const ang = Math.atan2(ry, rx) + S.spin * 0.5;
        let kx = c.x + Math.cos(ang) * R - p.x, ky = c.y + Math.sin(ang) * R - p.y;
        const kl = Math.hypot(kx, ky) || 1; kx /= kl; ky /= kl;
        kite = { x: kx, y: ky, w: 1.6 + Math.min(1.5, here * 0.4) };
        S.spinBlockT = pathLen(kx, ky, 90) < 60 ? S.spinBlockT + dt : 0;
        if (S.spinBlockT > 0.6) { S.spin *= -1; S.spinBlockT = 0; S.loopC = null; }
      }
    }

    const hazardHits = (dx, dy) => {
      if (!hazards.length) return 0;
      const reach = pathLen(dx, dy, 240);
      let hit = 0, frac = 0;
      for (const h of hazards) {
        if (h.hit) continue;
        const tr = Math.max(0, (h.delay || 0) - (h.t || 0));
        const t2 = Math.min(tr * pSpd * 0.9, reach);
        if (inHazard(h, p.x + dx * t2, p.y + dy * t2, p.r + 4)) { hit += 1; frac += hazFrac(h); }
      }
      return hit * 30 * bigFear + frac * DMG_W * 1.5;
    };

    const cost = DIRS.map(([dx, dy]) => {
      let bestStep = Infinity;
      for (const step of [55, 120, 200]) {
        const reach = pathLen(dx, dy, step);
        if (reach < 12) continue;
        const x = p.x + dx * reach, y = p.y + dy * reach;
        let c = danger(x, y, reach / pSpd);
        c += (reach < step ? 6 + 6 * (1 - reach / step) : 0) + cramped(x, y) * 1.2 + (slowWet && W.isLiquid(x, y) ? 1.2 : 0);
        if (target) {
          const before = Math.hypot(target.x - p.x, target.y - p.y), after = Math.hypot(target.x - x, target.y - y);
          c -= target.w * (before - after) / step;
        }
        bestStep = Math.min(bestStep, c);
      }
      if (bestStep === Infinity) return Infinity;
      bestStep += hazardHits(dx, dy);
      if (kite) bestStep -= kite.w * (dx * kite.x + dy * kite.y);
      else if (!target && !arena) bestStep -= 0.3 * (dx * Math.cos(S.wanderA) + dy * Math.sin(S.wanderA));
      return bestStep;
    });

    const sm = cost.map((c, i) => c === Infinity ? Infinity : 0.5 * c + 0.25 * (Math.min(cost[(i + 15) % 16], c + 3) + Math.min(cost[(i + 1) % 16], c + 3)));
    let bi = -1, bs = Infinity;
    sm.forEach((c, i) => { if (c < bs) { bs = c; bi = i; } });
    if (!target) S.wanderA += dt * 0.35;
    S.mode = judging ? (here > 2 ? '審判：閃避' : '審判：繞場') : arena ? (here > 2 ? '秘境：閃避' : '秘境：打 BOSS') : here > 2 ? '躲避' : target && (target.chase || target.hold) ? target.mode : kite ? (S.kiteLabel || '遛怪') : target ? target.mode : '閒逛';

    const escape = () => {
      let bd = null, bs2 = -Infinity;
      for (const [dx, dy] of DIRS) {
        let r = pathLen(dx, dy, 120);
        if (r < 12) for (let t2 = 6; t2 <= 40; t2 += 6) { if (W && W.isFree && !W.isFree(p.x + dx * t2, p.y + dy * t2, p.r * 0.5, wet)) break; r = t2 * 0.5; }
        const sc = r - cramped(p.x + dx * r, p.y + dy * r) * 15 - danger(p.x + dx * r, p.y + dy * r, 0.5) * 20;
        if (sc > bs2) { bs2 = sc; bd = [dx, dy]; }
      }
      return bd || DIRS[(Math.random() * 16) | 0];
    };
    if (bi < 0) { S.unstickT = Math.max(S.unstickT, 0.4); S.unstickDir = escape(); bi = 0; }

    let urgent = 0;
    for (const sh of shots) urgent += 6 * shotW(sh) * Math.exp(-Math.max(Math.hypot(p.x - sh.x, p.y - sh.y) - (sh.r || 6) - p.r, -10) / 30);
    for (const h of hazards) if (!h.hit && inHazard(h, p.x, p.y, p.r + 4)) urgent += 25;
    const emergency = urgent > 4;
    S.holdT -= dt;
    const keep = S.dirIdx >= 0 && sm[S.dirIdx] < Infinity && (emergency ? sm[S.dirIdx] - sm[bi] < 3 && S.holdT > 0 : S.holdT > 0 || sm[S.dirIdx] - sm[bi] < (S.farm ? 1.2 : 0.6));
    if (keep) bi = S.dirIdx;
    else if (bi !== S.dirIdx) { S.dirIdx = bi; S.holdT = emergency ? 0.25 : S.farm ? 0.3 : 0.15; }
    let best = DIRS[bi];

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

    if (target && target.fx !== undefined && here < 2) {
      const dx = target.x - p.x, dy = target.y - p.y, d = Math.hypot(dx, dy) || 1;
      const safe = !hazards.some(h => !h.hit && inHazard(h, p.x + dx / d * 30, p.y + dy / d * 30, p.r));
      if (safe && d > 4) best = [dx / d, dy / d];
    }

    if (S.stand && !emergency && here < 1.5 && !S.losBadT && !(target && target.orb) && !hazards.some(h => !h.hit && inHazard(h, p.x, p.y, p.r + 10))) {
      S.mode = '站樁輸出'; S.wd = null; S.stuckT = 0; S.lastPos = [p.x, p.y];
      return [0, 0];
    }

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
          let bd = null, bs3 = Infinity;
          for (const [dx, dy] of DIRS) {
            const reach = pathLen(dx, dy, 160);
            if (reach < 40) continue;
            let c = (160 - reach) / 20 + hazardHits(dx, dy);
            for (const e of near) {
              const ex = e.x - p.x, ey = e.y - p.y, d = Math.hypot(ex, ey) || 1, cos = (ex * dx + ey * dy) / d;
              if (cos > 0) c += (e.boss ? 4 : 1) * (0.5 + 10 * hitFrac(e.dmg, false)) * cos * cos * 100 / Math.max(30, d);
            }
            if (target) c -= 0.5 * (dx * (target.x - p.x) + dy * (target.y - p.y)) / (Math.hypot(target.x - p.x, target.y - p.y) || 1);
            if (c < bs3) { bs3 = c; bd = [dx, dy]; }
          }
          if (bd) { S.breakDir = bd; S.breakT = 2.5; best = bd; S.mode = '突圍'; S.dirIdx = -1; }
        }
      }
    }

    if (S.lastPos) {
      const moved = Math.hypot(p.x - S.lastPos[0], p.y - S.lastPos[1]);
      S.stuckT = moved < 0.3 ? S.stuckT + dt : 0;
    }
    S.lastPos = [p.x, p.y];
    if (!S.wd || S.holding) S.wd = { x: p.x, y: p.y, t: gt };
    else if (gt - S.wd.t > 3) {
      if (Math.hypot(p.x - S.wd.x, p.y - S.wd.y) < 10) {
        log('watchdog: stuck, escaping');
        if (S.plan) { S.ban[S.plan.key] = gt + 15; S.plan = null; }
        S.loopC = null; S.unstickT = 0.8; S.unstickDir = escape();
      }
      S.wd = { x: p.x, y: p.y, t: gt };
    }
    if (S.stuckT > 0.4) { S.stuckT = 0; S.unstickT = 0.5; S.unstickDir = escape(); }
    if (S.unstickT > 0) { S.unstickT -= dt; best = S.unstickDir; }

    const reversing = S.out[0] * best[0] + S.out[1] * best[1] < -0.2;
    const a = emergency || reversing || S.unstickT > 0 ? 1 : Math.min(1, dt * 12);
    let ox = S.out[0] * (1 - a) + best[0] * a, oy = S.out[1] * (1 - a) + best[1] * a;
    const ol = Math.hypot(ox, oy) || 1;
    S.out = [ox / ol, oy / ol];
    if (!isFinite(S.out[0]) || !isFinite(S.out[1])) { S.out = escape(); S.loopC = null; S.plan = null; }
    return S.out;
  }

  // ---------- 8a'. 自動買強化 ----------
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
      for (const [id, v] of Object.entries(cfg.upgradePri || {})) {
        const def = U.BY[id], lvl = upg[id] || 0;
        if (!def || lvl >= Math.min(def.max, cfg.upgradeCap[id] ?? def.max)) continue;
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
    }
  }

  // ---------- 8a''. 自動抽獎 ----------
  let lastGacha = 0;
  function gachaBanner(ns, sv) {
    const G = ns.Gacha;
    let best = null, bs = -Infinity;
    for (const b of G.BANNERS) {
      if (!G.isOpen(b.gen)) continue;
      const pity = (sv.pity || {})[b.gen] || 0;
      const missing = (G.featured(b.gen) || []).filter(d => !sv.owned[d]).map(d => ns.DEX_BY[d].bst || 0);
      const top = missing.length ? Math.max(...missing) : 0;
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
  }

  // ---------- 8a'''. 自動換最強夥伴 ----------
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
      if (!m || !(AFK_KINDS.includes(m.kind) || (m.kind === 'projectile' && m.homing))) continue;
      let v = (mon.atk || 1) * (m.cat ? ns.Stats.fit(mon, m.cat) : 1);
      if (mon.types.length === 1 && m.type === mon.types[0]) v *= 1.2;
      for (const a of abil) if (WEATHER_OF[a] === m.type) v *= WEATHER_MUL[m.type];
      off = Math.max(off, v);
    }
    if (!off) off = (mon.atk || 1) * 0.6;
    const tough = Math.sqrt((mon.hp || 80) / 100 * (((mon.df || 60) + (mon.sd || 60)) / 180));
    const u = (sv.pupg || {})[dex] || {};
    const inv = 0.04 * (u.atk || 0) + 0.03 * (u.cd || 0) + 0.02 * (u.def || 0) + 0.01 * (u.hp || 0) + 0.015 * (u.crit || 0) + 0.01 * (u.regen || 0);
    const fav = (cfg.favorites || []).includes(+dex) ? 1.08 : 1;
    return off * Math.sqrt(tough) * (0.8 + 0.2 * (mon.spd || 100) / 110) * (1 + inv) * fav;
  }
  let lastPartner = 0;
  function autoPartner(ns) {
    if (!cfg.autoPartner || ns.Game.state !== 'ui' || !ns.DB || !ns.DB.save) return;
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
    ns.Flow && ns.Flow.goMenu && ns.Flow.goMenu();
  }

  // ---------- 8b. 自動再開一局 ----------
  function autoRestart(ns) {
    if (!cfg.on || !cfg.restart || !['ui', 'over'].includes(ns.Game.state)) return;
    const open = id => { const e = document.getElementById(id); return e && !e.classList.contains('hidden'); };
    if (open('scr-test')) { const opt = document.querySelector('#scr-test button'); if (opt) { opt.click(); return; } }
    if (open('scr-result')) { const btn = document.querySelector('#scr-result button'); if (btn) { btn.click(); return; } }
    if (open('scr-login')) return;
    for (const [scr, btn] of [['scr-savenote', 'savenote-ok'], ['scr-news', 'news-close'], ['scr-nick', 'nick-later'], ['scr-recover', 'rec-later']]) {
      if (open(scr)) { document.getElementById(btn)?.click(); return; }
    }
    if (open('scr-over') || ns.Game.state === 'over') {
      const btn = document.getElementById('btn-again');
      if (btn && now() - S.overAt > 4000 && now() - (S.againAt || 0) > 2000) { S.againAt = now(); btn.click(); return; }
      if (ns.Game.state === 'over') return;
    }
    if (open('scr-lobby')) {
      const btn = document.getElementById('lobby-start');
      const room = ns.Room && ns.Room.room;
      if (S.coopFull && room && room.isHost) {
        const cap = ns.Room.MAX_PLAYERS || 4;
        const n = room.members ? room.members.length : 0;
        if (n < cap) return;
      }
      if (btn && !btn.classList.contains('hidden') && !btn.disabled && now() - (S.lobbyAt || 0) > 5000) {
        S.lobbyAt = now(); btn.click();
      }
      return;
    }
    const inRoom = !!(ns.Room && ns.Room.room);
    if (!inRoom && open('scr-menu') && now() - S.lastPlay > 6000 && now() - S.overAt > 5000) {
      S.lastPlay = now();
      document.querySelector('#scr-menu [data-go=play]')?.click();
    }
  }
  const now = () => performance.now();

  addEventListener('keydown', e => {
    if ((e.key === 'Escape' || e.code === 'KeyP') && capturedNs && capturedNs.Game && capturedNs.Game.state === 'playing') S.userPausedAt = now();
  }, true);
  function autoResume(ns) {
    const st = ns.Game.state;
    if (st === 'playing') { if (now() - S.userPausedAt > 1000) S.userPausedAt = -1e9; S.pausedAt = 0; return; }
    if (st !== 'paused' || S.userPausedAt > 0 || document.visibilityState !== 'visible') { S.pausedAt = 0; return; }
    if (!S.pausedAt) S.pausedAt = now();
    else if (now() - S.pausedAt > 1500) { S.pausedAt = 0; ns.Game.togglePause(); }
  }

  // ---------- 9. 控制面板（簡潔高效） ----------
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
<div class="hd"><b>PSBot 自動掛機 <span style="opacity:.6;font-weight:400">v${VERSION}</span></b><button data-k="toggle">OFF</button><button data-k="home" title="回到左上角">⌂</button><button data-k="min">–</button></div>
<div class="bd">
  <div class="st" data-k="status"></div>
  <details data-k="optsBox" open><summary>功能設定</summary><div class="opts">
    <label><input type="checkbox" data-o="move">自動走位與閃避</label>
    <label><input type="checkbox" data-o="cards">自動選卡（包含新被動/進化優先）</label>
    <label><input type="checkbox" data-o="bonds">自動羈絆（照配置順序）</label>
    <label><input type="checkbox" data-o="items">自動選攜帶道具（24種新道具權重）</label>
    <label><input type="checkbox" data-o="rift">主動進神祕裂縫</label>
    <label title="只要傳送門存在且在消失前走得到就強制進入"><input type="checkbox" data-portal="alwaysEnter">傳送門出現就強制進入</label>
    <label><input type="checkbox" data-o="orbs">自動使用寶珠</label>
    <label><input type="checkbox" data-o="farm">養怪模式（聚怪範圍輸出）</label>
    <label><input type="checkbox" data-o="focus">集火瞄準（優先收殘血）</label>
    <label><input type="checkbox" data-o="restart">結束後自動再開一局</label>
    <label><input type="checkbox" data-o="noRank">掛機局不上排行榜</label>
    <label><input type="checkbox" data-o="upgrade">主選單自動買強化（含新項目）</label>
    <label><input type="checkbox" data-o="gacha">主選單自動抽獎</label>
    <label><input type="checkbox" data-o="autoPartner">自動換最強寶可夢出戰</label>
  </div></details>
  <details data-k="histBox"><summary>戰績歷史（最近局數）</summary><div class="st" data-k="hist"></div></details>
  <details data-k="buildBox" open><summary data-k="ptitle">畢業配置</summary>
    <div class="chips" data-k="build"></div>
    <div class="row"><select data-k="pool"></select><button data-k="add">加入</button></div>
    <div class="row"><select data-k="item"></select><button data-k="clear">清空</button></div>
  </details>
  <div class="st">F8 開關 · 視窗請保持前景運行</div>
</div>`;
    document.body.appendChild(el);
    const $ = k => el.querySelector(`[data-k="${k}"]`);

    const setOn = v => { cfg.on = v; save(); $('toggle').textContent = v ? 'ON' : 'OFF'; $('toggle').classList.toggle('on', v); };
    setOn(cfg.on);
    $('toggle').onclick = () => setOn(!cfg.on);

    addEventListener('keydown', e => {
      if (e.key !== 'F8') return;
      e.preventDefault();
      e.shiftKey ? resetPos() : setOn(!cfg.on);
    }, true);

    $('min').onclick = () => { cfg.collapsed = !cfg.collapsed; el.classList.toggle('min', cfg.collapsed); save(); };
    el.querySelectorAll('[data-o]').forEach(i => {
      i.checked = !!cfg[i.dataset.o];
      i.onchange = () => { cfg[i.dataset.o] = i.checked; save(); };
    });

    const forcePortal = el.querySelector('[data-portal="alwaysEnter"]');
    if (forcePortal) {
      forcePortal.checked = !!cfg.portal.alwaysEnter;
      forcePortal.onchange = () => { cfg.portal.alwaysEnter = forcePortal.checked; save(); };
    }

    function renderHist() {
      const h = cfg.history || [];
      if (!h.length) { $('hist').textContent = '尚無紀錄'; return; }
      $('hist').textContent = h.slice(0, 5).map(x =>
        `${new Date(x.at).toLocaleTimeString()}  ${Math.round(x.time)}s Lv${x.level}  擊倒${x.kills}  金幣${x.coins}`
      ).join('\n');
    }
    renderHist();

    // 拖曳面板定位
    let dragging = false, ox = 0, oy = 0;
    el.querySelector('.hd').onmousedown = e => {
      if (e.target.tagName === 'BUTTON') return;
      dragging = true; ox = e.clientX - el.offsetLeft; oy = e.clientY - el.offsetTop;
    };
    window.addEventListener('mousemove', e => {
      if (!dragging) return;
      const x = Math.max(0, Math.min(window.innerWidth - el.offsetWidth, e.clientX - ox));
      const y = Math.max(0, Math.min(window.innerHeight - el.offsetHeight, e.clientY - oy));
      el.style.left = x + 'px'; el.style.top = y + 'px';
      cfg.panelX = x; cfg.panelY = y;
    });
    window.addEventListener('mouseup', () => { if (dragging) { dragging = false; save(); } });
    const resetPos = () => { cfg.panelX = 12; cfg.panelY = 64; el.style.left = '12px'; el.style.top = '64px'; save(); };
    $('home').onclick = resetPos;

    // 畢業配置 UI
    function renderBuild() {
      const p = ns.Game.player;
      const dex = p ? p.dex : menuDex(ns);
      const mon = dex && ns.DEX_BY && ns.DEX_BY[dex];
      $('ptitle').textContent = mon ? `畢業配置（${ns.T ? ns.T(mon.name) : mon.name}）` : '畢業配置';
      const prof = dex ? cfg.profiles[dex] || (cfg.profiles[dex] = { moves: [], item: '' }) : null;
      $('build').replaceChildren();
      if (!prof) return;

      prof.moves.forEach((id, i) => {
        const c = document.createElement('span'); c.className = 'chip';
        const m = ns.Moves.BY_ID[id];
        c.textContent = `${i + 1}. ${m && ns.T ? ns.T(m.name) : id} ✕`;
        c.onclick = () => { prof.moves.splice(i, 1); save(); renderBuild(); };
        $('build').appendChild(c);
      });

      const poolSel = $('pool');
      poolSel.replaceChildren();
      if (mon && ns.Moves && ns.Moves.poolFor) {
        const moves = ns.Moves.poolFor(mon);
        for (const mid of moves) {
          const m = ns.Moves.BY_ID[mid];
          if (!m || prof.moves.includes(mid)) continue;
          const opt = document.createElement('option'); opt.value = mid;
          opt.textContent = ns.T ? ns.T(m.name) : mid;
          poolSel.appendChild(opt);
        }
      }

      const itemSel = $('item');
      itemSel.replaceChildren();
      const defOpt = document.createElement('option'); defOpt.value = ''; defOpt.textContent = '– 選擇攜帶道具 –';
      itemSel.appendChild(defOpt);
      Object.keys(cfg.itemPri).forEach(it => {
        const opt = document.createElement('option'); opt.value = it; opt.textContent = it;
        if (prof.item === it) opt.selected = true;
        itemSel.appendChild(opt);
      });
      itemSel.onchange = () => { prof.item = itemSel.value; save(); };
    }

    $('add').onclick = () => {
      const p = ns.Game.player;
      const dex = p ? p.dex : menuDex(ns);
      if (!dex) return;
      const prof = cfg.profiles[dex] || (cfg.profiles[dex] = { moves: [], item: '' });
      const mid = $('pool').value;
      if (mid && prof.moves.length < 4 && !prof.moves.includes(mid)) {
        prof.moves.push(mid); save(); renderBuild();
      }
    };
    $('clear').onclick = () => {
      const p = ns.Game.player;
      const dex = p ? p.dex : menuDex(ns);
      if (!dex) return;
      cfg.profiles[dex] = { moves: [], item: '' }; save(); renderBuild();
    };

    // 狀態更新循環
    setInterval(() => {
      if (cfg.collapsed) return;
      const p = ns.Game.player;
      if (p && ns.Game.state === 'playing') {
        const m = S.mode || '走位中';
        $('status').textContent = `狀態：${m}\n生命：${Math.round(p.hp)}/${Math.round(p.maxHp)} (${Math.round(p.hp / p.maxHp * 100)}%)\n時間：${Math.round((ns.Game.st && ns.Game.st.time) || 0)}s · 擊倒：${ns.Game.st && ns.Game.st.kills || 0}`;
      } else {
        $('status').textContent = `狀態：主選單/結算中\n場次：${stats.runs} · 最佳：${Math.round(stats.best)}s`;
      }
      renderBuild();
      renderHist();
    }, 1000);
  }

  function menuDex(ns) {
    if (ns.DB && ns.DB.save && ns.DB.save.partner) return ns.DB.save.partner;
    const n = document.getElementById('menu-partner-name');
    const txt = n && n.textContent.trim();
    if (!txt || !ns.DEX) return null;
    const m = ns.DEX.find(d => d.name === txt || (ns.T && ns.T(d.name) === txt));
    return m ? m.dex : null;
  }
})();
