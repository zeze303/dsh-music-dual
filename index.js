/**
 * @dsh-external/dsh-music-dual — host half.
 *
 * Dual-platform music player for DeepSeek Harness: NetEase Cloud Music
 * (netease) + QQ Music (qq). Owns the playback state machine (queue, index,
 * playing, volume, mode), exposes it to the browser player over REST routes
 * on the web server, and gives the agent a `music` tool so the model can
 * queue songs, skip, pause, and adjust volume while chatting.
 *
 * No persistence by design: every load starts fresh, and the default library
 * is the configured NetEase Cloud Music playlist, fetched at startup (with a
 * built-in offline fallback). The browser player polls `/dsh-music/state` and
 * posts intents to `/dsh-music/command`; tool calls mutate the same state.
 *
 * Platform notes:
 * - NetEase: prefers the `NeteaseCloudMusicApi` npm package for signed
 *   endpoints (cloudsearch / playlist_track_all / song_url_v1 / login_status).
 *   When the package is absent the plugin falls back to the anonymous web API
 *   (search/playlist) + Meting + outer-link stream resolvers.
 * - QQ Music: self-contained implementation (no third-party package): signed
 *   mobile search (zzc signature), playlist detail via fcg_ucc_getcdinfo_byids_cp,
 *   playback via the vkey.GetVkeyServer protocol with optional DSH_MUSIC_QQ_COOKIE.
 * - Both platforms probe the resolved stream URL with an 8KB Range request
 *   (status + content-type + audio magic) before trusting it.
 *
 * @module
 */
import { defineTool } from "@deepseek-ai/dsh-tools";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { join } from "node:path";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

export const name = "dsh-music-dual";
export const inject = ["webServer", "tools"];

// ── Shared platform constants ────────────────────────────────────────────────

/** Chrome-like browser identity (NetEase web endpoints, QQ stream proxy). */
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
/** Android QQMusic identity for the signed mobile search endpoint. */
const QQ_ANDROID_UA = "QQMusic 14090508(android 12)";
const NETEASE_REFERER = "https://music.163.com/";
const QQ_REFERER = "https://y.qq.com/";

/** Runtime NetEase cookie (e.g. MUSIC_U=...). Starts from DSH_MUSIC_COOKIE,
 * may be replaced by QR/manual login in the browser and persisted to DSH_HOME. */
let neteaseCookie = process.env.DSH_MUSIC_COOKIE ?? "";
/** Runtime QQ Music cookie (uin=...; qm_keyst=...). Same lifecycle as above. */
let qqCookie = process.env.DSH_MUSIC_QQ_COOKIE ?? "";
/** Cookie persistence file under DSH_HOME (keeps runtime logins across restarts). */
const COOKIE_STORE_FILE = process.env.DSH_HOME ? join(process.env.DSH_HOME, "dsh-music-cookies.json") : "";
/** Refresh the module-level cookie from the persisted store (environment wins). */
function loadCookies() {
	if (COOKIE_STORE_FILE === "") return;
	try {
		const raw = JSON.parse(readFileSync(COOKIE_STORE_FILE, "utf8"));
		if (process.env.DSH_MUSIC_COOKIE ?? "" === "") neteaseCookie = typeof raw.netease === "string" ? raw.netease : neteaseCookie;
		if (process.env.DSH_MUSIC_QQ_COOKIE ?? "" === "") qqCookie = typeof raw.qq === "string" ? raw.qq : qqCookie;
	} catch {
		/* no store yet */
	}
}
/** Persist the module-level cookies (runtime logins survive restarts). */
function saveCookies() {
	if (COOKIE_STORE_FILE === "") return;
	try {
		mkdirSync(process.env.DSH_HOME, { recursive: true });
		writeFileSync(COOKIE_STORE_FILE, JSON.stringify({ netease: neteaseCookie, qq: qqCookie }, null, 2), "utf8");
	} catch {
		/* store write failure is non-fatal */
	}
}

/** A streamable NetEase track URL served by this plugin. */
const neteaseStreamUrl = (id) => `/dsh-music/netease/stream?id=${encodeURIComponent(id)}`;
/** A streamable QQ Music track URL served by this plugin. */
const qqStreamUrl = (mid, mediaMid) =>
	`/dsh-music/qq/stream?id=${encodeURIComponent(mid)}${mediaMid ? `&mediaMid=${encodeURIComponent(mediaMid)}` : ""}`;

/**
 * The built-in library is a NetEase Cloud Music playlist, configured through
 * the DSH_MUSIC_PLAYLIST environment variable (a playlist id or share link).
 * On startup the plugin loads it as the default queue; without a configured
 * playlist the queue starts empty and can be filled via the player UI or the
 * agent tool.
 */
const DEFAULT_PLAYLIST_ID = process.env.DSH_MUSIC_PLAYLIST ?? "";

/** Built-in default tracks: filled from the configured playlist at startup. */
let BUILTIN_TRACKS = [];

// ── Optional NeteaseCloudMusicApi package (lazy; falls back when missing) ────

let neteaseApiPromise = null;
/** Resolve the NeteaseCloudMusicApi module once; null when unavailable. */
function neteaseApiModule() {
	if (!neteaseApiPromise) {
		neteaseApiPromise = import("NeteaseCloudMusicApi")
			.then((mod) => mod?.default ?? mod ?? null)
			.catch(() => null);
	}
	return neteaseApiPromise;
}

/** Refresh the built-in library from the configured playlist. */
async function refreshBuiltinTracks() {
	if (DEFAULT_PLAYLIST_ID === "") return;
	try {
		const playlist = await neteasePlaylist(DEFAULT_PLAYLIST_ID);
		if (playlist.tracks.length === 0) return;
		BUILTIN_TRACKS = playlist.tracks.map((row) => ({
			id: `netease-${row.id}`,
			platform: "netease",
			title: row.name,
			artist: row.artist,
			cover: row.cover,
			url: neteaseStreamUrl(row.id)
		}));
	} catch {
		/* keep the empty queue; the player can still import playlists manually */
	}
}

/** Playback modes. */
const MODES = ["list", "single", "shuffle"];

/** Music platforms. */
const PLATFORMS = ["netease", "qq"];

/** Clamp a number into [0, 1]. */
const clamp01 = (value) => Math.min(1, Math.max(0, Number(value) || 0));

/** Compose the queue: built-ins first (when enabled), then session custom tracks. */
function composeQueue(custom, useBuiltin) {
	return [...(useBuiltin ? BUILTIN_TRACKS : []), ...custom];
}

/** Fresh state on every load: no persistence, the default library is the playlist. */
function defaultState() {
	return {
		queue: [...BUILTIN_TRACKS],
		index: 0,
		playing: false,
		volume: 0.8,
		mode: "list",
		custom: [],
		useBuiltin: true,
		version: 1
	};
}

/** Write the client-facing subset of the state. */
function publicState(state) {
	return {
		queue: state.queue.map(({ id, platform, title, artist, url, cover }) => ({ id, platform, title, artist, url, cover })),
		index: state.index,
		playing: state.playing,
		volume: state.volume,
		mode: state.mode,
		builtin: state.useBuiltin,
		version: state.version
	};
}

/** Apply one command intent to the state machine. */
async function applyCommand(state, command) {
	const { action } = command;
	const len = state.queue.length;
	switch (action) {
		case "play": {
			const target = Number(command.index);
			if (Number.isInteger(target) && target >= 0 && target < len) state.index = target;
			state.playing = true;
			break;
		}
		case "pause":
			state.playing = false;
			break;
		case "toggle":
			state.playing = !state.playing;
			break;
		case "next":
			if (len > 0) state.index = nextIndex(state, +1);
			state.playing = true;
			break;
		case "prev":
			if (len > 0) state.index = (state.index - 1 + len) % len;
			state.playing = true;
			break;
		case "ended":
			// Natural end of a track: single mode replays, others advance.
			if (state.mode === "single" || len === 0) {
				state.playing = state.mode === "single";
			} else {
				state.index = nextIndex(state, +1);
				state.playing = true;
			}
			break;
		case "volume":
			state.volume = clamp01(command.volume);
			break;
		case "mode":
			if (MODES.includes(command.mode)) state.mode = command.mode;
			break;
		case "add": {
			const url = typeof command.url === "string" ? command.url.trim() : "";
			const isExternal = /^https?:\/\/\S+$/.test(url);
			const isLocal = /^\/dsh-music\/\S*$/.test(url);
			if (!isExternal && !isLocal) return { ok: false, message: "需要 http(s) 音频直链或站内音乐链接" };
			const platform = (typeof command.platform === "string" && PLATFORMS.includes(command.platform))
				? command.platform
				: (url.includes("/qq/") ? "qq" : (url.includes("/netease/") ? "netease" : ""));
			const track = {
				id: `custom-${Date.now().toString(36)}`,
				platform,
				title: (typeof command.title === "string" && command.title.trim() !== ""
					? command.title.trim()
					: url.split("/").pop() || url).slice(0, 120),
				artist: "自定义",
				url
			};
			state.custom.push(track);
			state.queue = composeQueue(state.custom, state.useBuiltin);
			state.version += 1;
			return { ok: true, message: `已添加「${track.title}」到播放列表` };
		}
		case "remove": {
			const target = Number(command.index);
			if (!Number.isInteger(target) || target < 0 || target >= len) return { ok: false, message: "索引无效" };
			const removed = state.queue[target];
			state.custom = state.custom.filter((track) => track.id !== removed.id);
			state.queue = composeQueue(state.custom, state.useBuiltin);
			if (state.index > target) state.index -= 1;
			else if (state.index === target && state.queue.length > 0) state.index = state.index % state.queue.length;
			if (state.queue.length === 0) {
				state.index = 0;
				state.playing = false;
			}
			state.version += 1;
			return { ok: true, message: `已移除「${removed.title}」` };
		}
		case "importPlaylist": {
			const raw = typeof command.id === "string" ? command.id.trim() : "";
			const platform = command.platform === "qq" ? "qq" : "netease";
			const id = platform === "qq" ? parseQQPlaylistId(raw) : parsePlaylistId(raw);
			if (id === void 0) return { ok: false, message: "歌单 id 或链接无效" };
			const playlist = platform === "qq" ? await qqPlaylist(id) : await neteasePlaylist(id);
			if (playlist.tracks.length === 0) return { ok: false, message: "歌单为空、不可访问或已失效" };
			state.custom = playlist.tracks.map((row) => platform === "qq"
				? {
					id: `qq-${row.id}`,
					platform: "qq",
					title: row.name,
					artist: row.artist,
					cover: row.cover,
					url: qqStreamUrl(row.id, row.mediaMid)
				}
				: {
					id: `netease-${row.id}`,
					platform: "netease",
					title: row.name,
					artist: row.artist,
					cover: row.cover,
					url: neteaseStreamUrl(row.id)
				});
			state.useBuiltin = command.clear === false;
			state.queue = composeQueue(state.custom, state.useBuiltin);
			// Random start support: explicit shuffle, or already in shuffle mode.
			if (command.shuffle === true || state.mode === "shuffle") {
				state.mode = "shuffle";
				state.index = state.queue.length > 0 ? Math.floor(Math.random() * state.queue.length) : 0;
			} else {
				state.index = 0;
			}
			state.playing = true;
			state.version += 1;
			return {
				ok: true,
				message: `已导入${platform === "qq" ? " QQ 音乐" : "网易云"}歌单「${playlist.name}」（${playlist.tracks.length} 首）${state.useBuiltin ? "" : "，默认歌单已隐藏"}，开始播放第一首`
			};
		}
		case "builtin": {
			state.useBuiltin = command.enable === true;
			state.queue = composeQueue(state.custom, state.useBuiltin);
			state.version += 1;
			return { ok: true, message: state.useBuiltin ? "已恢复默认歌单" : "已隐藏默认歌单" };
		}
		case "reset":
			state.custom = [];
			state.useBuiltin = true;
			state.queue = composeQueue(state.custom, state.useBuiltin);
			state.index = 0;
			state.playing = false;
			state.version += 1;
			return { ok: true, message: "播放列表已重置为默认歌单" };
		default:
			return { ok: false, message: `未知操作: ${String(action)}` };
	}
	state.version += 1;
	return { ok: true, message: "ok" };
}

/** Advance index by one step honoring the playback mode. */
function nextIndex(state, step) {
	const len = state.queue.length;
	if (len === 0) return 0;
	if (state.mode === "shuffle") {
		if (len === 1) return 0;
		let next = state.index;
		while (next === state.index) next = Math.floor(Math.random() * len);
		return next;
	}
	return (state.index + step + len) % len;
}

/** Write a JSON response. */
function json(res, body, status = 200) {
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store"
	});
	res.end(JSON.stringify(body));
}

/** Collect the request body as text. */
function readBody(req) {
	return new Promise((resolve, reject) => {
		let data = "";
		req.on("data", (chunk) => {
			data += chunk;
			if (data.length > 1e6) {
				req.destroy();
				reject(new Error("body too large"));
			}
		});
		req.on("end", () => resolve(data));
		req.on("error", reject);
	});
}

/** Find a queue entry whose title matches the query. */
function findTrack(state, query) {
	const needle = query.trim().toLowerCase();
	if (needle === "") return void 0;
	return state.queue.find((track) => track.title.toLowerCase().includes(needle))
		?? state.queue.find((track) => track.artist.toLowerCase().includes(needle));
}

/** Format the queue as one line per track. */
function renderQueue(state) {
	return state.queue.map((track, i) => {
		const marker = i === state.index ? (state.playing ? "▶" : "⏸") : " ";
		const tag = track.platform === "qq" ? "[QQ]" : (track.platform === "netease" ? "[网易云]" : "");
		return `${marker} ${tag} [${i}] ${track.title} — ${track.artist}`;
	}).join("\n") || "（播放列表为空）";
}

// ── Audio URL probing (8KB Range verification for both platforms) ────────────

/** Audio container magic detection on a probe buffer. */
function audioMagic(buffer) {
	if (!buffer || buffer.length < 3) return "";
	if (buffer.subarray(0, 3).toString("ascii") === "ID3") return "mp3";
	if (buffer.length >= 4 && buffer.subarray(0, 4).toString("ascii") === "fLaC") return "flac";
	if (buffer.length >= 4 && buffer.subarray(0, 4).toString("ascii") === "OggS") return "ogg";
	if (buffer.length >= 12 && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WAVE") return "wave";
	if (buffer.length >= 12 && buffer.subarray(4, 8).toString("ascii") === "ftyp") return "mp4";
	const scan = Math.min(buffer.length - 1, 2048);
	for (let i = 0; i < scan; i++) {
		if (buffer[i] === 0xff && (buffer[i + 1] & 0xe0) === 0xe0) return "mpeg";
	}
	return "";
}

/** Probe one audio URL with a small Range request; resolves to true when it
 * looks like real playable audio (200/206, ≥512 bytes, non-text, audio magic). */
async function probeAudioUrl(url, headers, timeoutMs = 3000) {
	try {
		const res = await fetch(url, {
			headers: { ...headers, range: "bytes=0-8191" },
			signal: AbortSignal.timeout(timeoutMs)
		});
		if (res.status !== 200 && res.status !== 206) return false;
		const contentType = String(res.headers.get("content-type") || "").toLowerCase();
		if (/text\/html|application\/(json|xml)|text\/plain/.test(contentType)) return false;
		const buffer = Buffer.from(await res.arrayBuffer());
		return buffer.length >= 512 && audioMagic(buffer) !== "";
	} catch {
		return false;
	}
}

// ── NetEase Cloud Music integration ──────────────────────────────────────────

/** NetEase cache (30s search, 5min playlist, 8min stream). */
const neteaseCache = new Map();

/** Issue an http(s) request choosing the module by protocol. */
function agentRequest(url, headers) {
	return url.startsWith("https:")
		? httpsRequest(url, { headers })
		: httpRequest(url, { headers });
}

/** Map a NetEase song row to the plugin's song shape. */
function mapNeteaseSong(song) {
	const artists = Array.isArray(song.artists ?? song.ar)
		? (song.artists ?? song.ar).map((artist) => artist?.name ?? "").filter(Boolean)
		: [];
	return {
		id: String(song.id ?? ""),
		name: String(song.name ?? "未知歌曲"),
		artist: artists.length > 0 ? artists.join(" / ") : "未知歌手",
		album: (song.album ?? song.al)?.name ?? "",
		cover: typeof (song.album ?? song.al)?.picUrl === "string" && (song.album ?? song.al)?.picUrl !== ""
			? `${(song.album ?? song.al)?.picUrl}?param=160y160`
			: "",
		durationMs: typeof song.duration === "number" ? song.duration : (typeof song.dt === "number" ? song.dt : 0)
	};
}

/** Search NetEase Cloud Music. Prefers the NeteaseCloudMusicApi package
 * (cloudsearch), falls back to the anonymous web API. Cached 30s. */
async function neteaseSearch(query, limit = 20) {
	const key = `ns:${query}:${limit}`;
	const cached = neteaseCache.get(key);
	if (cached !== void 0 && Date.now() - cached.at < 30_000) return cached.rows;
	let rows = [];
	const api = await neteaseApiModule();
	if (api && typeof api.cloudsearch === "function") {
		try {
			const result = await api.cloudsearch({ keywords: query, limit, offset: 0, cookie: neteaseCookie });
			const songs = result?.body?.result?.songs;
			if (Array.isArray(songs)) {
				rows = songs.map(mapNeteaseSong).filter((s) => s.id);
			}
		} catch {
			/* fall through to the anonymous API */
		}
	}
	if (rows.length === 0) {
		const encoded = encodeURIComponent(query);
		const attempts = [
			`https://music.163.com/api/search/get/web?s=${encoded}&type=1&limit=${limit}&offset=0`,
			`https://music.163.com/api/search/get?s=${encoded}&type=1&limit=${limit}&offset=0`
		];
		for (const url of attempts) {
			try {
				const res = await fetch(url, {
					headers: {
						"user-agent": BROWSER_UA,
						referer: NETEASE_REFERER,
						cookie: "NMTID=00Kf3uH0LvXq0vXq0vXq0vXq0vXq0vXq"
					}
				});
				if (!res.ok) continue;
				const data = await res.json();
				const songs = data?.result?.songs;
				if (!Array.isArray(songs)) continue;
				rows = songs.map(mapNeteaseSong).filter((s) => s.id);
				if (rows.length > 0) break;
			} catch {
				/* try next endpoint */
			}
		}
	}
	neteaseCache.set(key, { rows, at: Date.now() });
	return rows;
}

/** Fetch one NetEase playlist's visible tracks (cached 5 minutes).
 * Prefers the NeteaseCloudMusicApi package (playlist_detail + playlist_track_all),
 * falls back to the anonymous web API. */
async function neteasePlaylist(id) {
	const key = `np:${id}`;
	const cached = neteaseCache.get(key);
	if (cached !== void 0 && Date.now() - cached.at < 300_000) return { name: cached.name, tracks: cached.rows };
	let name = "";
	let rows = [];
	const api = await neteaseApiModule();
	if (api && typeof api.playlist_track_all === "function") {
		try {
			const [metaResult, tracksResult] = await Promise.allSettled([
				api.playlist_detail({ id, cookie: neteaseCookie }),
				api.playlist_track_all({ id, limit: 500, offset: 0, cookie: neteaseCookie })
			]);
			if (metaResult.status === "fulfilled") {
				name = String(metaResult.value?.body?.playlist?.name ?? "");
			}
			const songs = tracksResult.status === "fulfilled"
				? tracksResult.value?.body?.songs
				: void 0;
			if (Array.isArray(songs)) {
				rows = songs.map(mapNeteaseSong).filter((s) => s.id);
			}
		} catch {
			/* fall through to the anonymous API */
		}
	}
	if (rows.length === 0) {
		const encoded = encodeURIComponent(id);
		const attempts = [
			`https://music.163.com/api/v6/playlist/detail?id=${encoded}&limit=500&n=500`,
			`https://music.163.com/api/playlist/detail?id=${encoded}`
		];
		for (const url of attempts) {
			try {
				const res = await fetch(url, {
					headers: {
						"user-agent": BROWSER_UA,
						referer: NETEASE_REFERER,
						cookie: "NMTID=00Kf3uH0LvXq0vXq0vXq0vXq0vXq0vXq"
					}
				});
				if (!res.ok) continue;
				const data = await res.json();
				const playlist = data?.playlist ?? data?.result;
				const tracks = playlist?.tracks;
				if (!Array.isArray(tracks)) continue;
				name = String(playlist?.name ?? "");
				rows = tracks.map(mapNeteaseSong).filter((s) => s.id);
				if (rows.length > 0) break;
			} catch {
				/* try next endpoint */
			}
		}
	}
	neteaseCache.set(key, { name, rows, at: Date.now() });
	return { name, tracks: rows };
}

/** Resolve via the Meting third-party API (matches the blog setup; unlocks tracks outer/url cannot). */
function resolveMetingUrl(id) {
	return new Promise((resolve) => {
		const url = `https://api.injahow.cn/meting/?server=netease&type=url&id=${encodeURIComponent(id)}`;
		const req = agentRequest(url, { "user-agent": BROWSER_UA })
			.on("error", () => resolve(void 0));
		req.setTimeout(10000, () => {
			req.destroy();
			resolve(void 0);
		});
		req.on("response", (res) => {
			if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
				res.resume();
				resolve(res.headers.location);
				return;
			}
			res.resume();
			resolve(void 0);
		});
		req.end();
	});
}

/** Resolve via NetEase's public outer-link endpoint (free tracks). */
function resolveOuterUrl(id) {
	return new Promise((resolve) => {
		const url = `https://music.163.com/song/media/outer/url?id=${encodeURIComponent(id)}.mp3`;
		const req = agentRequest(url, { "user-agent": BROWSER_UA, referer: NETEASE_REFERER })
			.on("error", () => resolve(void 0));
		req.setTimeout(10000, () => {
			req.destroy();
			resolve(void 0);
		});
		req.on("response", (res) => {
			if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
				res.resume();
				resolve(res.headers.location);
				return;
			}
			res.resume();
			resolve(void 0);
		});
		req.end();
	});
}

/** Resolve a playable NetEase CDN url. Priority when the NeteaseCloudMusicApi
 * package is available: song_url_v1 (eapi, level) → song_url (weapi, br),
 * both verified with an 8KB probe. When the package is missing: Meting →
 * outer-link (both probed as well). Returns void when nothing plays. */
async function resolveStreamUrl(id) {
	const key = `nsu:${id}`;
	const cached = neteaseCache.get(key);
	if (cached !== void 0 && Date.now() - cached.at < 480_000) return cached.url;
	const probeHeaders = { "user-agent": BROWSER_UA, referer: NETEASE_REFERER };
	const api = await neteaseApiModule();
	if (api && (typeof api.song_url_v1 === "function" || typeof api.song_url === "function")) {
		const attempts = [];
		if (typeof api.song_url_v1 === "function") {
			for (const level of ["standard", "higher", "exhigh", "lossless"]) {
				attempts.push(() => api.song_url_v1({ id, level, cookie: neteaseCookie }));
			}
		}
		if (typeof api.song_url === "function") {
			for (const br of [320000, 192000, 128000]) {
				attempts.push(() => api.song_url({ id, br, cookie: neteaseCookie }));
			}
		}
		for (const attempt of attempts) {
			try {
				const result = await attempt();
				const data = result?.body?.data?.[0];
				const url = data?.url;
				if (typeof url === "string" && /^https?:\/\//.test(url) && !data?.freeTrialInfo) {
					if (await probeAudioUrl(url, probeHeaders)) {
						neteaseCache.set(key, { url, at: Date.now() });
						return url;
					}
				}
			} catch {
				/* try next quality */
			}
		}
	}
	// Package missing or no playable result: fall back to Meting → outer-link.
	const meting = await resolveMetingUrl(id);
	if (meting !== void 0 && await probeAudioUrl(meting, probeHeaders)) {
		neteaseCache.set(key, { url: meting, at: Date.now() });
		return meting;
	}
	const outer = await resolveOuterUrl(id);
	if (outer !== void 0 && await probeAudioUrl(outer, probeHeaders)) {
		neteaseCache.set(key, { url: outer, at: Date.now() });
		return outer;
	}
	neteaseCache.set(key, { url: void 0, at: Date.now() });
	return void 0;
}

/** NetEase login/profile status derived from the configured cookie (cached 2 min). */
async function neteaseLoginStatus() {
	const key = "nlogin";
	const cached = neteaseCache.get(key);
	if (cached !== void 0 && Date.now() - cached.at < 120_000) return cached.value;
	const hasCookie = neteaseCookie !== "";
	const value = { loggedIn: false, hasCookie, userId: "", nickname: "" };
	if (!hasCookie) {
		neteaseCache.set(key, { value, at: Date.now() });
		return value;
	}
	const api = await neteaseApiModule();
	try {
		if (api && typeof api.login_status === "function") {
			const result = await api.login_status({ cookie: neteaseCookie });
			const profile = result?.body?.data?.profile || {};
			value.loggedIn = result?.body?.data?.account !== null && !!profile?.userId;
			value.userId = String(profile?.userId ?? "");
			value.nickname = String(profile?.nickname ?? "");
		} else if (api && typeof api.user_account === "function") {
			const result = await api.user_account({ cookie: neteaseCookie });
			const profile = result?.body?.profile || {};
			value.loggedIn = !!profile?.userId;
			value.userId = String(profile?.userId ?? "");
			value.nickname = String(profile?.nickname ?? "");
		}
	} catch {
		/* cookie invalid; keep the hasCookie view */
	}
	neteaseCache.set(key, { value, at: Date.now() });
	return value;
}

// ── QQ Music integration ─────────────────────────────────────────────────────

/** Shared cache for QQ lookups (30s search, 5min playlist, 8min stream, 2min login). */
const qqCache = new Map();

/** Parse a cookie header string into an object of name → value. */
function parseCookieString(cookieText) {
	const out = {};
	String(cookieText ?? "")
		.split(";")
		.map((part) => part.trim())
		.filter(Boolean)
		.forEach((part) => {
			const idx = part.indexOf("=");
			if (idx <= 0) return;
			const key = part.slice(0, idx).trim();
			const value = part.slice(idx + 1).trim();
			if (key) out[key] = value;
		});
	return out;
}

/** The configured QQ Music cookie as an object. */
function qqCookieObject() {
	return parseCookieString(qqCookie);
}

/** Extract the QQ account uin from the cookie (digits only). */
function qqCookieUin(obj) {
	obj = obj || qqCookieObject();
	const isWechat = !!obj.wxopenid || Number(obj.login_type) === 2;
	const raw = isWechat ? (obj.wxuin || obj.uin || obj.p_uin) : (obj.uin || obj.qqmusic_uin || obj.wxuin || obj.p_uin);
	return String(raw || "").replace(/\D/g, "").replace(/^0+/, "");
}

/** Extract the QQ Music playback key (qm_keyst/qqmusic_key/music_key/wxskey). */
function qqCookiePlaybackKey(obj) {
	obj = obj || qqCookieObject();
	return obj.qm_keyst || obj.qqmusic_key || obj.music_key || obj.wxskey || "";
}

/** QQ album cover URL from the album mid. */
function qqAlbumCover(albumMid, size) {
	if (!albumMid) return "";
	const px = size || 300;
	return `https://y.qq.com/music/photo_new/T002R${px}x${px}M000${albumMid}.jpg?max_age=2592000`;
}

/** Map QQ artist rows to { mid, name }. */
function mapQQArtists(raw) {
	return (raw || [])
		.map((a) => ({ mid: (a && a.mid) || "", name: (a && (a.name || a.title)) || "" }))
		.filter((a) => a.name);
}

/** Map one QQ track row to the plugin's song shape. */
function mapQQTrack(track, fallback) {
	track = track || {};
	fallback = fallback || {};
	const album = track.album || {};
	const artists = mapQQArtists(track.singer || []);
	const mid = track.mid || fallback.mid || fallback.songmid || "";
	const albumMid = album.mid || album.pmid || "";
	return {
		id: mid,
		mid,
		mediaMid: (track.file && track.file.media_mid) || fallback.mediaMid || "",
		name: track.name || track.title || fallback.name || "未知歌曲",
		artist: artists.map((a) => a.name).join(" / ") || fallback.artist || "未知歌手",
		album: album.name || album.title || fallback.album || "",
		cover: qqAlbumCover(albumMid, 300),
		durationMs: (Number(track.interval) || 0) * 1000
	};
}

/** Map one QQ playlist track row to the plugin's song shape. */
function mapQQPlaylistTrack(raw) {
	raw = raw || {};
	const track = raw.songid || raw.songmid || raw.mid || raw.name ? raw : (raw.track_info || raw.songInfo || raw.song || {});
	const album = track.album || {};
	const artists = mapQQArtists(track.singer || track.singers || []);
	const mid = track.mid || track.songmid || raw.mid || raw.songmid || "";
	const albumMid = album.mid || track.albummid || raw.albummid || "";
	return {
		id: mid,
		mid,
		mediaMid: (track.file && track.file.media_mid) || track.strMediaMid || track.media_mid || raw.strMediaMid || "",
		name: track.name || track.songname || raw.songname || "未知歌曲",
		artist: artists.map((a) => a.name).join(" / ") || track.singername || raw.singername || "未知歌手",
		album: album.name || album.title || track.albumname || raw.albumname || "",
		cover: qqAlbumCover(albumMid, 300),
		durationMs: (Number(track.interval || raw.interval) || 0) * 1000
	};
}

/** QQ search signature: SHA1 scramble + fixed XOR table → zzc... (lowercase). */
function qqSearchSign(text) {
	const hash = createHash("sha1").update(text).digest("hex");
	const part1 = [23, 14, 6, 36, 16, 40, 7, 19].map((index) => hash[index]).join("");
	const part2 = [16, 1, 32, 12, 19, 27, 8, 5].map((index) => hash[index]).join("");
	const scramble = [89, 39, 179, 150, 218, 82, 58, 252, 177, 52, 186, 123, 120, 64, 242, 133, 143, 161, 121, 179];
	const bytes = scramble.map((value, index) => value ^ parseInt(hash.slice(index * 2, index * 2 + 2), 16));
	const middle = Buffer.from(bytes).toString("base64").replace(/[\\/+=]/g, "");
	return `zzc${part1}${middle}${part2}`.toLowerCase();
}

/** POST one payload to the QQ unified music API (musicu.fcg). */
async function qqMusicRequest(payload, useCookie) {
	const body = JSON.stringify(payload);
	const headers = {
		"user-agent": QQ_ANDROID_UA,
		referer: QQ_REFERER,
		"content-type": "application/json;charset=UTF-8",
		"content-length": Buffer.byteLength(body)
	};
	if (useCookie && qqCookie !== "") headers.cookie = qqCookie;
	const res = await fetch("https://u.y.qq.com/cgi-bin/musicu.fcg", {
		method: "POST",
		headers,
		body,
		signal: AbortSignal.timeout(10000)
	});
	if (!res.ok) throw new Error(`QQ musicu HTTP ${res.status}`);
	return res.json();
}

/** QQ song detail via the unified API (used to enrich search rows with mediaMid). */
async function qqSongDetail(mid) {
	const json = await qqMusicRequest({
		comm: { ct: 24, cv: 0 },
		songinfo: {
			module: "music.pf_song_detail_svr",
			method: "get_song_detail_yqq",
			param: { song_mid: mid }
		}
	}, false);
	const data = json?.songinfo?.data;
	return mapQQTrack(data?.track_info, { mid });
}

/** Full QQ Music song search via the signed mobile endpoint. */
async function qqFullSongSearch(query, limit) {
	limit = Math.max(1, Math.min(30, limit || 20));
	const payload = {
		comm: {
			ct: "11", cv: "14090508", v: "14090508", tmeAppID: "qqmusic",
			phonetype: "EBG-AN10", os_ver: "12", OpenUDID: "0", QIMEI36: "0",
			udid: "0", chid: "0", aid: "0", oaid: "0", taid: "0", tid: "0",
			wid: "0", uid: "0", sid: "0", modeSwitch: "6", teenMode: "0",
			ui_mode: "2", nettype: "1020"
		},
		req: {
			module: "music.search.SearchCgiService",
			method: "DoSearchForQQMusicMobile",
			param: {
				search_type: 0,
				searchid: String(Date.now()) + String(Math.random()).slice(2, 8),
				query,
				page_num: 1,
				num_per_page: limit,
				highlight: 0,
				nqc_flag: 0,
				multi_zhida: 0,
				cat: 2,
				grp: 1,
				sin: 0,
				sem: 0
			}
		}
	};
	const bodyText = JSON.stringify(payload);
	const res = await fetch(`https://u.y.qq.com/cgi-bin/musics.fcg?sign=${qqSearchSign(bodyText)}`, {
		method: "POST",
		headers: {
			"user-agent": QQ_ANDROID_UA,
			"content-type": "application/json",
			"content-length": Buffer.byteLength(bodyText)
		},
		body: bodyText,
		signal: AbortSignal.timeout(10000)
	});
	if (!res.ok) throw new Error(`QQ search HTTP ${res.status}`);
	const json = await res.json();
	const data = json?.req?.data;
	const body = data?.body || data;
	const items = body?.item_song || body?.song?.list || body?.list || [];
	return items
		.map((item) => mapQQTrack(item?.track_info || item?.songInfo || item?.songinfo || item?.song || item, {}))
		.filter((song) => song.id && song.name);
}

/** Signature-free QQ smartbox search (fallback when the mobile endpoint fails). */
async function qqSmartboxSearch(query, limit) {
	const u = new URL("https://c.y.qq.com/splcloud/fcgi-bin/smartbox_new.fcg");
	u.searchParams.set("format", "json");
	u.searchParams.set("key", query);
	u.searchParams.set("g_tk", "5381");
	u.searchParams.set("loginUin", "0");
	u.searchParams.set("hostUin", "0");
	u.searchParams.set("inCharset", "utf8");
	u.searchParams.set("outCharset", "utf-8");
	u.searchParams.set("notice", "0");
	u.searchParams.set("platform", "yqq.json");
	u.searchParams.set("needNewCode", "0");
	const res = await fetch(u, {
		headers: { "user-agent": BROWSER_UA, referer: QQ_REFERER },
		signal: AbortSignal.timeout(10000)
	});
	if (!res.ok) throw new Error(`QQ smartbox HTTP ${res.status}`);
	const json = await res.json();
	const items = json?.data?.song?.itemlist || [];
	return items
		.slice(0, Math.max(1, Math.min(limit || 10, 10)))
		.map((item) => ({
			id: item.mid || item.songmid || "",
			mid: item.mid || item.songmid || "",
			mediaMid: "",
			name: item.name || item.title || "未知歌曲",
			artist: item.singer || "未知歌手",
			album: "",
			cover: "",
			durationMs: 0
		}))
		.filter((song) => song.id && song.name);
}

/** Search QQ Music: signed full search + detail enrichment, smartbox fallback
 * (cached 30s). Detail enrichment fills mediaMid (needed for streaming). */
async function qqSearch(query, limit = 20) {
	const key = `qs:${query}:${limit}`;
	const cached = qqCache.get(key);
	if (cached !== void 0 && Date.now() - cached.at < 30_000) return cached.rows;
	let rows = [];
	try {
		rows = await qqFullSongSearch(query, limit);
	} catch {
		/* fall through to smartbox */
	}
	if (rows.length === 0) {
		try {
			rows = await qqSmartboxSearch(query, limit);
		} catch {
			/* empty */
		}
	}
	// Enrich rows that lack mediaMid (streaming needs it for the vkey filename).
	if (rows.length > 0) {
		const enriched = await Promise.all(rows.map(async (row) => {
			if (row.mediaMid) return row;
			try {
				const detail = await qqSongDetail(row.mid);
				if (detail && detail.id) return { ...row, ...detail, id: row.id, mid: row.mid };
			} catch {
				/* keep the base row */
			}
			return row;
		}));
		rows = enriched;
	}
	qqCache.set(key, { rows, at: Date.now() });
	return rows;
}

/** Fetch one QQ playlist's visible tracks (cached 5 minutes). */
async function qqPlaylist(id) {
	const key = `qp:${id}`;
	const cached = qqCache.get(key);
	if (cached !== void 0 && Date.now() - cached.at < 300_000) return { name: cached.name, tracks: cached.rows };
	const uin = qqCookieUin();
	const u = new URL("https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg");
	u.searchParams.set("type", "1");
	u.searchParams.set("utf8", "1");
	u.searchParams.set("disstid", id);
	u.searchParams.set("song_begin", "0");
	u.searchParams.set("song_num", "500");
	u.searchParams.set("loginUin", uin || "0");
	u.searchParams.set("format", "json");
	u.searchParams.set("inCharset", "utf8");
	u.searchParams.set("outCharset", "utf-8");
	u.searchParams.set("notice", "0");
	u.searchParams.set("platform", "yqq.json");
	u.searchParams.set("needNewCode", "0");
	const headers = { "user-agent": BROWSER_UA, referer: "https://y.qq.com/n/yqq/playlist" };
	if (qqCookie !== "") headers.cookie = qqCookie;
	const res = await fetch(u, { headers, signal: AbortSignal.timeout(15000) });
	if (!res.ok) throw new Error(`QQ playlist HTTP ${res.status}`);
	const json = await res.json();
	const detail = json?.cdlist?.[0] || {};
	const rawTracks = Array.isArray(detail.songlist) ? detail.songlist : [];
	const name = String(detail.dissname || detail.diss_name || detail.name || "");
	const rows = rawTracks.map(mapQQPlaylistTrack).filter((s) => s.id && s.name);
	qqCache.set(key, { name, rows, at: Date.now() });
	return { name, tracks: rows };
}

/** QQ quality filename templates (browser-friendly formats first). */
const QQ_QUALITY_TEMPLATES = [
	{ prefix: "M800", ext: ".mp3", level: "exhigh", label: "320k MP3" },
	{ prefix: "M500", ext: ".mp3", level: "standard", label: "128k MP3" },
	{ prefix: "C400", ext: ".m4a", level: "aac", label: "AAC/M4A" }
];
const QQ_STREAM_FALLBACK_SIP = "https://ws.stream.qqmusic.qq.com/";

/** Resolve a playable QQ CDN url via the vkey protocol (CgiGetVkey).
 * Uses the optional logged-in cookie (DSH_MUSIC_QQ_COOKIE); without one only
 * public tracks resolve. Each candidate is verified with an 8KB probe.
 * Returns void when nothing plays. */
async function qqResolveStreamUrl(mid, mediaMid) {
	const mediaIds = [];
	if (mediaMid) mediaIds.push(mediaMid);
	if (mid && !mediaIds.includes(mid)) mediaIds.push(mid);
	const uin = qqCookieUin();
	const musicKey = qqCookiePlaybackKey();
	const candidates = mediaIds.flatMap((mediaId) =>
		QQ_QUALITY_TEMPLATES.map((item) => ({ ...item, mediaId, filename: item.prefix + mediaId + item.ext }))
	);
	const filenames = candidates.map((item) => item.filename);
	const param = {
		guid: String(10000000 + Math.floor(Math.random() * 90000000)),
		songmid: filenames.length ? filenames.map(() => mid) : [mid],
		songtype: filenames.length ? filenames.map(() => 0) : [0],
		uin: uin || "0",
		loginflag: 1,
		platform: "20"
	};
	if (filenames.length) param.filename = filenames;
	const comm = { uin: uin || "0", format: "json", ct: musicKey ? 19 : 24, cv: 0 };
	if (musicKey) comm.authst = musicKey;
	const json = await qqMusicRequest({
		comm,
		req_0: { module: "vkey.GetVkeyServer", method: "CgiGetVkey", param }
	}, true);
	const data = json?.req_0?.data;
	const infos = Array.isArray(data?.midurlinfo) ? data.midurlinfo : [];
	const purlInfos = infos.filter((item) => item && item.purl);
	const sips = Array.isArray(data?.sip) && data.sip.length ? data.sip.filter(Boolean) : [QQ_STREAM_FALLBACK_SIP];
	const probeHeaders = { "user-agent": BROWSER_UA, referer: QQ_REFERER };
	for (const info of purlInfos) {
		for (const sip of sips) {
			const url = String(sip) + String(info.purl);
			if (await probeAudioUrl(url, probeHeaders)) return url;
		}
	}
	return void 0;
}

/** QQ login/profile status derived from the configured cookie (cached 2 min). */
async function qqLoginStatus() {
	const key = "qlogin";
	const cached = qqCache.get(key);
	if (cached !== void 0 && Date.now() - cached.at < 120_000) return cached.value;
	const hasCookie = qqCookie !== "";
	const uin = qqCookieUin();
	const playbackKeyReady = qqCookiePlaybackKey() !== "";
	const value = { loggedIn: false, hasCookie, uin, nickname: "", playbackKeyReady };
	if (!hasCookie || !uin) {
		qqCache.set(key, { value, at: Date.now() });
		return value;
	}
	try {
		const u = new URL("https://c.y.qq.com/rsc/fcgi-bin/fcg_get_profile_homepage.fcg");
		u.searchParams.set("cid", "205360838");
		u.searchParams.set("userid", uin);
		u.searchParams.set("reqfrom", "1");
		u.searchParams.set("g_tk", "5381");
		u.searchParams.set("loginUin", uin);
		u.searchParams.set("hostUin", "0");
		u.searchParams.set("format", "json");
		u.searchParams.set("inCharset", "utf8");
		u.searchParams.set("outCharset", "utf-8");
		u.searchParams.set("notice", "0");
		u.searchParams.set("platform", "yqq.json");
		u.searchParams.set("needNewCode", "0");
		const res = await fetch(u, {
			headers: { "user-agent": BROWSER_UA, referer: QQ_REFERER, cookie: qqCookie },
			signal: AbortSignal.timeout(10000)
		});
		if (res.ok) {
			const json = await res.json().catch(() => null);
			if (!(json && (json.code === 1000 || json.result === 301))) {
				const profile = json?.data?.profile || {};
				const nickname = String(profile.nick || profile.nickname || "");
				if (nickname !== "") value.loggedIn = true;
				value.nickname = nickname;
			}
		}
	} catch {
		/* cookie invalid or unreachable; keep the hasCookie view */
	}
	qqCache.set(key, { value, at: Date.now() });
	return value;
}

// ── Shared audio streaming helpers ───────────────────────────────────────────

/** Write audio response head mirroring the upstream status and range headers. */
function writeAudioHead(res, upstream) {
	res.writeHead(upstream.statusCode ?? 200, {
		"content-type": upstream.headers["content-type"] ?? "audio/mpeg",
		"cache-control": "no-store",
		"accept-ranges": upstream.headers["accept-ranges"] ?? "bytes",
		...(upstream.headers["content-range"] ? { "content-range": upstream.headers["content-range"] } : {}),
		...(upstream.headers["content-length"] ? { "content-length": upstream.headers["content-length"] } : {})
	});
}

/** Pipe one final audio url into the browser response with timeout/abort safety. */
function pipeStream(url, range, res, fail, headers) {
	const h = { ...headers };
	if (typeof range === "string" && range !== "") h.range = range;
	let active;
	// When the browser aborts (seek/skip/reload), tear the upstream down instead
	// of letting it pipe into a dead response and emit unhandled errors.
	res.on("close", () => active?.destroy());
	const req = agentRequest(url, h).on("error", () => fail("音频流获取失败"));
	req.setTimeout(12000, () => {
		req.destroy();
		fail("音频流获取超时");
	});
	active = req;
	req.on("response", (upstream) => {
		if (upstream.statusCode >= 300 && upstream.statusCode < 400 && upstream.headers.location) {
			upstream.resume();
			const next = agentRequest(upstream.headers.location, { ...h })
				.on("error", () => fail("音频流获取失败"));
			next.setTimeout(12000, () => {
				next.destroy();
				fail("音频流获取超时");
			});
			active = next;
			next.on("response", (final) => {
				if (final.statusCode !== 200 && final.statusCode !== 206) {
					final.resume();
					fail(`上游返回 ${final.statusCode}`);
					return;
				}
				final.on("error", () => { /* aborted by client */ });
				writeAudioHead(res, final);
				final.pipe(res);
			});
			next.end();
			return;
		}
		if (upstream.statusCode !== 200 && upstream.statusCode !== 206) {
			upstream.resume();
			fail(`上游返回 ${upstream.statusCode}`);
			return;
		}
		upstream.on("error", () => { /* aborted by client */ });
		writeAudioHead(res, upstream);
		upstream.pipe(res);
	});
	req.end();
}

/** Stream a NetEase track through this host (bypasses browser CORS/anti-leech). */
async function proxyNeteaseStream(id, req, res) {
	const fail = (message) => {
		// The response may already be gone (browser aborted the stream on skip).
		try {
			res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
			res.end(JSON.stringify({ error: message }));
		} catch {
			/* response closed */
		}
	};
	let target;
	try {
		target = await resolveStreamUrl(id);
	} catch {
		target = void 0;
	}
	if (target === void 0) {
		fail("音频流获取失败（免费歌曲可播；VIP/版权歌曲需配置 DSH_MUSIC_COOKIE 或弹窗扫码登录）");
		return;
	}
	pipeStream(target, req.headers.range, res, fail, { "user-agent": BROWSER_UA, referer: NETEASE_REFERER });
}

/** Stream a QQ Music track through this host (vkey resolve + proxy). */
async function proxyQQStream(mid, mediaMid, req, res) {
	const fail = (message) => {
		try {
			res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
			res.end(JSON.stringify({ error: message }));
		} catch {
			/* response closed */
		}
	};
	let target;
	try {
		target = await qqResolveStreamUrl(mid, mediaMid);
	} catch {
		target = void 0;
	}
	if (target === void 0) {
		fail("音频流获取失败（免费歌曲可播；VIP/版权歌曲需配置 DSH_MUSIC_QQ_COOKIE 或粘贴 cookie 登录）");
		return;
	}
	pipeStream(target, req.headers.range, res, fail, { "user-agent": BROWSER_UA, referer: QQ_REFERER });
}

/** Extract a playlist id from a raw NetEase id or share link. */
function parsePlaylistId(raw) {
	const value = String(raw ?? "").trim();
	if (/^\d+$/.test(value)) return value;
	const match = /music\.163\.com\/(?:playlist|#\/playlist)\/?(?:\?id=)?(\d+)/.exec(value);
	return match ? match[1] : void 0;
}

/** Extract a playlist id from a raw QQ id or share link. */
function parseQQPlaylistId(raw) {
	const value = String(raw ?? "").trim();
	if (/^\d+$/.test(value)) return value;
	const match = /y\.qq\.com\/n\/(?:ryqq|yqq)\/playlist\/(\d+)/.exec(value)
		?? /(?:disstid|id)=(\d+)/.exec(value);
	return match ? match[1] : void 0;
}

/**
 * The plugin entry: register the REST surface and the agent tool.
 * @param ctx - host context.
 */
export function apply(ctx) {
	const state = defaultState();

	// Restore runtime-login cookies persisted across restarts (env vars win).
	loadCookies();

	// Load the configured NetEase playlist as the built-in queue at startup.
	refreshBuiltinTracks().then(() => {
		state.queue = composeQueue(state.custom, state.useBuiltin);
		if (state.index >= state.queue.length) state.index = 0;
		state.version += 1;
	});

	// State snapshot for the browser player.
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/dsh-music/state",
		handler: (_req, res) => json(res, publicState(state))
	}));

	// Player intents from the browser.
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/dsh-music/command",
		handler: async (req, res) => {
			try {
				const body = await readBody(req);
				const command = JSON.parse(body || "{}");
				const result = await applyCommand(state, command);
				json(res, { ...publicState(state), result });
			} catch (error) {
				json(res, { error: error instanceof Error ? error.message : String(error) }, 400);
			}
		}
	}));

	// NetEase Cloud Music search proxy (browser cannot call music.163.com directly).
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/dsh-music/netease/search",
		handler: async (req, res) => {
			try {
				const query = new URL(req.url, "http://localhost").searchParams.get("q") ?? "";
				if (query.trim() === "") {
					json(res, { songs: [] });
					return;
				}
				const songs = await neteaseSearch(query.trim(), 20);
				json(res, { songs });
			} catch (error) {
				json(res, { error: error instanceof Error ? error.message : String(error) }, 502);
			}
		}
	}));

	// NetEase Cloud Music playlist proxy.
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/dsh-music/netease/playlist",
		handler: async (req, res) => {
			try {
				const raw = new URL(req.url, "http://localhost").searchParams.get("id") ?? "";
				const id = parsePlaylistId(raw);
				if (id === void 0) {
					json(res, { error: "歌单 id 或链接无效" }, 400);
					return;
				}
				const playlist = await neteasePlaylist(id);
				json(res, { name: playlist.name, tracks: playlist.tracks });
			} catch (error) {
				json(res, { error: error instanceof Error ? error.message : String(error) }, 502);
			}
		}
	}));

	// NetEase Cloud Music audio stream proxy.
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/dsh-music/netease/stream",
		handler: (req, res) => {
			const id = new URL(req.url, "http://localhost").searchParams.get("id") ?? "";
			if (!/^\d+$/.test(id)) {
				json(res, { error: "无效的歌曲 id" }, 400);
				return;
			}
			proxyNeteaseStream(id, req, res);
		}
	}));

	// NetEase login/profile status (cookie validity).
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/dsh-music/netease/login",
		handler: async (_req, res) => {
			try {
				const status = await neteaseLoginStatus();
				json(res, status);
			} catch (error) {
				json(res, { error: error instanceof Error ? error.message : String(error) }, 502);
			}
		}
	}));

	// NetEase QR login: get the unikey.
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/dsh-music/netease/login/qr-key",
		handler: async (_req, res) => {
			try {
				const api = await neteaseApiModule();
				if (!api || typeof api.login_qr_key !== "function") {
					json(res, { error: "NeteaseCloudMusicApi 包不可用，无法使用二维码登录" }, 501);
					return;
				}
				const result = await api.login_qr_key({ timestamp: Date.now() });
				const key = result?.body?.data?.unikey;
				if (!key) {
					json(res, { error: "获取二维码 key 失败" }, 502);
					return;
				}
				json(res, { key });
			} catch (error) {
				json(res, { error: error instanceof Error ? error.message : String(error) }, 502);
			}
		}
	}));

	// NetEase QR login: render the QR image (base64 PNG).
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/dsh-music/netease/login/qr-create",
		handler: async (req, res) => {
			try {
				const key = new URL(req.url, "http://localhost").searchParams.get("key") ?? "";
				if (key === "") {
					json(res, { error: "缺少 key 参数" }, 400);
					return;
				}
				const api = await neteaseApiModule();
				if (!api || typeof api.login_qr_create !== "function") {
					json(res, { error: "NeteaseCloudMusicApi 包不可用" }, 501);
					return;
				}
				const result = await api.login_qr_create({ key, qrimg: true, timestamp: Date.now() });
				const data = result?.body?.data || {};
				json(res, { img: data.qrimg || "", url: data.qrurl || "" });
			} catch (error) {
				json(res, { error: error instanceof Error ? error.message : String(error) }, 502);
			}
		}
	}));

	// NetEase QR login: poll scan status; 803 = authorized (cookie saved).
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/dsh-music/netease/login/qr-check",
		handler: async (req, res) => {
			try {
				const key = new URL(req.url, "http://localhost").searchParams.get("key") ?? "";
				if (key === "") {
					json(res, { error: "缺少 key 参数" }, 400);
					return;
				}
				const api = await neteaseApiModule();
				if (!api || typeof api.login_qr_check !== "function") {
					json(res, { error: "NeteaseCloudMusicApi 包不可用" }, 501);
					return;
				}
				let result = await api.login_qr_check({ key, noCookie: true, timestamp: Date.now() });
				let body = result?.body || {};
				let code = Number(body.code ?? result?.code ?? 0);
				let message = String(body.message ?? result?.message ?? "");
				let cookie = "";
				const extract = (resp) => {
					for (const spot of [resp?.cookie, resp?.body?.cookie, resp?.body?.data?.cookie, resp?.body?.data?.cookies]) {
						if (typeof spot === "string" && spot.includes("=")) return spot;
						if (Array.isArray(spot) && spot.length > 0) return spot.join("; ");
					}
					return "";
				};
				cookie = extract(result);
				if (code === 803 && cookie === "") {
					// Retry once without noCookie — the login cookie usually arrives here.
					try {
						const retry = await api.login_qr_check({ key, timestamp: Date.now() });
						body = retry?.body || body;
						code = Number(body.code ?? retry?.code ?? code);
						message = String(body.message ?? retry?.message ?? message);
						cookie = extract(retry);
					} catch {
						/* keep first attempt */
					}
				}
				if (code === 803 && cookie !== "") {
					neteaseCookie = cookie;
					saveCookies();
					neteaseCache.delete("nlogin");
					const status = await neteaseLoginStatus();
					json(res, { code: 803, message, cookie: true, ...status });
					return;
				}
				json(res, { code, message, nickname: body.nickname ?? "", avatarUrl: body.avatarUrl ?? "" });
			} catch (error) {
				json(res, { error: error instanceof Error ? error.message : String(error) }, 502);
			}
		}
	}));

	// NetEase manual cookie set (paste from a browser).
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/dsh-music/netease/login/cookie",
		handler: async (req, res) => {
			try {
				const body = await readBody(req);
				const parsed = JSON.parse(body || "{}");
				const cookie = typeof parsed.cookie === "string" ? parsed.cookie.trim() : "";
				if (cookie === "") {
					json(res, { error: "cookie 不能为空" }, 400);
					return;
				}
				if (!/\bMUSIC_U=/.test(cookie)) {
					json(res, { error: "cookie 缺少 MUSIC_U（网易云登录凭证）" }, 400);
					return;
				}
				neteaseCookie = cookie;
				saveCookies();
				neteaseCache.delete("nlogin");
				const status = await neteaseLoginStatus();
				json(res, { ok: true, ...status });
			} catch (error) {
				json(res, { error: error instanceof Error ? error.message : String(error) }, 400);
			}
		}
	}));

	// QQ Music search proxy.
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/dsh-music/qq/search",
		handler: async (req, res) => {
			try {
				const query = new URL(req.url, "http://localhost").searchParams.get("q") ?? "";
				if (query.trim() === "") {
					json(res, { songs: [] });
					return;
				}
				const songs = await qqSearch(query.trim(), 20);
				json(res, { songs });
			} catch (error) {
				json(res, { error: error instanceof Error ? error.message : String(error) }, 502);
			}
		}
	}));

	// QQ Music playlist proxy.
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/dsh-music/qq/playlist",
		handler: async (req, res) => {
			try {
				const raw = new URL(req.url, "http://localhost").searchParams.get("id") ?? "";
				const id = parseQQPlaylistId(raw);
				if (id === void 0) {
					json(res, { error: "歌单 id 或链接无效" }, 400);
					return;
				}
				const playlist = await qqPlaylist(id);
				json(res, { name: playlist.name, tracks: playlist.tracks });
			} catch (error) {
				json(res, { error: error instanceof Error ? error.message : String(error) }, 502);
			}
		}
	}));

	// QQ Music audio stream proxy (vkey resolve + range proxy).
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/dsh-music/qq/stream",
		handler: (req, res) => {
			const url = new URL(req.url, "http://localhost");
			const id = url.searchParams.get("id") ?? "";
			const mediaMid = url.searchParams.get("mediaMid") ?? "";
			if (id.trim() === "") {
				json(res, { error: "无效的歌曲 mid" }, 400);
				return;
			}
			proxyQQStream(id.trim(), mediaMid.trim(), req, res);
		}
	}));

	// QQ Music login/profile status (cookie validity).
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/dsh-music/qq/login",
		handler: async (_req, res) => {
			try {
				const status = await qqLoginStatus();
				json(res, status);
			} catch (error) {
				json(res, { error: error instanceof Error ? error.message : String(error) }, 502);
			}
		}
	}));

	// QQ Music manual cookie set (paste from a browser).
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: "/dsh-music/qq/login/cookie",
		handler: async (req, res) => {
			try {
				const body = await readBody(req);
				const parsed = JSON.parse(body || "{}");
				const cookie = typeof parsed.cookie === "string" ? parsed.cookie.trim() : "";
				if (cookie === "") {
					json(res, { error: "cookie 不能为空" }, 400);
					return;
				}
				const obj = parseCookieString(cookie);
				const uin = qqCookieUin(obj);
				const playbackKey = qqCookiePlaybackKey(obj);
				if (!uin) {
					json(res, { error: "cookie 缺少 uin（QQ 账号）" }, 400);
					return;
				}
				if (!playbackKey) {
					json(res, {
						error: "cookie 缺少播放授权票据（qm_keyst/qqmusic_key/music_key）。只有 uin+qqmusic_key 的网页登录态无法换取播放地址，请访问 https://y.qq.com/n/ryqq/player 后再复制 cookie",
						partial: true
					}, 400);
					return;
				}
				qqCookie = cookie;
				saveCookies();
				qqCache.delete("qlogin");
				const status = await qqLoginStatus();
				json(res, { ok: true, ...status });
			} catch (error) {
				json(res, { error: error instanceof Error ? error.message : String(error) }, 400);
			}
		}
	}));

	// Agent-facing music control tool.
	ctx.tools.register(defineTool({
		name: "music",
		description: "控制 DeepSeek Harness 的双平台音乐播放器（网易云 + QQ 音乐）：播放/暂停/切歌/调音量/切换循环模式/查看队列/导入歌单/搜歌。用户提到放歌、听歌、切歌、暂停、下一首、导入歌单等场景时使用。",
		parameters: {
			action: {
				type: "string",
				required: true,
				description: "play(播放；query 先匹配本地曲库，未命中自动搜指定平台并播放) / pause / next / prev / list(查看队列) / search(搜歌) / playlist(导入歌单) / add(添加直链) / remove(按索引移除) / volume / mode / builtin(恢复/隐藏默认歌单) / reset"
			},
			platform: { type: "string", description: "音乐平台：netease(网易云，默认)/qq(QQ音乐)，配合 play/search/playlist 使用" },
			query: { type: "string", description: "歌名或歌手关键词，配合 play/search 使用" },
			url: { type: "string", description: "音频直链(http/https)，配合 add 使用" },
			title: { type: "string", description: "自定义歌曲标题，配合 add 使用" },
			id: { type: "string", description: "歌单 id 或分享链接，配合 playlist 使用" },
			clear: { type: "boolean", description: "playlist 是否隐藏默认歌单（默认 true，仅保留新歌单）" },
			shuffle: { type: "boolean", description: "playlist 是否随机播放歌单（默认跟随当前模式；当前已是随机模式则自动随机起播）" },
			enable: { type: "boolean", description: "builtin 是否恢复默认歌单" },
			index: { type: "number", description: "队列索引，配合 play/remove 使用" },
			volume: { type: "number", description: "音量 0-1，配合 volume 使用" },
			mode: { type: "string", description: "循环模式：list(列表循环)/single(单曲循环)/shuffle(随机)，配合 mode 使用" }
		},
		output: {
			schema: { type: "string" },
			render: (_args, value) => [{ type: "text", text: value }]
		},
		async execute(args) {
			const action = args.action;
			const platform = args.platform === "qq" ? "qq" : "netease";
			switch (action) {
				case "play": {
					if (typeof args.query === "string" && args.query.trim() !== "") {
						const track = findTrack(state, args.query);
						if (track !== void 0) {
							state.index = state.queue.indexOf(track);
						} else {
							// Local miss: fall back to the chosen platform's search.
							const songs = platform === "qq" ? await qqSearch(args.query, 5) : await neteaseSearch(args.query, 5);
							if (songs.length === 0) {
								return `曲库中没有匹配「${args.query}」的歌曲，${platform === "qq" ? "QQ 音乐" : "网易云"}搜索也没有结果。当前队列：\n${renderQueue(state)}`;
							}
							const song = songs[0];
							const trackRow = platform === "qq"
								? {
									id: `qq-${song.id}`,
									platform: "qq",
									title: song.name,
									artist: song.artist,
									cover: song.cover,
									url: qqStreamUrl(song.id, song.mediaMid)
								}
								: {
									id: `netease-${song.id}`,
									platform: "netease",
									title: song.name,
									artist: song.artist,
									cover: song.cover,
									url: neteaseStreamUrl(song.id)
								};
							state.custom.push(trackRow);
							state.queue = composeQueue(state.custom, state.useBuiltin);
							state.index = state.queue.length - 1;
							return `本地曲库无匹配，已从${platform === "qq" ? "QQ 音乐" : "网易云"}搜索并加入：▶ 「${song.name} — ${song.artist}」（自动播放）`;
						}
					} else if (Number.isInteger(args.index)) {
						state.index = args.index;
					}
					state.playing = true;
					state.version += 1;
					const current = state.queue[state.index];
					return `▶ 正在播放「${current.title} — ${current.artist}」（${state.index + 1}/${state.queue.length}）`;
				}
				case "pause":
					state.playing = false;
					state.version += 1;
					return "⏸ 已暂停";
				case "next":
				case "prev": {
					if (state.queue.length === 0) return "播放列表为空";
					state.index = action === "next" ? nextIndex(state, +1) : (state.index - 1 + state.queue.length) % state.queue.length;
					state.playing = true;
					state.version += 1;
					const current = state.queue[state.index];
					return `${action === "next" ? "⏭" : "⏮"} 切到「${current.title} — ${current.artist}」`;
				}
				case "list":
					return `正在${state.playing ? "播放" : "暂停"}：${state.queue[state.index]?.title ?? "无"}\n模式：${state.mode}｜音量：${Math.round(state.volume * 100)}%\n\n${renderQueue(state)}`;
				case "search": {
					if (typeof args.query !== "string" || args.query.trim() === "") return "请提供搜索关键词 query";
					const songs = platform === "qq" ? await qqSearch(args.query.trim(), 10) : await neteaseSearch(args.query.trim(), 10);
					if (songs.length === 0) return `${platform === "qq" ? "QQ 音乐" : "网易云"}没有搜到「${args.query}」`;
					return `${platform === "qq" ? "QQ 音乐" : "网易云"}搜索结果（前 ${songs.length} 条）：\n${songs.map((song, i) =>
						`${i + 1}. ${song.name} — ${song.artist}${song.album ? `（专辑：${song.album}）` : ""}${song.durationMs ? `（${Math.round(song.durationMs / 1000 / 60)}:${String(Math.round(song.durationMs / 1000) % 60).padStart(2, "0")}）` : ""}`
					).join("\n")}\n\n告诉用户序号，或用 play 播放指定歌曲。`;
				}
				case "add": {
					if (typeof args.url !== "string" || args.url.trim() === "") return "请提供音频直链 url";
					const result = await applyCommand(state, { action: "add", url: args.url, title: args.title, platform });
					return result.message;
				}
				case "remove": {
					const result = await applyCommand(state, { action: "remove", index: args.index });
					return result.message;
				}
				case "volume": {
					if (typeof args.volume !== "number") return "请提供 volume(0-1)";
					state.volume = clamp01(args.volume);
					state.version += 1;
					return `音量已设为 ${Math.round(state.volume * 100)}%`;
				}
				case "mode": {
					if (!MODES.includes(args.mode)) return `模式必须是 ${MODES.join("/")}`;
					state.mode = args.mode;
					state.version += 1;
					return `循环模式已切换为 ${state.mode}`;
				}
				case "playlist": {
					const id = platform === "qq" ? parseQQPlaylistId(args.id ?? args.url) : parsePlaylistId(args.id ?? args.url);
					if (id === void 0) return `请提供${platform === "qq" ? " QQ 音乐" : "网易云"}歌单 id 或分享链接（如 ${platform === "qq" ? "https://y.qq.com/n/ryqq/playlist/xxx" : "https://music.163.com/playlist?id=xxx"}）`;
					const result = await applyCommand(state, { action: "importPlaylist", id, platform, clear: args.clear !== false, shuffle: args.shuffle === true });
					return result.message;
				}
				case "builtin": {
					const result = await applyCommand(state, { action: "builtin", enable: args.enable === true });
					return result.message;
				}
				case "reset": {
					const result = await applyCommand(state, { action: "reset" });
					return result.message;
				}
				default:
					return `未知操作「${String(action)}」。可用：play/pause/next/prev/list/search/playlist/add/remove/volume/mode/builtin/reset`;
			}
		}
	}));
}
