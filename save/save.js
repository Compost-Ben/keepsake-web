// Save my keepsakes without the app: sign in
// with the email code, see every keepsake you hold, and save each as one
// zip of what the app's writer, src/lib/saveKeepsakes.ts, puts in its
// folder; change the two together. Reads go through the publishable key
// and the person's own session, so RLS is the boundary. The session lives
// in this tab alone, through a reload.

// Keepsake's servers; the local stack when served from this computer.
const SERVER = ['localhost', '127.0.0.1'].includes(location.hostname)
  ? { url: 'http://127.0.0.1:54321', key: 'sb_publishable_ACJWlzQHlZjBrEguHvfOxg_3BJgxAaH' }
  : { url: 'https://kmgecmxnzykmnfsijkho.supabase.co', key: 'sb_publishable_s2yrKvxOL2W6TppbQGSh7A_omnjjWgS' };
const UNTITLED = '(untitled)';
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const KEPT = 'keepsake-save';
// A keepsake's words, last in its zip.
const WORDS = 'Keepsake.txt';
const KINDS = { image: 'Photo', video: 'Video', audio: 'Sound' };

const $ = (id) => document.getElementById(id);
let session = null;
let renewing = null;
let address = '';
let names = null;

// A call to Supabase Auth; it rejects with Auth's error code.
async function auth(path, body, token) {
  const response = await fetch(`${SERVER.url}/auth/v1/${path}`, {
    method: 'POST',
    headers: {
      apikey: SERVER.key,
      'Content-Type': 'application/json',
      ...(token && { Authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(json.msg ?? `Auth ${response.status}`), { code: json.error_code });
  return json;
}

// The session, kept with the tab or dropped.
function keep(next) {
  session = next;
  try {
    if (next) sessionStorage.setItem(KEPT, JSON.stringify(next));
    else sessionStorage.removeItem(KEPT);
  } catch {
    // Held in memory alone.
  }
}

const signIn = (json) =>
  keep({
    token: json.access_token,
    refresh: json.refresh_token,
    until: Date.now() + json.expires_in * 1000,
    user: { id: json.user.id, email: json.user.email },
  });

// The session's token, renewed a minute before it lapses; a session Auth
// no longer knows is dropped.
async function bearer() {
  if (Date.now() > session.until - 60_000) {
    renewing ??= auth('token?grant_type=refresh_token', { refresh_token: session.refresh })
      .then(signIn, (error) => {
        if (error.code) keep(null);
        throw error;
      })
      .finally(() => (renewing = null));
    await renewing;
  }
  return session.token;
}

// A read through RLS, as the person.
async function read(table, params) {
  const response = await fetch(`${SERVER.url}/rest/v1/${table}?${new URLSearchParams(params)}`, {
    headers: { apikey: SERVER.key, Authorization: `Bearer ${await bearer()}` },
  });
  if (response.status === 401) keep(null);
  if (!response.ok) throw new Error(`${table} ${response.status}`);
  return response.json();
}

// What Home and the Archive show, oldest first: every keepsake held and
// not deleted for the person. A group's, once opened, is its copies.
async function listHeld(userId) {
  const rows = await read('user_keepsake_state_v2', {
    select: 'entries!inner(id,user_id,connection_id,copy_of,title,message,sealed_at,hero_snapshot_path)',
    user_id: `eq.${userId}`,
    deleted_at: 'is.null',
    visible_from_utc: 'lte.now',
    'entries.sealed_at': 'not.is.null',
  });
  const held = rows.flatMap(({ entries: entry }) => (entry.sealed_at ? [entry] : []));
  const copied = new Set(held.flatMap((entry) => (entry.user_id === userId && entry.copy_of ? [entry.copy_of] : [])));
  return held
    .filter((entry) => !copied.has(entry.id))
    .sort((a, b) => Date.parse(a.sealed_at) - Date.parse(b.sealed_at) || a.id.localeCompare(b.id));
}

// A day as a person reads it, in this computer's zone: "3 Nov 2026".
function shortDate(at) {
  const date = new Date(at);
  return `${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`;
}

const clean = (value) => value?.trim() || null;

// The person's own name, and each of their Circle by the name they gave.
async function readNames(user) {
  const [mine, connections] = await Promise.all([
    read('profiles', { select: 'display_name', id: `eq.${user.id}` }),
    read('connections', {
      select: 'id,user_a,user_b,consent_a,consent_b,blocked_at,declined_at',
      or: `(user_a.eq.${user.id},user_b.eq.${user.id})`,
    }),
  ]);
  const active = connections.filter((c) => c.consent_a === true && c.consent_b === true && !c.blocked_at && !c.declined_at);
  const partner = (c) => (c.user_a === user.id ? c.user_b : c.user_a);
  const ids = `in.(${active.map(partner).join(',')})`;
  const [profiles, overrides] = active.length
    ? await Promise.all([
        read('profiles', { select: 'id,display_name', id: ids }),
        read('connection_overrides', { select: 'target_user_id,nickname', owner_user_id: `eq.${user.id}`, target_user_id: ids }),
      ])
    : [[], []];
  const own = new Map(profiles.map((profile) => [profile.id, profile.display_name]));
  const given = new Map(overrides.map((override) => [override.target_user_id, override.nickname]));
  const local = user.email?.split('@')[0];
  return {
    me: clean(mine[0]?.display_name) ?? (local ? local.charAt(0).toUpperCase() + local.slice(1) : 'You'),
    people: new Map(
      active.map((c) => [c.id, clean(given.get(partner(c))) ?? clean(own.get(partner(c))) ?? 'Someone'])
    ),
  };
}

// Its sealed day and title, as Files sorts them; a number after when
// another keepsake already has the name. Sixty whole characters of title
// keep any name inside the 255 bytes Files allows.
function folderName(keepsake, taken) {
  const at = new Date(keepsake.sealed_at);
  const day = [at.getFullYear(), at.getMonth() + 1, at.getDate()]
    .map((part) => String(part).padStart(2, '0'))
    .join('-');
  const cleaned = keepsake.title
    .replace(/[\\/:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^\.+/, '');
  const title = Array.from(cleaned).slice(0, 60).join('').trim();
  const base = title ? `${day} ${title}` : day;
  let name = base;
  for (let n = 2; taken.has(name.toLowerCase()); n += 1) name = `${base} ${n}`;
  taken.add(name.toLowerCase());
  return name;
}

const isFields = (value) => typeof value === 'object' && value !== null && !Array.isArray(value);

// A letter's words: a v5 doc carries them; an older doc's boxes are a
// paragraph each, top to bottom, then left to right (upgradeLetterDoc).
function letterWords(doc) {
  if (!isFields(doc)) return '';
  if (doc.schemaVersion === 5 && typeof doc.words === 'string') return doc.words;
  const isBox = (box) =>
    isFields(box) && Number.isFinite(box.x) && Number.isFinite(box.y) && typeof box.content === 'string';
  const line = (block) =>
    isFields(block) && Array.isArray(block.runs)
      ? block.runs.map((run) => (isFields(run) && typeof run.text === 'string' ? run.text : '')).join('')
      : '';
  const boxes =
    doc.schemaVersion === 4 && Array.isArray(doc.objects) && doc.objects.every(isBox)
      ? doc.objects
      : doc.schemaVersion === 2 && Array.isArray(doc.blocks)
        ? [{ x: 0, y: 0, content: doc.blocks.map(line).join('\n') }]
        : [];
  return boxes
    .map(({ x, y, content }) => ({ x, y, content: content.trim() }))
    .filter((box) => box.content)
    .sort((a, b) => a.y - b.y || a.x - b.x)
    .map((box) => box.content)
    .join('\n\n');
}

// A song's link, as the app reads its row; null when the row is no song.
function songLink(row) {
  if ((row.provider === 'spotify' || row.provider === 'youtube') && row.share_url) return row.share_url;
  return row.provider === 'apple' && row.apple_track_id && row.external_url ? row.external_url : null;
}

function extOf(uri) {
  const path = uri.split('?')[0].split('#')[0];
  const dot = path.lastIndexOf('.');
  return dot === -1 ? null : path.slice(dot + 1).toLowerCase();
}

// Its title and message, who made it and for whom, the day it was sealed,
// then each letter's words and each song by the file it is.
function describe(keepsake, userId, notes) {
  const mine = keepsake.user_id === userId;
  const other = keepsake.connection_id ? (names.people.get(keepsake.connection_id) ?? 'Someone') : null;
  const recipient = mine ? other : names.me;
  return `${[
    [keepsake.title.trim() || UNTITLED, keepsake.message.trim()].filter(Boolean).join('\n\n'),
    [
      `Made by ${mine ? names.me : (other ?? 'Someone')}`,
      ...(recipient ? [`For ${recipient}`] : []),
      `Sealed ${shortDate(keepsake.sealed_at)}`,
    ].join('\n'),
    ...notes,
  ].join('\n\n')}\n`;
}

// The stored file at full size, through a short-lived signed link. Every
// keepsake file is in keepsake-media, under entry/<id>/.
async function fetchStored(path) {
  const signing = await fetch(`${SERVER.url}/storage/v1/object/sign/keepsake-media/${path.trim().replace(/^\/+/, '')}`, {
    method: 'POST',
    headers: { apikey: SERVER.key, Authorization: `Bearer ${await bearer()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ expiresIn: 3600 }),
  });
  const { signedURL } = await signing.json().catch(() => ({}));
  if (!signing.ok || !signedURL) throw new Error('Could not sign a keepsake file.');
  const file = await fetch(encodeURI(`${SERVER.url}/storage/v1${signedURL}`));
  if (!file.ok) throw new Error(`Download ${file.status}`);
  return file.blob();
}

const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = CRC[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// Little-endian fields, as [width in bytes, value], then a name.
function record(fields, name) {
  const out = new Uint8Array(fields.reduce((sum, [width]) => sum + width, 0) + name.length);
  const view = new DataView(out.buffer);
  let at = 0;
  for (const [width, value] of fields) {
    if (width === 2) view.setUint16(at, value, true);
    else view.setUint32(at, value, true);
    at += width;
  }
  out.set(name, at);
  return out;
}

// A zip of the files in order, each stored as it is (photos, video and
// sound are compressed already), names in UTF-8, dated now.
async function zip(files) {
  const now = new Date();
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const parts = [];
  const central = [];
  let offset = 0;
  for (const { name, data } of files) {
    const path = new TextEncoder().encode(name);
    const bytes = new Uint8Array(await data.arrayBuffer());
    const crc = crc32(bytes);
    // Zip 2.0, UTF-8 names, stored; when; its CRC and size, twice; its name.
    const shared = [[2, 20], [2, 0x800], [2, 0], [2, time], [2, date], [4, crc], [4, bytes.length], [4, bytes.length], [2, path.length], [2, 0]];
    const local = record([[4, 0x04034b50], ...shared], path);
    central.push(record([[4, 0x02014b50], [2, 20], ...shared, [2, 0], [2, 0], [2, 0], [4, 0], [4, offset]], path));
    parts.push(local, data);
    offset += local.length + bytes.length;
    if (offset > 0xffffffff) throw new Error('Too large to zip.');
  }
  const size = central.reduce((sum, entry) => sum + entry.length, 0);
  const end = record([[4, 0x06054b50], [2, 0], [2, 0], [2, files.length], [2, files.length], [4, size], [4, offset], [2, 0]], []);
  return new Blob([...parts, ...central, end], { type: 'application/zip' });
}

// One keepsake whole: its sealed picture, never cropped; every photo,
// video, sound, letter and song as stored, in its own order; its words.
async function zipKeepsake(keepsake) {
  const [media, letters, songs] = await Promise.all([
    read('entry_media', { select: 'id,kind,storage_path', entry_id: `eq.${keepsake.id}`, order: 'sort_order.asc,created_at.asc' }),
    read('entry_letter_content', { select: 'media_id,doc', entry_id: `eq.${keepsake.id}` }),
    read('entry_media_song_metadata', {
      select: 'entry_media_id,provider,apple_track_id,title,artist,external_url,share_url,entry_media!inner(entry_id)',
      'entry_media.entry_id': `eq.${keepsake.id}`,
    }),
  ]);
  const words = new Map(letters.flatMap((row) => (row.media_id ? [[row.media_id, letterWords(row.doc)]] : [])));
  const tunes = new Map(songs.flatMap((row) => (songLink(row) ? [[row.entry_media_id, row]] : [])));
  const hero = keepsake.hero_snapshot_path;
  const files = hero ? [{ path: hero, name: `Keepsake.${extOf(hero) ?? 'png'}` }] : [];
  const notes = [];
  let n = 0;
  for (const item of media) {
    if (!item.storage_path) continue;
    n += 1;
    const letter = words.get(item.id);
    const song = tunes.get(item.id);
    const kind = letter != null ? 'Letter' : song ? 'Song' : (KINDS[item.kind] ?? 'Photo');
    const name = `${n} ${kind}.${extOf(item.storage_path) ?? 'bin'}`;
    files.push({ path: item.storage_path, name });
    if (letter != null) notes.push(`${name}\n${letter}`);
    if (song) notes.push([name, `${song.title}, ${song.artist}`, songLink(song)].join('\n'));
  }
  const stored = await Promise.all(files.map((file) => fetchStored(file.path)));
  const text = new Blob([describe(keepsake, session.user.id, notes)]);
  return zip([...files.map((file, i) => ({ name: file.name, data: stored[i] })), { name: WORDS, data: text }]);
}

// Hands the zip to the browser as a download of its own.
function hand(blob, name) {
  const link = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: name });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 60_000);
}

function say(words) {
  $('said').textContent = words;
}

function show(step) {
  for (const id of ['ask', 'check', 'held']) $(id).hidden = id !== step;
}

// Back to the email, the list gone.
function signedOut(words) {
  $('list').replaceChildren();
  show('ask');
  say(words);
}

// A keepsake by its title and day, and its Save, which hands over a zip
// named as the app names its folder.
function row(keepsake, index, folder) {
  const item = document.createElement('li');
  const name = document.createElement('span');
  const day = document.createElement('small');
  const save = document.createElement('button');
  const title = keepsake.title.trim() || UNTITLED;
  name.id = `keepsake-${index}`;
  name.textContent = title;
  day.textContent = shortDate(keepsake.sealed_at);
  save.type = 'button';
  save.textContent = 'Save';
  save.setAttribute('aria-describedby', name.id);
  save.onclick = async () => {
    save.disabled = true;
    save.textContent = 'Saving…';
    say('');
    try {
      hand(await zipKeepsake(keepsake), `${folder}.zip`);
      save.textContent = 'Saved';
    } catch {
      save.textContent = 'Save';
      if (session) say(`Could not save ${title}. Try again.`);
      else signedOut('Sign in again.');
    } finally {
      save.disabled = false;
    }
  };
  name.append(day);
  item.append(name, save);
  return item;
}

async function load() {
  show('held');
  say('Reading your keepsakes…');
  try {
    const [held, named] = await Promise.all([listHeld(session.user.id), readNames(session.user)]);
    // Named among them all, so each zip is named as the app names its folder.
    const taken = new Set();
    names = named;
    $('list').replaceChildren(...held.map((keepsake, index) => row(keepsake, index, folderName(keepsake, taken))));
    say(held.length ? '' : 'You hold no keepsakes yet.');
  } catch {
    if (session) say('Could not read your keepsakes. Reload the page to try again.');
    else signedOut('Sign in again.');
  }
}

$('ask').onsubmit = async (event) => {
  event.preventDefault();
  const button = $('ask').querySelector('button');
  address = $('email').value.trim().toLowerCase();
  button.disabled = true;
  try {
    await auth('otp', { email: address, create_user: false });
    $('sent').textContent = `Enter the 6-digit code we sent to ${address}.`;
    $('code').value = '';
    show('check');
    say('');
    $('code').focus();
  } catch (error) {
    say(error.code === 'otp_disabled' ? 'No Keepsake account uses that address.' : 'Could not send a code. Wait a minute and try again.');
  } finally {
    button.disabled = false;
  }
};

$('check').onsubmit = async (event) => {
  event.preventDefault();
  const button = $('check').querySelector('button');
  const token = $('code').value.trim();
  if (!/^\d{6}$/.test(token)) return say('Enter the 6-digit code.');
  button.disabled = true;
  try {
    signIn(await auth('verify', { type: 'email', email: address, token }));
  } catch (error) {
    return say(error.code === 'otp_expired' ? 'That code did not work. Check it, or go back for a new one.' : 'Could not sign in. Try again.');
  } finally {
    button.disabled = false;
  }
  await load();
};

$('back').onclick = () => {
  show('ask');
  say('');
};

$('out').onclick = () => {
  const token = session?.token;
  keep(null);
  if (token) auth('logout?scope=local', {}, token).catch(() => {});
  signedOut('');
};

try {
  session = JSON.parse(sessionStorage.getItem(KEPT));
} catch {
  // Signed out.
}
if (session) void load();
