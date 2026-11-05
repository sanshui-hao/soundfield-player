/* 声场 · SOUNDFIELD — local player */
(() => {
  'use strict';

  // 远程访问（公网）时，登录过期后的接口请求会返回 401；统一回到登录页。
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const response = await nativeFetch(input, init);
    if (response.status === 401) {
      const raw = typeof input === 'string' ? input : (input && input.url) || '';
      let sameOrigin = raw.startsWith('/');
      if (!sameOrigin && raw) {
        try { sameOrigin = new URL(raw, window.location.href).origin === window.location.origin; } catch (_) { /* ignore */ }
      }
      if (sameOrigin) window.location.replace('/login');
    }
    return response;
  };

  const $ = (selector, root = document) => root.querySelector(selector);
  const $$ = (selector, root = document) => Array.from(root.querySelectorAll(selector));
  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));

  const els = {
    body: document.body,
    appShell: $('#appShell'),
    audio: $('#audio'),
    sidebar: $('#sidebar'),
    sidebarScrim: $('#sidebarScrim'),
    sidebarClose: $('#sidebarClose'),
    menuBtn: $('#menuBtn'),
    navCount: $('#navCount'),
    favCount: $('#favCount'),
    rootName: $('#rootName'),
    rootPath: $('#rootPath'),
    statCount: $('#statCount'),
    statDuration: $('#statDuration'),
    scanBtn: $('#scanBtn'),
    openFolderBtn: $('#openFolderBtn'),
    refreshTop: $('#refreshTop'),
    searchInput: $('#searchInput'),
    viewEyebrow: $('#viewEyebrow'),
    viewTitle: $('#viewTitle'),
    playlistCount: $('#playlistCount'),
    playlistList: $('#playlistList'),
    playlistEmpty: $('#playlistEmpty'),
    scrollArea: $('#scrollArea'),
    nowPlaying: $('#nowPlaying'),
    cover: $('#cover'),
    coverImg: $('#coverImg'),
    coverTitle: $('#coverTitle'),
    coverArtist: $('#coverArtist'),
    coverGlyph: $('#coverGlyph'),
    artFormat: $('#artFormat'),
    artSize: $('#artSize'),
    statusPill: $('#statusPill'),
    statusText: $('#statusText'),
    favBtn: $('#favBtn'),
    trackArtist: $('#trackArtist'),
    trackTitle: $('#trackTitle'),
    trackAlbum: $('#trackAlbum'),
    metaChips: $('#metaChips'),
    waveWrap: $('#waveWrap'),
    waveform: $('#waveform'),
    waveTooltip: $('#waveTooltip'),
    currentTime: $('#currentTime'),
    durationTime: $('#durationTime'),
    shuffleBtn: $('#shuffleBtn'),
    prevBtn: $('#prevBtn'),
    playBtn: $('#playBtn'),
    nextBtn: $('#nextBtn'),
    repeatBtn: $('#repeatBtn'),
    repeatOne: $('#repeatOne'),
    muteBtn: $('#muteBtn'),
    volumeSlider: $('#volumeSlider'),
    volumeValue: $('#volumeValue'),
    speedBtn: $('#speedBtn'),
    visualizer: $('#visualizer'),
    queueCount: $('#queueCount'),
    downloadLyricsBtn: $('#downloadLyricsBtn'),
    downloadLyricsLabel: $('#downloadLyricsLabel'),
    playAllBtn: $('#playAllBtn'),
    trackList: $('#trackList'),
    tableHead: $('.table-head'),
    emptyState: $('#emptyState'),
    emptyTitle: $('#emptyTitle'),
    emptyCopy: $('#emptyCopy'),
    emptyScanBtn: $('#emptyScanBtn'),
    syncState: $('#syncState'),
    toast: $('#toast'),
    toastText: $('#toastText'),
    helpDialog: $('#helpDialog'),
    helpTop: $('#helpTop'),
    helpClose: $('#helpClose'),
    shortcutsBtn: $('#shortcutsBtn'),
    appFooter: $('.app-footer'),
    immersive: $('#immersive'),
    immBg: $('#immBg'),
    immBack: $('#immBack'),
    immFav: $('#immFav'),
    immStatus: $('#immStatus'),
    immCover: $('#immCover'),
    immCoverImg: $('#immCoverImg'),
    immGlyph: $('#immGlyph'),
    immTitle: $('#immTitle'),
    immArtist: $('#immArtist'),
    immAlbum: $('#immAlbum'),
    immLyricsSource: $('#immLyricsSource'),
    immLyricsScroll: $('#immLyricsScroll'),
    immLyricsList: $('#immLyricsList'),
    immLyricsLoading: $('#immLyricsLoading'),
    immLyricsEmpty: $('#immLyricsEmpty'),
    immLyricsHint: $('#immLyricsHint'),
    immRetryLyrics: $('#immRetryLyrics'),
    immOpenFolder: $('#immOpenFolder'),
    immCurrent: $('#immCurrent'),
    immDuration: $('#immDuration'),
    immSeek: $('#immSeek'),
    immPrev: $('#immPrev'),
    immPlay: $('#immPlay'),
    immNext: $('#immNext'),
  };

  const PALETTES = [
    { a: '#242422', b: '#4a4a45', c: '#d9d6ce' },
    { a: '#1f2826', b: '#40534e', c: '#c8d2cd' },
    { a: '#2b2322', b: '#59453f', c: '#d9c5bd' },
    { a: '#262a22', b: '#4b5440', c: '#ccd2c1' },
    { a: '#242429', b: '#484b58', c: '#c9cdd8' },
    { a: '#2c2620', b: '#574b3b', c: '#d8cbb8' },
  ];

  const SPEEDS = [0.75, 1, 1.25, 1.5];
  const FAV_KEY = 'soundfield:favorites';
  const SETTINGS_KEY = 'soundfield:settings';
  const LAST_TRACK_KEY = 'soundfield:last-track';
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  const state = {
    tracks: [],
    playlists: [],
    version: '',
    root: '',
    currentId: null,
    view: 'all',
    playlistPath: null,
    search: '',
    shuffle: false,
    repeat: 'off',
    speed: 1,
    volume: 0.8,
    muted: false,
    favorites: new Set(),
    peaks: new Map(),
    wavePeaks: null,
    waveToken: 0,
    artToken: 0,
    immArtToken: 0,
    waveAbort: null,
    hoverFraction: null,
    draggingWave: false,
    syncing: false,
    savingLyrics: false,
    initialized: false,
    toastTimer: null,
    lastPosUpdate: 0,
    lastWaveDraw: 0,
    lyrics: {
      trackId: null,
      token: 0,
      lines: [],
      timed: false,
      estimated: false,
      activeIndex: -1,
      source: 'none',
      loading: false,
    },
  };

  let previousFocus = null;
  let decodeContext = null;
  let audioContext = null;
  let analyser = null;
  let sourceNode = null;
  let frequencyData = null;

  /* ------------------------------------------------------------------ */
  /* utilities                                                          */
  /* ------------------------------------------------------------------ */

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[char]));
  }

  function hashString(value) {
    let hash = 2166136261;
    for (let i = 0; i < value.length; i += 1) {
      hash ^= value.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
  }

  function paletteFor(id) {
    return PALETTES[hashString(id || 'soundfield') % PALETTES.length];
  }

  function hexToRgba(hex, alpha) {
    const value = hex.replace('#', '');
    const full = value.length === 3 ? value.split('').map((c) => c + c).join('') : value;
    const number = parseInt(full, 16);
    const r = (number >> 16) & 255;
    const g = (number >> 8) & 255;
    const b = number & 255;
    return `rgba(${r}, ${g}, ${b}, ${alpha})`;
  }

  function formatTime(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
    const total = Math.floor(seconds + 0.0001);
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    const pad = (n) => String(n).padStart(2, '0');
    return hours > 0 ? `${hours}:${pad(minutes)}:${pad(secs)}` : `${pad(minutes)}:${pad(secs)}`;
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return '00:00';
    return formatTime(Math.round(seconds));
  }

  function formatSize(bytes) {
    if (!bytes) return '—';
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function formatBitrate(kbps) {
    if (!kbps) return '';
    return kbps >= 1000 ? `${(kbps / 1000).toFixed(1)} Mbps` : `${kbps} kbps`;
  }

  function speedLabel(speed) {
    return ({ 0.75: '0.75', 1: '1.0', 1.25: '1.25', 1.5: '1.5' })[speed] || String(speed);
  }

  function firstCharacter(value) {
    return Array.from(String(value || '音'))[0] || '音';
  }

  function currentTrack() {
    return state.tracks.find((track) => track.id === state.currentId) || null;
  }

  function getDuration() {
    const audio = els.audio;
    if (Number.isFinite(audio.duration) && audio.duration > 0) return audio.duration;
    const track = currentTrack();
    return track && track.duration > 0 ? track.duration : 0;
  }

  function showToast(message, duration = 2600) {
    els.toastText.textContent = message;
    els.toast.classList.add('is-visible');
    window.clearTimeout(state.toastTimer);
    state.toastTimer = window.setTimeout(() => {
      els.toast.classList.remove('is-visible');
    }, duration);
  }

  function loadStoredState() {
    try {
      const favorites = JSON.parse(localStorage.getItem(FAV_KEY) || '[]');
      if (Array.isArray(favorites)) state.favorites = new Set(favorites);
    } catch (error) {
      state.favorites = new Set();
    }

    try {
      const settings = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      if (Number.isFinite(settings.volume)) state.volume = clamp(settings.volume, 0, 1);
      if (Number.isFinite(settings.speed) && SPEEDS.includes(settings.speed)) state.speed = settings.speed;
      if (typeof settings.shuffle === 'boolean') state.shuffle = settings.shuffle;
      if (['off', 'all', 'one'].includes(settings.repeat)) state.repeat = settings.repeat;
      if (typeof settings.muted === 'boolean') state.muted = settings.muted;
    } catch (error) {
      /* use defaults */
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify({
        volume: state.volume,
        speed: state.speed,
        shuffle: state.shuffle,
        repeat: state.repeat,
        muted: state.muted,
      }));
    } catch (error) {
      /* storage can be unavailable */
    }
  }

  function saveFavorites() {
    try {
      localStorage.setItem(FAV_KEY, JSON.stringify(Array.from(state.favorites)));
    } catch (error) {
      /* storage can be unavailable */
    }
  }

  /* ------------------------------------------------------------------ */
  /* library                                                            */
  /* ------------------------------------------------------------------ */

  function updateCounts() {
    els.navCount.textContent = String(state.tracks.length);
    els.favCount.textContent = String(state.tracks.filter((track) => state.favorites.has(track.id)).length);
  }

  function updateStats() {
    const total = state.tracks.reduce((sum, track) => sum + (track.duration || 0), 0);
    els.statCount.textContent = String(state.tracks.length);
    els.statDuration.textContent = formatDuration(total);
    updateCounts();
  }

  function playlistOfTrack(track) {
    if (track.playlist) return track.playlist;
    const path = String(track.path || '');
    const slash = path.indexOf('/');
    return slash > 0 ? path.slice(0, slash) : null;
  }

  function derivePlaylists(tracks) {
    const groups = new Map();
    tracks.forEach((track) => {
      const folder = playlistOfTrack(track);
      if (!folder) return;
      if (!groups.has(folder)) groups.set(folder, []);
      groups.get(folder).push(track);
    });
    const result = [];
    groups.forEach((items, name) => {
      const cover = items.find((item) => item.hasCover && item.coverUrl);
      result.push({
        path: name,
        name,
        trackCount: items.length,
        duration: items.reduce((sum, item) => sum + (item.duration || 0), 0),
        coverUrl: cover ? cover.coverUrl : null,
      });
    });
    result.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
    return result;
  }

  function normalizePlaylists(provided, tracks) {
    if (!Array.isArray(provided) || provided.length === 0) return derivePlaylists(tracks);
    return provided
      .map((item) => {
        const path = item.path || item.name;
        const folderTracks = tracks.filter((track) => playlistOfTrack(track) === path);
        const cover = folderTracks.find((track) => track.hasCover && track.coverUrl);
        return {
          path,
          name: item.name || path,
          trackCount: item.trackCount ?? folderTracks.length,
          duration: item.duration ?? folderTracks.reduce((sum, track) => sum + (track.duration || 0), 0),
          coverUrl: item.coverUrl || (cover ? cover.coverUrl : null),
        };
      })
      .filter((item) => item.path)
      .sort((a, b) => a.name.localeCompare(b.name, 'zh-CN', { numeric: true }));
  }

  function applyLibrary(data) {
    const rawTracks = Array.isArray(data.tracks) ? data.tracks : [];
    state.tracks = rawTracks.map((track) => {
      const folder = playlistOfTrack(track);
      return {
        ...track,
        playlist: folder,
        playlistId: track.playlistId || (folder ? `folder:${folder}` : null),
      };
    });
    state.playlists = normalizePlaylists(data.playlists, state.tracks);
    state.version = data.version || '';
    state.root = data.root || '';
    els.rootName.textContent = data.rootName || '音乐播放器';
    els.rootPath.textContent = data.root || '';
    els.rootPath.title = data.root || '';
    els.statCount.textContent = String(data.stats?.count ?? state.tracks.length);
    els.statDuration.textContent = formatDuration(data.stats?.duration || 0);
    els.syncState.textContent = `已同步 · ${new Date(data.scannedAt || Date.now()).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
    updateCounts();
    if (state.tracks.length) {
      const favs = state.tracks.filter((track) => state.favorites.has(track.id)).length;
      els.favCount.textContent = String(favs);
    }
  }

  function getFilteredTracks() {
    let list = state.tracks.slice();
    if (state.view === 'favorites') {
      list = list.filter((track) => state.favorites.has(track.id));
    } else if (state.view === 'playlist') {
      list = list.filter((track) => playlistOfTrack(track) === state.playlistPath);
    }
    const query = state.search.trim().toLocaleLowerCase();
    if (query) {
      list = list.filter((track) => {
        const haystack = [track.title, track.artist, track.album, track.source, track.format]
          .filter(Boolean).join(' ').toLocaleLowerCase();
        return haystack.includes(query);
      });
    }
    return list;
  }

  function renderPlaylists() {
    const list = state.playlists;
    els.playlistCount.textContent = String(list.length);
    els.playlistEmpty.hidden = list.length > 0;
    els.playlistList.innerHTML = list.map((playlist) => {
      const palette = paletteFor(playlist.path);
      const active = state.view === 'playlist' && state.playlistPath === playlist.path;
      const cover = playlist.coverUrl
        ? `<img src="${escapeHtml(playlist.coverUrl)}" alt="" loading="lazy">`
        : '';
      return `
        <button class="playlist-item${active ? ' is-active' : ''}" data-playlist="${escapeHtml(playlist.path)}"
                aria-current="${active ? 'true' : 'false'}" title="${escapeHtml(playlist.name)}">
          <span class="playlist-tile" style="--p1:${palette.c};--p2:${palette.a}">${cover}<b>${escapeHtml(firstCharacter(playlist.name))}</b></span>
          <span class="playlist-name">${escapeHtml(playlist.name)}</span>
          <span class="playlist-count">${playlist.trackCount}</span>
        </button>`;
    }).join('');
  }

  function updateNavState() {
    $$('.nav-item').forEach((button) => {
      button.classList.toggle('is-active', button.dataset.view === state.view);
    });
    $$('.playlist-item', els.playlistList).forEach((button) => {
      const active = state.view === 'playlist' && button.dataset.playlist === state.playlistPath;
      button.classList.toggle('is-active', active);
      button.setAttribute('aria-current', String(active));
    });
  }

  function updateViewHeading() {
    let eyebrow = 'LOCAL LIBRARY';
    let title = '全部歌曲';
    let placeholder = '搜索歌曲、歌手或专辑';
    if (state.view === 'favorites') {
      eyebrow = 'YOUR COLLECTION';
      title = '我的收藏';
      placeholder = '搜索收藏的歌曲';
    } else if (state.view === 'playlist') {
      const playlist = state.playlists.find((item) => item.path === state.playlistPath);
      eyebrow = 'PLAYLIST';
      title = playlist ? playlist.name : '歌单';
      placeholder = playlist ? `在「${playlist.name}」中搜索` : '在歌单中搜索';
    }
    els.viewEyebrow.textContent = eyebrow;
    els.viewTitle.textContent = title;
    els.viewTitle.title = title;
    els.searchInput.placeholder = placeholder;
  }

  function rowMarkup(track, index) {
    const palette = paletteFor(track.id);
    const isActive = track.id === state.currentId;
    const isFav = state.favorites.has(track.id);
    const albumLabel = track.album && track.album !== track.artist
      ? track.album
      : (track.playlist || '');
    const album = albumLabel ? escapeHtml(albumLabel) : '—';
    const source = track.source ? `<span class="album-source">${escapeHtml(track.source)}</span>` : '';
    const cover = track.hasCover && track.coverUrl
      ? `<img src="${escapeHtml(track.coverUrl)}" alt="" loading="lazy">`
      : `<span>${escapeHtml(firstCharacter(track.title))}</span>`;
    const duration = track.duration ? formatDuration(track.duration) : '--:--';
    return `
      <div class="track-row${isActive ? ' is-active' : ''}" data-id="${escapeHtml(track.id)}" role="button" tabindex="0"
           aria-label="播放 ${escapeHtml(track.title)}" aria-current="${isActive ? 'true' : 'false'}">
        <div class="track-index">
          <span class="row-num">${String(index + 1).padStart(2, '0')}</span>
          <svg class="row-play" viewBox="0 0 24 24"><use href="#i-play"/></svg>
          <span class="row-eq" aria-hidden="true"><i></i><i></i><i></i></span>
        </div>
        <div class="song-cell">
          <div class="mini-cover" style="--m1:${palette.c};--m2:${palette.a}">${cover}</div>
          <div class="song-text">
            <div class="song-title">${escapeHtml(track.title)}</div>
            <div class="song-artist">${escapeHtml(track.artist || '未知艺术家')}</div>
          </div>
        </div>
        <div class="album-cell">${album}${source}</div>
        <div class="format-cell"><span class="format-tag">${escapeHtml(track.format || 'AUDIO')}</span></div>
        <div class="time-cell">${duration}</div>
        <div class="fav-cell">
          <button class="row-fav${isFav ? ' is-fav' : ''}" data-fav="${escapeHtml(track.id)}"
                  aria-label="${isFav ? '取消收藏' : '收藏'} ${escapeHtml(track.title)}" aria-pressed="${isFav}">
            <svg viewBox="0 0 24 24"><use href="#i-heart"/></svg>
          </button>
        </div>
      </div>`;
  }

  function renderTrackList() {
    const list = getFilteredTracks();
    els.queueCount.textContent = `${list.length} 首`;
    els.tableHead.hidden = list.length === 0;
    els.trackList.innerHTML = list.map(rowMarkup).join('');
    els.emptyState.hidden = list.length !== 0;

    if (list.length === 0) {
      if (state.tracks.length === 0) {
        els.emptyTitle.textContent = '曲库里还没有音乐';
        els.emptyCopy.textContent = '把 MP3、M4A、FLAC 等音频文件放进这个文件夹，然后点击重新扫描。';
        els.emptyScanBtn.hidden = false;
      } else if (state.view === 'favorites' && !state.search) {
        els.emptyTitle.textContent = '还没有收藏歌曲';
        els.emptyCopy.textContent = '点击歌曲右侧的心形按钮，把喜欢的歌留在这里。';
        els.emptyScanBtn.hidden = true;
      } else if (state.view === 'playlist' && !state.search) {
        els.emptyTitle.textContent = '这个歌单里还没有歌曲';
        els.emptyCopy.textContent = '把音频文件放进这个歌单文件夹，或者点击重新扫描。';
        els.emptyScanBtn.hidden = false;
      } else {
        els.emptyTitle.textContent = '没有找到匹配的歌曲';
        els.emptyCopy.textContent = '换一个关键词，或切换到「全部歌曲」看看。';
        els.emptyScanBtn.hidden = true;
      }
    }
  }

  function updateFavoriteUI() {
    const track = currentTrack();
    const isFav = track ? state.favorites.has(track.id) : false;
    els.favBtn.classList.toggle('is-fav', isFav);
    els.favBtn.setAttribute('aria-pressed', String(isFav));
    els.favBtn.setAttribute('aria-label', isFav ? '取消收藏当前歌曲' : '收藏当前歌曲');
    els.immFav.classList.toggle('is-fav', isFav);
    els.immFav.setAttribute('aria-pressed', String(isFav));
    els.immFav.setAttribute('aria-label', isFav ? '取消收藏当前歌曲' : '收藏当前歌曲');
    updateCounts();
    $$('.row-fav', els.trackList).forEach((button) => {
      const id = button.dataset.fav;
      const active = state.favorites.has(id);
      button.classList.toggle('is-fav', active);
      button.setAttribute('aria-pressed', String(active));
      button.setAttribute('aria-label', `${active ? '取消收藏' : '收藏'} ${button.getAttribute('aria-label').replace(/^(取消收藏|收藏) /, '')}`);
    });
  }

  function toggleFavorite(id) {
    const track = state.tracks.find((item) => item.id === id);
    if (!track) return;
    if (state.favorites.has(id)) {
      state.favorites.delete(id);
      showToast(`已取消收藏 · ${track.title}`);
    } else {
      state.favorites.add(id);
      showToast(`已收藏 · ${track.title}`);
    }
    saveFavorites();
    updateFavoriteUI();
    if (state.view === 'favorites') renderTrackList();
  }

  async function syncLibrary({ manual = false, auto = false } = {}) {
    if (state.syncing) return;
    state.syncing = true;
    if (manual) {
      els.scanBtn.classList.add('is-spinning');
      els.refreshTop.classList.add('is-spinning');
    }
    const previousCount = state.tracks.length;
    const previousVersion = state.version;
    try {
      const url = `/api/tracks?refresh=1${manual ? '&force=1' : ''}&_=${Date.now()}`;
      const response = await fetch(url, { cache: 'no-store' });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      const changed = !state.initialized || data.version !== previousVersion;
      const wasInitialized = state.initialized;
      if (manual) state.peaks.clear();
      applyLibrary(data);

      let playlistRemoved = false;
      if (state.view === 'playlist' && state.playlistPath
          && !state.playlists.some((playlist) => playlist.path === state.playlistPath)) {
        state.view = 'all';
        state.playlistPath = null;
        playlistRemoved = true;
        updateNavState();
        updateViewHeading();
      }

      if (state.currentId) {
        const fresh = state.tracks.find((track) => track.id === state.currentId);
        if (fresh) {
          if (changed || manual) updateTrackUI(fresh);
        } else {
          els.audio.pause();
          els.audio.removeAttribute('src');
          els.audio.load();
          state.currentId = null;
          state.wavePeaks = null;
          if (state.tracks.length) {
            setTrack(state.tracks[0], false);
          } else {
            resetTrackUI();
          }
        }
      } else if (wasInitialized && state.tracks.length) {
        setTrack(state.tracks[0], false);
      }

      if (changed || manual) {
        renderPlaylists();
        renderTrackList();
        updateFavoriteUI();
      }

      if (playlistRemoved && wasInitialized) {
        showToast('歌单文件夹已被移除，已切换到全部歌曲');
      }

      if (manual) {
        const added = state.tracks.length - previousCount;
        if (added > 0) showToast(`扫描完成 · 新增 ${added} 首，共 ${state.tracks.length} 首`);
        else showToast(`扫描完成 · 当前共 ${state.tracks.length} 首曲目`);
      }

      if (!auto && !manual && state.initialized && changed) {
        showToast(`曲库已同步 · 共 ${state.tracks.length} 首`);
      }

      state.initialized = true;
    } catch (error) {
      console.error(error);
      els.syncState.textContent = '同步失败';
      if (!auto) showToast('无法连接本地播放器，请确认启动窗口仍在运行');
    } finally {
      state.syncing = false;
      if (manual) {
        els.scanBtn.classList.remove('is-spinning');
        els.refreshTop.classList.remove('is-spinning');
      }
    }
  }

  async function openFolder(path = '') {
    try {
      const response = await fetch('/api/open-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || '打开失败');
      showToast(path ? '已在资源管理器中打开歌曲文件夹' : '已在资源管理器中打开曲库文件夹');
    } catch (error) {
      showToast('无法打开文件夹，请手动打开播放器所在目录');
    }
  }

  /* ------------------------------------------------------------------ */
  /* artwork & track UI                                                 */
  /* ------------------------------------------------------------------ */

  function updateTrackUI(track) {
    if (!track) {
      resetTrackUI();
      return;
    }
    const palette = paletteFor(track.id);
    const coverRoot = document.documentElement;
    coverRoot.style.setProperty('--cover-a', palette.a);
    coverRoot.style.setProperty('--cover-b', palette.b);
    coverRoot.style.setProperty('--cover-c', palette.c);
    coverRoot.style.setProperty('--art-glow', hexToRgba(palette.c, 0.3));

    els.coverTitle.textContent = track.title || '未知曲目';
    els.coverTitle.classList.toggle('is-small', (track.title || '').length > 11);
    els.coverArtist.textContent = track.artist || 'LOCAL HI-FI';
    els.coverGlyph.textContent = firstCharacter(track.title);

    const token = ++state.artToken;
    els.coverImg.onload = () => {
      if (token !== state.artToken) return;
      els.coverImg.hidden = false;
      els.cover.classList.add('has-photo');
    };
    els.coverImg.onerror = () => {
      if (token !== state.artToken) return;
      els.coverImg.hidden = true;
      els.cover.classList.remove('has-photo');
    };
    if (track.hasCover && track.coverUrl) {
      if (els.coverImg.getAttribute('src') !== track.coverUrl) {
        els.coverImg.hidden = true;
        els.cover.classList.remove('has-photo');
        els.coverImg.src = track.coverUrl;
      } else if (els.coverImg.complete && els.coverImg.naturalWidth > 0) {
        els.coverImg.hidden = false;
        els.cover.classList.add('has-photo');
      }
    } else {
      els.coverImg.hidden = true;
      els.cover.classList.remove('has-photo');
      els.coverImg.removeAttribute('src');
    }

    els.trackTitle.textContent = track.title || '未知曲目';
    els.trackTitle.classList.toggle('is-long', (track.title || '').length > 13);
    els.trackArtist.textContent = track.artist || '未知艺术家';
    const source = track.source ? ` <span class="source">· ${escapeHtml(track.source)}</span>` : '';
    const albumLabel = track.album && track.album !== track.artist
      ? track.album
      : (track.playlist || '本地曲库');
    els.trackAlbum.innerHTML = `${escapeHtml(albumLabel)}${source}`;
    els.artFormat.textContent = `${track.format || 'AUDIO'} FILE`;
    els.artSize.textContent = formatSize(track.size);
    const bitrate = formatBitrate(track.bitrate);
    els.metaChips.innerHTML = [
      `<span class="chip is-accent">${escapeHtml(track.format || 'AUDIO')}</span>`,
      `<span class="chip">${formatDuration(track.duration)}</span>`,
      bitrate ? `<span class="chip">≈ ${bitrate}</span>` : '<span class="chip">VBR</span>',
      `<span class="chip">${formatSize(track.size)}</span>`,
    ].join('');
    els.durationTime.textContent = formatDuration(track.duration);
    updateFavoriteUI();
    updateMediaMetadata(track);
    if (isImmersiveOpen()) updateImmersiveTrack(track);
  }

  function resetTrackUI() {
    if (isImmersiveOpen()) closeImmersive();
    document.documentElement.style.setProperty('--cover-a', '#24170f');
    document.documentElement.style.setProperty('--cover-b', '#6e4524');
    document.documentElement.style.setProperty('--cover-c', '#e2bd82');
    document.documentElement.style.setProperty('--art-glow', 'rgba(193, 143, 78, 0.32)');
    els.coverTitle.textContent = '等待曲目';
    els.coverTitle.classList.remove('is-small');
    els.coverArtist.textContent = 'LOCAL HI-FI';
    els.coverGlyph.textContent = '声';
    els.coverImg.hidden = true;
    els.coverImg.removeAttribute('src');
    els.cover.classList.remove('has-photo');
    els.trackTitle.textContent = '曲库为空';
    els.trackArtist.textContent = '—';
    els.trackAlbum.textContent = '把音乐放进曲库文件夹，然后重新扫描。';
    els.metaChips.innerHTML = '';
    els.artFormat.textContent = 'LOCAL FILE';
    els.artSize.textContent = '—';
    els.currentTime.textContent = '00:00';
    els.durationTime.textContent = '00:00';
    els.waveWrap.setAttribute('aria-valuenow', '0');
    els.statusPill.classList.remove('is-live');
    els.statusText.textContent = '准备播放';
    els.body.classList.remove('is-playing');
    els.favBtn.classList.remove('is-fav');
    els.favBtn.setAttribute('aria-pressed', 'false');
    document.title = '声场 · SOUNDFIELD';
    state.wavePeaks = null;
    drawWave();
  }

  /* ------------------------------------------------------------------ */
  /* immersive now-playing view & lyrics                                */
  /* ------------------------------------------------------------------ */

  function isImmersiveOpen() {
    return els.body.classList.contains('immersive-open');
  }

  function openImmersive() {
    const track = currentTrack();
    if (!track) {
      showToast('还没有正在播放的歌曲');
      return;
    }
    if (!isImmersiveOpen()) {
      closeHelp();
      closeSidebar();
      previousFocus = document.activeElement;
      els.appShell.setAttribute('inert', '');
      els.body.classList.add('immersive-open');
      els.immersive.setAttribute('aria-hidden', 'false');
      els.immersive.scrollTop = 0;
      els.immersive.scrollLeft = 0;
    }
    updateImmersiveTrack(track);
    loadLyrics(track);
    updateImmersiveProgress();
    window.requestAnimationFrame(() => {
      syncLyrics(true);
      try { els.immBack.focus({ preventScroll: true }); } catch (error) { /* ignore */ }
    });
  }

  function closeImmersive() {
    if (!isImmersiveOpen()) return;
    els.body.classList.remove('immersive-open');
    els.immersive.setAttribute('aria-hidden', 'true');
    els.appShell.removeAttribute('inert');
    setPlayingUI();
    const target = previousFocus && previousFocus.isConnected ? previousFocus : els.playBtn;
    window.setTimeout(() => {
      try { target.focus({ preventScroll: true }); } catch (error) { /* ignore */ }
    }, 260);
  }

  function updateImmersiveTrack(track) {
    if (!track) return;
    const palette = paletteFor(track.id);
    els.immersive.style.setProperty('--imm-a', palette.a);
    els.immersive.style.setProperty('--imm-b', palette.b);
    els.immersive.style.setProperty('--imm-c', palette.c);

    els.immTitle.textContent = track.title || '未知曲目';
    els.immArtist.textContent = track.artist || '未知艺术家';
    const albumLabel = track.album && track.album !== track.artist
      ? track.album
      : (track.playlist || '本地曲库');
    els.immAlbum.textContent = albumLabel;
    els.immGlyph.textContent = firstCharacter(track.title);
    els.immTitle.title = track.title || '';

    const token = ++state.immArtToken;
    els.immCoverImg.onload = () => {
      if (token !== state.immArtToken) return;
      els.immCoverImg.hidden = false;
      els.immCover.classList.add('has-photo');
    };
    els.immCoverImg.onerror = () => {
      if (token !== state.immArtToken) return;
      els.immCoverImg.hidden = true;
      els.immCover.classList.remove('has-photo');
      els.immBg.classList.remove('is-photo');
      els.immBg.style.removeProperty('--imm-photo');
    };
    if (track.hasCover && track.coverUrl) {
      if (els.immCoverImg.getAttribute('src') !== track.coverUrl) {
        els.immCoverImg.hidden = true;
        els.immCover.classList.remove('has-photo');
        els.immCoverImg.src = track.coverUrl;
      } else if (els.immCoverImg.complete && els.immCoverImg.naturalWidth > 0) {
        els.immCoverImg.hidden = false;
        els.immCover.classList.add('has-photo');
      }
      els.immBg.style.setProperty('--imm-photo', `url("${track.coverUrl}")`);
      els.immBg.classList.add('is-photo');
    } else {
      els.immCoverImg.hidden = true;
      els.immCoverImg.removeAttribute('src');
      els.immCover.classList.remove('has-photo');
      els.immBg.style.removeProperty('--imm-photo');
      els.immBg.classList.remove('is-photo');
    }

    const isFav = state.favorites.has(track.id);
    els.immFav.classList.toggle('is-fav', isFav);
    els.immFav.setAttribute('aria-pressed', String(isFav));
    els.immFav.setAttribute('aria-label', isFav ? '取消收藏当前歌曲' : '收藏当前歌曲');
    setPlayingUI();
  }

  function updateImmersiveProgress() {
    if (!isImmersiveOpen()) return;
    const duration = getDuration();
    const current = els.audio.currentTime || 0;
    els.immCurrent.textContent = formatTime(current);
    els.immDuration.textContent = duration ? formatDuration(duration) : '00:00';
    const ratio = duration ? clamp(current / duration, 0, 1) : 0;
    els.immSeek.value = String(Math.round(ratio * 1000));
    els.immSeek.style.setProperty('--imm-progress', `${ratio * 100}%`);
  }

  function lyricsSourceLabel(source, estimated) {
    const labels = {
      lrc: 'LRC · 本地文件',
      embedded: '内嵌歌词',
      'lrclib-synced': '在线歌词 · LRCLIB',
      'lrclib-plain': '在线歌词 · LRCLIB',
      none: '',
    };
    let label = labels[source] || '';
    if (estimated) label += (label ? ' · ' : '') + '自动时间轴';
    return label;
  }

  function showLyricsLoading() {
    state.lyrics.loading = true;
    els.immLyricsList.innerHTML = '';
    els.immLyricsList.hidden = true;
    els.immLyricsEmpty.hidden = true;
    els.immLyricsLoading.hidden = false;
    els.immLyricsSource.textContent = '';
  }

  function showLyricsEmpty(message) {
    state.lyrics.loading = false;
    state.lyrics.lines = [];
    state.lyrics.activeIndex = -1;
    els.immLyricsLoading.hidden = true;
    els.immLyricsList.innerHTML = '';
    els.immLyricsList.hidden = true;
    els.immLyricsEmpty.hidden = false;
    els.immLyricsSource.textContent = '';
    const track = currentTrack();
    if (track) {
      const stem = track.path.split('/').pop().replace(/\.[^.]+$/, '');
      els.immLyricsHint.textContent = message
        || `没有找到歌词。已尝试在线匹配；也可以把同名歌词文件「${stem}.lrc」放到歌曲旁边，刷新后就会跟随播放滚动。`;
    } else {
      els.immLyricsHint.textContent = message || '暂时没有找到这首歌的歌词。';
    }
  }

  function renderLyrics() {
    const lines = state.lyrics.lines;
    if (!lines.length) {
      showLyricsEmpty();
      return;
    }
    els.immLyricsLoading.hidden = true;
    els.immLyricsEmpty.hidden = true;
    els.immLyricsList.hidden = false;
    els.immLyricsList.innerHTML = lines.map((line, index) => {
      const hasTime = Number.isFinite(line.time);
      return `<button type="button" class="lyric-line${hasTime ? '' : ' has-no-time'}"
        data-lyric-index="${index}"${hasTime ? ` data-time="${line.time}"` : ''}>${escapeHtml(line.text)}</button>`;
    }).join('');
    state.lyrics.activeIndex = -1;
    els.immLyricsScroll.scrollTop = 0;
    window.requestAnimationFrame(() => syncLyrics(true));
  }

  function parseLrcText(text) {
    if (!text || !text.trim()) return { timed: false, lines: [] };
    const timePattern = /\[(\d{1,3}):(\d{2})(?:[.:](\d{1,3}))?\]/g;
    const tagPattern = /\[[^\]]*\]/g;
    let offsetMs = 0;
    const timedLines = [];
    const untimedLines = [];
    text.replace(/\r\n?/g, '\n').split('\n').forEach((rawLine) => {
      const raw = rawLine.replace(/^\ufeff/, '').trim();
      if (!raw) return;
      const offsetMatch = raw.match(/\[offset:\s*([+-]?\d+)\]/i);
      if (offsetMatch) {
        const parsed = Number(offsetMatch[1]);
        if (Number.isFinite(parsed)) offsetMs = parsed;
      }
      const stamps = Array.from(raw.matchAll(timePattern));
      const content = raw.replace(tagPattern, '').trim();
      if (!stamps.length) {
        if (content) untimedLines.push(content);
        return;
      }
      if (!content) return;
      stamps.forEach((stamp) => {
        const millis = stamp[3] ? Number(stamp[3].padEnd(3, '0').slice(0, 3)) : 0;
        const time = Number(stamp[1]) * 60 + Number(stamp[2]) + millis / 1000;
        timedLines.push({ time: Math.max(0, time + offsetMs / 1000), text: content });
      });
    });
    if (timedLines.length) {
      timedLines.sort((a, b) => a.time - b.time);
      const seen = new Set();
      const deduped = [];
      timedLines.forEach((line) => {
        const key = `${line.time.toFixed(3)}|${line.text}`;
        if (!seen.has(key)) {
          seen.add(key);
          deduped.push({ time: Number(line.time.toFixed(3)), text: line.text });
        }
      });
      return { timed: true, lines: deduped };
    }
    return { timed: false, lines: untimedLines.map((line) => ({ time: null, text: line })) };
  }

  function normalizeMatch(value) {
    return String(value || '').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  }

  async function fetchBrowserLyrics(track, options = {}) {
    if (!track.title || !track.artist || track.artist === '未知艺术家') return null;
    const controller = new AbortController();
    const timeoutMs = Number(options.timeoutMs) || 7000;
    const timer = window.setTimeout(() => controller.abort(), timeoutMs);
    try {
      const params = new URLSearchParams({
        track_name: track.title,
        artist_name: track.artist,
      });
      const response = await fetch(`https://lrclib.net/api/search?${params.toString()}`, {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
        credentials: 'omit',
      });
      if (!response.ok) return null;
      const results = await response.json();
      if (!Array.isArray(results)) return null;
      const targetTitle = normalizeMatch(track.title);
      const targetArtist = normalizeMatch(track.artist);
      let best = null;
      let bestScore = -999;
      results.forEach((item) => {
        if (!item || typeof item !== 'object') return;
        const synced = String(item.syncedLyrics || '').trim();
        const plain = String(item.plainLyrics || '').trim();
        if (!synced && !plain) return;
        let score = 0;
        if (normalizeMatch(item.trackName) === targetTitle) score += 6;
        if (normalizeMatch(item.artistName) === targetArtist) score += 6;
        if (synced) score += 3;
        const itemDuration = Number(item.duration || 0);
        if (track.duration > 0 && itemDuration > 0) {
          score -= Math.min(6, Math.abs(itemDuration - track.duration) / 8);
        }
        if (score > bestScore) {
          bestScore = score;
          const raw = synced || plain;
          const parsed = parseLrcText(raw);
          best = {
            lines: parsed.lines,
            timed: parsed.timed,
            source: synced ? 'lrclib-synced' : 'lrclib-plain',
            raw,
          };
        }
      });
      return best;
    } catch (error) {
      return null;
    } finally {
      window.clearTimeout(timer);
    }
  }

  function setLyricsLoadingText(text) {
    const label = els.immLyricsLoading.querySelector('span');
    if (label) label.textContent = text;
  }

  function applyLyricsData(data) {
    let lines = Array.isArray(data.lines) ? data.lines : [];
    lines = lines
      .filter((line) => line && String(line.text || '').trim())
      .map((line) => ({
        time: Number.isFinite(Number(line.time)) ? Number(line.time) : null,
        text: String(line.text),
      }));
    let timed = Boolean(data.timed) && lines.every((line) => line.time !== null);
    let estimated = false;
    if (!timed && lines.length > 1) {
      const duration = getDuration();
      if (duration > 1) {
        lines = lines.map((line, index) => ({
          ...line,
          time: (index / lines.length) * duration,
        }));
        timed = true;
        estimated = true;
      }
    }
    state.lyrics.lines = lines;
    state.lyrics.timed = timed;
    state.lyrics.estimated = estimated;
    state.lyrics.source = data.source || 'none';
    state.lyrics.loading = false;
    els.immLyricsSource.textContent = lyricsSourceLabel(state.lyrics.source, estimated);
    if (!lines.length) {
      showLyricsEmpty();
      return false;
    }
    renderLyrics();
    return true;
  }

  async function loadLyrics(track) {
    if (!track) return;
    if (state.lyrics.trackId === track.id
        && (state.lyrics.loading || state.lyrics.lines.length || state.lyrics.source !== 'none')) {
      return;
    }
    const token = ++state.lyrics.token;
    state.lyrics.trackId = track.id;
    state.lyrics.lines = [];
    state.lyrics.timed = false;
    state.lyrics.estimated = false;
    state.lyrics.activeIndex = -1;
    state.lyrics.source = 'none';
    state.lyrics.userScrollUntil = 0;
    showLyricsLoading();
    setLyricsLoadingText('正在读取本地歌词…');

    try {
      let localData = null;
      const localController = new AbortController();
      const localTimer = window.setTimeout(() => localController.abort(), 1600);
      try {
        const localResponse = await fetch(
          `/api/lyrics/${encodeURIComponent(track.id)}?online=0`,
          { cache: 'no-store', signal: localController.signal },
        );
        if (localResponse.ok) localData = await localResponse.json();
      } catch (localError) {
        if (localError.name !== 'AbortError') console.debug('Local lyrics unavailable:', localError);
      } finally {
        window.clearTimeout(localTimer);
      }
      if (token !== state.lyrics.token || track.id !== state.currentId) return;
      if (localData && Array.isArray(localData.lines) && localData.lines.length) {
        applyLyricsData(localData);
        return;
      }

      if (track.title && track.artist && track.artist !== '未知艺术家') {
        setLyricsLoadingText('正在在线匹配歌词…');
        const browserLyrics = await fetchBrowserLyrics(track);
        if (token !== state.lyrics.token || track.id !== state.currentId) return;
        if (browserLyrics && browserLyrics.lines.length) {
          applyLyricsData(browserLyrics);
          return;
        }

        setLyricsLoadingText('正在尝试服务器匹配…');
        let onlineData = null;
        const onlineController = new AbortController();
        const onlineTimer = window.setTimeout(() => onlineController.abort(), 6000);
        try {
          const onlineResponse = await fetch(
            `/api/lyrics/${encodeURIComponent(track.id)}`,
            { cache: 'no-store', signal: onlineController.signal },
          );
          if (onlineResponse.ok) onlineData = await onlineResponse.json();
        } catch (onlineError) {
          if (onlineError.name !== 'AbortError') console.debug('Server lyrics unavailable:', onlineError);
        } finally {
          window.clearTimeout(onlineTimer);
        }
        if (token !== state.lyrics.token || track.id !== state.currentId) return;
        if (onlineData && Array.isArray(onlineData.lines) && onlineData.lines.length) {
          applyLyricsData(onlineData);
          return;
        }
      }

      state.lyrics.loading = false;
      showLyricsEmpty();
    } catch (error) {
      if (token !== state.lyrics.token) return;
      console.debug('Lyrics unavailable:', error);
      showLyricsEmpty('歌词加载失败。可以检查网络，或把同名 .lrc 文件放到歌曲旁边。');
    }
  }

  function retryLyrics() {
    const track = currentTrack();
    if (!track) return;
    state.lyrics.trackId = null;
    state.lyrics.lines = [];
    state.lyrics.source = 'none';
    state.lyrics.loading = false;
    loadLyrics(track);
  }

  function wait(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  async function validateLibraryDirectory(root) {
    const topFolders = Array.from(new Set(
      state.tracks
        .filter((track) => track.path.includes('/'))
        .map((track) => track.path.split('/')[0])
        .filter(Boolean),
    ));
    for (const folder of topFolders) {
      try {
        await root.getDirectoryHandle(folder, { create: false });
        return true;
      } catch (error) {
        /* try next */
      }
    }
    const first = state.tracks[0];
    if (first && !first.path.includes('/')) {
      try {
        await root.getFileHandle(first.path, { create: false });
        return true;
      } catch (error) {
        /* not the library folder */
      }
    }
    return false;
  }

  async function downloadLyricsForLibrary() {
    if (state.savingLyrics) return;
    if (!window.showDirectoryPicker) {
      showToast('当前浏览器不支持直接写入歌词文件，请使用 Chrome 或 Edge');
      return;
    }
    let root;
    try {
      root = await window.showDirectoryPicker({ id: 'soundfield-library', mode: 'readwrite' });
    } catch (error) {
      if (error.name !== 'AbortError') showToast('无法访问文件夹，请重试');
      return;
    }
    if (!await validateLibraryDirectory(root)) {
      showToast('请选择包含「周杰伦歌单」等歌曲文件夹的音乐播放器目录');
      return;
    }

    const tracks = state.tracks.filter((track) => track.title && track.artist);
    state.savingLyrics = true;
    els.downloadLyricsBtn.disabled = true;
    els.downloadLyricsBtn.classList.add('is-busy');
    let saved = 0;
    let skipped = 0;
    let missing = 0;
    let failed = 0;
    let consecutiveMisses = 0;
    let stoppedEarly = false;
    let stoppedAtIndex = -1;

    try {
      for (let index = 0; index < tracks.length; index += 1) {
        const track = tracks[index];
        els.downloadLyricsLabel.textContent = `${index + 1}/${tracks.length}`;
        if (index % 2 === 0) {
          showToast(`正在补齐歌词 ${index + 1}/${tracks.length} · ${track.title}`, 30000);
        }
        try {
          const parts = track.path.split('/');
          const fileName = parts.pop();
          const stem = fileName.replace(/\.[^.]+$/, '');
          let folder = root;
          for (const part of parts) {
            folder = await folder.getDirectoryHandle(part, { create: false });
          }
          const lrcName = `${stem}.lrc`;
          let exists = true;
          try {
            await folder.getFileHandle(lrcName, { create: false });
          } catch (error) {
            if (error.name === 'NotFoundError') exists = false;
            else throw error;
          }
          if (exists) {
            skipped += 1;
            continue;
          }
          if (state.lyrics.trackId === track.id && state.lyrics.source === 'lrc') {
            skipped += 1;
            continue;
          }
          const found = await fetchBrowserLyrics(track, { timeoutMs: 5000 });
          if (!found || !found.raw) {
            missing += 1;
            consecutiveMisses += 1;
            if (consecutiveMisses >= 5) {
              stoppedEarly = true;
              stoppedAtIndex = index;
              break;
            }
            continue;
          }
          consecutiveMisses = 0;
          const fileHandle = await folder.getFileHandle(lrcName, { create: true });
          const writable = await fileHandle.createWritable();
          await writable.write(found.raw);
          await writable.close();
          saved += 1;
          track.hasLocalLyrics = true;
          await wait(220);
        } catch (error) {
          failed += 1;
          console.warn('Could not save lyrics for', track.title, error);
        }
      }
    } finally {
      state.savingLyrics = false;
      els.downloadLyricsBtn.disabled = false;
      els.downloadLyricsBtn.classList.remove('is-busy');
      els.downloadLyricsLabel.textContent = '补齐歌词';
    }

    let summary = `歌词补齐完成：保存 ${saved} 首`;
    if (skipped) summary += `，已有 ${skipped} 首`;
    if (missing) summary += `，未找到 ${missing} 首`;
    if (failed) summary += `，失败 ${failed} 首`;
    if (stoppedEarly) {
      const remaining = Math.max(0, tracks.length - stoppedAtIndex - 1);
      summary += `；网络连续失败，已停止${remaining ? `，还有 ${remaining} 首未处理` : ''}`;
    }
    if (missing && !saved) summary += '（请检查网络，或确认浏览器允许访问 lrclib.net）';
    showToast(summary, 8000);
  }

  function scrollLyricsTo(index, immediate = false) {
    const line = els.immLyricsList.children[index];
    if (!line) return;
    if (!immediate && Date.now() < state.lyrics.userScrollUntil) return;
    const lineRect = line.getBoundingClientRect();
    const viewRect = els.immLyricsScroll.getBoundingClientRect();
    const offset = (lineRect.top - viewRect.top) - viewRect.height * 0.38 + lineRect.height / 2;
    els.immLyricsScroll.scrollTo({
      top: Math.max(0, els.immLyricsScroll.scrollTop + offset),
      behavior: immediate || reduceMotion ? 'auto' : 'smooth',
    });
  }

  function syncLyrics(force = false) {
    if (!isImmersiveOpen() || !state.lyrics.timed || !state.lyrics.lines.length) return;
    const current = els.audio.currentTime || 0;
    let index = -1;
    for (let i = 0; i < state.lyrics.lines.length; i += 1) {
      const line = state.lyrics.lines[i];
      if (line.time !== null && line.time <= current + 0.18) index = i;
      else break;
    }
    if (index === state.lyrics.activeIndex && !force) return;
    state.lyrics.activeIndex = index;
    const lineElements = els.immLyricsList.children;
    for (let i = 0; i < lineElements.length; i += 1) {
      lineElements[i].classList.toggle('is-active', i === index);
      lineElements[i].classList.toggle('is-past', i < index);
    }
    if (index >= 0) scrollLyricsTo(index, force);
  }

  function trackFolder() {
    const track = currentTrack();
    if (!track || !track.path.includes('/')) return '';
    return track.path.slice(0, track.path.lastIndexOf('/'));
  }

  function updateCurrentDuration(duration) {
    const track = currentTrack();
    if (track && duration > 0) {
      track.duration = duration;
      els.durationTime.textContent = formatDuration(duration);
      const row = els.trackList.querySelector(`.track-row[data-id="${CSS.escape(track.id)}"] .time-cell`);
      if (row) row.textContent = formatDuration(duration);
      updateStats();
    }
    if (isImmersiveOpen()) updateImmersiveProgress();
  }

  /* ------------------------------------------------------------------ */
  /* playback                                                           */
  /* ------------------------------------------------------------------ */

  function ensureAudioGraph() {
    if (audioContext) {
      if (audioContext.state === 'suspended') audioContext.resume().catch(() => {});
      return;
    }
    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;
      audioContext = new AudioContextClass();
      sourceNode = audioContext.createMediaElementSource(els.audio);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 128;
      analyser.smoothingTimeConstant = 0.84;
      sourceNode.connect(analyser);
      analyser.connect(audioContext.destination);
      frequencyData = new Uint8Array(analyser.frequencyBinCount);
      audioContext.resume().catch(() => {});
    } catch (error) {
      console.warn('Audio graph unavailable:', error);
      analyser = null;
    }
  }

  function setPlayingUI() {
    const audio = els.audio;
    const playing = Boolean(state.currentId) && !audio.paused && !audio.ended && !audio.error;
    const hasTrack = Boolean(state.currentId);
    els.body.classList.toggle('is-playing', playing);
    els.body.classList.toggle('is-paused', !playing);
    els.statusPill.classList.toggle('is-live', playing);
    if (audio.error) {
      els.statusText.textContent = '无法播放';
    } else if (playing) {
      els.statusText.textContent = '正在播放';
    } else if (!hasTrack) {
      els.statusText.textContent = '准备播放';
    } else if (audio.ended) {
      els.statusText.textContent = '播放完毕';
    } else if (audio.currentTime > 0.2) {
      els.statusText.textContent = '已暂停';
    } else {
      els.statusText.textContent = '准备播放';
    }
    els.playBtn.setAttribute('aria-label', playing ? '暂停' : '播放');
    els.playBtn.setAttribute('title', playing ? '暂停 (空格)' : '播放 (空格)');
    els.immStatus.textContent = els.statusText.textContent;
    els.immPlay.setAttribute('aria-label', playing ? '暂停' : '播放');
    const track = currentTrack();
    document.title = playing && track ? `${track.title} · 声场` : '声场 · SOUNDFIELD';
    if ('mediaSession' in navigator) {
      navigator.mediaSession.playbackState = playing ? 'playing' : (hasTrack ? 'paused' : 'none');
    }
    if (isImmersiveOpen()) updateImmersiveProgress();
  }

  function playAudio() {
    if (!state.currentId) {
      showToast('曲库为空，请先添加音乐');
      return;
    }
    ensureAudioGraph();
    if (els.audio.ended) els.audio.currentTime = 0;
    const promise = els.audio.play();
    if (promise && promise.catch) {
      promise.catch((error) => {
        if (error.name === 'AbortError') return;
        console.warn(error);
        setPlayingUI();
        showToast('无法开始播放，请再点一次播放按钮');
      });
    }
  }

  function pauseAudio() {
    els.audio.pause();
  }

  function togglePlay() {
    if (!state.currentId) {
      if (state.tracks.length) playTrack(getFilteredTracks()[0]?.id || state.tracks[0].id, true);
      else showToast('曲库为空，请先添加音乐');
      return;
    }
    if (els.audio.paused) playAudio();
    else pauseAudio();
  }

  function setTrack(track, autoplay = true) {
    if (!track) return;
    const same = state.currentId === track.id && els.audio.getAttribute('src');
    state.currentId = track.id;
    try {
      localStorage.setItem(LAST_TRACK_KEY, track.id);
    } catch (error) {
      /* ignore */
    }

    if (!same) {
      els.audio.pause();
      els.audio.src = track.audioUrl;
      els.audio.load();
      els.audio.playbackRate = state.speed;
      els.audio.preservesPitch = true;
      els.audio.webkitPreservesPitch = true;
      els.audio.mozPreservesPitch = true;
      state.wavePeaks = null;
      updateTrackUI(track);
      els.currentTime.textContent = '00:00';
      els.waveWrap.setAttribute('aria-valuenow', '0');
      loadWaveform(track);
    } else {
      updateTrackUI(track);
    }

    renderTrackList();
    updateFavoriteUI();
    setPlayingUI();
    if (isImmersiveOpen()) loadLyrics(track);

    if (autoplay) {
      playAudio();
    } else {
      els.durationTime.textContent = formatDuration(track.duration);
      drawWave();
    }
  }

  function playTrack(id, autoplay = true) {
    const track = state.tracks.find((item) => item.id === id);
    if (!track) return;
    if (state.currentId === track.id) {
      if (autoplay) playAudio();
      return;
    }
    setTrack(track, autoplay);
  }

  function nextTrack({ fromEnded = false } = {}) {
    const list = getFilteredTracks();
    if (!list.length) return null;
    if (state.shuffle) {
      if (list.length === 1) return (fromEnded && state.repeat === 'off') ? null : list[0];
      let candidate = list[Math.floor(Math.random() * list.length)];
      let guard = 0;
      while (candidate.id === state.currentId && guard < 8) {
        candidate = list[Math.floor(Math.random() * list.length)];
        guard += 1;
      }
      return candidate;
    }
    const index = list.findIndex((track) => track.id === state.currentId);
    if (index === -1) return list[0];
    if (fromEnded && state.repeat === 'off' && index === list.length - 1) return null;
    return list[(index + 1) % list.length];
  }

  function previousTrack() {
    const list = getFilteredTracks();
    if (!list.length) return;
    if (els.audio.currentTime > 3 && state.currentId) {
      els.audio.currentTime = 0;
      updateTimeUI();
      return;
    }
    if (state.shuffle) {
      const track = nextTrack();
      if (track) setTrack(track, true);
      return;
    }
    const index = list.findIndex((track) => track.id === state.currentId);
    if (index === -1) {
      setTrack(list[0], true);
      return;
    }
    setTrack(list[(index - 1 + list.length) % list.length], true);
  }

  function handleEnded() {
    if (!state.currentId) return;
    if (state.repeat === 'one') {
      els.audio.currentTime = 0;
      playAudio();
      return;
    }
    const next = nextTrack({ fromEnded: true });
    if (next) setTrack(next, true);
    else {
      setPlayingUI();
      els.statusText.textContent = '播放完毕';
    }
  }

  function cycleRepeat() {
    state.repeat = state.repeat === 'off' ? 'all' : (state.repeat === 'all' ? 'one' : 'off');
    const label = { off: '关闭', all: '列表循环', one: '单曲循环' }[state.repeat];
    els.repeatBtn.classList.toggle('is-active', state.repeat !== 'off');
    els.repeatBtn.classList.toggle('repeat-mode-one', state.repeat === 'one');
    els.repeatBtn.setAttribute('aria-pressed', String(state.repeat !== 'off'));
    els.repeatBtn.setAttribute('aria-label', `循环模式：${label}`);
    els.repeatBtn.title = `循环模式：${label} (R)`;
    saveSettings();
    showToast(`循环模式 · ${label}`);
  }

  function toggleShuffle() {
    state.shuffle = !state.shuffle;
    els.shuffleBtn.classList.toggle('is-active', state.shuffle);
    els.shuffleBtn.setAttribute('aria-pressed', String(state.shuffle));
    els.shuffleBtn.title = `随机播放：${state.shuffle ? '开' : '关'} (S)`;
    saveSettings();
    showToast(`随机播放 · ${state.shuffle ? '开启' : '关闭'}`);
  }

  function cycleSpeed() {
    const index = SPEEDS.indexOf(state.speed);
    state.speed = SPEEDS[(index + 1) % SPEEDS.length];
    els.audio.playbackRate = state.speed;
    els.audio.preservesPitch = true;
    els.speedBtn.textContent = `${speedLabel(state.speed)}×`;
    saveSettings();
    showToast(`播放速度 · ${state.speed}×`);
  }

  function seekTo(seconds) {
    const duration = getDuration();
    if (!duration) return;
    els.audio.currentTime = clamp(seconds, 0, duration);
    updateTimeUI();
    drawWave();
  }

  function seekBy(delta) {
    seekTo(els.audio.currentTime + delta);
  }

  /* ------------------------------------------------------------------ */
  /* volume                                                             */
  /* ------------------------------------------------------------------ */

  function updateVolumeUI() {
    const effective = state.muted ? 0 : state.volume;
    els.audio.volume = state.volume;
    els.audio.muted = state.muted;
    els.volumeSlider.value = String(state.volume);
    els.volumeSlider.style.setProperty('--vol', `${effective * 100}%`);
    els.volumeSlider.setAttribute('aria-valuetext', `${Math.round(effective * 100)}%`);
    els.volumeValue.textContent = String(Math.round(effective * 100));
    els.body.classList.toggle('is-muted', state.muted || state.volume === 0);
    els.muteBtn.setAttribute('aria-label', state.muted ? '取消静音' : '静音');
    els.muteBtn.title = `${state.muted ? '取消静音' : '静音'} (M)`;
  }

  function setVolume(value) {
    state.volume = clamp(value, 0, 1);
    if (state.volume > 0) state.muted = false;
    updateVolumeUI();
    saveSettings();
  }

  function toggleMute() {
    state.muted = !state.muted;
    updateVolumeUI();
    saveSettings();
  }

  /* ------------------------------------------------------------------ */
  /* time, waveform, visualizer                                         */
  /* ------------------------------------------------------------------ */

  function updateTimeUI() {
    const duration = getDuration();
    const current = els.audio.currentTime || 0;
    els.currentTime.textContent = formatTime(current);
    els.durationTime.textContent = duration ? formatDuration(duration) : '--:--';
    els.waveWrap.setAttribute('aria-valuenow', String(duration ? Math.round((current / duration) * 100) : 0));
    if ('mediaSession' in navigator && duration > 0 && navigator.mediaSession.setPositionState) {
      const now = Date.now();
      if (now - state.lastPosUpdate > 1000) {
        state.lastPosUpdate = now;
        try {
          navigator.mediaSession.setPositionState({
            duration,
            playbackRate: els.audio.playbackRate,
            position: clamp(current, 0, duration),
          });
        } catch (error) {
          /* ignore */
        }
      }
    }
    if (isImmersiveOpen()) {
      updateImmersiveProgress();
      syncLyrics();
    }
  }

  function resizeCanvas(canvas) {
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) return null;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.round(rect.width * dpr);
    const height = Math.round(rect.height * dpr);
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    const context = canvas.getContext('2d');
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { context, width: rect.width, height: rect.height };
  }

  function placeholderPeaks(seed) {
    let value = hashString(seed || 'soundfield') || 1;
    const peaks = [];
    for (let i = 0; i < 180; i += 1) {
      value = (Math.imul(value, 1664525) + 1013904223) >>> 0;
      const random = value / 4294967296;
      const envelope = 0.42 + 0.58 * Math.sin((i / 179) * Math.PI);
      peaks.push(0.1 + 0.74 * random * envelope);
    }
    return peaks;
  }

  function drawWave() {
    const dims = resizeCanvas(els.waveform);
    if (!dims) return;
    const { context, width, height } = dims;
    context.clearRect(0, 0, width, height);
    const peaks = state.wavePeaks || placeholderPeaks(state.currentId || 'soundfield');
    const duration = getDuration();
    const progress = duration ? clamp((els.audio.currentTime || 0) / duration, 0, 1) : 0;
    const bars = Math.max(56, Math.min(180, Math.floor(width / 4.1)));
    const step = width / bars;
    const barWidth = Math.max(1.4, Math.min(3, step * 0.44));
    const center = height / 2;
    const maxHeight = height - 10;
    const playedGradient = context.createLinearGradient(0, 0, width, 0);
    playedGradient.addColorStop(0, 'rgba(27, 27, 25, 0.88)');
    playedGradient.addColorStop(0.6, 'rgba(45, 45, 42, 0.95)');
    playedGradient.addColorStop(1, 'rgba(17, 17, 16, 1)');

    context.fillStyle = 'rgba(20, 20, 18, 0.05)';
    context.fillRect(0, center - 0.5, width, 1);

    for (let i = 0; i < bars; i += 1) {
      const sourceIndex = Math.min(peaks.length - 1, Math.floor((i / bars) * peaks.length));
      const amplitude = Math.max(2.4, peaks[sourceIndex] * maxHeight);
      const x = i * step + step / 2 - barWidth / 2;
      const y = center - amplitude / 2;
      const position = i / Math.max(1, bars - 1);
      if (position <= progress) {
        context.fillStyle = playedGradient;
        context.globalAlpha = 1;
      } else {
        context.fillStyle = 'rgba(20, 20, 18, 0.14)';
        context.globalAlpha = 1;
      }
      context.beginPath();
      const radius = barWidth / 2;
      if (context.roundRect) {
        context.roundRect(x, y, barWidth, amplitude, radius);
        context.fill();
      } else {
        context.fillRect(x, y, barWidth, amplitude);
      }
    }

    if (state.hoverFraction !== null) {
      const hoverX = state.hoverFraction * width;
      context.fillStyle = 'rgba(20, 20, 18, 0.18)';
      context.fillRect(hoverX, 5, 1, height - 10);
    }
    context.globalAlpha = 1;
  }

  function computePeaks(buffer) {
    const channel = buffer.getChannelData(0);
    const buckets = 200;
    const step = Math.max(1, Math.floor(channel.length / buckets));
    const stride = Math.max(1, Math.floor(step / 56));
    const peaks = [];
    for (let bucket = 0; bucket < buckets; bucket += 1) {
      const start = bucket * step;
      const end = Math.min(channel.length, start + step);
      let max = 0;
      for (let index = start; index < end; index += stride) {
        const value = Math.abs(channel[index]);
        if (value > max) max = value;
      }
      peaks.push(max);
    }
    const top = Math.max(...peaks) || 1;
    return peaks.map((value) => Math.max(0.035, Math.min(1, value / top)));
  }

  async function loadWaveform(track) {
    state.waveToken += 1;
    const token = state.waveToken;
    if (state.waveAbort) state.waveAbort.abort();
    const controller = new AbortController();
    state.waveAbort = controller;
    state.hoverFraction = null;

    if (state.peaks.has(track.id)) {
      state.wavePeaks = state.peaks.get(track.id);
      drawWave();
      return;
    }

    state.wavePeaks = placeholderPeaks(track.id);
    drawWave();

    if (!track.size || track.size > 90 * 1024 * 1024) return;
    if (track.duration > 1800) return;

    try {
      const response = await fetch(track.audioUrl, { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const buffer = await response.arrayBuffer();
      if (token !== state.waveToken) return;
      const OfflineContext = window.OfflineAudioContext || window.webkitOfflineAudioContext;
      if (!OfflineContext) return;
      if (!decodeContext) decodeContext = new OfflineContext(1, 1, 44100);
      const decoded = await decodeContext.decodeAudioData(buffer);
      if (token !== state.waveToken) return;
      const peaks = computePeaks(decoded);
      state.peaks.set(track.id, peaks);
      if (state.peaks.size > 24) {
        const oldest = state.peaks.keys().next().value;
        state.peaks.delete(oldest);
      }
      state.wavePeaks = peaks;
      drawWave();
    } catch (error) {
      if (error.name !== 'AbortError') {
        console.debug('Waveform unavailable:', error);
      }
    }
  }

  function drawVisualizer(timestamp) {
    const dims = resizeCanvas(els.visualizer);
    if (!dims) return;
    const { context, width, height } = dims;
    context.clearRect(0, 0, width, height);
    const bars = Math.max(18, Math.min(38, Math.floor(width / 7)));
    const gap = 2;
    const barWidth = Math.max(1.2, (width - (bars - 1) * gap) / bars);
    const active = analyser && !els.audio.paused && !els.audio.ended;
    if (active && frequencyData) analyser.getByteFrequencyData(frequencyData);
    for (let i = 0; i < bars; i += 1) {
      let value;
      if (active && frequencyData) {
        const index = Math.floor(2 + (i / bars) * (frequencyData.length * 0.72));
        value = frequencyData[Math.min(frequencyData.length - 1, index)] / 255;
      } else if (reduceMotion) {
        value = 0.08;
      } else {
        value = 0.08 + 0.035 * (0.5 + 0.5 * Math.sin(timestamp / 900 + i * 0.52));
      }
      const barHeight = Math.max(1.5, value * (height - 3));
      const x = i * (barWidth + gap);
      context.fillStyle = `rgba(27, 27, 25, ${active ? 0.24 + value * 0.55 : 0.14})`;
      context.fillRect(x, height - barHeight, barWidth, barHeight);
    }
  }

  function animationLoop(timestamp) {
    if (timestamp - state.lastWaveDraw > 55) {
      drawWave();
      state.lastWaveDraw = timestamp;
    }
    drawVisualizer(timestamp);
    window.requestAnimationFrame(animationLoop);
  }

  function updateWaveFromPointer(event) {
    const rect = els.waveWrap.getBoundingClientRect();
    if (rect.width <= 0) return;
    const fraction = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    state.hoverFraction = fraction;
    const duration = getDuration();
    els.waveTooltip.style.left = `${fraction * 100}%`;
    els.waveTooltip.textContent = duration ? formatTime(fraction * duration) : '00:00';
    els.waveTooltip.classList.add('is-visible');
    drawWave();
  }

  function clearWaveHover() {
    if (state.draggingWave) return;
    state.hoverFraction = null;
    els.waveTooltip.classList.remove('is-visible');
    drawWave();
  }

  function seekFromPointer(event) {
    const rect = els.waveWrap.getBoundingClientRect();
    const duration = getDuration();
    if (rect.width <= 0 || !duration) return;
    const fraction = clamp((event.clientX - rect.left) / rect.width, 0, 1);
    els.audio.currentTime = fraction * duration;
    updateTimeUI();
    drawWave();
  }

  /* ------------------------------------------------------------------ */
  /* media session                                                      */
  /* ------------------------------------------------------------------ */

  function updateMediaMetadata(track) {
    if (!('mediaSession' in navigator) || !track) return;
    if (typeof MediaMetadata === 'undefined') return;
    const artwork = track.hasCover && track.coverUrl
      ? [{ src: new URL(track.coverUrl, window.location.href).href, sizes: '512x512', type: 'image/jpeg' }]
      : [];
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: track.title || '未知曲目',
        artist: track.artist || '未知艺术家',
        album: track.album || '',
        artwork,
      });
    } catch (error) {
      /* metadata is a progressive enhancement */
    }
  }

  function setupMediaSession() {
    if (!('mediaSession' in navigator)) return;
    const handlers = {
      play: () => playAudio(),
      pause: () => pauseAudio(),
      previoustrack: () => previousTrack(),
      nexttrack: () => {
        const track = nextTrack();
        if (track) setTrack(track, true);
      },
      stop: () => {
        els.audio.pause();
        els.audio.currentTime = 0;
      },
      seekbackward: (details) => seekBy(-(details.seekOffset || 10)),
      seekforward: (details) => seekBy(details.seekOffset || 10),
      seekto: (details) => {
        if (typeof details.seekTime === 'number') seekTo(details.seekTime);
      },
    };
    Object.entries(handlers).forEach(([action, handler]) => {
      try {
        navigator.mediaSession.setActionHandler(action, handler);
      } catch (error) {
        /* unsupported action */
      }
    });
  }

  /* ------------------------------------------------------------------ */
  /* view / interactions                                                */
  /* ------------------------------------------------------------------ */

  function setView(view) {
    state.view = view;
    state.playlistPath = null;
    updateNavState();
    updateViewHeading();
    renderTrackList();
    closeSidebar();
    els.scrollArea.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
  }

  function setPlaylist(path) {
    const playlist = state.playlists.find((item) => item.path === path);
    if (!playlist) return;
    state.view = 'playlist';
    state.playlistPath = path;
    updateNavState();
    updateViewHeading();
    renderTrackList();
    renderPlaylists();
    closeSidebar();
    els.scrollArea.scrollTo({ top: 0, behavior: reduceMotion ? 'auto' : 'smooth' });
  }

  function playAllVisible() {
    const list = getFilteredTracks();
    if (!list.length) {
      const message = state.view === 'favorites'
        ? '还没有收藏歌曲'
        : (state.view === 'playlist' ? '这个歌单里还没有歌曲' : '没有可播放的歌曲');
      showToast(message);
      return;
    }
    if (state.currentId === list[0].id && els.audio.paused) {
      playAudio();
    } else {
      setTrack(list[0], true);
    }
    openImmersive();
  }

  function openSidebar() {
    els.body.classList.add('sidebar-open');
  }

  function closeSidebar() {
    els.body.classList.remove('sidebar-open');
  }

  function openHelp() {
    if (typeof els.helpDialog.showModal === 'function') {
      els.helpDialog.showModal();
    } else {
      els.helpDialog.setAttribute('open', '');
    }
  }

  function closeHelp() {
    if (typeof els.helpDialog.close === 'function') els.helpDialog.close();
    else els.helpDialog.removeAttribute('open');
  }

  function bindEvents() {
    els.audio.addEventListener('play', setPlayingUI);
    els.audio.addEventListener('pause', setPlayingUI);
    els.audio.addEventListener('playing', () => {
      setPlayingUI();
      updateTimeUI();
    });
    els.audio.addEventListener('waiting', () => {
      if (!els.audio.paused) els.statusText.textContent = '缓冲中…';
    });
    els.audio.addEventListener('timeupdate', updateTimeUI);
    els.audio.addEventListener('loadedmetadata', () => {
      if (Number.isFinite(els.audio.duration) && els.audio.duration > 0) {
        updateCurrentDuration(els.audio.duration);
        els.durationTime.textContent = formatDuration(els.audio.duration);
      }
      els.audio.playbackRate = state.speed;
      updateTimeUI();
      drawWave();
    });
    els.audio.addEventListener('durationchange', () => {
      if (Number.isFinite(els.audio.duration) && els.audio.duration > 0) updateCurrentDuration(els.audio.duration);
    });
    els.audio.addEventListener('ended', handleEnded);
    els.audio.addEventListener('error', () => {
      if (!state.currentId || !els.audio.getAttribute('src')) return;
      const messages = {
        1: '播放被中止',
        2: '读取音频时发生问题',
        3: '浏览器无法解码这首音频',
        4: '浏览器不支持这个音频格式',
      };
      const message = messages[els.audio.error?.code] || '音频无法播放';
      els.statusPill.classList.remove('is-live');
      els.statusText.textContent = '无法播放';
      showToast(`${message}，可尝试转换为 MP3 或 M4A`, 4200);
      setPlayingUI();
    });

    els.playBtn.addEventListener('click', togglePlay);
    els.prevBtn.addEventListener('click', previousTrack);
    els.nextBtn.addEventListener('click', () => {
      const track = nextTrack();
      if (track) setTrack(track, true);
    });
    els.shuffleBtn.addEventListener('click', toggleShuffle);
    els.repeatBtn.addEventListener('click', cycleRepeat);
    els.speedBtn.addEventListener('click', cycleSpeed);
    els.favBtn.addEventListener('click', () => {
      if (state.currentId) toggleFavorite(state.currentId);
    });

    els.muteBtn.addEventListener('click', toggleMute);
    els.volumeSlider.addEventListener('input', (event) => setVolume(Number(event.target.value)));

    els.scanBtn.addEventListener('click', () => syncLibrary({ manual: true }));
    els.refreshTop.addEventListener('click', () => syncLibrary({ manual: true }));
    els.emptyScanBtn.addEventListener('click', () => syncLibrary({ manual: true }));
    els.openFolderBtn.addEventListener('click', openFolder);
    els.downloadLyricsBtn.addEventListener('click', downloadLyricsForLibrary);
    els.playAllBtn.addEventListener('click', playAllVisible);

    $$('.nav-item').forEach((button) => {
      button.addEventListener('click', () => setView(button.dataset.view));
    });

    els.playlistList.addEventListener('click', (event) => {
      const item = event.target.closest('[data-playlist]');
      if (item) setPlaylist(item.dataset.playlist);
    });

    let searchTimer = 0;
    els.searchInput.addEventListener('input', () => {
      window.clearTimeout(searchTimer);
      state.search = els.searchInput.value;
      searchTimer = window.setTimeout(renderTrackList, 70);
    });

    els.trackList.addEventListener('click', (event) => {
      const favorite = event.target.closest('[data-fav]');
      if (favorite) {
        event.stopPropagation();
        toggleFavorite(favorite.dataset.fav);
        return;
      }
      const row = event.target.closest('.track-row');
      if (row) {
        playTrack(row.dataset.id, true);
        openImmersive();
      }
    });

    els.trackList.addEventListener('keydown', (event) => {
      if (event.target.closest('button')) return;
      const row = event.target.closest('.track-row');
      if (!row) return;
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        event.stopPropagation();
        playTrack(row.dataset.id, true);
        openImmersive();
      }
    });

    els.waveWrap.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      state.draggingWave = true;
      els.waveWrap.setPointerCapture(event.pointerId);
      updateWaveFromPointer(event);
      seekFromPointer(event);
    });
    els.waveWrap.addEventListener('pointermove', (event) => {
      updateWaveFromPointer(event);
      if (state.draggingWave) seekFromPointer(event);
    });
    els.waveWrap.addEventListener('pointerup', (event) => {
      state.draggingWave = false;
      try { els.waveWrap.releasePointerCapture(event.pointerId); } catch (error) { /* ignore */ }
    });
    els.waveWrap.addEventListener('pointercancel', () => { state.draggingWave = false; });
    els.waveWrap.addEventListener('pointerleave', clearWaveHover);
    els.waveWrap.addEventListener('keydown', (event) => {
      if (event.key === 'ArrowLeft') { event.preventDefault(); event.stopPropagation(); seekBy(-5); }
      if (event.key === 'ArrowRight') { event.preventDefault(); event.stopPropagation(); seekBy(5); }
      if (event.key === 'Home') { event.preventDefault(); event.stopPropagation(); seekTo(0); }
      if (event.key === 'End') { event.preventDefault(); event.stopPropagation(); seekTo(getDuration()); }
    });

    els.menuBtn.addEventListener('click', openSidebar);
    els.sidebarClose.addEventListener('click', closeSidebar);
    els.sidebarScrim.addEventListener('click', closeSidebar);

    els.helpTop.addEventListener('click', openHelp);
    els.shortcutsBtn.addEventListener('click', openHelp);
    els.helpClose.addEventListener('click', closeHelp);
    els.helpDialog.addEventListener('click', (event) => {
      if (event.target === els.helpDialog) closeHelp();
    });

    els.immBack.addEventListener('click', closeImmersive);
    els.immPlay.addEventListener('click', togglePlay);
    els.immPrev.addEventListener('click', previousTrack);
    els.immNext.addEventListener('click', () => {
      const track = nextTrack();
      if (track) setTrack(track, true);
    });
    els.immFav.addEventListener('click', () => {
      if (state.currentId) toggleFavorite(state.currentId);
    });
    els.immRetryLyrics.addEventListener('click', retryLyrics);
    els.immOpenFolder.addEventListener('click', () => openFolder(trackFolder()));
    els.immSeek.addEventListener('input', () => {
      const duration = getDuration();
      if (!duration) return;
      els.audio.currentTime = clamp((Number(els.immSeek.value) / 1000) * duration, 0, duration);
      updateTimeUI();
    });
    els.immLyricsList.addEventListener('click', (event) => {
      const line = event.target.closest('[data-time]');
      if (!line) return;
      const time = Number(line.dataset.time);
      if (!Number.isFinite(time)) return;
      seekTo(time);
      if (els.audio.paused) playAudio();
    });
    const pauseLyricFollow = () => {
      state.lyrics.userScrollUntil = Date.now() + 4500;
    };
    els.immLyricsScroll.addEventListener('wheel', pauseLyricFollow, { passive: true });
    els.immLyricsScroll.addEventListener('touchstart', pauseLyricFollow, { passive: true });

    window.addEventListener('resize', () => {
      drawWave();
      drawVisualizer(performance.now());
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) updateTimeUI();
    });

    document.addEventListener('keydown', (event) => {
      const target = event.target;
      const typing = target && (
        target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable
      );

      if (event.key === 'Escape') {
        if (els.helpDialog.open) {
          closeHelp();
          return;
        }
        if (isImmersiveOpen()) {
          closeImmersive();
          return;
        }
        if (typing) {
          target.blur();
          return;
        }
        closeSidebar();
        return;
      }

      if (els.helpDialog.open) return;

      if (typing) return;
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (isImmersiveOpen() && (event.key === '/' || event.key === '?')) return;

      if (event.key === '/') {
        event.preventDefault();
        els.searchInput.focus();
        els.searchInput.select();
        return;
      }
      if (event.key === '?') {
        event.preventDefault();
        openHelp();
        return;
      }
      if (event.key === ' ' || event.key === 'Enter') {
        if (target.closest && target.closest('button, [role="button"], a')) return;
        event.preventDefault();
        togglePlay();
        return;
      }
      if (event.key === 'ArrowRight') { event.preventDefault(); seekBy(5); return; }
      if (event.key === 'ArrowLeft') { event.preventDefault(); seekBy(-5); return; }
      if (event.key === 'ArrowUp') { event.preventDefault(); setVolume(state.volume + 0.05); return; }
      if (event.key === 'ArrowDown') { event.preventDefault(); setVolume(state.volume - 0.05); return; }

      const key = event.key.toLowerCase();
      if (key === 'm') { event.preventDefault(); toggleMute(); }
      else if (key === 's') { event.preventDefault(); toggleShuffle(); }
      else if (key === 'r') { event.preventDefault(); cycleRepeat(); }
      else if (key === 'f') {
        event.preventDefault();
        if (state.currentId) toggleFavorite(state.currentId);
      } else if (key === 'n') {
        event.preventDefault();
        const track = nextTrack();
        if (track) setTrack(track, true);
      } else if (key === 'p') {
        event.preventDefault();
        previousTrack();
      }
    });
  }

  function applyStoredSettingsToUI() {
    els.audio.volume = state.volume;
    els.audio.muted = state.muted;
    els.audio.playbackRate = state.speed;
    els.shuffleBtn.classList.toggle('is-active', state.shuffle);
    els.shuffleBtn.setAttribute('aria-pressed', String(state.shuffle));
    els.shuffleBtn.title = `随机播放：${state.shuffle ? '开' : '关'} (S)`;
    els.repeatBtn.classList.toggle('is-active', state.repeat !== 'off');
    els.repeatBtn.classList.toggle('repeat-mode-one', state.repeat === 'one');
    els.repeatBtn.setAttribute('aria-pressed', String(state.repeat !== 'off'));
    const repeatLabel = { off: '关闭', all: '列表循环', one: '单曲循环' }[state.repeat];
    els.repeatBtn.setAttribute('aria-label', `循环模式：${repeatLabel}`);
    els.repeatBtn.title = `循环模式：${repeatLabel} (R)`;
    els.speedBtn.textContent = `${speedLabel(state.speed)}×`;
    updateVolumeUI();
  }

  async function init() {
    loadStoredState();
    applyStoredSettingsToUI();
    bindEvents();
    setupMediaSession();
    els.body.classList.add('is-paused');

    await syncLibrary();
    updateViewHeading();
    updateNavState();

    if (state.tracks.length) {
      let savedId = null;
      try { savedId = localStorage.getItem(LAST_TRACK_KEY); } catch (error) { /* ignore */ }
      const track = state.tracks.find((item) => item.id === savedId) || state.tracks[0];
      setTrack(track, false);
    } else {
      resetTrackUI();
      renderTrackList();
    }

    window.requestAnimationFrame(animationLoop);
    window.setInterval(() => {
      if (!document.hidden) syncLibrary({ auto: true });
    }, 20000);
  }

  init().catch((error) => {
    console.error(error);
    showToast('播放器界面初始化失败，请刷新页面');
  });
})();
