(function () {
  'use strict';

  /* ===== 設定 ===== */
  var BAR_HIDE_MS = 5000;               // 操作ボタンはタップから5秒で消える
  var CAPTION_MS = 5000;                // 曲名を出しておく時間
  var CACHE_MS = 24 * 60 * 60 * 1000;   // 検索結果は1日使い回す（API の使用量を節約）
  var PER_ARTIST = 25;                  // 1人あたりの検索件数

  var $ = function (s) { return document.querySelector(s); };
  var store = {
    get: function (k, d) { try { var v = localStorage.getItem('pv.' + k); return v === null ? d : JSON.parse(v); } catch (e) { return d; } },
    set: function (k, v) { try { localStorage.setItem('pv.' + k, JSON.stringify(v)); } catch (e) {} },
    del: function (k) { try { localStorage.removeItem('pv.' + k); } catch (e) {} }
  };

  var cfg = store.get('cfg', { artists: [], suffix: 'MV', key: '', urls: '' });

  /* ===== URL の #… で設定を受け取る（QRコードやリンクで渡す用） =====
     #key=APIキー  #artists=A|B  #urls=動画やプレイリストのURL|URL（キーなしで人に渡せる） */
  (function importHash() {
    if (!location.hash || location.hash.length < 3) return;
    var p = {};
    location.hash.slice(1).split('&').forEach(function (kv) {
      var i = kv.indexOf('=');
      if (i > 0) {
        try { p[kv.slice(0, i)] = decodeURIComponent(kv.slice(i + 1).replace(/\+/g, ' ')); } catch (e) {}
      }
    });
    if (p.key) cfg.key = p.key.trim();
    if (p.artists) cfg.artists = p.artists.split('|').map(function (s) { return s.trim(); }).filter(Boolean);
    if (p.urls) cfg.urls = p.urls.split('|').map(function (s) { return s.trim(); }).filter(Boolean).join('\n');
    // #v=動画ID,動画ID,…（「共有リンクを作る」で作るリンク。キーなしで再生できる）
    if (p.v) cfg.urls = p.v.split(',').filter(function (s) { return /^[\w-]{11}$/.test(s); }).join('\n');
    if (p.key || p.artists || p.urls || p.v) {
      store.set('cfg', cfg);
      history.replaceState(null, '', location.pathname + location.search); // キーをURLに残さない
    }
  })();

  var msgEl = $('#msg'), capEl = $('#caption'), capArtist = $('#capArtist'), capTitle = $('#capTitle');
  function say(t) { msgEl.textContent = t || ''; }

  /* ===== 動画の一覧（キュー）を作る ===== */
  var queue = [], pos = -1, playlistId = null, bad = store.get('bad', {}), lastLists = [], buildErr = null;
  var SHARE_MAX = 40; // 共有リンクに入れる動画の上限（QRコードが細かくなりすぎないように）

  function decode(s) { var t = document.createElement('textarea'); t.innerHTML = s; return t.value; }
  function norm(s) { return (s || '').toLowerCase().replace(/[\s・\-_.]/g, ''); }
  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)), t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }

  function parseUrls(text) {
    var vids = [], lists = [];
    (text || '').split(/\s+/).forEach(function (u) {
      if (!u) return;
      var m;
      if ((m = u.match(/[?&]list=([\w-]+)/))) lists.push(m[1]);
      else if ((m = u.match(/(?:v=|youtu\.be\/|shorts\/|embed\/)([\w-]{11})/))) vids.push(m[1]);
      else if (/^[\w-]{11}$/.test(u)) vids.push(u);
    });
    return { vids: vids, lists: lists };
  }

  // アーティスト名で YouTube を検索（YouTube Data API v3。キーが必要）
  function searchArtist(name, force) {
    var ck = 'cache.' + name + '|' + cfg.suffix, c = store.get(ck, null);
    if (!force && c && Date.now() - c.at < CACHE_MS) return Promise.resolve(c.items);
    var q = (name + ' ' + cfg.suffix).trim();
    var url = 'https://www.googleapis.com/youtube/v3/search?part=snippet&type=video' +
      '&videoEmbeddable=true&videoSyndicated=true&videoCategoryId=10' +
      '&maxResults=' + PER_ARTIST + '&q=' + encodeURIComponent(q) + '&key=' + encodeURIComponent(cfg.key);
    return fetch(url).then(function (r) {
      return r.json().then(function (j) {
        if (!r.ok) {
          var reason = j && j.error && j.error.errors && j.error.errors[0] && j.error.errors[0].reason;
          throw new Error(reason || ('HTTP ' + r.status));
        }
        var all = (j.items || []).map(function (it) {
          return { id: it.id.videoId, title: decode(it.snippet.title), ch: decode(it.snippet.channelTitle), artist: name };
        });
        // 名前が題名かチャンネル名に入っているものを優先（カバー動画などを減らす）
        var n = norm(name), hit = all.filter(function (v) { return norm(v.title).indexOf(n) >= 0 || norm(v.ch).indexOf(n) >= 0; });
        var items = hit.length >= 3 ? hit : all;
        store.set(ck, { at: Date.now(), items: items });
        return items;
      });
    }).catch(function (e) {
      if (c) return c.items; // 失敗したら古い結果でも使う
      throw e;
    });
  }

  function errText(e) {
    var r = e && e.message;
    if (r === 'quotaExceeded' || r === 'dailyLimitExceeded') return 'YouTube API の1日の使用量を超えました。明日また試してください';
    if (r === 'keyInvalid' || r === 'badRequest') return 'API キーが正しくないようです。設定を確かめてください';
    if (r === 'forbidden' || r === 'ipRefererBlocked' || r === 'accessNotConfigured') return 'API キーの設定（使えるサイトの制限、YouTube Data API の有効化）を確かめてください';
    return '検索できませんでした（' + r + '）';
  }

  function build(force) {
    var u = parseUrls(cfg.urls);
    var useSearch = cfg.key && cfg.artists.length;
    say(useSearch ? '検索しています…' : '');
    var jobs = useSearch ? cfg.artists.map(function (a) {
      return searchArtist(a, force).catch(function (e) { lastErr = e; return []; });
    }) : [];
    var lastErr = null;
    return Promise.all(jobs).then(function (lists) {
      buildErr = lastErr; // 共有リンクの画面でも理由を出せるように残す
      var items = [], seen = {};
      lists = lists.concat([u.vids.map(function (id) { return { id: id, title: '', artist: '' }; })]);
      lastLists = lists; // 共有リンクを作るときに、アーティストごとの結果を使う
      lists.forEach(function (l) {
        l.forEach(function (v) { if (!seen[v.id] && !bad[v.id]) { seen[v.id] = 1; items.push(v); } });
      });
      queue = shuffle(items); pos = -1;
      playlistId = items.length ? null : (u.lists[0] || null);
      if (!queue.length && !playlistId) {
        if (lastErr) say(errText(lastErr));
        else if (cfg.artists.length && !cfg.key) say('アーティスト検索には YouTube API キーが必要です。画面をタップして ⚙ から設定してください');
        else say('画面をタップして ⚙ から、アーティストを登録してください');
        return false;
      }
      say('');
      return true;
    });
  }

  /* ===== YouTube プレーヤー（公式の埋め込み。常にミュート） ===== */
  var player = null, apiReady = false, ready = false, errRun = 0, captionFor = null;

  window.onYouTubeIframeAPIReady = function () { apiReady = true; createPlayer(); };

  function createPlayer() {
    if (player || !apiReady) return;
    // cc_load_policy: 0 … YouTube の字幕を最初から出さない
    var vars = { autoplay: 1, mute: 1, controls: 0, disablekb: 1, fs: 0, iv_load_policy: 3, rel: 0, playsinline: 1, modestbranding: 1, cc_load_policy: 0 };
    if (location.origin && location.origin !== 'null') vars.origin = location.origin;
    player = new YT.Player('player', {
      playerVars: vars,
      events: {
        onReady: function () { ready = true; player.mute(); start(); },
        onStateChange: onState,
        onError: onError
      }
    });
  }

  function start() {
    if (!ready) return;
    if (playlistId) {
      player.loadPlaylist({ list: playlistId, listType: 'playlist', index: 0 });
      player.setLoop(true);
      setTimeout(function () { try { player.setShuffle(true); } catch (e) {} }, 1500);
    } else if (queue.length) {
      next();
    }
  }

  function next() {
    if (!ready) return;
    if (playlistId) { player.nextVideo(); return; }
    if (!queue.length) return;
    pos++;
    if (pos >= queue.length) { shuffle(queue); pos = 0; } // 一巡したら並べ直してもう一周
    player.loadVideoById(queue[pos].id);
    player.mute();
  }

  function onState(e) {
    if (e.data === YT.PlayerState.PLAYING) {
      errRun = 0;
      hideCaptions();
      if (!player.isMuted()) player.mute();
      var d = player.getVideoData ? player.getVideoData() : {};
      if (d && d.video_id && d.video_id !== captionFor) {
        captionFor = d.video_id;
        var item = !playlistId && queue[pos] && queue[pos].id === d.video_id ? queue[pos] : null;
        showCaption(item && item.artist ? item.artist : (d.author || ''), item && item.title ? item.title : (d.title || ''));
      }
    } else if (e.data === YT.PlayerState.ENDED && !playlistId) {
      next();
    }
  }

  // YouTube の字幕（自動字幕を含む）を消す。ミュート再生だと字幕が自動で出ることがあるため、
  // 再生が始まるたびに字幕の部品を外す（少し遅れて出る場合に備えて2回）
  function hideCaptions() {
    function off() {
      try { player.setOption('captions', 'track', {}); } catch (e) {}
      try { player.unloadModule('captions'); } catch (e) {}
      try { player.unloadModule('cc'); } catch (e) {}
    }
    off();
    setTimeout(off, 1500);
  }

  // 埋め込み禁止・削除済みなどで再生できない動画は、記録して飛ばす
  function onError(e) {
    var id = !playlistId && queue[pos] ? queue[pos].id : null;
    if (id && (e.data === 100 || e.data === 101 || e.data === 150)) { bad[id] = 1; store.set('bad', bad); }
    errRun++;
    if (errRun > Math.max(5, queue.length)) { say('再生できる動画が見つかりません。検索の言葉やアーティストを変えてみてください'); return; }
    setTimeout(next, 600);
  }

  var capTimer = null;
  function showCaption(artist, title) {
    if (!title) return;
    capArtist.textContent = artist;
    capTitle.textContent = title;
    capEl.classList.add('show');
    clearTimeout(capTimer);
    capTimer = setTimeout(function () { capEl.classList.remove('show'); }, CAPTION_MS);
  }

  /* ===== 操作ボタン ===== */
  var bar = $('#bar'), barTimer = null;
  function showBar() {
    bar.classList.remove('hide');
    clearTimeout(barTimer);
    barTimer = setTimeout(function () { bar.classList.add('hide'); }, BAR_HIDE_MS);
  }
  $('#tap').addEventListener('click', function () {
    showBar();
    if (queue.length && pos >= 0) showCaption(queue[pos].artist, queue[pos].title);
  });
  document.addEventListener('contextmenu', function (e) { e.preventDefault(); });

  $('#btnNext').addEventListener('click', function () { showBar(); next(); });

  // 全画面
  var root = document.documentElement, btnFs = $('#btnFs');
  var reqFs = root.requestFullscreen || root.webkitRequestFullscreen;
  function isFs() { return !!(document.fullscreenElement || document.webkitFullscreenElement); }

  // iPhone は全画面と画面の向きの固定ができないので、代わりに
  // 「縦持ちのまま動画を90°回して画面いっぱいに出す」に切り替える
  var isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  var standalone = window.navigator.standalone === true ||
    (window.matchMedia && matchMedia('(display-mode: standalone), (display-mode: fullscreen)').matches);
  var useRotate = !reqFs || isIOS;
  var rot = store.get('rot', false);
  function rotUi() { document.body.classList.toggle('rot', rot); btnFs.classList.toggle('on', rot); layoutVideo(); }

  /* ===== v7：表示の大きさ ===== */
  // fill＝画面いっぱい（既定。端が少し切れる）／zoom＝さらに拡大（動画に黒帯が入っている映画サイズのMV向け）／fit＝全体を表示（黒帯あり）
  var ZOOMS = ['fill', 'zoom', 'fit'];
  var ZOOM_NAME = { fill: '画面いっぱい', zoom: '拡大（動画の中の黒帯も消す）', fit: '全体を表示' };
  var ZOOM_EXTRA = 1.33;               // 「拡大」の倍率（2.35:1 の映画サイズが縦いっぱいになる）
  var zoomMode = store.get('zoom', 'fill');
  function layoutVideo() {
    var mode = zoomMode || 'fill';
    var w = window.innerWidth, h = window.innerHeight;
    // v10：iPhone のホーム画面アプリは、innerHeight が画面の下端（ホームバーの部分）を含まないことがあり、
    // 回転表示の片側に黒い帯が出た。ホーム画面アプリは画面全体に描けるので、画面そのものの大きさを使う
    if (isIOS && standalone && screen.width && screen.height) {
      var sw = screen.width, sh = screen.height;
      if ((w > h) !== (sw > sh)) { var s = sw; sw = sh; sh = s; }
      w = Math.max(w, sw); h = Math.max(h, sh);
    }
    root.style.setProperty('--sw', w + 'px');   // v8：回転表示の枠に、実際に測った画面の大きさを使う
    root.style.setProperty('--sh', h + 'px');
    // v11（試し）：iPhone のホーム画面アプリで、ページ自体の高さが画面より短く、下端に描けない帯が残る。
    // ページ（html・body）の高さを画面の高さまで伸ばして、下端まで描けるようにする
    if (isIOS && standalone) {
      root.style.height = h + 'px';
      document.body.style.height = h + 'px';
    }
    if (document.body.classList.contains('rot') && h > w) { var t = w; w = h; h = t; } // 90°回しているときは縦横を入れ替える
    else if (h > w) mode = 'fit'; // v9：縦持ちで回転なしのときは、いっぱいにすると大きく切れるので全体を表示
    var k = mode === 'fit' ? Math.min(w / 16, h / 9) : Math.max(w / 16, h / 9);
    if (mode === 'zoom') k *= ZOOM_EXTRA;
    root.style.setProperty('--pw', Math.ceil(16 * k) + 'px');
    root.style.setProperty('--ph', Math.ceil(9 * k) + 'px');
  }
  window.addEventListener('resize', layoutVideo);
  window.addEventListener('orientationchange', function () { setTimeout(layoutVideo, 300); });
  if (useRotate) rotUi();

  var toastEl = $('#toast'), toastTimer = null;
  function toast(t, ms) {
    toastEl.textContent = t; toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('show'); }, ms || 6000);
  }
  // Safari で開いているときは、ホーム画面に追加すると上下のバーが消えることを3回まで案内
  if (isIOS && !standalone) {
    var tips = store.get('iosTip', 0);
    if (tips < 3) { store.set('iosTip', tips + 1); setTimeout(function () { toast('Safari の共有ボタン（□↑）→「ホーム画面に追加」から開くと、上下のバーが消えて大きく映ります', 8000); }, 2500); }
  }

  layoutVideo();
  var btnZoom = $('#btnZoom');
  btnZoom.addEventListener('click', function () {
    showBar();
    zoomMode = ZOOMS[(ZOOMS.indexOf(zoomMode) + 1) % ZOOMS.length];
    store.set('zoom', zoomMode);
    layoutVideo();
    // v11：iPhone では原因を確かめるため、画面の高さとブラウザが使える高さも小さく出す
    toast(ZOOM_NAME[zoomMode] + (isIOS ? '（画面 ' + screen.height + ' / 表示 ' + window.innerHeight + '）' : ''), 3500);
  });

  btnFs.addEventListener('click', function () {
    showBar();
    if (useRotate) {
      rot = !rot; store.set('rot', rot); rotUi();
      toast(rot ? '縦に持ったままでも、横向きの大きさで映します（スマホを横にすると普通の表示）' :
        '回転をやめました。スマホを横にすると大きく映ります', 4000);
      return;
    }
    if (isFs()) { (document.exitFullscreen || document.webkitExitFullscreen).call(document); return; }
    var p = reqFs.call(root, { navigationUI: 'hide' });
    if (p && p.then) p.then(function () {
      if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(function () {});
    }).catch(function () {});
  });
  function fsUi() { if (!useRotate) btnFs.classList.toggle('on', isFs()); }
  document.addEventListener('fullscreenchange', fsUi);
  document.addEventListener('webkitfullscreenchange', fsUi);

  // Wake Lock（画面消灯防止）。置きっぱなし用なので最初からON
  var btnWake = $('#btnWake'), wake = { want: store.get('wake', true), lock: null };
  function wakeUi() { btnWake.classList.toggle('on', !!wake.lock); }
  function wakeOn() {
    if (!('wakeLock' in navigator) || wake.lock || document.hidden) return;
    navigator.wakeLock.request('screen').then(function (l) {
      wake.lock = l;
      l.addEventListener('release', function () { wake.lock = null; wakeUi(); });
      wakeUi();
    }).catch(function () { wakeUi(); });
  }
  if (!('wakeLock' in navigator)) btnWake.disabled = true;
  btnWake.addEventListener('click', function () {
    showBar();
    wake.want = !wake.want; store.set('wake', wake.want);
    if (wake.want) wakeOn();
    else if (wake.lock) { wake.lock.release(); wake.lock = null; wakeUi(); }
  });
  if (wake.want) wakeOn();

  /* ===== 設定画面 ===== */
  var setEl = $('#settings'), fArtists = $('#fArtists'), fSuffix = $('#fSuffix'), fKey = $('#fKey'), fUrls = $('#fUrls');
  function openSettings() {
    fArtists.value = cfg.artists.join('\n');
    fSuffix.value = cfg.suffix;
    fKey.value = cfg.key;
    fUrls.value = cfg.urls;
    $('#setNote').textContent = '検索結果は1日保存して使い回します（API の使用量の節約）。' +
      '再生できなかった動画は次から飛ばします。今の一覧：' + (playlistId ? 'プレイリスト' : queue.length + '本');
    setEl.classList.add('show');
  }
  function closeSettings() { setEl.classList.remove('show'); }
  function readForm() {
    cfg.artists = fArtists.value.split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
    cfg.suffix = fSuffix.value;
    cfg.key = fKey.value.trim();
    cfg.urls = fUrls.value.trim();
    store.set('cfg', cfg);
  }
  function rebuild(force) {
    closeSettings();
    captionFor = null; errRun = 0;
    build(force).then(function (ok) { if (ok) start(); else if (ready) player.stopVideo(); });
  }
  $('#btnSet').addEventListener('click', function () { showBar(); openSettings(); });
  $('#btnCancel').addEventListener('click', closeSettings);
  $('#setForm').addEventListener('submit', function (e) { e.preventDefault(); readForm(); rebuild(false); });
  $('#btnRefresh').addEventListener('click', function () { readForm(); bad = {}; store.set('bad', bad); rebuild(true); });

  /* ===== 共有リンク：検索で見つけた動画のIDだけを入れる（キーは入れない） ===== */
  var shareEl = $('#share'), shareQr = $('#shareQr'), shareUrl = $('#shareUrl'), shareInfo = $('#shareInfo');

  function pickShareIds() {
    // アーティストごとに1本ずつ順番に取り、偏らないようにする
    var lists = lastLists.map(function (l) { return l.filter(function (v) { return !bad[v.id]; }); });
    var ids = [], seen = {}, i = 0, more = true;
    while (ids.length < SHARE_MAX && more) {
      more = false;
      lists.forEach(function (l) {
        if (i < l.length) {
          more = true;
          var id = l[i].id;
          if (!seen[id] && ids.length < SHARE_MAX) { seen[id] = 1; ids.push(id); }
        }
      });
      i++;
    }
    return ids;
  }

  function loadQrLib() {
    if (window.qrcode) return Promise.resolve();
    return new Promise(function (ok, ng) {
      var s = document.createElement('script');
      s.src = 'https://cdnjs.cloudflare.com/ajax/libs/qrcode-generator/1.4.4/qrcode.min.js';
      s.onload = ok; s.onerror = ng;
      document.head.appendChild(s);
    });
  }

  function makeShare() {
    var ids = pickShareIds();
    if (!ids.length) {
      var why;
      if (cfg.artists.length && !cfg.key) why = 'この端末（このアプリ）には YouTube API キーが入っていないので、検索できません。上の「YouTube API キー」の欄にキーを貼り付けてから、もう一度押してください';
      else if (buildErr) why = errText(buildErr);
      else if (!cfg.artists.length) why = '先にアーティストを登録してください';
      else why = '検索しても再生できる動画が見つかりませんでした。アーティスト名の書き方を変えてみてください';
      $('#setNote').textContent = '共有リンクを作れませんでした：' + why;
      return;
    }
    var base = location.href.split('#')[0].split('?')[0].replace(/index\.html$/, '');
    var link = base + '#v=' + ids.join(',');
    var names = cfg.artists.length ? cfg.artists.join('、') : 'URLで入れた動画';
    shareInfo.textContent = names + ' の動画 ' + ids.length + '本。受け取った人は API キーなしで、音なしで流せます。';
    shareUrl.value = link;
    shareQr.innerHTML = '';
    shareEl.classList.add('show');
    loadQrLib().then(function () {
      var qr = qrcode(0, 'L');
      qr.addData(link);
      qr.make();
      shareQr.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    }).catch(function () { /* QRが作れなくてもリンクは使える */ });
  }

  $('#btnShare').addEventListener('click', function () {
    readForm();
    $('#setNote').textContent = '検索しています…';
    build(false).then(function () { $('#setNote').textContent = ''; makeShare(); });
  });
  $('#btnShareSend').addEventListener('click', function () {
    if (navigator.share) navigator.share({ title: '音なしPV', url: shareUrl.value }).catch(function () {});
    else { shareUrl.select(); document.execCommand('copy'); }
  });
  $('#btnShareCopy').addEventListener('click', function () {
    var b = this;
    function done() { b.textContent = 'コピーしました'; setTimeout(function () { b.textContent = 'コピー'; }, 1500); }
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(shareUrl.value).then(done, function () { shareUrl.select(); document.execCommand('copy'); done(); });
    else { shareUrl.select(); document.execCommand('copy'); done(); }
  });
  $('#btnShareClose').addEventListener('click', function () { shareEl.classList.remove('show'); });

  /* ===== 画面に戻ったとき ===== */
  document.addEventListener('visibilitychange', function () {
    if (document.hidden) return;
    if (wake.want) wakeOn();
    if (ready && player.getPlayerState() !== YT.PlayerState.PLAYING && (queue.length || playlistId)) player.playVideo();
  });

  /* ===== 起動 ===== */
  build(false).then(function (ok) {
    if (!ok && !cfg.artists.length && !cfg.urls) { openSettings(); showBar(); }
    createPlayer();
    if (ok) start();
  });
  if ('serviceWorker' in navigator && window.isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch(function () {});
  }
})();
