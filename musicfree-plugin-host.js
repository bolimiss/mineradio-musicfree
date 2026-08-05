'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Module = require('module');
const { PluginAdapter } = require('./musicfree-runtime/plugin-adapter');
const { createUnifiedTrack, toLegacySong } = require('./musicfree-runtime/unified-track');
const { IsolatedPluginRuntime, IsolatedPluginAdapter } = require('./musicfree-runtime/plugin-runtime');
const { readZipEntries, pluginCandidates } = require('./musicfree-runtime/zip-reader');
const { mergeTrackMetadata, needsMetadata } = require('./musicfree-runtime/metadata-resolver');

const DEFAULT_MANIFEST_URL = '';
const MAX_REMOTE_BYTES = 2 * 1024 * 1024;
const MAX_PLAYLIST_RESPONSE_BYTES = 16 * 1024 * 1024;
const AUDIO_TOKEN_TTL_MS = 60 * 60 * 1000;
const MEDIA_RESOLVE_CACHE_TTL_MS = 10 * 60 * 1000;
const LYRIC_RESOLVE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const LYRIC_RESOLVE_MISS_TTL_MS = 2 * 60 * 1000;
const BUILTIN_MUSICFREE_PLUGIN_IDS = new Set([
  'fc5e358ae7194be687c3',
  'd66050298bf36616023a',
  '5841cebc3ceea97b0590',
  'c0a21b16ea0c6c290336',
  'dea0a4b3f3697456bdef',
]);

function safeId(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex').slice(0, 20);
}

function jsonClone(value) {
  try { return JSON.parse(JSON.stringify(value)); }
  catch (_) { return null; }
}

function balancedJsonValue(text, marker) {
  const source = String(text || '');
  const markerIndex = source.indexOf(marker);
  if (markerIndex < 0) return null;
  let start = markerIndex + marker.length;
  while (start < source.length && /[\s=]/.test(source[start])) start += 1;
  if (source[start] !== '{' && source[start] !== '[') return null;
  const open = source[start];
  const close = open === '{' ? '}' : ']';
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      continue;
    }
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (!depth) {
        try { return JSON.parse(source.slice(start, index + 1)); }
        catch (_) { return null; }
      }
    }
  }
  return null;
}

function secureKugouImage(value, size = 400) {
  return String(value || '')
    .replace('{size}', String(size))
    .replace(/^http:\/\//i, 'https://');
}

function splitKugouFilename(value) {
  const filename = String(value || '').trim();
  const separator = filename.indexOf(' - ');
  if (separator < 0) return { artist: '', name: filename };
  return {
    artist: filename.slice(0, separator).trim(),
    name: filename.slice(separator + 3).trim(),
  };
}

function firstHttpUrl(value) {
  const match = String(value || '').match(/https?:\/\/[^\s<>"'，。；;]+/i);
  return match ? match[0].replace(/[)\]}]+$/, '') : '';
}

function normalizePluginExport(value) {
  if (value && value.default && typeof value.default === 'object') return value.default;
  return value;
}

const MUSICFREE_CAPABILITY_METHODS = [
  'search', 'getMediaSource', 'getMusicInfo', 'getLyric', 'getAlbumInfo',
  'getArtistWorks', 'getMusicSheetInfo', 'importMusicSheet',
  'getRecommendSheetTags', 'getRecommendSheetsByTag',
  'getTopLists', 'getTopListDetail', 'getComments', 'getSuggest'
];

function musicFreeResultItems(result) {
  if (Array.isArray(result)) return result;
  if (!result || typeof result !== 'object') return [];
  for (const key of ['musicList', 'data', 'items', 'list', 'songs', 'tracks', 'results']) {
    if (Array.isArray(result[key])) return result[key];
    if (result[key] && typeof result[key] === 'object') {
      const nested = musicFreeResultItems(result[key]);
      if (nested.length) return nested;
    }
  }
  return [];
}

function musicFreeCatalogEntries(value, output = [], seen = new Set()) {
  if (!value || output.length >= 80 || seen.has(value)) return output;
  if (typeof value === 'object') seen.add(value);
  if (Array.isArray(value)) {
    value.forEach(item => musicFreeCatalogEntries(item, output, seen));
    return output;
  }
  if (typeof value !== 'object') return output;
  if (value.id != null && (value.title || value.name)) output.push(value);
  for (const key of ['data', 'items', 'list', 'children', 'content']) {
    if (value[key]) musicFreeCatalogEntries(value[key], output, seen);
  }
  return output;
}

function normalizePluginModuleSource(source) {
  let text = String(source || '').replace(/^\uFEFF/, '');
  const exportObject = text.lastIndexOf('module.exports');
  if (exportObject >= 0) {
    const braceStart = text.indexOf('{', exportObject);
    if (braceStart >= 0) {
      let depth = 0;
      let quote = '';
      let escaped = false;
      for (let index = braceStart; index < text.length; index += 1) {
        const char = text[index];
        if (quote) {
          if (escaped) escaped = false;
          else if (char === '\\') escaped = true;
          else if (char === quote) quote = '';
          continue;
        }
        if (char === '"' || char === "'" || char === '`') { quote = char; continue; }
        if (char === '{') depth += 1;
        else if (char === '}' && --depth === 0) {
          const tail = text.slice(index + 1);
          if (/^\s*;/.test(tail) && /\S/.test(tail.replace(/^\s*;/, ''))) text = text.slice(0, index + 1) + ';';
          break;
        }
      }
    }
  }
  if (!/\bexport\s+default\b/.test(text)) return text;
  if (/^\s*import\s/m.test(text)) {
    throw new Error('ESM 音源包含 import 语句，请导入编译后的 MusicFree CommonJS 插件');
  }
  text = text.replace(/\bexport\s+default\s+(?=\{)/, 'module.exports = ');
  text = text.replace(/\bexport\s+default\s+([A-Za-z_$][\w$]*)\s*;?\s*$/, 'module.exports = $1;');
  return text;
}

function normalizeQuality(value) {
  const quality = String(value || '').toLowerCase();
  if (quality === 'standard' || quality === 'low') return quality;
  if (quality === 'exhigh' || quality === 'high') return 'high';
  if (quality === 'lossless' || quality === 'hires' || quality === 'jymaster' || quality === 'super') return 'super';
  return 'standard';
}

const MUSICFREE_QUALITY_ORDER = ['super', 'high', 'standard', 'low'];

function musicFreeQualityKey(value) {
  const quality = String(value == null ? '' : value).trim().toLowerCase().replace(/[\s_-]+/g, '');
  if (!quality) return '';
  if (/^(super|lossless|hires|jymaster|flac|sq|master|ultra|ape|wav)$/.test(quality)) return 'super';
  if (/^(high|exhigh|hq|320|320k|320kbps)$/.test(quality)) return 'high';
  if (/^(standard|normal|medium|std|192|192k|192kbps)$/.test(quality)) return 'standard';
  if (/^(low|128|128k|128kbps|96|96k|96kbps|64|64k|64kbps)$/.test(quality)) return 'low';
  return '';
}

function musicFreeQualityPayloadAvailable(value) {
  if (value === true) return true;
  if (value == null || value === false) return false;
  if (typeof value === 'number') return value > 0;
  if (typeof value === 'string') return value.trim() !== '' && value !== '0';
  if (typeof value !== 'object') return false;
  if (value.available === false || value.playable === false || value.disabled === true) return false;
  if (value.available === true || value.playable === true) return true;
  if (String(value.url || value.src || '').trim()) return true;
  const metrics = ['size', 'br', 'bitrate', 'bitRate', 'kbps'];
  let sawMetric = false;
  for (const key of metrics) {
    if (value[key] == null) continue;
    sawMetric = true;
    if (Number(value[key]) > 0) return true;
  }
  if (sawMetric) return false;
  // In the MusicFree schema an explicitly declared level may use an empty
  // object as its capability marker. Only an explicit false/zero metric means
  // unavailable.
  return true;
}

function musicFreeAvailableQualities(item) {
  item = item && typeof item === 'object' ? item : {};
  const found = new Set();
  const containers = [item.qualities, item.quality, item.qualitys, item.availableQualities, item.qualityList, item.levels];
  let hasDeclaration = false;
  for (const container of containers) {
    if (!container) continue;
    hasDeclaration = true;
    if (Array.isArray(container)) {
      for (const entry of container) {
        const key = musicFreeQualityKey(entry && typeof entry === 'object' ? (entry.key || entry.level || entry.quality || entry.name) : entry);
        if (key && musicFreeQualityPayloadAvailable(entry && typeof entry === 'object' ? entry : true)) found.add(key);
      }
      continue;
    }
    if (typeof container === 'string') {
      container.split(/[,|/\s]+/).forEach(value => { const key = musicFreeQualityKey(value); if (key) found.add(key); });
      continue;
    }
    if (typeof container === 'object') {
      for (const [rawKey, payload] of Object.entries(container)) {
        const key = musicFreeQualityKey(rawKey) || musicFreeQualityKey(payload && (payload.key || payload.level || payload.quality || payload.name));
        if (key && musicFreeQualityPayloadAvailable(payload)) found.add(key);
      }
    }
  }
  const directLevel = musicFreeQualityKey(item.level || item.qualityLevel || item.qualityName);
  if (directLevel && (item.url || item.src)) found.add(directLevel);
  return { known: hasDeclaration || !!directLevel, levels: MUSICFREE_QUALITY_ORDER.filter(level => found.has(level)) };
}

function musicFreeQualityPlan(item) {
  const available = musicFreeAvailableQualities(item);
  return {
    known: available.known,
    levels: available.levels.length ? available.levels : MUSICFREE_QUALITY_ORDER.slice(),
  };
}

function lyricText(value) {
  if (typeof value === 'string') return value.replace(/^\uFEFF/, '');
  if (!value || typeof value !== 'object') return '';
  const nested = value.data && typeof value.data === 'object' ? value.data : {};
  return String(
    value.rawLrc || value.lyric || value.lrc || value.rawLyric || value.content ||
    nested.rawLrc || nested.lyric || nested.lrc || nested.content || ''
  ).replace(/^\uFEFF/, '');
}

function translationText(value) {
  if (!value || typeof value !== 'object') return '';
  const nested = value.data && typeof value.data === 'object' ? value.data : {};
  return String(
    value.translation || value.trans || value.tlyric || value.translatedLyric ||
    nested.translation || nested.trans || nested.tlyric || ''
  ).replace(/^\uFEFF/, '');
}

function cleanLyricBody(value) {
  const text = String(value || '')
    .replace(/^\uFEFF/, '')
    .replace(/\u0000/g, '')
    .replace(/\r\n?/g, '\n')
    .trim();
  // Some MusicFree plugins (notably Kuwo variants) return [seconds.fraction]
  // while Mineradio consumes standard [mm:ss.xxx] LRC timestamps.
  return text.replace(/^\s*\[(\d{1,5})(?:\.(\d{1,9}))\]/gm, (_, secondsText, fractionText) => {
    const totalMs = Number(secondsText) * 1000 + Number(String(fractionText || '').padEnd(3, '0').slice(0, 3));
    const minutes = Math.floor(totalMs / 60000);
    const seconds = Math.floor((totalMs % 60000) / 1000);
    const millis = totalMs % 1000;
    return '[' + String(minutes).padStart(2, '0') + ':' + String(seconds).padStart(2, '0') + '.' + String(millis).padStart(3, '0') + ']';
  });
}

function usableLyricBody(value) {
  const text = cleanLyricBody(value);
  if (!text || text.length < 8) return false;
  if ((text.match(/\uFFFD/g) || []).length > Math.max(2, text.length * 0.015)) return false;
  if (/^\s*[<{[]/.test(text) && /(?:error|message|status|code|html|doctype)/i.test(text.slice(0, 240))) return false;
  if (/<(?:html|body|script|title|!doctype)\b/i.test(text)) return false;
  if (/^(?:error|failed|undefined|null|not found|no lyric|暂无歌词|纯音乐|歌词获取失败|接口异常|请求失败)[\s\W]*$/i.test(text)) return false;
  const timedLines = (text.match(/^\s*\[(?:\d{1,3}:)?\d{1,2}[.:]\d{1,3}]/gm) || []).length;
  const plainLines = text.split('\n').filter(line => line.replace(/\[[^\]]*]/g, '').trim().length >= 2).length;
  return timedLines > 0 || (plainLines >= 2 && text.replace(/\s/g, '').length >= 18);
}

function lyricIdentityText(value) {
  if (Array.isArray(value)) return value.map(lyricIdentityText).filter(Boolean).join('/');
  if (value && typeof value === 'object') return lyricIdentityText(value.name || value.title || value.artist || value.singer || '');
  return String(value || '');
}

function lyricIdentityKey(value) {
  return lyricIdentityText(value).toLowerCase().replace(/[\s\u00b7\u30fb,，.。'"“”‘’()（）[\]【】<>《》_\-]+/g, '');
}

function lyricSongIdentity(song) {
  song = song || {};
  const item = song.musicFreeItem && typeof song.musicFreeItem === 'object' ? song.musicFreeItem : song;
  return {
    title: lyricIdentityText(song.name || song.title || item.title || item.name),
    artist: lyricIdentityText(song.artist || song.singer || item.artist || item.singer || item.artists),
    duration: lyricDurationSeconds(song) || lyricDurationSeconds(item),
  };
}

function lyricDurationSeconds(value) {
  value = value || {};
  let duration = Number(value.duration || value.dt || value.interval || value.time || value.timelength || 0);
  if (!Number.isFinite(duration) || duration <= 0) return 0;
  if (duration > 10000) duration /= 1000;
  return duration >= 8 && duration <= 24 * 60 * 60 ? duration : 0;
}

function lyricTimelineLastSeconds(value) {
  const text = cleanLyricBody(value);
  let last = 0;
  const standard = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?]/g;
  let match = null;
  while ((match = standard.exec(text))) {
    const fraction = match[3] ? Number(match[3]) / Math.pow(10, Math.min(3, match[3].length)) : 0;
    last = Math.max(last, Number(match[1]) * 60 + Number(match[2]) + fraction);
  }
  const karaoke = /^\[(\d+),(\d+)]/gm;
  while ((match = karaoke.exec(text))) last = Math.max(last, (Number(match[1]) + Number(match[2])) / 1000);
  return last;
}

function lyricDurationCompatibilityScore(candidateSeconds, wantedSeconds) {
  candidateSeconds = Number(candidateSeconds) || 0;
  wantedSeconds = Number(wantedSeconds) || 0;
  if (!candidateSeconds || !wantedSeconds) return 0;
  const delta = Math.abs(candidateSeconds - wantedSeconds);
  if (delta <= 2.5) return 46;
  if (delta <= 6) return 28;
  if (delta <= 12) return 8;
  if (delta <= 20) return -24;
  return delta >= 45 ? -115 : -62;
}

function lyricTimelineCompatibilityScore(body, wantedSeconds) {
  wantedSeconds = Number(wantedSeconds) || 0;
  const last = lyricTimelineLastSeconds(body);
  if (!wantedSeconds || !last) return 0;
  if (last > wantedSeconds + 18) return -130;
  if (last < wantedSeconds * 0.42) return -85;
  const outro = wantedSeconds - last;
  if (outro >= -4 && outro <= 34) return 32;
  return outro <= 55 ? 10 : -26;
}

function lyricCandidateMatchScore(candidate, wanted) {
  const current = lyricSongIdentity(candidate);
  const title = lyricIdentityKey(current.title);
  const artist = lyricIdentityKey(current.artist);
  const wantedTitle = lyricIdentityKey(wanted && wanted.title);
  const wantedArtist = lyricIdentityKey(wanted && wanted.artist);
  let score = 0;
  if (title && wantedTitle) score += title === wantedTitle ? 120 : (title.includes(wantedTitle) || wantedTitle.includes(title) ? 68 : -90);
  if (artist && wantedArtist) score += artist === wantedArtist ? 55 : (artist.includes(wantedArtist) || wantedArtist.includes(artist) ? 30 : -25);
  score += lyricDurationCompatibilityScore(current.duration, wanted && wanted.duration);
  return score;
}

function lyricBodyScore(value) {
  const text = cleanLyricBody(value);
  const timedLines = (text.match(/^\s*\[(?:\d{1,3}:)?\d{1,2}[.:]\d{1,3}]/gm) || []).length;
  return Math.min(80, timedLines * 3) + Math.min(25, Math.floor(text.length / 180));
}

function timedPluginCall(factory, timeoutMs) {
  let timer = null;
  return Promise.race([
    Promise.resolve().then(factory),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('PLUGIN_CALL_TIMEOUT')), timeoutMs || 10000); }),
  ]).finally(() => { if (timer) clearTimeout(timer); });
}

class MusicFreePluginHost {
  constructor(options = {}) {
    this.appRoot = options.appRoot || __dirname;
    this.pluginDir = options.pluginDir || path.join(
      process.env.APPDATA || path.join(process.cwd(), 'data'),
      'Mineradio',
      'musicfree-plugins'
    );
    this.registryFile = path.join(this.pluginDir, 'registry.json');
    this.settingsFile = path.join(this.pluginDir, 'settings.json');
    this.defaultManifestUrl = options.defaultManifestUrl || DEFAULT_MANIFEST_URL;
    this.appVersion = String(options.appVersion || '');
    this.registry = [];
    this.plugins = new Map();
    this.audioTokens = new Map();
    this.videoTokens = new Map();
    this.mediaResolveCache = new Map();
    this.mediaResolvePending = new Map();
    this.lyricResolveCache = new Map();
    this.lyricResolvePending = new Map();
    this.settings = this.readSettings();
    fs.mkdirSync(this.pluginDir, { recursive: true });
    this.ready = this.initialize();
  }

  readRegistry() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.registryFile, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }

  readSettings() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.settingsFile, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (_) {
      return {};
    }
  }

  writeSettings() {
    const temp = this.settingsFile + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(this.settings, null, 2), 'utf8');
    fs.renameSync(temp, this.settingsFile);
  }

  writeRegistry() {
    const temp = this.registryFile + '.tmp';
    fs.writeFileSync(temp, JSON.stringify(this.registry, null, 2), 'utf8');
    fs.renameSync(temp, this.registryFile);
  }

  async initialize() {
    this.registry = this.readRegistry();
    await this.reload();
    const hasDefault = this.registry.some(item => item && item.manifestUrl === this.defaultManifestUrl);
    if (this.defaultManifestUrl && !hasDefault && this.settings.defaultManifestDismissed !== true) {
      try { await this.importNetwork(this.defaultManifestUrl, { automatic: true }); }
      catch (error) { console.warn('[MusicFree] default manifest import failed:', error.message); }
    }
    return this.list();
  }

  moduleFromSource(source, filename) {
    const mod = new Module(filename, module.parent);
    mod.filename = filename;
    mod.paths = Module._nodeModulePaths(path.dirname(filename));
    const bundledModules = path.join(this.appRoot, 'node_modules');
    if (!mod.paths.includes(bundledModules)) mod.paths.unshift(bundledModules);
    mod._compile(normalizePluginModuleSource(source), filename);
    const plugin = normalizePluginExport(mod.exports);
    const adapter = new PluginAdapter(plugin, { filename });
    if (!String(adapter.metadata.platform || '').trim()) throw new Error('插件缺少 platform 字段');
    return plugin;
  }

  async createRuntime(entry, source, filename) {
    const isolated = new IsolatedPluginRuntime({
      source,
      filename,
      appRoot: this.appRoot,
      appVersion: this.appVersion,
      metadata: {
        id: entry.id,
        label: entry.label || entry.id,
        platform: entry.platform || entry.label || entry.id,
        version: entry.version || '0.0.0',
      },
      userVariables: this.settings.pluginVariables && this.settings.pluginVariables[entry.id] || {},
    });
    await isolated.ready;
    const adapter = new IsolatedPluginAdapter(isolated);
    return {
      id: entry.id,
      entry,
      plugin: {
        platform: isolated.metadata.platform,
        version: isolated.metadata.version,
        author: isolated.metadata.author,
        supportedSearchType: isolated.supportedSearchType,
        userVariables: isolated.userVariables,
        fallbackPolicy: isolated.fallbackPolicy,
        qualityPolicy: isolated.qualityPolicy,
      },
      adapter,
      isolated,
      label: String(entry.label || isolated.metadata.platform || entry.id),
      platform: String(isolated.metadata.platform || entry.label || entry.id),
      version: String(isolated.metadata.version || entry.version || '0.0.0'),
      author: String(isolated.metadata.author || ''),
      fallbackPolicy: String(isolated.fallbackPolicy || ''),
      qualityPolicy: String(isolated.qualityPolicy || ''),
    };
  }

  async loadEntry(entry) {
    const filename = path.join(this.pluginDir, entry.file);
    const source = fs.readFileSync(filename, 'utf8');
    const runtime = await this.createRuntime(entry, source, filename);
    this.plugins.set(entry.id, runtime);
    return runtime;
  }

  async reload() {
    const previous = Array.from(this.plugins.values());
    this.plugins.clear();
    this.mediaResolveCache.clear();
    this.mediaResolvePending.clear();
    this.lyricResolveCache.clear();
    this.lyricResolvePending.clear();
    await Promise.allSettled(previous.map(runtime => runtime.isolated && runtime.isolated.close()));
    const failures = [];
    for (const entry of this.registry) {
      if (!entry || entry.enabled === false || !entry.file) continue;
      try { await this.loadEntry(entry); }
      catch (error) {
        failures.push({ id: entry.id, label: entry.label || entry.id, error: error.message });
        console.warn('[MusicFree] plugin load failed:', entry.file, error.message);
      }
    }
    return { plugins: this.list(), failures };
  }

  list() {
    return this.registry.map(entry => {
      const runtime = this.plugins.get(entry.id);
      const supportedSearchTypes = runtime && Array.isArray(runtime.plugin.supportedSearchType)
        ? runtime.plugin.supportedSearchType.map(value => String(value).toLowerCase()) : [];
      const supportsMusicSearch = !!(runtime && runtime.adapter.has('search') &&
        (!supportedSearchTypes.length || supportedSearchTypes.includes('music')));
      const requiresConfiguration = !!(runtime && Array.isArray(runtime.plugin.userVariables) && runtime.plugin.userVariables.length);
      const variableDefinitions = requiresConfiguration ? runtime.plugin.userVariables : [];
      const savedVariables = this.settings.pluginVariables && this.settings.pluginVariables[entry.id] || {};
      const configured = !requiresConfiguration || variableDefinitions.every(variable => {
        const key = String(variable && (variable.key || variable.name || variable.id) || '');
        const hasDefault = variable && variable.defaultValue != null && String(variable.defaultValue) !== '';
        return !key || hasDefault || (savedVariables[key] != null && String(savedVariables[key]) !== '');
      });
      return {
        id: entry.id,
        builtIn: entry.builtIn === true || BUILTIN_MUSICFREE_PLUGIN_IDS.has(String(entry.id || '')),
        label: runtime ? runtime.label : String(entry.label || entry.id),
        platform: runtime ? runtime.platform : String(entry.platform || entry.label || ''),
        version: runtime ? runtime.version : String(entry.version || '0.0.0'),
        author: runtime ? runtime.author : '',
        url: entry.url || '',
        manifestUrl: entry.manifestUrl || '',
        installedAt: Number(entry.installedAt || 0),
        updatedAt: Number(entry.updatedAt || entry.installedAt || 0),
        local: entry.kind === 'local',
        enabled: entry.enabled !== false,
        loaded: !!runtime,
        searchable: supportsMusicSearch,
        playable: !!(runtime && runtime.adapter.has('getMediaSource')),
        lyric: !!(runtime && runtime.adapter.has('getLyric')),
        browsable: !!(runtime && (runtime.adapter.has('getTopLists') || runtime.adapter.has('getRecommendSheetsByTag') || runtime.adapter.has('getMusicSheetInfo'))),
        requiresConfiguration,
        configured,
        configurationFields: variableDefinitions.map(variable => {
          const key = String(variable && (variable.key || variable.name || variable.id) || '');
          return {
            key,
            name: String(variable && (variable.name || variable.label || key) || key),
            type: String(variable && variable.type || 'text'),
            description: String(variable && (variable.description || variable.desc) || ''),
            hasValue: !!(key && savedVariables[key] != null && String(savedVariables[key]) !== ''),
          };
        }),
        capabilities: runtime ? runtime.adapter.capabilities() : [],
        runtimeStatus: runtime && runtime.isolated ? runtime.isolated.status : (runtime ? 'legacy' : 'unloaded'),
        runtimeFailures: runtime && runtime.isolated ? runtime.isolated.failures : 0,
        lastError: runtime && runtime.isolated ? runtime.isolated.lastError : null,
        methodMap: runtime && runtime.adapter ? Object.fromEntries(runtime.adapter.capabilities().map(capability => [capability, runtime.adapter.methodName(capability)])) : {},
      };
    });
  }

  async fetchText(url) {
    let target = firstHttpUrl(url) || String(url || '').trim();
    if (!/^https?:\/\//i.test(target)) throw new Error('只支持 http/https 地址');
    try {
      const parsed = new URL(target);
      if (parsed.hostname.toLowerCase() === 'github.com') {
        const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/(?:blob|raw)\/([^/]+)\/(.+)$/);
        if (match) target = 'https://raw.githubusercontent.com/' + [match[1], match[2], match[3]].map(encodeURIComponent).join('/') + '/' + match[4].split('/').map(encodeURIComponent).join('/');
      } else if (parsed.hostname.toLowerCase() === 'gist.github.com') {
        const match = parsed.pathname.match(/^\/([^/]+)\/([a-f0-9]+)(?:\/.*)?$/i);
        if (match) target = 'https://gist.githubusercontent.com/' + match[1] + '/' + match[2] + '/raw';
      } else if (/^(?:www\.)?gitee\.com$/i.test(parsed.hostname) && /\/blob\//.test(parsed.pathname)) {
        parsed.pathname = parsed.pathname.replace('/blob/', '/raw/');
        target = parsed.toString();
      } else if (/gitlab\.com$/i.test(parsed.hostname) && /\/-\/blob\//.test(parsed.pathname)) {
        parsed.pathname = parsed.pathname.replace('/-/blob/', '/-/raw/');
        target = parsed.toString();
      }
      if (parsed.hostname.toLowerCase() === 'raw.github.com') {
        parsed.hostname = 'raw.githubusercontent.com';
        target = parsed.toString();
      }
    } catch (_) {}
    let response = null;
    let lastError = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        response = await fetch(target, {
          redirect: 'follow',
          headers: { 'User-Agent': 'Mineradio/2.1 MusicFree Plugin Host', Accept: '*/*' },
          signal: AbortSignal.timeout(25000),
        });
        if (response.ok || response.status < 500) break;
        lastError = new Error('下载失败: HTTP ' + response.status);
      } catch (error) {
        lastError = error;
        response = null;
      }
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 320 + attempt * 420));
    }
    if (!response) throw lastError || new Error('音源地址请求失败');
    if (!response.ok) throw new Error('下载失败: HTTP ' + response.status);
    const length = Number(response.headers.get('content-length') || 0);
    if (length > MAX_REMOTE_BYTES) throw new Error('远程文件过大');
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > MAX_REMOTE_BYTES) throw new Error('远程文件过大');
    return text;
  }

  async fetchBuffer(url) {
    const target = firstHttpUrl(url) || String(url || '').trim();
    if (!/^https?:\/\//i.test(target)) throw new Error('只支持 http/https 地址');
    const response = await fetch(target, {
      redirect: 'follow',
      headers: { 'User-Agent': 'Mineradio/2.1 MusicFree Plugin Runtime', Accept: 'application/zip,application/octet-stream,*/*' },
      signal: AbortSignal.timeout(30000),
    });
    if (!response.ok) throw new Error('下载失败: HTTP ' + response.status);
    const declaredLength = Number(response.headers.get('content-length') || 0);
    if (declaredLength > MAX_PLAYLIST_RESPONSE_BYTES) throw new Error('压缩包过大');
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_PLAYLIST_RESPONSE_BYTES) throw new Error('压缩包过大');
    return buffer;
  }

  async importZipBuffer(buffer, meta = {}) {
    const entries = readZipEntries(buffer);
    const candidates = pluginCandidates(entries);
    const imported = [];
    const failures = [];
    for (const entry of candidates.scripts) {
      try {
        imported.push(await this.savePlugin(entry.data.toString('utf8'), {
          kind: meta.kind,
          filename: String(meta.filename || 'plugin.zip') + '#' + entry.name,
          url: meta.url ? String(meta.url).replace(/#.*$/, '') + '#entry=' + encodeURIComponent(entry.name) : '',
          manifestUrl: meta.manifestUrl || meta.url || '',
          label: '',
        }));
      } catch (error) {
        failures.push({ entry: entry.name, error: error && error.message || String(error) });
      }
    }
    if (!imported.length) {
      for (const entry of candidates.manifests) {
        let manifest = null;
        try { manifest = JSON.parse(entry.data.toString('utf8')); } catch (_) { continue; }
        for (const item of this.manifestEntries(manifest)) {
          const pluginUrl = this.resolvePluginUrl(this.manifestItemUrl(item), meta.url || '');
          if (!pluginUrl) continue;
          try {
            const source = await this.fetchText(pluginUrl);
            imported.push(await this.savePlugin(source, {
              kind: meta.kind,
              url: pluginUrl,
              manifestUrl: meta.url || String(meta.filename || 'plugin.zip'),
              label: this.manifestItemName(item),
              version: String(item && item.version || ''),
            }));
          } catch (error) {
            failures.push({ entry: entry.name, url: pluginUrl, error: error && error.message || String(error) });
          }
        }
      }
    }
    if (!imported.length) throw new Error(failures[0] && failures[0].error || 'ZIP 中没有可加载的 MusicFree 插件');
    return { kind: 'zip', imported, failures, plugins: this.list() };
  }

  qingMusicLines(manifest) {
    if (!manifest || typeof manifest !== 'object' || !Array.isArray(manifest.lines)) return [];
    return manifest.lines.filter(line => line && typeof line === 'object' &&
      String(line.id || '').trim() && (line.searchApi || line.detailApi || Array.isArray(line.levels)));
  }

  qingMusicProvider(line) {
    const id = String(line && line.id || '').trim().toLowerCase();
    const signature = [id, line && line.searchApi, line && line.detailApi].filter(Boolean).join(' ').toLowerCase();
    if (id === 'kw' || /fetchsearchmusic|fetchmusicdetail|\bkuwo\b/.test(signature)) return 'kuwo';
    if (id === 'kg' || /kgsearchmusic|kgmusicdetail|\bkugou\b/.test(signature)) return 'kugou';
    if (id === 'wy' || /wysearchmusic|wymusicdetail|netease/.test(signature)) return 'netease';
    if (id === 'tx' || id === 'qq' || /txsearchmusic|txmusicdetail|qqmusic/.test(signature)) return 'qq';
    if (id === 'mg' || /mgsearchmusic|mgmusicdetail|migu/.test(signature)) return 'migu';
    return '';
  }

  qingMusicRuntime(provider, sourceUrl = '') {
    const patterns = {
      netease: /网易|元力WY|netease|\bWY\b/i,
      qq: /(^|\s)qq($|\s)|元力QQ|\bQQ\b/i,
      kugou: /酷狗|酷gou|元力KG|kugou|\bKG\b/i,
      kuwo: /酷我|元力KW|kuwo|\bKW\b/i,
      migu: /咪咕|元力MG|migu|\bMG\b/i,
    };
    const match = patterns[provider];
    if (!match) return null;
    return Array.from(this.plugins.values()).find(runtime => {
      if (!runtime || !runtime.entry || runtime.entry.manifestUrl === sourceUrl) return false;
      if (!runtime.adapter.has('search') || !runtime.adapter.has('getMediaSource')) return false;
      return match.test(runtime.label + ' ' + runtime.platform);
    }) || null;
  }

  qingMusicAdapterUrl(provider) {
    const filenames = {
      netease: 'wy.js',
      kuwo: 'kw.js',
      kugou: 'kg.js',
      qq: 'qq.js',
      migu: 'xiaomi.js',
    };
    const filename = filenames[provider];
    if (!filename) return '';
    try { return new URL(filename, this.defaultManifestUrl).toString(); }
    catch (_) { return ''; }
  }

  async importQingMusicConfig(manifest, options = {}) {
    const lines = this.qingMusicLines(manifest);
    const sourceUrl = String(options.sourceUrl || '').trim();
    const filename = String(options.filename || 'music.json').trim();
    const kind = options.kind === 'local' ? 'local' : 'network';
    const manifestUrl = sourceUrl || ('local-qingmusic:' + filename);
    const imported = [];
    const failures = [];
    const skipped = [];
    for (const line of lines) {
      const label = String(line.name || line.id || 'QingMusic 音源').trim();
      if (line.enabled === false) {
        skipped.push({ id: String(line.id || ''), label, reason: '配置中已禁用' });
        continue;
      }
      const provider = this.qingMusicProvider(line);
      if (!provider) {
        failures.push({ label, error: '无法识别 QingMusic 线路平台：' + String(line.id || '') });
        continue;
      }
      try {
        const runtime = this.qingMusicRuntime(provider, sourceUrl);
        const adapterUrl = this.qingMusicAdapterUrl(provider);
        let pluginSource = '';
        let adapterVersion = String(line.version || 'qing-adapter');
        if (runtime && runtime.entry && runtime.entry.file) {
          pluginSource = fs.readFileSync(path.join(this.pluginDir, runtime.entry.file), 'utf8');
          adapterVersion = String(runtime.version || adapterVersion);
        } else if (adapterUrl) {
          pluginSource = await this.fetchText(adapterUrl);
        }
        if (!pluginSource.trim()) {
          throw new Error('缺少可执行的 ' + provider + ' MusicFree 适配器；该 JSON 只有函数名称，没有插件代码');
        }
        const meta = {
          kind,
          manifestUrl,
          label,
          version: adapterVersion,
        };
        if (kind === 'network') meta.url = sourceUrl + '#line=' + encodeURIComponent(String(line.id || provider));
        else meta.filename = filename + '#' + String(line.id || provider);
        imported.push(await this.savePlugin(pluginSource, meta));
      } catch (error) {
        failures.push({ label, error: error && error.message || String(error) });
      }
    }
    if (!imported.length) {
      const detail = failures[0] && failures[0].error || 'QingMusic 配置中没有启用且可适配的线路';
      throw new Error(detail);
    }
    return { kind: 'qingmusic', imported, failures, skipped, plugins: this.list() };
  }

  manifestEntries(manifest) {
    if (Array.isArray(manifest)) return manifest;
    if (!manifest || typeof manifest !== 'object') return [];
    for (const key of ['plugins', 'pluginList', 'sources', 'musicSources', 'items', 'data']) {
      if (Array.isArray(manifest[key])) return manifest[key];
      if (manifest[key] && typeof manifest[key] === 'object') {
        const nested = this.manifestEntries(manifest[key]);
        if (nested.length) return nested;
        const values = Object.values(manifest[key]).filter(item => typeof item === 'string' || (item && typeof item === 'object'));
        if (values.some(item => this.manifestItemUrl(item))) return values;
      }
    }
    if (this.manifestItemUrl(manifest)) return [manifest];
    return [];
  }

  manifestItemUrl(item) {
    if (typeof item === 'string') return item.trim();
    if (!item || typeof item !== 'object') return '';
    return String(item.url || item.src || item.pluginUrl || item.sourceUrl || item.script || item.downloadUrl || '').trim();
  }

  manifestItemName(item) {
    if (!item || typeof item !== 'object') return '';
    return String(item.name || item.title || item.label || item.platform || '').trim();
  }

  resolvePluginUrl(pluginUrl, manifestUrl) {
    let value = String(pluginUrl || '').trim();
    if (!value) return '';
    try { value = new URL(value, manifestUrl).toString(); } catch (_) {}
    return value;
  }

  async savePlugin(source, meta = {}) {
    const identity = meta.url || ('local:' + (meta.filename || '') + ':' + safeId(source));
    const id = safeId(identity);
    const file = id + '.js';
    const filename = path.join(this.pluginDir, file);
    const oldIndex = this.registry.findIndex(item => item && item.id === id);
    const previousEntry = oldIndex >= 0 ? this.registry[oldIndex] : null;
    const provisional = {
      id,
      file,
      label: String(meta.label || meta.filename || id).trim(),
      platform: '',
      version: String(meta.version || '0.0.0'),
    };
    const runtime = await this.createRuntime(provisional, String(source || ''), filename);
    const entry = {
      id,
      file,
      kind: meta.kind === 'local' ? 'local' : 'network',
      label: String(meta.label || runtime.platform || meta.filename || id).trim(),
      platform: String(runtime.platform || ''),
      version: String(runtime.version || meta.version || '0.0.0'),
      url: meta.url || '',
      manifestUrl: meta.manifestUrl || '',
      enabled: true,
      installedAt: Number(previousEntry && previousEntry.installedAt || Date.now()),
      updatedAt: Date.now(),
    };
    const temp = filename + '.tmp';
    fs.writeFileSync(temp, String(source || ''), 'utf8');
    fs.renameSync(temp, filename);
    if (oldIndex >= 0) this.registry[oldIndex] = entry;
    else this.registry.push(entry);
    this.writeRegistry();
    const previous = this.plugins.get(id);
    if (previous && previous.isolated) previous.isolated.close().catch(() => {});
    runtime.entry = entry;
    runtime.label = entry.label;
    this.plugins.set(id, runtime);
    return this.list().find(item => item.id === id);
  }

  async importNetwork(url, options = {}) {
    const sourceUrl = String(url || '').trim();
    if (/\.zip(?:[?#]|$)/i.test(sourceUrl)) {
      return this.importZipBuffer(await this.fetchBuffer(sourceUrl), { kind: 'network', url: sourceUrl, manifestUrl: sourceUrl });
    }
    const text = await this.fetchText(sourceUrl);
    let manifest = null;
    try { manifest = JSON.parse(text); } catch (_) { }
    if (this.qingMusicLines(manifest).length) {
      return await this.importQingMusicConfig(manifest, { kind: 'network', sourceUrl });
    }
    const manifestPlugins = this.manifestEntries(manifest);
    if (manifestPlugins.length) {
      if (sourceUrl === this.defaultManifestUrl && this.settings.defaultManifestDismissed) {
        this.settings.defaultManifestDismissed = false;
        this.writeSettings();
      }
      const imported = [];
      const failures = [];
      for (const item of manifestPlugins) {
        const pluginUrl = this.resolvePluginUrl(this.manifestItemUrl(item), sourceUrl);
        if (!pluginUrl) continue;
        try {
          const source = await this.fetchText(pluginUrl);
          imported.push(await this.savePlugin(source, {
            kind: 'network',
            url: pluginUrl,
            manifestUrl: sourceUrl,
            label: this.manifestItemName(item),
            version: String(item && item.version || ''),
          }));
        } catch (error) {
          failures.push({ url: pluginUrl, label: this.manifestItemName(item) || pluginUrl, error: error.message });
        }
      }
      if (!imported.length && failures.length) throw new Error(failures[0].error || '清单中没有可用插件');
      return { kind: 'manifest', automatic: !!options.automatic, imported, failures, plugins: this.list() };
    }
    const imported = await this.savePlugin(text, { kind: 'network', url: sourceUrl, label: options.label || '' });
    return { kind: 'plugin', imported: [imported], failures: [], plugins: this.list() };
  }

  async importLocal(source, filename, zipBase64 = '') {
    if (/\.zip$/i.test(String(filename || '')) || zipBase64) {
      let buffer = null;
      try { buffer = Buffer.from(String(zipBase64 || source || ''), 'base64'); }
      catch (_) { throw new Error('ZIP 数据无效'); }
      return this.importZipBuffer(buffer, { kind: 'local', filename: filename || 'plugin.zip' });
    }
    const text = String(source || '');
    if (!text.trim()) throw new Error('本地插件为空');
    let manifest = null;
    try { manifest = JSON.parse(text); } catch (_) { }
    if (this.qingMusicLines(manifest).length) {
      return await this.importQingMusicConfig(manifest, { kind: 'local', filename: filename || 'music.json' });
    }
    const manifestPlugins = this.manifestEntries(manifest);
    if (manifestPlugins.length) {
      const imported = [];
      const failures = [];
      const manifestId = 'local-manifest:' + String(filename || 'plugins.json');
      for (const item of manifestPlugins) {
        const pluginUrl = this.manifestItemUrl(item);
        if (!pluginUrl) continue;
        try {
          const pluginSource = await this.fetchText(pluginUrl);
          imported.push(await this.savePlugin(pluginSource, {
            kind: 'local', url: pluginUrl, manifestUrl: manifestId,
            label: this.manifestItemName(item), version: String(item && item.version || ''),
          }));
        } catch (error) {
          failures.push({ url: pluginUrl, label: this.manifestItemName(item) || pluginUrl, error: error.message });
        }
      }
      if (!imported.length) throw new Error(failures[0] && failures[0].error || '本地清单中没有可用插件');
      return { kind: 'manifest', imported, failures, plugins: this.list() };
    }
    const imported = await this.savePlugin(text, { kind: 'local', filename: filename || 'local-plugin.js' });
    return { imported: [imported], plugins: this.list() };
  }

  remove(id) {
    const index = this.registry.findIndex(item => item && item.id === id);
    if (index < 0) return false;
    const entry = this.registry[index];
    if (entry.builtIn === true || BUILTIN_MUSICFREE_PLUGIN_IDS.has(String(entry.id || ''))) return false;
    this.registry.splice(index, 1);
    const runtime = this.plugins.get(id);
    this.plugins.delete(id);
    if (runtime && runtime.isolated) runtime.isolated.close().catch(() => {});
    this.writeRegistry();
    try { fs.unlinkSync(path.join(this.pluginDir, entry.file)); } catch (_) { }
    return true;
  }

  async setPluginVariables(id, values = {}) {
    await this.ready;
    const entry = this.registry.find(item => item && item.id === String(id || ''));
    if (!entry) throw new Error('音源插件不存在');
    const runtime = this.plugins.get(entry.id);
    const definitions = runtime && Array.isArray(runtime.plugin.userVariables) ? runtime.plugin.userVariables : [];
    const allowedKeys = new Set(definitions.map(variable => String(variable && (variable.key || variable.name || variable.id) || '')).filter(Boolean));
    const sanitized = Object.assign({}, this.settings.pluginVariables && this.settings.pluginVariables[entry.id] || {});
    Object.keys(values && typeof values === 'object' ? values : {}).forEach(key => {
      if (!allowedKeys.size || allowedKeys.has(key)) {
        if (values[key] === null) delete sanitized[key];
        else if (String(values[key]) !== '') sanitized[key] = String(values[key]);
      }
    });
    if (!this.settings.pluginVariables || typeof this.settings.pluginVariables !== 'object') this.settings.pluginVariables = {};
    this.settings.pluginVariables[entry.id] = sanitized;
    this.writeSettings();
    if (runtime && runtime.isolated) await runtime.isolated.close().catch(() => {});
    this.plugins.delete(entry.id);
    await this.loadEntry(entry);
    return { ok: true, plugin: this.list().find(plugin => plugin.id === entry.id) };
  }

  groupEntries(group = {}) {
    const manifestUrl = String(group.manifestUrl || '').trim();
    const pluginId = String(group.pluginId || '').trim();
    if (manifestUrl) return this.registry.filter(entry => entry && entry.manifestUrl === manifestUrl);
    if (pluginId) return this.registry.filter(entry => entry && entry.id === pluginId);
    return [];
  }

  async setGroupEnabled(group, enabled) {
    const entries = this.groupEntries(group);
    if (!entries.length) return { ok: false, plugins: this.list() };
    for (const entry of entries) entry.enabled = enabled !== false;
    this.writeRegistry();
    await this.reload();
    return { ok: true, affected: entries.length, enabled: enabled !== false, plugins: this.list() };
  }

  async removeGroup(group) {
    const entries = this.groupEntries(group);
    if (!entries.length) return { ok: false, removed: 0, plugins: this.list() };
    if (entries.some(entry => entry && (entry.builtIn === true || BUILTIN_MUSICFREE_PLUGIN_IDS.has(String(entry.id || ''))))) {
      return { ok: false, error: 'BUILTIN_SOURCE_CANNOT_BE_REMOVED', removed: 0, plugins: this.list() };
    }
    const ids = new Set(entries.map(entry => entry.id));
    this.registry = this.registry.filter(entry => !entry || !ids.has(entry.id));
    for (const entry of entries) {
      this.plugins.delete(entry.id);
      try { fs.unlinkSync(path.join(this.pluginDir, entry.file)); } catch (_) { }
    }
    const manifestUrl = String(group && group.manifestUrl || '').trim();
    if (manifestUrl && manifestUrl === this.defaultManifestUrl) {
      this.settings.defaultManifestDismissed = true;
      this.writeSettings();
    }
    this.writeRegistry();
    return { ok: true, removed: entries.length, plugins: this.list() };
  }

  runtime(id) {
    const runtime = this.plugins.get(String(id || ''));
    if (!runtime) throw new Error('音源插件未加载或已删除');
    return runtime;
  }

  toMineradioSong(item, runtime) {
    const track = createUnifiedTrack(item, runtime);
    const legacy = toLegacySong(track);
    const detected = musicFreeAvailableQualities(item || {}).levels;
    if (detected.length) {
      track.quality.available = detected;
      legacy.quality = track.quality;
      legacy.musicFreeAvailableQualities = detected;
    }
    return legacy;
  }

  async search(query, page = 1, pluginId = '') {
    await this.ready;
    const runtimes = pluginId ? [this.runtime(pluginId)] : Array.from(this.plugins.values());
    const searchable = runtimes.filter(runtime => runtime.adapter.has('search') ||
      (runtime.adapter.has('getTopLists') && runtime.adapter.has('getTopListDetail')));
    const settled = await Promise.allSettled(searchable.map(async runtime => {
      let result = null;
      let data = [];
      if (runtime.adapter.has('search')) {
        const adapted = await timedPluginCall(() => runtime.adapter.search(String(query || ''), Math.max(1, Number(page) || 1), 'music'), 12000);
        result = adapted.raw;
        data = adapted.items;
      } else {
        const catalog = await timedPluginCall(() => runtime.adapter.call('getTopLists'), 12000);
        const entries = musicFreeCatalogEntries(catalog);
        const keyword = String(query || '').trim().toLowerCase();
        const preferred = entries.filter(item => String(item && (item.title || item.name) || '').toLowerCase().includes(keyword));
        const selected = (preferred.length ? preferred : entries).slice(0, preferred.length ? 3 : 2);
        const details = await Promise.allSettled(selected.map(item => timedPluginCall(() => runtime.adapter.call('getTopListDetail', item), 15000)));
        const rows = [];
        details.forEach(entry => { if (entry.status === 'fulfilled') rows.push(...musicFreeResultItems(entry.value)); });
        data = rows.filter(item => {
          if (!keyword || preferred.length) return true;
          return String(item && ((item.title || item.name || '') + ' ' + (item.artist || item.singer || ''))).toLowerCase().includes(keyword);
        });
        result = { isEnd: true };
      }
      return {
        runtime,
        songs: data.map(item => this.toMineradioSong(item, runtime)),
        isEnd: result && result.isEnd === true,
      };
    }));
    const songs = [];
    const failures = [];
    let hasMore = false;
    settled.forEach((entry, index) => {
      if (entry.status === 'fulfilled') {
        songs.push(...entry.value.songs);
        if (!entry.value.isEnd && entry.value.songs.length) hasMore = true;
      } else {
        failures.push({ id: searchable[index] && searchable[index].id, error: entry.reason && entry.reason.message || String(entry.reason) });
      }
    });
    return { songs, hasMore, failures };
  }

  async fetchImportText(url, accept = 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8', userAgent = '') {
    let lastError = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const response = await fetch(String(url || ''), {
          redirect: 'follow',
          headers: {
            'User-Agent': userAgent || 'Mozilla/5.0 (Linux; Android 13; Mobile) AppleWebKit/537.36 Chrome/126 Mobile Safari/537.36',
            Accept: accept,
          },
          signal: AbortSignal.timeout(25000),
        });
        if (!response.ok) throw new Error('平台链接请求失败（HTTP ' + response.status + '）');
        const body = await response.text();
        if (Buffer.byteLength(body) > MAX_PLAYLIST_RESPONSE_BYTES) throw new Error('平台返回内容过大，已停止导入');
        return { body, url: String(response.url || url), contentType: String(response.headers.get('content-type') || '') };
      } catch (error) {
        lastError = error;
        if (attempt === 0) await new Promise(resolve => setTimeout(resolve, 280));
      }
    }
    throw lastError || new Error('平台链接请求失败');
  }

  async kugouSpecialIdFromLink(link) {
    const text = String(link || '').trim();
    const direct = text.match(/\/plist\/list\/(\d+)/i) ||
      text.match(/\/special\/single\/(\d+)/i) ||
      text.match(/[?&](?:specialid|special_id|id)=(\d+)/i);
    if (direct) return { id: direct[1], share: null };
    const page = await this.fetchImportText(text);
    const output = balancedJsonValue(page.body, 'window.$output');
    const listInfo = output && output.info && output.info.listinfo;
    const specialId = String(listInfo && (listInfo.specialid || listInfo.specialId) || '');
    const embeddedSongs = Array.isArray(output && output.info && output.info.songs) ? output.info.songs : [];
    // New Kugou mobile/Android/iOS share links use an opaque gcid instead of
    // a numeric specialid. Their public share page already contains the full
    // playlist in window.$output; specialid is deliberately 0 in that format.
    if ((!/^\d+$/.test(specialId) || specialId === '0') && embeddedSongs.length) {
      return { id: '', share: output, embeddedSongs, resolvedUrl: page.url };
    }
    if (!/^\d+$/.test(specialId) || specialId === '0') throw new Error('酷狗分享页中没有找到可读取的歌单数据');
    return { id: specialId, share: output, embeddedSongs: [], resolvedUrl: page.url };
  }

  kugouImportedTrack(item, index) {
    item = item && typeof item === 'object' ? item : {};
    const parsed = splitKugouFilename(item.filename || item.audio_name || item.songname || '');
    const embeddedParsed = splitKugouFilename(item.name || '');
    const name = String(item.songname || item.song_name || parsed.name || embeddedParsed.name || '').trim();
    const artist = String(item.singername || item.author_name || parsed.artist || embeddedParsed.artist || '').trim();
    const albumAudioId = String(item.album_audio_id || item.mixsongid || item.audio_id || '');
    const hash = String(item.hash || item.filehash || '').toUpperCase();
    const durationSeconds = Number(item.duration || item.timelength && Number(item.timelength) / 1000 || 0);
    return {
      id: hash || albumAudioId || ('kugou-import-' + index + '-' + safeId(name + '|' + artist)),
      name,
      title: name,
      artist,
      album: String(item.album_name || item.album || ''),
      albumId: String(item.album_id || ''),
      albumAudioId,
      hash,
      fileHash: hash,
      cover: secureKugouImage(item.imgurl || item.sizable_cover || item.cover || '', 400),
      artwork: secureKugouImage(item.imgurl || item.sizable_cover || item.cover || '', 400),
      duration: durationSeconds > 0 && durationSeconds < 100000 ? Math.round(durationSeconds * 1000) : Math.round(durationSeconds || 0),
      provider: 'kugou',
      source: 'kugou',
      type: 'kugou',
      playable: true,
      _resolveWithMusicFree: true,
      importedPlaylist: true,
    };
  }

  isKugouSharedSongLink(link) {
    const text = String(link || '').trim();
    if (!/kugou\.com|kugou\.cn/i.test(text)) return false;
    if (/share_type=songlist|gcid=collection_|src_cid=collection_|\/plist\/|\/special\//i.test(text)) return false;
    return /\/song\.html(?:[?#]|$)|\/share\/[a-z0-9_-]+\.html(?:[?#]|$)/i.test(text);
  }

  async importKugouSharedSong(link) {
    const desktopUserAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/138 Safari/537.36';
    const page = await this.fetchImportText(link, 'text/html,application/xhtml+xml,*/*;q=0.8', desktopUserAgent);
    const rows = balancedJsonValue(page.body, 'var dataFromSmarty');
    const first = Array.isArray(rows) && rows.find(item => item && /^[A-F0-9]{32}$/i.test(String(item.hash || '')));
    if (!first) throw new Error('酷狗电脑端分享页中没有找到歌曲信息');
    const track = this.kugouImportedTrack(first, 0);
    if (!track.name || !track.artist || !track.hash) throw new Error('酷狗电脑端分享歌曲信息不完整');
    const cover = String(track.cover || track.artwork || '');
    return {
      provider: 'kugou',
      source: '酷狗音乐',
      sourceUrl: String(link || ''),
      resolvedUrl: String(page.url || link),
      truncated: false,
      playlist: {
        id: 'kugou-song-' + track.hash,
        name: track.name,
        cover,
        creator: track.artist,
        trackCount: 1,
        kind: 'shared-song',
      },
      tracks: [track],
    };
  }

  async importKugouPlaylist(link) {
    const resolved = await this.kugouSpecialIdFromLink(link);
    const specialId = resolved.id;
    if (Array.isArray(resolved.embeddedSongs) && resolved.embeddedSongs.length) {
      const listInfo = resolved.share && resolved.share.info && resolved.share.info.listinfo || {};
      const expectedTotal = Number(listInfo.count || resolved.embeddedSongs.length);
      const tracks = resolved.embeddedSongs.map((item, index) => this.kugouImportedTrack(item, index)).filter(track => track.name);
      if (!tracks.length) throw new Error('酷狗分享歌单没有解析到歌曲');
      if (expectedTotal && tracks.length !== expectedTotal) {
        const error = new Error('酷狗歌单不完整：公开页面共 ' + expectedTotal + ' 首，实际取得 ' + tracks.length + ' 首，已取消导入');
        error.code = 'PLAYLIST_INCOMPLETE';
        throw error;
      }
      const cover = secureKugouImage(listInfo.pic || tracks[0].cover || '', 400);
      return {
        provider: 'kugou', source: '酷狗音乐', sourceUrl: String(link || ''),
        resolvedUrl: String(resolved.resolvedUrl || link), truncated: false,
        playlist: {
          id: 'kugou-gcid-' + safeId(String(listInfo.name || '') + '|' + String(listInfo.list_create_userid || '') + '|' + String(link || '')),
          name: String(listInfo.name || '酷狗链接歌单'), cover,
          creator: String(listInfo.list_create_username || ''), trackCount: expectedTotal || tracks.length,
        },
        tracks,
      };
    }
    const metaResponse = await this.fetchImportText('https://m.kugou.com/plist/list/' + specialId + '?json=true', 'application/json,text/plain,*/*');
    let metaJson = null;
    try { metaJson = JSON.parse(metaResponse.body); } catch (_) { }
    const meta = metaJson && metaJson.info && metaJson.info.list || {};
    const expectedTotal = Number(meta.songcount || meta.count || 0);
    const pageSize = 100;
    const pageCount = Math.max(1, Math.ceil((expectedTotal || pageSize) / pageSize));
    const pages = await Promise.all(Array.from({ length: pageCount }, async (_, pageIndex) => {
      const endpoint = 'https://mobileservice.kugou.com/api/v3/special/song?specialid=' + encodeURIComponent(specialId) +
        '&page=' + (pageIndex + 1) + '&pagesize=' + pageSize + '&plat=0&version=9108';
      const response = await this.fetchImportText(endpoint, 'application/json,text/plain,*/*');
      const payload = JSON.parse(response.body);
      return payload && payload.data || {};
    }));
    const apiTotal = Number(pages[0] && pages[0].total || 0);
    const total = apiTotal || expectedTotal;
    const seen = new Set();
    const rows = [];
    pages.forEach(page => {
      (Array.isArray(page && page.info) ? page.info : []).forEach(item => {
        const key = String(item && (item.hash || item.album_audio_id || item.filename) || '');
        if (!key || seen.has(key)) return;
        seen.add(key);
        rows.push(item);
      });
    });
    if (!rows.length) throw new Error('酷狗歌单没有解析到歌曲');
    if (total && rows.length !== total) {
      const error = new Error('酷狗歌单不完整：官方共 ' + total + ' 首，实际取得 ' + rows.length + ' 首，已取消导入');
      error.code = 'PLAYLIST_INCOMPLETE';
      throw error;
    }
    const tracks = rows.map((item, index) => this.kugouImportedTrack(item, index));
    const shareInfo = resolved.share && resolved.share.info && resolved.share.info.listinfo || {};
    const cover = secureKugouImage(meta.imgurl || shareInfo.pic || shareInfo.imgurl || tracks[0].cover || '', 400);
    return {
      provider: 'kugou',
      source: '酷狗音乐',
      sourceUrl: String(link || ''),
      resolvedUrl: 'https://m.kugou.com/plist/list/' + specialId,
      truncated: false,
      playlist: {
        id: 'kugou-' + specialId,
        name: String(meta.specialname || shareInfo.name || '酷狗链接歌单'),
        cover,
        creator: String(meta.nickname || shareInfo.nickname || ''),
        trackCount: total || tracks.length,
      },
      tracks,
    };
  }

  qishuiImage(value) {
    value = value && typeof value === 'object' ? value : {};
    const urls = Array.isArray(value.urls) ? value.urls : [];
    const direct = urls.find(url => /\/[^/]+(?:\?|$)/.test(String(url || '').replace(/^https?:\/\//, ''))) || '';
    if (direct && !String(direct).endsWith('/')) return String(direct).replace(/^http:\/\//i, 'https://');
    const base = String(urls[0] || '').replace(/^http:\/\//i, 'https://');
    const uri = String(value.uri || '');
    return base && uri ? base + uri : base;
  }

  qishuiImportedTrack(media, index) {
    const track = media && media.entity && media.entity.track || media && media.track || {};
    const artists = Array.isArray(track.artists) ? track.artists : [];
    const artist = artists.map(item => String(item && (item.name || item.simple_display_name) || '').trim()).filter(Boolean).join(' / ');
    const album = track.album && typeof track.album === 'object' ? track.album : {};
    const id = String(track.id || media && media.id || ('qishui-import-' + index));
    return {
      id,
      providerSongId: id,
      name: String(track.name || '').trim(),
      title: String(track.name || '').trim(),
      artist,
      artists: artists.map(item => ({ id: String(item && item.id || ''), name: String(item && item.name || '') })),
      album: String(album.name || ''),
      albumId: String(album.id || ''),
      cover: this.qishuiImage(album.url_cover),
      artwork: this.qishuiImage(album.url_cover),
      duration: Math.round(Number(track.duration || 0)),
      provider: 'qishui',
      source: 'qishui',
      type: 'qishui',
      playable: true,
      _resolveWithMusicFree: true,
      importedPlaylist: true,
      availableQualities: (Array.isArray(track.bit_rates) ? track.bit_rates : []).map(item => String(item && item.quality || '')).filter(Boolean),
    };
  }

  async importQishuiPlaylist(link) {
    const page = await this.fetchImportText(link);
    const router = balancedJsonValue(page.body, '_ROUTER_DATA');
    const playlistPage = router && router.loaderData && router.loaderData.playlist_page;
    const media = Array.isArray(playlistPage && playlistPage.medias) ? playlistPage.medias : [];
    const meta = playlistPage && playlistPage.playlistInfo || {};
    const total = Number(meta.count_tracks || 0);
    if (!media.length || !meta.id) throw new Error('汽水分享页中没有解析到公开歌单');
    const tracks = media.map((item, index) => this.qishuiImportedTrack(item, index)).filter(song => song.name);
    if (total && tracks.length !== total) {
      const error = new Error('汽水歌单不完整：官方公开 ' + total + ' 首，实际取得 ' + tracks.length + ' 首，已取消导入');
      error.code = 'PLAYLIST_INCOMPLETE';
      throw error;
    }
    return {
      provider: 'qishui',
      source: '汽水音乐',
      sourceUrl: String(link || ''),
      resolvedUrl: page.url,
      truncated: false,
      playlist: {
        id: 'qishui-' + String(meta.id),
        name: String(meta.title || '汽水链接歌单'),
        cover: this.qishuiImage(meta.url_cover),
        creator: String(meta.owner && (meta.owner.nickname || meta.owner.public_name) || ''),
        trackCount: total || tracks.length,
      },
      tracks,
    };
  }

  playlistNumericId(provider, link) {
    const source = String(link || '').replace(/#\//g, '');
    let match = null;
    if (provider === 'qq') match = source.match(/(?:[?&]id=|\/playlist\/|\/taoge\/)(\d+)/i);
    else if (provider === 'kuwo') match = source.match(/\/(?:playlist_detail|playlist)\/(\d+)/i) || source.match(/[?&](?:pid|id)=(\d+)/i);
    else if (provider === 'netease') match = source.match(/[?&]id=(\d+)/i) || source.match(/\/playlist\/(\d+)/i);
    return match ? match[1] : (/^\d+$/.test(source.trim()) ? source.trim() : '');
  }

  qqImportedTrack(item, index) {
    item = item && typeof item === 'object' ? item : {};
    const singers = Array.isArray(item.singer) ? item.singer : [];
    const album = item.album && typeof item.album === 'object' ? item.album : {};
    const mid = String(item.mid || item.songmid || '');
    const name = String(item.name || item.title || '').trim();
    const artist = singers.map(singer => String(singer && singer.name || '').trim()).filter(Boolean).join(' / ');
    const albumMid = String(album.mid || item.albummid || '');
    return {
      id: mid || String(item.id || item.songid || ('qq-import-' + index + '-' + safeId(name + '|' + artist))),
      mid,
      songmid: mid,
      name,
      title: name,
      artist,
      artists: singers.map(singer => ({ id: String(singer && (singer.mid || singer.id) || ''), name: String(singer && singer.name || '') })),
      album: String(album.name || item.albumname || ''),
      albumId: String(album.mid || album.id || ''),
      cover: albumMid ? 'https://y.gtimg.cn/music/photo_new/T002R500x500M000' + albumMid + '.jpg' : '',
      artwork: albumMid ? 'https://y.gtimg.cn/music/photo_new/T002R500x500M000' + albumMid + '.jpg' : '',
      duration: Math.round(Number(item.interval || item.duration || 0) * 1000),
      provider: 'qq',
      source: 'qq',
      type: 'qq',
      playable: true,
      _resolveWithMusicFree: true,
      importedPlaylist: true,
    };
  }

  async importQQPlaylist(link) {
    const id = this.playlistNumericId('qq', link);
    if (!id) throw new Error('QQ 音乐链接中没有找到歌单 ID');
    const fetchPage = async (begin, count) => {
      const request = {
        comm: { ct: 24, cv: 0 },
        req_1: {
          module: 'music.srfDissInfo.aiDissInfo',
          method: 'uniform_get_Dissinfo',
          param: { disstid: Number(id), enc_host_uin: '', tag: 1, userinfo: 1, song_begin: begin, song_num: count },
        },
      };
      const endpoint = 'https://u.y.qq.com/cgi-bin/musicu.fcg?data=' + encodeURIComponent(JSON.stringify(request));
      const response = await this.fetchImportText(endpoint, 'application/json,text/plain,*/*');
      const payload = JSON.parse(response.body);
      return payload && payload.req_1 && payload.req_1.data || {};
    };
    const first = await fetchPage(0, 500);
    const total = Number(first.total_song_num || (Array.isArray(first.songlist) ? first.songlist.length : 0));
    const pages = [first];
    for (let begin = 500; begin < total; begin += 500) pages.push(await fetchPage(begin, Math.min(500, total - begin)));
    const seen = new Set();
    const list = [];
    pages.forEach(page => {
      (Array.isArray(page && page.songlist) ? page.songlist : []).forEach(item => {
        const key = String(item && (item.mid || item.songmid || item.id) || '');
        if (!key || seen.has(key)) return;
        seen.add(key);
        list.push(item);
      });
    });
    if (!list.length) throw new Error('QQ 音乐歌单没有解析到歌曲');
    if (total && list.length !== total) {
      const error = new Error('QQ 音乐歌单不完整：官方共 ' + total + ' 首，实际取得 ' + list.length + ' 首，已取消导入');
      error.code = 'PLAYLIST_INCOMPLETE';
      throw error;
    }
    const meta = first.dirinfo || {};
    const tracks = list.map((item, index) => this.qqImportedTrack(item, index));
    return {
      provider: 'qq',
      source: 'QQ 音乐',
      sourceUrl: String(link || ''),
      resolvedUrl: 'https://y.qq.com/n/ryqq/playlist/' + id,
      truncated: false,
      playlist: {
        id: 'qq-' + id,
        name: String(meta.title || 'QQ 音乐链接歌单'),
        cover: String(meta.picurl || tracks[0].cover || '').replace(/^http:\/\//i, 'https://'),
        creator: String(meta.host_nick || meta.nickname || ''),
        trackCount: total || tracks.length,
      },
      tracks,
    };
  }

  async importKuwoPlaylist(link) {
    const id = this.playlistNumericId('kuwo', link);
    if (!id) throw new Error('酷我音乐链接中没有找到歌单 ID');
    const pageSize = 1000;
    const endpoint = page => 'https://nplserver.kuwo.cn/pl.svc?op=getlistinfo&pid=' + encodeURIComponent(id) +
      '&pn=' + page + '&rn=' + pageSize + '&encode=utf8&keyset=pl2012&identity=kuwo' +
      '&vipver=MUSIC_9.1.1.2_W1&newver=1';
    const firstResponse = await this.fetchImportText(endpoint(0), 'application/json,text/plain,*/*');
    const firstPayload = JSON.parse(firstResponse.body) || {};
    const expectedTotal = Number(firstPayload.total || 0);
    const pageCount = Math.max(1, Math.ceil((expectedTotal || pageSize) / pageSize));
    const remainingPages = pageCount > 1
      ? await Promise.all(Array.from({ length: pageCount - 1 }, async (_, index) => {
        const response = await this.fetchImportText(endpoint(index + 1), 'application/json,text/plain,*/*');
        return JSON.parse(response.body) || {};
      }))
      : [];
    const seen = new Set();
    const tracks = [];
    [firstPayload].concat(remainingPages).forEach(payload => {
      const list = Array.isArray(payload && payload.musiclist) ? payload.musiclist : [];
      list.forEach(item => {
        const name = String(item && (item.name || item.songname || item.FSONGNAME) || '').trim();
        const artist = String(item && (item.artist || item.FARTIST || item.AARTIST) || '').trim();
        const songId = String(item && (item.id || item.musicrid || item.musicattachinfoid) || '');
        const key = songId || name + '|' + artist;
        if (seen.has(key)) return;
        seen.add(key);
        const album = String(item && (item.album || item.albumname || item.FALBUM) || '').trim();
        const cover = String(item && (item.albumpic || item.pic || item.musicPic || item.artistPic) || '').replace(/^http:\/\//i, 'https://');
        tracks.push({
          id: songId || ('kuwo-import-' + tracks.length + '-' + safeId(name + '|' + artist)),
          providerSongId: songId,
          name,
          title: name,
          artist,
          artists: artist ? artist.split(/\s*(?:&|,|\/|、)\s*/).filter(Boolean).map(value => ({ name: value })) : [],
          album,
          albumId: String(item && item.albumid || ''),
          cover,
          artwork: cover,
          duration: Number(item && item.duration || 0),
          formats: String(item && item.formats || ''),
          availableQualities: String(item && item.formats || '').split('|').filter(Boolean),
          provider: 'kuwo',
          source: 'kuwo',
          type: 'kuwo',
          playable: true,
          _resolveWithMusicFree: true,
          importedPlaylist: true,
        });
      });
    });
    if (!tracks.length) throw new Error('酷我音乐歌单没有解析到歌曲');
    if (expectedTotal && tracks.length !== expectedTotal) {
      const error = new Error('酷我音乐歌单不完整：官方共 ' + expectedTotal + ' 首，实际取得 ' + tracks.length + ' 首，已取消导入');
      error.code = 'PLAYLIST_INCOMPLETE';
      throw error;
    }
    const meta = firstPayload;
    return {
      provider: 'kuwo',
      source: '酷我音乐',
      sourceUrl: String(link || ''),
      resolvedUrl: 'https://www.kuwo.cn/playlist_detail/' + id,
      truncated: false,
      playlist: {
        id: 'kuwo-' + id,
        name: String(meta.title || '酷我音乐链接歌单'),
        cover: String(meta.pic || tracks[0].cover || '').replace(/^http:\/\//i, 'https://'),
        creator: String(meta.uname || ''),
        trackCount: expectedTotal || tracks.length,
      },
      tracks,
    };
  }

  async importNeteasePlaylist(link) {
    const id = this.playlistNumericId('netease', link);
    if (!id) throw new Error('网易云音乐链接中没有找到歌单 ID');
    const canonical = 'https://music.163.com/playlist?id=' + id;
    const response = await this.fetchImportText('https://music.163.com/api/v6/playlist/detail?id=' + id, 'application/json,text/plain,*/*');
    const payload = JSON.parse(response.body);
    const meta = payload && (payload.playlist || payload.result) || {};
    const trackIds = (Array.isArray(meta.trackIds) ? meta.trackIds : []).map(item => String(item && (item.id || item) || '')).filter(Boolean);
    const includedTracks = Array.isArray(meta.tracks) ? meta.tracks : [];
    const byId = new Map(includedTracks.map(item => [String(item && item.id || ''), item]));
    const missingIds = trackIds.filter(songId => !byId.has(songId));
    const batches = [];
    for (let offset = 0; offset < missingIds.length; offset += 200) batches.push(missingIds.slice(offset, offset + 200));
    for (let groupStart = 0; groupStart < batches.length; groupStart += 6) {
      const group = batches.slice(groupStart, groupStart + 6);
      const results = await Promise.all(group.map(async batch => {
        const detailUrl = 'https://music.163.com/api/song/detail?ids=' + encodeURIComponent(JSON.stringify(batch));
        const detailResponse = await this.fetchImportText(detailUrl, 'application/json,text/plain,*/*');
        const detailPayload = JSON.parse(detailResponse.body);
        return Array.isArray(detailPayload && detailPayload.songs) ? detailPayload.songs : [];
      }));
      results.flat().forEach(item => byId.set(String(item && item.id || ''), item));
    }
    const orderedItems = trackIds.length ? trackIds.map(songId => byId.get(songId)).filter(Boolean) : includedTracks;
    if (!orderedItems.length) throw new Error('网易云音乐歌单没有解析到歌曲');
    const expectedTotal = Number(trackIds.length || meta.trackCount || orderedItems.length);
    const tracks = orderedItems.map((item, index) => {
      const artists = Array.isArray(item && item.ar) ? item.ar : (Array.isArray(item && item.artists) ? item.artists : []);
      const albumInfo = item && (item.al || item.album) || {};
      const name = String(item && (item.name || item.title) || '').trim();
      const artist = artists.map(value => String(value && value.name || '').trim()).filter(Boolean).join(' / ');
      const songId = String(item && item.id || '');
      const cover = String(albumInfo && (albumInfo.picUrl || albumInfo.blurPicUrl) || '').replace(/^http:\/\//i, 'https://');
      const qualities = [];
      if (item && (item.l || item.b || item.m)) qualities.push('standard');
      if (item && item.h) qualities.push('high');
      if (item && item.sq) qualities.push('lossless');
      if (item && item.hr) qualities.push('hires');
      return {
        id: songId || ('netease-import-' + index + '-' + safeId(name + '|' + artist)),
        providerSongId: songId,
        name,
        title: name,
        artist,
        artists: artists.map(value => ({ id: String(value && value.id || ''), name: String(value && value.name || '') })),
        album: String(albumInfo && albumInfo.name || ''),
        albumId: String(albumInfo && albumInfo.id || ''),
        cover,
        artwork: cover,
        duration: Number(item && (item.dt || item.duration) || 0) / 1000,
        availableQualities: qualities,
        provider: 'netease',
        source: 'netease',
        type: 'netease',
        playable: true,
        _resolveWithMusicFree: true,
        importedPlaylist: true,
      };
    });
    if (expectedTotal && tracks.length !== expectedTotal) {
      const error = new Error('网易云音乐歌单不完整：官方共 ' + expectedTotal + ' 首，实际取得 ' + tracks.length + ' 首，已取消导入');
      error.code = 'PLAYLIST_INCOMPLETE';
      throw error;
    }
    return {
      provider: 'netease',
      source: '网易云音乐',
      sourceUrl: String(link || ''),
      resolvedUrl: canonical,
      truncated: false,
      playlist: {
        id: 'netease-' + id,
        name: String(meta.name || '网易云音乐链接歌单'),
        cover: String(meta.coverImgUrl || meta.picUrl || tracks[0].cover || '').replace(/^http:\/\//i, 'https://'),
        creator: String(meta.creator && (meta.creator.nickname || meta.creator.name) || ''),
        trackCount: expectedTotal || tracks.length,
      },
      tracks,
    };
  }

  playlistProviderFromLink(link) {
    const text = String(link || '').toLowerCase();
    if (/music\.163\.com|163cn\.tv|music\.163\.cn/.test(text)) return 'netease';
    if (/y\.qq\.com|i\.y\.qq\.com|c6\.y\.qq\.com|qq\.com\/.*(?:playlist|taoge|toplist)/.test(text)) return 'qq';
    if (/kugou\.com|kg\.qq\.com|kugou.cn/.test(text)) return 'kugou';
    if (/kuwo\.cn|kuwo\.com/.test(text)) return 'kuwo';
    if (/qishui|tsmusic\.cn|music\.douyin\.com|douyin\.com|douyin\.cn/.test(text)) return 'qishui';
    return '';
  }

  canonicalPlaylistLink(provider, link) {
    const source = String(link || '').replace(/#\//g, '').trim();
    let match = null;
    if (provider === 'netease') {
      match = source.match(/[?&]id=(\d+)/i) || source.match(/\/playlist\/(\d+)/i);
      if (match) return 'https://music.163.com/playlist?id=' + match[1];
    }
    if (provider === 'qq') {
      match = source.match(/(?:[?&]id=|\/playlist\/|\/taoge\/)(\d+)/i);
      if (match) return 'https://y.qq.com/n/ryqq/playlist/' + match[1];
    }
    if (provider === 'kuwo') {
      match = source.match(/\/(?:playlist_detail|playlist)\/(\d+)/i) || source.match(/[?&](?:pid|id)=(\d+)/i);
      if (match) return 'https://www.kuwo.cn/playlist_detail/' + match[1];
    }
    return source;
  }

  async normalizePlaylistShareLink(link) {
    let current = firstHttpUrl(link) || String(link || '').trim();
    const visited = new Set();
    for (let step = 0; step < 5 && /^https?:\/\//i.test(current) && !visited.has(current); step += 1) {
      visited.add(current);
      try {
        const response = await fetch(current, {
          redirect: 'follow',
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
            Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          },
          signal: AbortSignal.timeout(12000),
        });
        const finalUrl = String(response.url || current);
        let next = finalUrl;
        const type = String(response.headers.get('content-type') || '').toLowerCase();
        if (/text|html|json/.test(type)) {
          const body = (await response.text()).slice(0, 2 * 1024 * 1024);
          const decoded = body.replace(/\\u0026/g, '&').replace(/&amp;/g, '&').replace(/\\\//g, '/');
          const candidates = decoded.match(/https?:\/\/[^\s"'<>\\]+/gi) || [];
          const platformUrl = candidates.find(url => this.playlistProviderFromLink(url));
          if (platformUrl) next = platformUrl;
        }
        if (next === current) break;
        current = next;
      } catch (_) {
        break;
      }
    }
    return current;
  }

  playlistRuntimeCandidates(provider) {
    const patterns = {
      netease: /网易|元力WY|netease|\bWY\b/i,
      qq: /(^|\s)qq($|\s)|元力QQ|\bQQ\b/i,
      kugou: /酷狗|酷gou|元力KG|kugou|\bKG\b/i,
      kuwo: /酷我|元力KW|kuwo|\bKW\b/i,
      qishui: /汽水|qishui|tsmusic/i,
    };
    const match = patterns[provider] || null;
    return Array.from(this.plugins.values()).filter(runtime => {
      if (!runtime.adapter.has('importMusicSheet')) return false;
      return !match || match.test(runtime.label + ' ' + runtime.platform);
    });
  }

  async importPlaylist(link, providerHint = '') {
    await this.ready;
    const originalText = String(link || '').trim();
    const originalUrl = firstHttpUrl(originalText) || originalText;
    if (!originalUrl) throw new Error('请输入歌单链接');
    const originalProvider = String(providerHint || this.playlistProviderFromLink(originalUrl) || '').toLowerCase();
    const failures = [];
    if (originalProvider === 'kugou') {
      if (this.isKugouSharedSongLink(originalUrl)) {
        try { return await this.importKugouSharedSong(originalUrl); }
        catch (error) { failures.push({ source: 'Kugou desktop shared song', error: error && error.message || String(error) }); }
      }
      try { return await this.importKugouPlaylist(originalUrl); }
      catch (error) { failures.push({ source: '酷狗官方歌单', error: error && error.message || String(error) }); }
    }
    if (originalProvider === 'qishui') {
      try { return await this.importQishuiPlaylist(originalUrl); }
      catch (error) { failures.push({ source: '汽水官方分享页', error: error && error.message || String(error) }); }
    }
    if (originalProvider === 'qq') {
      try { return await this.importQQPlaylist(originalUrl); }
      catch (error) { failures.push({ source: 'QQ 音乐官方歌单', error: error && error.message || String(error) }); }
    }
    if (originalProvider === 'kuwo') {
      try { return await this.importKuwoPlaylist(originalUrl); }
      catch (error) { failures.push({ source: '酷我音乐歌单', error: error && error.message || String(error) }); }
    }
    if (originalProvider === 'netease' && this.playlistNumericId('netease', originalUrl)) {
      try { return await this.importNeteasePlaylist(originalUrl); }
      catch (error) { failures.push({ source: '网易云音乐歌单', error: error && error.message || String(error) }); }
    }
    const normalizedUrl = await this.normalizePlaylistShareLink(originalUrl);
    const provider = String(providerHint || this.playlistProviderFromLink(normalizedUrl) || originalProvider || '').toLowerCase();
    const sourceUrl = this.canonicalPlaylistLink(provider, normalizedUrl);
    if (provider === 'kugou') {
      if (this.isKugouSharedSongLink(sourceUrl)) {
        try { return await this.importKugouSharedSong(sourceUrl); }
        catch (error) { failures.push({ source: 'Kugou desktop shared song', error: error && error.message || String(error) }); }
      }
      try { return await this.importKugouPlaylist(sourceUrl); }
      catch (error) { failures.push({ source: '酷狗官方歌单', error: error && error.message || String(error) }); }
    }
    if (provider === 'qishui') {
      try { return await this.importQishuiPlaylist(sourceUrl); }
      catch (error) { failures.push({ source: '汽水官方分享页', error: error && error.message || String(error) }); }
    }
    if (provider === 'qq') {
      try { return await this.importQQPlaylist(sourceUrl); }
      catch (error) { failures.push({ source: 'QQ 音乐官方歌单', error: error && error.message || String(error) }); }
    }
    if (provider === 'kuwo') {
      try { return await this.importKuwoPlaylist(sourceUrl); }
      catch (error) { failures.push({ source: '酷我音乐歌单', error: error && error.message || String(error) }); }
    }
    if (provider === 'netease') {
      try { return await this.importNeteasePlaylist(sourceUrl); }
      catch (error) { failures.push({ source: '网易云音乐歌单', error: error && error.message || String(error) }); }
    }
    const candidates = this.playlistRuntimeCandidates(provider);
    if (!candidates.length) {
      const error = new Error('没有已安装的' + (provider || '对应平台') + '音源可以解析这个歌单');
      error.failures = failures;
      throw error;
    }
    for (const runtime of candidates) {
      try {
        const result = await timedPluginCall(() => runtime.adapter.call('importMusicSheet', sourceUrl), 30000);
        const list = musicFreeResultItems(result);
        if (!list.length) throw new Error('链接中没有解析到歌曲');
        const tracks = list.map(item => this.toMineradioSong(item, runtime));
        const meta = result && !Array.isArray(result) ? result : {};
        const expectedTotal = Number(meta.total || meta.trackCount || meta.songCount || meta.count || list.length) || list.length;
        if (expectedTotal > tracks.length) {
          const incomplete = new Error('平台返回的歌单不完整：应有 ' + expectedTotal + ' 首，实际解析 ' + tracks.length + ' 首，已取消导入');
          incomplete.code = 'PLAYLIST_INCOMPLETE';
          throw incomplete;
        }
        const first = tracks[0] || {};
        const providerLabels = { netease: '网易云音乐', qq: 'QQ 音乐', kugou: '酷狗音乐', kuwo: '酷我音乐' };
        return {
          provider: provider || runtime.label,
          source: runtime.label,
          sourceUrl: originalUrl,
          resolvedUrl: sourceUrl,
          truncated: false,
          playlist: {
            id: 'link-' + safeId(sourceUrl),
            name: String(meta.title || meta.name || meta.sheetName || (providerLabels[provider] || runtime.label) + '链接歌单'),
            cover: String(meta.cover || meta.artwork || meta.coverImg || first.cover || ''),
            creator: String(meta.creator || meta.author || ''),
            trackCount: expectedTotal,
          },
          tracks,
        };
      } catch (error) {
        failures.push({ source: runtime.label, error: error && error.message || String(error) });
      }
    }
    const error = new Error(failures[0] && failures[0].error || '歌单链接解析失败');
    error.failures = failures;
    throw error;
  }

  originalItem(song) {
    return jsonClone(song && song.musicFreeItem) || jsonClone(song) || {};
  }

  purgeAudioTokens() {
    const now = Date.now();
    for (const [token, entry] of this.audioTokens) {
      if (!entry || now - entry.createdAt > AUDIO_TOKEN_TTL_MS) this.audioTokens.delete(token);
    }
  }

  purgeVideoTokens() {
    const now = Date.now();
    for (const [token, entry] of this.videoTokens) {
      if (!entry || now - entry.createdAt > AUDIO_TOKEN_TTL_MS) this.videoTokens.delete(token);
    }
  }

  async probeMediaSource(url, headers = {}, timeoutMs = 7000) {
    const target = String(url || '').trim();
    if (!/^https?:\/\//i.test(target)) throw new Error('MEDIA_URL_INVALID');
    const requestHeaders = Object.assign({}, headers || {});
    if (!requestHeaders.Range && !requestHeaders.range) requestHeaders.Range = 'bytes=0-1';
    const response = await fetch(target, {
      method: 'GET',
      redirect: 'follow',
      headers: requestHeaders,
      signal: AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 7000)),
    });
    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    const finalUrl = String(response.url || target);
    if (response.body) response.body.cancel().catch(() => {});
    if (!response.ok && response.status !== 206) throw new Error('MEDIA_HTTP_' + response.status);
    if (/text\/(?:html|plain)|application\/(?:json|xml)/i.test(contentType)) {
      throw new Error('MEDIA_CONTENT_TYPE_' + (contentType || 'UNKNOWN'));
    }
    return { ok: true, status: response.status, contentType, finalUrl };
  }

  async mediaFallbackCandidates(song, excludedPluginIds = new Set()) {
    const wanted = lyricSongIdentity(song || {});
    const query = [wanted.title, wanted.artist].filter(Boolean).join(' ').trim();
    if (!query) return [];
    const runtimes = Array.from(this.plugins.values()).filter(runtime =>
      !excludedPluginIds.has(runtime.id) && runtime.adapter.has('search') && runtime.adapter.has('getMediaSource')
    );
    const settled = await Promise.allSettled(runtimes.map(async runtime => {
      const response = await timedPluginCall(() => runtime.adapter.search(query, 1, 'music'), 9000);
      return response.items.slice(0, 12).map(item => ({ runtime, song: this.toMineradioSong(item, runtime) }));
    }));
    const ranked = [];
    settled.forEach(result => {
      if (result.status !== 'fulfilled') return;
      result.value.forEach(entry => {
        const score = lyricCandidateMatchScore(entry.song, wanted);
        if (score >= 55) ranked.push(Object.assign({ score }, entry));
      });
    });
    ranked.sort((a, b) => b.score - a.score);
    const seen = new Set();
    return ranked.filter(entry => {
      const key = entry.runtime.id + ':' + String(entry.song.id || '');
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    }).slice(0, 24).map(entry => entry.song);
  }

  async completeTrackMetadata(song) {
    if (!needsMetadata(song)) return song;
    const wanted = lyricSongIdentity(song || {});
    const query = [wanted.title, wanted.artist].filter(Boolean).join(' ').trim();
    if (!query) return song;
    const sourcePluginId = String(song && song.musicFreePluginId || '');
    const runtimes = Array.from(this.plugins.values()).filter(runtime => runtime.id !== sourcePluginId && runtime.adapter.has('search'));
    const settled = await Promise.allSettled(runtimes.map(async runtime => {
      const response = await timedPluginCall(() => runtime.adapter.search(query, 1, 'music'), 7000);
      return response.items.slice(0, 8).map(item => this.toMineradioSong(item, runtime));
    }));
    const candidates = [];
    settled.forEach(result => {
      if (result.status !== 'fulfilled') return;
      result.value.forEach(candidate => {
        const score = lyricCandidateMatchScore(candidate, wanted);
        if (score >= 55) candidates.push({ score, candidate });
      });
    });
    candidates.sort((a, b) => b.score - a.score);
    return mergeTrackMetadata(song, candidates.slice(0, 12).map(entry => entry.candidate));
  }

  mediaResolveCacheKey(song, quality) {
    const original = this.originalItem(song || {});
    const pluginId = String(song && song.musicFreePluginId || original.pluginId || '');
    const mediaId = String(original && (original.id || original.mid || original.hash || original.songmid || original.rid) || safeId(JSON.stringify(original || song || {})));
    return [pluginId, mediaId, normalizeQuality(quality)].join(':').toLowerCase();
  }

  async resolveMedia(song, quality) {
    await this.ready;
    const key = this.mediaResolveCacheKey(song, quality);
    const cached = this.mediaResolveCache.get(key);
    if (cached && cached.data && Date.now() - cached.createdAt < MEDIA_RESOLVE_CACHE_TTL_MS) return jsonClone(cached.data) || cached.data;
    if (cached) this.mediaResolveCache.delete(key);
    if (this.mediaResolvePending.has(key)) return this.mediaResolvePending.get(key);
    const pending = this._resolveMediaUncached(song, quality).then(data => {
      if (data && data.url) {
        this.mediaResolveCache.set(key, { data: jsonClone(data) || data, createdAt: Date.now() });
        if (this.mediaResolveCache.size > 500) this.mediaResolveCache.delete(this.mediaResolveCache.keys().next().value);
      }
      return data;
    }).finally(() => this.mediaResolvePending.delete(key));
    this.mediaResolvePending.set(key, pending);
    return pending;
  }

  async _resolveMediaUncached(song, quality) {
    await this.ready;
    const requestedPluginId = String(song && song.musicFreePluginId || '');
    const requestedRuntime = requestedPluginId ? this.plugins.get(requestedPluginId) : null;
    const fallbackPolicy = String(song && song.musicFreeFallbackPolicy || requestedRuntime && requestedRuntime.fallbackPolicy || '').toLowerCase();
    const sourceOnly = fallbackPolicy === 'source-only';
    const alternates = !sourceOnly && Array.isArray(song && song.musicFreeAlternates) ? song.musicFreeAlternates : [];
    const candidates = [song].concat(alternates).filter(Boolean);
    const tried = new Set();
    const failures = [];
    let candidateIndex = 0;
    let fallbackExpanded = sourceOnly;
    while (candidateIndex < candidates.length || !fallbackExpanded) {
      if (candidateIndex >= candidates.length) {
        fallbackExpanded = true;
        const excluded = new Set(Array.from(tried).map(key => String(key).split(':')[0]));
        try { candidates.push(...await this.mediaFallbackCandidates(song, excluded)); }
        catch (error) { failures.push({ source: 'MusicFree Resolver', error: error && error.message || String(error) }); }
        if (candidateIndex >= candidates.length) break;
      }
      const candidate = candidates[candidateIndex++];
      const pluginId = String(candidate && candidate.musicFreePluginId || '');
      const original = this.originalItem(candidate);
      const originalId = String(original && (original.id || original.mid || original.hash || original.songmid || original.rid) || safeId(JSON.stringify(original)));
      const attemptKey = pluginId + ':' + originalId;
      if (!pluginId || tried.has(attemptKey)) continue;
      tried.add(attemptKey);
      let runtime = null;
      try { runtime = this.runtime(pluginId); }
      catch (error) { failures.push({ pluginId, error: error.message }); continue; }
      const item = original;
      let detail = null;
      try {
        let media = null;
        let resolvedLevel = '';
        let qualityPlan = musicFreeQualityPlan(item);
        const detailPromise = runtime.adapter.has('getMusicInfo')
          ? timedPluginCall(() => runtime.adapter.call('getMusicInfo', item), 2500).catch(() => null)
          : null;
        const tryMediaLevels = async (limit = 0) => {
          qualityPlan = musicFreeQualityPlan(item);
          if (runtime.adapter.has('getMediaSource')) {
            const plannedLevels = limit > 0 ? qualityPlan.levels.slice(0, limit) : qualityPlan.levels;
            for (const level of plannedLevels) {
              try {
                media = await timedPluginCall(() => runtime.adapter.media(item, level), 2500);
                if (typeof media === 'string') media = { url: media };
                if (media && media.url) {
                  const rawMediaQuality = String(media.level || media.quality || media.raw && media.raw.quality || '').toLowerCase();
                  resolvedLevel = /^(original|native|source)$/.test(rawMediaQuality) ? 'original' : (musicFreeQualityKey(rawMediaQuality) || level);
                  try {
                    const mediaHeaders = Object.assign({}, media.headers || {}, media.userAgent ? { 'User-Agent': media.userAgent } : {});
                    media.probe = await this.probeMediaSource(media.url, mediaHeaders, 900);
                  } catch (probeError) {
                    const probeText = String(probeError && (probeError.code || probeError.name || probeError.message) || probeError || '');
                    if (!/timeout|timed.?out|abort/i.test(probeText)) {
                      failures.push({ source: runtime.label, quality: level, error: probeText || 'MEDIA_INVALID' });
                      media = null;
                      continue;
                    }
                    // Slow CDNs are still playable through the proxy.  A probe
                    // timeout must not hold playback or discard a valid URL.
                    media.probe = { ok: false, deferred: true, contentType: '' };
                  }
                  return true;
                }
                failures.push({ source: runtime.label, quality: level, error: 'NO_MEDIA_SOURCE' });
              } catch (error) {
                failures.push({ source: runtime.label, quality: level, error: error && error.message || String(error) });
                media = null;
              }
            }
          } else if (item.url) {
            media = { url: item.url };
            resolvedLevel = qualityPlan.levels[0] || 'standard';
            return true;
          }
          return false;
        };
        // Start with one highest-quality direct attempt. Plugins whose search
        // result is already complete return immediately; detail-dependent
        // plugins prepare getMusicInfo concurrently instead of blocking twice.
        await tryMediaLevels(detailPromise ? 1 : 0);
        // Most MusicFree plugins can resolve directly from the search item.
        // Only request the slower detail endpoint when direct resolution fails.
        if ((!media || !media.url) && detailPromise) {
          detail = await detailPromise;
          if (detail && typeof detail === 'object') Object.assign(item, detail);
          await tryMediaLevels();
        }
        if (typeof media === 'string') media = { url: media };
        if (!media || !media.url) { failures.push({ source: runtime.label, error: 'NO_MEDIA_SOURCE' }); continue; }
        if (!media.probe) {
          try {
            const mediaHeaders = Object.assign({}, media.headers || {}, media.userAgent ? { 'User-Agent': media.userAgent } : {});
            media.probe = await this.probeMediaSource(media.url, mediaHeaders, 900);
          } catch (probeError) {
            const probeText = String(probeError && (probeError.code || probeError.name || probeError.message) || probeError || '');
            if (!/timeout|timed.?out|abort/i.test(probeText)) {
              failures.push({ source: runtime.label, quality: resolvedLevel || '', error: probeText || 'MEDIA_INVALID' });
              continue;
            }
            media.probe = { ok: false, deferred: true, contentType: '' };
          }
        }
        const mediaDurationMs = Math.max(0, Number(media.durationMs || media.raw && (media.raw.durationMs || media.raw.timelength || media.raw.duration) || 0) || 0);
        if (mediaDurationMs > 0) {
          item.durationMs = mediaDurationMs;
          item.duration = mediaDurationMs;
        }
        const token = crypto.randomBytes(18).toString('hex');
        this.purgeAudioTokens();
        this.audioTokens.set(token, {
          url: String(media.url),
          headers: Object.assign({}, media.headers || {}, media.userAgent ? { 'User-Agent': media.userAgent } : {}),
          createdAt: Date.now(),
        });
        const resolvedTrack = this.toMineradioSong(item, runtime);
        // Playback must not wait for cross-plugin metadata searches.  Cover and
        // lyric completion run on their own paths after audio has started.
        const resolvedSong = resolvedTrack;
        return {
          provider: 'musicfree', source: runtime.label, label: runtime.label,
          level: resolvedLevel || 'standard', requestedLevel: normalizeQuality(quality),
          availableQualities: resolvedLevel === 'original' ? [] : (qualityPlan.known ? qualityPlan.levels : []), autoHighest: resolvedLevel !== 'original',
          url: String(media.url),
          proxyUrl: '/api/musicfree/audio?token=' + encodeURIComponent(token),
          mediaType: String(media.probe && media.probe.contentType || media.format || ''),
          validated: !!(media.probe && media.probe.ok),
          sourceOnly,
          originalQuality: resolvedLevel === 'original',
          durationMs: mediaDurationMs,
          segmentCount: Array.isArray(media.segments) && media.segments.length ? media.segments.length : 1,
          detail: jsonClone(detail), resolvedSong: jsonClone(resolvedSong),
          fallbackUsed: !sourceOnly && candidate !== song, attemptedSources: tried.size,
        };
      } catch (error) {
        failures.push({ source: runtime.label, error: error && error.message || String(error) });
      }
    }
    return { provider: 'musicfree', source: '', url: '', error: 'NO_MEDIA_SOURCE', failures, attemptedSources: tried.size };
  }

  async resolveVideo(song, quality) {
    await this.ready;
    const pluginId = String(song && song.musicFreePluginId || '');
    if (!pluginId) throw new Error('BILIBILI_VIDEO_PLUGIN_MISSING');
    const runtime = this.runtime(pluginId);
    const platform = String(song && song.musicFreePlatform || runtime.platform || runtime.label || '').toLowerCase();
    const mediaType = String(song && song.mediaType || '').toLowerCase();
    if (platform !== 'bilibili' || mediaType !== 'video') throw new Error('VIDEO_PLAYER_REQUIRES_BILIBILI');
    if (!runtime.adapter.has('getVideoSource')) throw new Error('BILIBILI_VIDEO_CAPABILITY_UNAVAILABLE');
    const item = this.originalItem(song);
    let playbackItem = item;
    let multipartSongs = [];
    // Bilibili search results represent a whole submission.  A submission can
    // contain many pages (for example a 120-song compilation), while playurl
    // accepts one cid at a time.  Resolve the page list once and expose it to
    // the queue instead of silently treating page 1 as the complete video.
    if (!item.cid && runtime.adapter.has('getAlbumInfo')) {
      try {
        const albumInfo = await timedPluginCall(() => runtime.adapter.call('getAlbumInfo', item), 4200);
        const pageItems = musicFreeResultItems(albumInfo).filter(page => page && page.cid);
        if (pageItems.length > 1) {
          playbackItem = pageItems[0];
          multipartSongs = pageItems.map(page => {
            const normalized = this.toMineradioSong(page, runtime);
            const pageDurationMs = Math.max(0, Number(normalized.duration || 0) || 0);
            normalized.durationMs = pageDurationMs;
            normalized.dt = pageDurationMs;
            return normalized;
          });
        }
      } catch (_) { }
    }
    const source = await timedPluginCall(() => runtime.adapter.video(playbackItem, quality || 'auto'), 6200);
    if (!source || !source.audioUrl) throw new Error('BILIBILI_DASH_AUDIO_INVALID');
    const headers = Object.assign({}, source.headers || {});
    const probeResults = await Promise.allSettled([
      source.videoUrl ? this.probeMediaSource(source.videoUrl, headers, 550) : Promise.reject(new Error('VIDEO_UNAVAILABLE')),
      this.probeMediaSource(source.audioUrl, headers, 550),
    ]);
    const videoProbe = probeResults[0].status === 'fulfilled' ? probeResults[0].value : null;
    const audioProbe = probeResults[1].status === 'fulfilled' ? probeResults[1].value : null;
    this.purgeVideoTokens();
    const register = (url, kind, backups = []) => {
      const urls = [url].concat(Array.isArray(backups) ? backups : []).map(String).filter((value, index, list) => /^https?:\/\//i.test(value) && list.indexOf(value) === index);
      const token = crypto.randomBytes(18).toString('hex');
      this.videoTokens.set(token, { url: String(urls[0] || ''), urls, headers, kind, createdAt: Date.now() });
      return '/api/musicfree/video-stream?token=' + encodeURIComponent(token);
    };
    const qualities = (Array.isArray(source.qualities) ? source.qualities : []).filter(item => item && item.videoUrl).map(item => Object.assign({}, item, {
      proxyVideoUrl: register(item.videoUrl, 'video', item.videoUrls),
      videoUrl: String(item.videoUrl || ''),
    }));
    const selectedQuality = String(source.selectedQuality || qualities[0] && qualities[0].id || '');
    const selected = qualities.find(item => String(item.id) === selectedQuality) || qualities[0] || null;
    const durationMs = Math.max(0, Number(source.durationMs || 0) || 0);
    if (durationMs > 0) {
      playbackItem.durationMs = durationMs;
      playbackItem.duration = durationMs;
    }
    const resolvedSong = this.toMineradioSong(playbackItem, runtime);
    if (durationMs > 0) {
      resolvedSong.durationMs = durationMs;
      resolvedSong.duration = durationMs;
      resolvedSong.dt = durationMs;
    }
    if (multipartSongs.length) {
      multipartSongs[0] = Object.assign({}, multipartSongs[0], resolvedSong);
    }
    return {
      provider: 'musicfree-video',
      mediaType: 'video',
      platform: 'bilibili',
      source: runtime.label,
      selectedQuality: selected && String(selected.id) || selectedQuality,
      qualityLabel: selected && selected.label || '',
      qualities,
      proxyVideoUrl: selected && selected.proxyVideoUrl || (source.videoUrl ? register(source.videoUrl, 'video', source.videoUrls) : ''),
      proxyAudioUrl: register(source.audioUrl, 'audio', source.audioUrls),
      durationMs,
      multipart: multipartSongs.length > 1,
      parts: jsonClone(multipartSongs),
      totalDurationMs: multipartSongs.reduce((total, part) => {
        return total + (Number(part && (part.durationMs || part.duration) || 0) || 0);
      }, 0),
      headers,
      validated: !!audioProbe,
      videoAvailable: !!(source.videoUrl && videoProbe),
      videoContentType: String(videoProbe && videoProbe.contentType || 'video/mp4'),
      audioContentType: String(audioProbe && audioProbe.contentType || 'audio/mp4'),
      resolvedSong: jsonClone(resolvedSong),
      android: {
        player: 'ExoPlayer',
        streamType: 'dash-separated',
        videoUrl: String(source.videoUrl),
        audioUrl: String(source.audioUrl),
        headers,
      },
    };
  }

  async resolveBilibiliAudio(song, quality) {
    await this.ready;
    const pluginId = String(song && song.musicFreePluginId || '');
    if (!pluginId) throw new Error('BILIBILI_AUDIO_PLUGIN_MISSING');
    const runtime = this.runtime(pluginId);
    const runtimePlatform = String(runtime.platform || runtime.label || '').toLowerCase();
    if (runtimePlatform !== 'bilibili') throw new Error('BILIBILI_AUDIO_REQUIRES_BILIBILI_PLUGIN');
    // A Bilibili video plugin's generic getMediaSource can describe a short
    // music preview and therefore report a 3–4 minute placeholder duration
    // even when the source video is a multi-hour collection. Always derive
    // audio-only playback from the same getVideoSource/DASH response used by
    // VideoPlayer. This keeps the full source duration and never changes to a
    // different MusicFree provider.
    const strictSong = Object.assign({}, song, {
      provider: 'musicfree', source: 'musicfree', musicFreePluginId: pluginId,
      musicFreePlatform: 'bilibili', mediaType: 'video',
      musicFreeFallbackPolicy: 'source-only', musicFreeSourceOnly: true,
      musicFreeAlternates: [],
    });
    const videoResult = await this.resolveVideo(strictSong, quality || 'auto');
    if (!videoResult || !videoResult.proxyAudioUrl) throw new Error('BILIBILI_AUDIO_SOURCE_UNAVAILABLE');
    return {
      provider: 'musicfree',
      source: runtime.label,
      label: runtime.label,
      level: 'original',
      requestedLevel: 'original',
      availableQualities: [],
      autoHighest: false,
      originalQuality: true,
      url: String(videoResult.android && videoResult.android.audioUrl || ''),
      proxyUrl: String(videoResult.proxyAudioUrl),
      mediaType: String(videoResult.audioContentType || 'audio/mp4'),
      validated: !!videoResult.validated,
      durationMs: Math.max(0, Number(videoResult.durationMs || 0) || 0),
      multipart: !!videoResult.multipart,
      parts: videoResult.parts || [],
      totalDurationMs: Math.max(0, Number(videoResult.totalDurationMs || 0) || 0),
      resolvedSong: videoResult.resolvedSong || null,
      audioOnly: true,
      sourceOnly: true,
      fallbackUsed: false,
      attemptedSources: 1,
    };
  }

  async diagnose(pluginId, query = '稻香') {
    await this.ready;
    const runtime = this.runtime(pluginId);
    const startedAt = Date.now();
    const checks = {};
    let song = null;
    const run = async (name, factory) => {
      const start = Date.now();
      try {
        const detail = await factory();
        checks[name] = { ok: true, durationMs: Date.now() - start, detail };
        return detail;
      } catch (error) {
        checks[name] = { ok: false, durationMs: Date.now() - start, error: error && error.message || String(error) };
        return null;
      }
    };
    if (runtime.adapter.has('search')) {
      const search = await run('search', async () => {
        const result = await timedPluginCall(() => runtime.adapter.search(String(query || '稻香'), 1, 'music'), 12000);
        if (!result.items.length) throw new Error('EMPTY_SEARCH_RESULT');
        song = this.toMineradioSong(result.items[0], runtime);
        return { count: result.items.length, track: { title: song.title, artist: song.artist } };
      });
      if (!search) song = null;
    } else checks.search = { ok: false, durationMs: 0, error: 'CAPABILITY_UNSUPPORTED' };
    if (song) {
      await run('play', async () => {
        const media = await this.resolveMedia(song, 'auto');
        if (!media.url || !media.validated) throw new Error(media.error || 'MEDIA_UNAVAILABLE');
        return { level: media.level, mediaType: media.mediaType, source: media.source };
      });
      await run('lyrics', async () => {
        const lyric = await this.lyric(song);
        if (!lyric.validated) throw new Error('LYRIC_UNAVAILABLE');
        return { source: lyric.source, length: String(lyric.lyric || '').length, fallback: lyric.fallback };
      });
      await run('cover', async () => {
        if (!song.cover) throw new Error('COVER_UNAVAILABLE');
        const response = await fetch(song.cover, { method: 'GET', headers: { Range: 'bytes=0-1' }, signal: AbortSignal.timeout(7000) });
        const contentType = String(response.headers.get('content-type') || '');
        if (response.body) response.body.cancel().catch(() => {});
        if (!response.ok || (!/^image\//i.test(contentType) && contentType)) throw new Error('COVER_INVALID');
        return { contentType };
      });
    }
    return {
      pluginId: runtime.id,
      label: runtime.label,
      platform: runtime.platform,
      ok: !!(checks.search && checks.search.ok && checks.play && checks.play.ok),
      durationMs: Date.now() - startedAt,
      checks,
      runtime: runtime.isolated ? runtime.isolated.diagnostics() : null,
    };
  }

  lyricResolveCacheKey(song) {
    const wanted = lyricSongIdentity(song || {});
    const pluginId = String(song && song.musicFreePluginId || '');
    const original = this.originalItem(song || {});
    const id = String(original && (original.id || original.mid || original.hash || original.songmid || original.rid) || '');
    return [pluginId, id, wanted.title, wanted.artist, Math.round(Number(wanted.duration) || 0)].join('|').toLowerCase();
  }

  async lyric(song) {
    await this.ready;
    const key = this.lyricResolveCacheKey(song);
    const cached = this.lyricResolveCache.get(key);
    const ttl = cached && cached.data && cached.data.validated ? LYRIC_RESOLVE_CACHE_TTL_MS : LYRIC_RESOLVE_MISS_TTL_MS;
    if (cached && cached.data && Date.now() - cached.createdAt < ttl) return jsonClone(cached.data) || cached.data;
    if (cached) this.lyricResolveCache.delete(key);
    if (this.lyricResolvePending.has(key)) return this.lyricResolvePending.get(key);
    const pending = this._lyricUncached(song).then(data => {
      this.lyricResolveCache.set(key, { data: jsonClone(data) || data, createdAt: Date.now() });
      if (this.lyricResolveCache.size > 1000) this.lyricResolveCache.delete(this.lyricResolveCache.keys().next().value);
      return data;
    }).finally(() => this.lyricResolvePending.delete(key));
    this.lyricResolvePending.set(key, pending);
    return pending;
  }

  async _lyricUncached(song) {
    await this.ready;
    const requestedPluginId = String(song && song.musicFreePluginId || '');
    const requestedRuntime = requestedPluginId ? this.plugins.get(requestedPluginId) : null;
    const sourceOnly = String(song && song.musicFreeFallbackPolicy || requestedRuntime && requestedRuntime.fallbackPolicy || '').toLowerCase() === 'source-only';
    const wanted = lyricSongIdentity(song);
    const tried = new Set();
    const failures = [];

    const inlineBody = cleanLyricBody(lyricText(song));
    if (usableLyricBody(inlineBody)) {
      return {
        lyric: inlineBody, tlyric: cleanLyricBody(translationText(song)),
        source: String(song && (song.musicFreeLabel || song.sourceLabel || '歌曲内嵌') || '歌曲内嵌'),
        fallback: false, resolvedSong: jsonClone(song), validated: true,
        attemptedSources: 0, failures: [],
      };
    }

    const inspect = async (candidate, runtime, searched) => {
      const item = this.originalItem(candidate);
      const itemId = String(item && (item.id || item.mid || item.hash || item.songmid || item.rid) || '');
      const attemptKey = runtime.id + ':' + (itemId || safeId(JSON.stringify(item)));
      if (tried.has(attemptKey)) return null;
      tried.add(attemptKey);

      const validate = result => {
        const body = cleanLyricBody(lyricText(result) || lyricText(item));
        if (!usableLyricBody(body)) return null;
        const normalizedCandidate = this.toMineradioSong(item, runtime);
        const identityScore = lyricCandidateMatchScore(normalizedCandidate, wanted);
        if (identityScore < 55) return null;
        const timelineScore = lyricTimelineCompatibilityScore(body, wanted.duration);
        if (timelineScore <= -85) return null;
        const translated = cleanLyricBody(translationText(result) || translationText(item));
        return {
          lyric: body,
          tlyric: usableLyricBody(translated) ? translated : '',
          sourceRuntime: runtime,
          resolvedSong: normalizedCandidate,
          score: identityScore + lyricBodyScore(body) + timelineScore + (searched ? 0 : 18),
        };
      };

      let lastError = null;
      if (runtime.adapter.has('getLyric')) {
        try {
          const result = await timedPluginCall(() => runtime.adapter.call('getLyric', item), 3500);
          const found = validate(result);
          if (found) return found;
        } catch (error) { lastError = error; }
      } else {
        const found = validate(item);
        if (found) return found;
      }

      if (runtime.adapter.has('getMusicInfo')) {
        try {
          const detail = await timedPluginCall(() => runtime.adapter.call('getMusicInfo', item), 2500);
          if (detail && typeof detail === 'object') Object.assign(item, detail);
          if (runtime.adapter.has('getLyric')) {
            const result = await timedPluginCall(() => runtime.adapter.call('getLyric', item), 3500);
            const found = validate(result);
            if (found) return found;
          } else {
            const found = validate(item);
            if (found) return found;
          }
        } catch (error) { lastError = error; }
      }
      failures.push({ source: runtime.label, error: lastError && lastError.message || 'EMPTY_LYRIC' });
      return null;
    };

    const tasks = [];
    let winnerChosen = false;
    const direct = [song].concat(!sourceOnly && Array.isArray(song && song.musicFreeAlternates) ? song.musicFreeAlternates : []).filter(Boolean);
    for (const candidate of direct) {
      try {
        const runtime = this.runtime(candidate && candidate.musicFreePluginId);
        tasks.push(inspect(candidate, runtime, false).then(found => {
          if (!found) throw new Error('DIRECT_LYRIC_UNAVAILABLE');
          return found;
        }));
      } catch (_) { }
    }

    if (!sourceOnly) {
      const query = [wanted.title, wanted.artist].filter(Boolean).join(' ').trim();
      const searchable = Array.from(this.plugins.values()).filter(runtime => runtime.adapter.has('search'));
      for (const runtime of searchable) {
        tasks.push((async () => {
          // Give the original plugin a very short head start. Healthy sources
          // normally answer within this window, avoiding unnecessary global
          // searches; slow or broken sources still trigger parallel fallback.
          await new Promise(resolve => setTimeout(resolve, 220));
          if (winnerChosen) throw new Error('LYRIC_ALREADY_RESOLVED');
          const supported = Array.isArray(runtime.plugin.supportedSearchType) ? runtime.plugin.supportedSearchType.map(String) : [];
          const searchType = supported.includes('lyric') ? 'lyric' : 'music';
          const response = await timedPluginCall(() => runtime.adapter.search(query, 1, searchType), 3500);
          const ranked = response.items
            .map(item => ({ item, score: lyricCandidateMatchScore(this.toMineradioSong(item, runtime), wanted) }))
            .filter(entry => entry.score >= 55)
            .sort((a, b) => b.score - a.score)
            .slice(0, 3);
          for (const entry of ranked) {
            const found = await inspect(this.toMineradioSong(entry.item, runtime), runtime, true);
            if (found) return found;
          }
          throw new Error('SEARCHED_LYRIC_UNAVAILABLE');
        })());
      }
    }

    let best = null;
    try { best = tasks.length ? await Promise.any(tasks) : null; }
    catch (_) { best = null; }
    finally { winnerChosen = true; }
    return {
      lyric: best ? best.lyric : '',
      tlyric: best ? best.tlyric : '',
      source: best ? best.sourceRuntime.label : '',
      fallback: !!(best && best.sourceRuntime.id !== requestedPluginId),
      resolvedSong: best ? best.resolvedSong : null,
      validated: !!best,
      attemptedSources: tried.size,
      failures,
    };
  }

  async proxyAudio(req, res, token) {
    this.purgeAudioTokens();
    const entry = this.audioTokens.get(String(token || ''));
    if (!entry) {
      res.writeHead(404, { 'Cache-Control': 'no-store' });
      res.end('MusicFree audio token expired');
      return;
    }
    const headers = Object.assign({}, entry.headers || {});
    if (req.headers.range) headers.Range = req.headers.range;
    const upstream = await fetch(entry.url, { headers, signal: AbortSignal.timeout(15000) });
    const out = {
      'Content-Type': upstream.headers.get('content-type') || 'audio/mpeg',
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': upstream.headers.get('accept-ranges') || 'bytes',
      'Cache-Control': 'no-store',
    };
    for (const key of ['content-length', 'content-range']) {
      const value = upstream.headers.get(key);
      if (value) out[key === 'content-length' ? 'Content-Length' : 'Content-Range'] = value;
    }
    res.writeHead(upstream.status, out);
    if (!upstream.body) { res.end(); return; }
    const reader = upstream.body.getReader();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (!res.write(chunk.value)) await new Promise(resolve => res.once('drain', resolve));
      }
      res.end();
    } catch (error) {
      try { await reader.cancel(); } catch (_) { }
      if (!res.headersSent) res.writeHead(502);
      res.end();
    }
  }

  async proxyVideo(req, res, token) {
    this.purgeVideoTokens();
    const entry = this.videoTokens.get(String(token || ''));
    if (!entry) {
      res.writeHead(404, { 'Cache-Control': 'no-store' });
      res.end('MusicFree video token expired');
      return;
    }
    const headers = Object.assign({}, entry.headers || {});
    if (req.headers.range) headers.Range = req.headers.range;
    const candidates = (Array.isArray(entry.urls) && entry.urls.length ? entry.urls : [entry.url]).filter(Boolean);
    let upstream = null;
    for (const candidate of candidates) {
      try {
        const response = await fetch(candidate, { headers, signal: AbortSignal.timeout(6500) });
        if (response.ok || response.status === 206) { upstream = response; break; }
        if (response.body) response.body.cancel().catch(() => {});
      } catch (_) { }
    }
    if (!upstream) {
      res.writeHead(502, { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
      res.end('Bilibili stream unavailable');
      return;
    }
    const out = {
      'Content-Type': upstream.headers.get('content-type') || (entry.kind === 'audio' ? 'audio/mp4' : 'video/mp4'),
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': upstream.headers.get('accept-ranges') || 'bytes',
      'Cache-Control': 'no-store',
    };
    for (const key of ['content-length', 'content-range']) {
      const value = upstream.headers.get(key);
      if (value) out[key === 'content-length' ? 'Content-Length' : 'Content-Range'] = value;
    }
    res.writeHead(upstream.status, out);
    if (!upstream.body) { res.end(); return; }
    const reader = upstream.body.getReader();
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        if (!res.write(chunk.value)) await new Promise(resolve => res.once('drain', resolve));
      }
      res.end();
    } catch (_) {
      try { await reader.cancel(); } catch (_) { }
      if (!res.headersSent) res.writeHead(502);
      res.end();
    }
  }
}

module.exports = {
  MusicFreePluginHost,
  DEFAULT_MANIFEST_URL,
};
