/*
 * AMEN CONNECT Admin — couche « hors connexion » (offline-first)
 *
 * - Lectures  : mises en cache locale (IndexedDB) à chaque lecture réussie ; servies depuis le cache sans Internet.
 * - Écritures : si Internet est coupé, l'action est placée dans une file d'attente persistante (outbox),
 *               appliquée immédiatement à l'affichage (identifiants temporaires « tmp_… »),
 *               puis rejouée automatiquement dans l'ordre dès le retour de la connexion.
 * - Connexion : une fois connecté en ligne, le compte peut se reconnecter hors ligne (empreinte PBKDF2 locale).
 *
 * Le client Supabase d'origine est enveloppé : l'interface (index.html) n'a pas besoin d'être modifiée.
 */
(function (root) {
  'use strict';

  var TMP = 'tmp_';
  var PENDING_CODE = '⏳ généré à la synchronisation';
  var OFFLINE_LOGIN_MAX_DAYS = 30;

  var WRITE_RPC = {
    admin_create_parent: 1, admin_create_teacher: 1, admin_create_student_for_parent: 1,
    admin_link_student_to_parent: 1, admin_assign_teacher: 1, admin_update_teacher_assignment: 1,
    admin_create_announcement: 1, admin_delete_announcements: 1,
    admin_reset_parent_code: 1, admin_reset_teacher_code: 1
  };
  var DELETE_TABLES = { classes: 1, subjects: 1, teacher_assignments: 1, notes: 1 };

  // ------------------------------------------------------------------ utilitaires
  function isNetErr(e) {
    if (!e) return false;
    var m = String(e.message || e).toLowerCase();
    return /failed to fetch|networkerror|network request failed|load failed|fetch failed|econn|enotfound|etimedout|err_internet|err_network|err_name_not_resolved|network timeout|aborted/.test(m) || e.status === 0;
  }
  function isAuthErr(e) {
    var m = String((e && e.message) || e || '').toLowerCase();
    return /jwt|not authenticated|auth session missing|accès direction requis|invalid token|token is expired|refresh token/.test(m);
  }
  function uid() {
    var c = root.crypto;
    return TMP + (c && c.randomUUID ? c.randomUUID() : Math.random().toString(36).slice(2) + Date.now().toString(36));
  }
  function isTmp(v) { return typeof v === 'string' && v.indexOf(TMP) === 0; }
  function walk(v, fn) {
    if (Array.isArray(v)) return v.map(function (x) { return walk(x, fn); });
    if (v && typeof v === 'object') { var o = {}; for (var k in v) o[k] = walk(v[k], fn); return o; }
    return fn(v);
  }
  function hasTmp(v) { var f = false; walk(v, function (x) { if (isTmp(x)) f = true; return x; }); return f; }
  function clone(v) { return v === undefined ? v : JSON.parse(JSON.stringify(v)); }
  function withTimeout(p, ms) {
    var t;
    return Promise.race([
      p,
      new Promise(function (_, rej) { t = setTimeout(function () { rej(new Error('Network timeout')); }, ms); })
    ]).then(function (r) { clearTimeout(t); return r; }, function (e) { clearTimeout(t); throw e; });
  }
  function b64e(u8) { var s = ''; for (var i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s); }
  function b64d(s) { var b = atob(s), u = new Uint8Array(b.length); for (var i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; }
  async function derive(pw, saltB64, iter) {
    var subtle = root.crypto.subtle;
    var key = await subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveBits']);
    var bits = await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: b64d(saltB64), iterations: iter }, key, 256);
    return b64e(new Uint8Array(bits));
  }

  // ------------------------------------------------------------------ stockage
  function memoryStore() {
    var S = { cache: new Map(), outbox: new Map(), meta: new Map() };
    return {
      async get(s, k) { return S[s].has(k) ? JSON.parse(S[s].get(k)) : undefined; },
      async set(s, k, v) { S[s].set(k, JSON.stringify(v)); },
      async del(s, k) { S[s].delete(k); },
      async all(s) {
        return Array.from(S[s].entries()).sort(function (a, b) { return a[0] < b[0] ? -1 : 1; })
          .map(function (e) { return [e[0], JSON.parse(e[1])]; });
      }
    };
  }
  function idbStore() {
    var dbp = null;
    function open() {
      return dbp || (dbp = new Promise(function (res, rej) {
        var r = indexedDB.open('amen_offline', 1);
        r.onupgradeneeded = function () {
          var d = r.result;
          ['cache', 'outbox', 'meta'].forEach(function (n) { if (!d.objectStoreNames.contains(n)) d.createObjectStore(n); });
        };
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { rej(r.error); };
      }));
    }
    async function tx(s, mode, fn) {
      var d = await open();
      return new Promise(function (res, rej) {
        var t = d.transaction(s, mode), rq = fn(t.objectStore(s));
        t.oncomplete = function () { res(rq && rq.result); };
        t.onerror = t.onabort = function () { rej(t.error); };
      });
    }
    return {
      get: function (s, k) { return tx(s, 'readonly', function (st) { return st.get(k); }); },
      set: function (s, k, v) { return tx(s, 'readwrite', function (st) { return st.put(v, k); }); },
      del: function (s, k) { return tx(s, 'readwrite', function (st) { return st.delete(k); }); },
      all: async function (s) {
        var d = await open();
        return new Promise(function (res, rej) {
          var out = [], rq = d.transaction(s, 'readonly').objectStore(s).openCursor();
          rq.onsuccess = function () { var c = rq.result; if (c) { out.push([c.key, c.value]); c.continue(); } else res(out); };
          rq.onerror = function () { rej(rq.error); };
        });
      }
    };
  }

  // ------------------------------------------------------------------ cœur
  function createLayer(o) {
    var raw = o.raw, store = o.store, url = o.url, key = o.key;
    var fetchFn = o.fetch || (root.fetch && root.fetch.bind(root));
    var hooks = Object.assign({
      onState: function () {}, toast: function () {}, onSynced: function () {},
      askPassword: async function () { return null; }
    }, o.hooks || {});
    var state = { online: null, syncing: false, pending: 0, failed: 0, authed: false };
    var names = { classes: {}, teachers: {}, subjects: {}, parents: {}, students: {} };
    var idmap = {}, seq = 0, authInfo = null, lastQueuedAt = 0, reauthDeclinedAt = 0, saveTimer = null, readyP = null;

    function emit() { try { hooks.onState(Object.assign({}, state)); } catch (e) {} }
    function ready() {
      return readyP || (readyP = (async function () {
        names = (await store.get('meta', 'names')) || names;
        idmap = (await store.get('meta', 'idmap')) || {};
        seq = (await store.get('meta', 'seq')) || 0;
        authInfo = (await store.get('meta', 'auth')) || null;
        await recount();
      })());
    }
    function persistSoon() {
      if (saveTimer) return;
      saveTimer = setTimeout(async function () {
        saveTimer = null;
        try { await store.set('meta', 'names', names); await store.set('meta', 'idmap', idmap); } catch (e) {}
      }, 400);
    }
    async function flushMeta() {
      if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
      await store.set('meta', 'names', names); await store.set('meta', 'idmap', idmap);
    }
    async function listOps() { return (await store.all('outbox')).map(function (e) { return e[1]; }); }
    async function recount() {
      var l = await listOps();
      state.pending = l.filter(function (x) { return x.status === 'pending'; }).length;
      state.failed = l.filter(function (x) { return x.status === 'failed'; }).length;
      emit();
    }

    // ---- état réseau
    function noteOnline() {
      var was = state.online;
      state.online = true;
      if (authInfo && authInfo.active !== undefined && Date.now() - (authInfo.lastOnline || 0) > 600000) {
        authInfo.lastOnline = Date.now(); store.set('meta', 'auth', authInfo).catch(function () {});
      }
      if (was !== true) { emit(); if (state.pending > 0) setTimeout(flush, 300); }
    }
    function noteOffline() { if (state.online !== false) { state.online = false; emit(); } }
    var probeDelay = o.probeRetryDelay === undefined ? 700 : o.probeRetryDelay;
    async function probe() {
      var lastErr = '';
      for (var n = 0; n < 2; n++) {
        try {
          var r = await withTimeout(Promise.resolve(fetchFn(url + '/auth/v1/health', o.desktop ? { method: 'GET', headers: { apikey: key } } : { mode: 'no-cors', cache: 'no-store' })), 8000);
          state.diag = { ok: true, status: r && r.status, at: Date.now() };
          noteOnline(); return true;
        } catch (e) {
          lastErr = String((e && e.message) || e);
          if (n === 0 && probeDelay) await new Promise(function (res) { setTimeout(res, probeDelay); });
        }
      }
      state.diag = { ok: false, error: lastErr, at: Date.now() };
      noteOffline(); return false;
    }
    // Une requête a échoué : vrai hors-ligne (true) ou serveur joignable mais requête en erreur (false) ?
    async function trulyOffline(err) {
      state.lastError = String((err && err.message) || err || '');
      return !(await probe());
    }
    function isTimeout(e) { return /timeout/i.test(String((e && e.message) || e || '')); }

    // ---- noms (pour afficher les jointures des éléments créés hors ligne)
    var NAME_FIELD = { classes: 'name', subjects: 'name', teachers: 'full_name', parents: 'full_name', students: 'full_name' };
    function learn(table, rows) {
      if (!state.authed || !Array.isArray(rows) || !names[table]) return;
      rows.forEach(function (r) { if (r && r.id) names[table][r.id] = r[NAME_FIELD[table]] || ''; });
      persistSoon();
    }
    function nm(table, id) { return (names[table] && names[table][id]) || ''; }
    function jn(table, id) {
      if (table === 'classes' || table === 'subjects') return { id: id, name: nm(table, id) };
      return { id: id, full_name: nm(table, id) };
    }

    // ---- superposition des opérations en attente sur les données en cache
    function overlay(table, rowsIn, ops) {
      if (!Array.isArray(rowsIn)) return { rows: rowsIn, changed: false };
      var rows = clone(rowsIn), changed = false;
      ops.forEach(function (op) {
        if (op.status !== 'pending') return;
        var a = op.args || {}, k = op.kind + ':' + op.name;
        switch (k) {
          case 'rpc:admin_create_parent':
            if (table === 'parents') { rows.push({ id: op.tmpId, full_name: String(a.p_full_name || '').trim(), phone: a.p_phone || null, created_at: op.ts }); changed = true; }
            break;
          case 'rpc:admin_create_teacher':
            if (table === 'teachers') { rows.push({ id: op.tmpId, full_name: String(a.p_full_name || '').trim(), phone: a.p_phone || null, created_at: op.ts }); changed = true; }
            break;
          case 'rpc:admin_create_student_for_parent':
            if (table === 'students') { rows.push({ id: op.tmpId, full_name: String(a.p_student_full_name || '').trim(), class_id: a.p_class_id, classes: jn('classes', a.p_class_id) }); changed = true; }
            if (table === 'student_parents') { rows.push({ student_id: op.tmpId, parent_id: a.p_parent_id, relationship: a.p_relationship || 'Parent' }); changed = true; }
            break;
          case 'rpc:admin_link_student_to_parent':
            if (table === 'student_parents') {
              rows = rows.filter(function (r) { return !(r.student_id === a.p_student_id && r.parent_id === a.p_parent_id); });
              rows.push({ student_id: a.p_student_id, parent_id: a.p_parent_id, relationship: a.p_relationship || 'Parent' }); changed = true;
            }
            break;
          case 'rpc:admin_assign_teacher':
            if (table === 'teacher_assignments') {
              rows.push({ id: op.tmpId, teacher_id: a.p_teacher_id, class_id: a.p_class_id, subject_id: a.p_subject_id, is_homeroom: !!a.p_is_homeroom, created_at: op.ts,
                teachers: jn('teachers', a.p_teacher_id), classes: jn('classes', a.p_class_id), subjects: jn('subjects', a.p_subject_id) });
              changed = true;
            }
            break;
          case 'rpc:admin_update_teacher_assignment':
            if (table === 'teacher_assignments') {
              rows.forEach(function (r) {
                if (r.id !== a.p_assignment_id) return;
                r.teacher_id = a.p_teacher_id; r.class_id = a.p_class_id; r.subject_id = a.p_subject_id; r.is_homeroom = !!a.p_is_homeroom;
                r.teachers = jn('teachers', a.p_teacher_id); r.classes = jn('classes', a.p_class_id); r.subjects = jn('subjects', a.p_subject_id);
                changed = true;
              });
            }
            break;
          case 'rpc:admin_create_announcement':
            if (table === 'announcements') {
              rows.push({ id: op.tmpId, title: a.p_title, body: a.p_body, importance: a.p_importance, target_type: a.p_target_type,
                class_id: a.p_class_id || null, student_id: a.p_student_id || null, parent_id: a.p_parent_id || null, teacher_id: a.p_teacher_id || null, created_at: op.ts });
              changed = true;
            }
            break;
          case 'rpc:admin_delete_announcements':
            if (table === 'announcements') {
              var n = rows.length;
              rows = rows.filter(function (r) { return (a.p_announcement_ids || []).indexOf(r.id) < 0; });
              if (rows.length !== n) changed = true;
            }
            break;
          case 'insert:subjects':
            if (table === 'subjects') { rows.push({ id: op.tmpId, name: a.row && a.row.name, created_at: op.ts }); changed = true; }
            break;
          default:
            if (op.kind === 'delete' && op.name === table) {
              var m = rows.length;
              rows = rows.filter(function (r) { return r.id !== a.id; });
              if (rows.length !== m) changed = true;
            }
        }
      });
      return { rows: rows, changed: changed };
    }
    function reorder(rows, calls) {
      calls.forEach(function (c) {
        if (c[0] !== 'order') return;
        var col = c[1][0], asc = !(c[1][1] && c[1][1].ascending === false);
        rows.sort(function (x, y) {
          var p = x[col], q = y[col], r;
          if (typeof p === 'string' && typeof q === 'string' && col !== 'created_at') r = p.localeCompare(q, 'fr', { sensitivity: 'base' });
          else r = (p > q) - (p < q);
          return asc ? r : -r;
        });
      });
      calls.forEach(function (c) { if (c[0] === 'limit') rows.splice(c[1][0]); });
      return rows;
    }
    function codesOverlay(rows, ops) {
      rows = clone(rows) || [];
      ops.forEach(function (op) {
        if (op.status !== 'pending') return;
        var a = op.args || {};
        if (op.name === 'admin_create_parent' || op.name === 'admin_create_teacher') {
          rows.push({ id: 'rec_' + op.tmpId, role: op.name === 'admin_create_parent' ? 'parent' : 'teacher',
            parent_id: op.name === 'admin_create_parent' ? op.tmpId : null, teacher_id: op.name === 'admin_create_teacher' ? op.tmpId : null,
            full_name: String(a.p_full_name || '').trim(), phone: a.p_phone || null, access_code: PENDING_CODE, generated_at: null, is_current: true });
        }
      });
      return rows;
    }

    // ---- exécution brute d'une opération
    function execRaw(op, args) {
      if (op.kind === 'rpc') return raw.rpc(op.name, args);
      if (op.kind === 'delete') return raw.from(op.name).delete().eq('id', args.id);
      if (op.kind === 'insert') return raw.from(op.name).insert(args.row).select().single();
      return Promise.resolve({ error: { message: 'Opération inconnue : ' + op.kind } });
    }
    function resolveArgs(args) { return walk(args, function (x) { return isTmp(x) && idmap[x] ? idmap[x] : x; }); }

    // ---- placement en file d'attente + réponse optimiste
    async function enqueue(op) {
      await ready();
      var tmp = null;
      if (op.kind === 'rpc' && /^admin_create_(parent|teacher|student_for_parent)$|^admin_assign_teacher$|^admin_create_announcement$/.test(op.name)) tmp = uid();
      if (op.kind === 'insert') tmp = uid();
      op.tmpId = tmp; op.ts = new Date().toISOString(); op.status = 'pending';
      seq += 1; op.key = String(seq).padStart(10, '0');
      var a = op.args;
      if (op.name === 'admin_create_parent' && tmp) names.parents[tmp] = String(a.p_full_name || '').trim();
      if (op.name === 'admin_create_teacher' && tmp) names.teachers[tmp] = String(a.p_full_name || '').trim();
      if (op.name === 'admin_create_student_for_parent' && tmp) names.students[tmp] = String(a.p_student_full_name || '').trim();
      if (op.kind === 'insert' && op.name === 'subjects') names.subjects[tmp] = a.row && a.row.name;
      await store.set('outbox', op.key, op);
      await store.set('meta', 'seq', seq);
      await flushMeta();
      lastQueuedAt = Date.now();
      await recount();
      if (state.online !== false) setTimeout(flush, 200);
      return optimistic(op);
    }
    function optimistic(op) {
      var a = op.args, id = op.tmpId;
      switch (op.kind + ':' + op.name) {
        case 'rpc:admin_create_parent': return { data: { success: true, parent_id: id, parent_code: PENDING_CODE, pending: true }, error: null };
        case 'rpc:admin_create_teacher': return { data: { success: true, teacher_id: id, teacher_code: PENDING_CODE, pending: true }, error: null };
        case 'rpc:admin_create_student_for_parent': return { data: { success: true, student_id: id, parent_id: a.p_parent_id, relationship: a.p_relationship, pending: true }, error: null };
        case 'rpc:admin_assign_teacher': return { data: { success: true, assignment_id: id, pending: true }, error: null };
        case 'rpc:admin_create_announcement': return { data: { success: true, announcement_id: id, pending: true }, error: null };
        case 'rpc:admin_reset_parent_code': return { data: { success: true, parent_id: a.p_parent_id, parent_code: PENDING_CODE, pending: true }, error: null };
        case 'rpc:admin_reset_teacher_code': return { data: { success: true, teacher_id: a.p_teacher_id, teacher_code: PENDING_CODE, pending: true }, error: null };
        case 'rpc:admin_delete_announcements': return { data: (a.p_announcement_ids || []).length, error: null };
        case 'insert:subjects': return { data: { id: id, name: a.row && a.row.name, created_at: op.ts }, error: null };
        case 'delete:' + op.name: return { data: null, error: null };
        default: return { data: { success: true, pending: true }, error: null };
      }
    }

    // ---- annule les opérations en attente liées à un élément « tmp_ » supprimé avant synchronisation
    async function cancelTmp(ids) {
      var l = await listOps(), removed = 0;
      for (var i = 0; i < l.length; i++) {
        var op = l[i];
        var s = JSON.stringify(op.args || {});
        var dep = ids.some(function (id) { return op.tmpId === id || s.indexOf(id) >= 0; });
        if (dep && op.status === 'pending') { await store.del('outbox', op.key); removed++; }
      }
      await recount();
      return removed;
    }

    // ---- point d'entrée de toute écriture
    async function mutate(op) {
      await ready();
      // Suppression d'un élément créé hors ligne et pas encore synchronisé : on annule simplement sa création.
      if (op.kind === 'delete' && isTmp(op.args.id)) { await cancelTmp([op.args.id]); return { data: null, error: null }; }
      if (op.name === 'admin_delete_announcements') {
        var ids = op.args.p_announcement_ids || [], tmps = ids.filter(isTmp);
        if (tmps.length) {
          await cancelTmp(tmps);
          op.args = { p_announcement_ids: ids.filter(function (x) { return !isTmp(x); }) };
          if (!op.args.p_announcement_ids.length) return { data: ids.length, error: null };
        }
      }
      var args = resolveArgs(op.args);
      var pending = (await listOps()).filter(function (x) { return x.status === 'pending'; });
      var mustQueue = state.online === false || pending.length > 0 || hasTmp(args);
      if (!mustQueue) {
        try {
          var res = await execRaw(op, args);
          if (!res.error || !isNetErr(res.error)) { noteOnline(); return res; }
          if (!(await trulyOffline(res.error))) return res;
        } catch (e) { if (!isNetErr(e)) throw e; if (!(await trulyOffline(e))) return { data: null, error: { message: String(e.message || e) } }; }
      }
      op.args = args;
      return enqueue(op);
    }

    // ---- lecture (select) avec cache
    async function runSelect(table, calls) {
      await ready();
      var k = 'q:' + table + ':' + JSON.stringify(calls);
      var pend = (await listOps()).filter(function (x) { return x.status === 'pending'; });
      if (state.online !== false) {
        try {
          var b = raw.from(table);
          calls.forEach(function (c) { b = b[c[0]].apply(b, c[1]); });
          var res = await withTimeout(Promise.resolve(b), 25000);
          if (!res.error) {
            noteOnline();
            if (state.authed) { await store.set('cache', k, { data: res.data, ts: Date.now() }); learn(table, res.data); }
            if (pend.length && Array.isArray(res.data)) {
              var ov = overlay(table, res.data, pend);
              if (ov.changed) return { data: reorder(ov.rows, calls), error: null };
            }
            return res;
          }
          if (!isNetErr(res.error)) return res;
          if (!(await trulyOffline(res.error)) && !isTimeout(res.error)) return res;
        } catch (e) {
          if (!isNetErr(e)) throw e;
          if (!(await trulyOffline(e)) && !isTimeout(e)) return { data: null, error: { message: String(e.message || e) } };
        }
      }
      var c = await store.get('cache', k);
      if (!c) return { data: null, error: { message: 'Hors connexion : ces données ne sont pas encore disponibles sur cet ordinateur (ouvrez-les une fois avec Internet).' } };
      var o2 = overlay(table, c.data, pend);
      return { data: o2.changed ? reorder(o2.rows, calls) : o2.rows, error: null, offline: true };
    }

    async function runRpcRead(name, args) {
      await ready();
      var k = 'rpc:' + name + ':' + JSON.stringify(args);
      var pend = (await listOps()).filter(function (x) { return x.status === 'pending'; });
      if (state.online !== false) {
        try {
          var res = await withTimeout(Promise.resolve(raw.rpc(name, args)), 25000);
          if (!res.error) {
            noteOnline();
            if (state.authed) await store.set('cache', k, { data: res.data, ts: Date.now() });
            return name === 'admin_access_codes' && pend.length ? { data: codesOverlay(res.data, pend), error: null } : res;
          }
          if (!isNetErr(res.error)) return res;
          if (!(await trulyOffline(res.error)) && !isTimeout(res.error)) return res;
        } catch (e) {
          if (!isNetErr(e)) throw e;
          if (!(await trulyOffline(e)) && !isTimeout(e)) return { data: null, error: { message: String(e.message || e) } };
        }
      }
      var c = await store.get('cache', k);
      if (!c) return { data: name === 'admin_access_codes' ? codesOverlay([], pend) : null, error: null, offline: true };
      return { data: name === 'admin_access_codes' ? codesOverlay(c.data, pend) : c.data, error: null, offline: true };
    }

    // ---- rpc()
    async function rpc(name, args) {
      args = args || {};
      if (WRITE_RPC[name]) return mutate({ kind: 'rpc', name: name, args: args });
      if (name === 'admin_access_codes') return runRpcRead(name, args);
      if (name === 'bootstrap_admin') {
        if (state.online !== false) {
          try { var r = await raw.rpc(name, args); if (!r.error || !isNetErr(r.error)) return r; if (!(await trulyOffline(r.error))) return r; }
          catch (e) { if (!isNetErr(e)) throw e; if (!(await trulyOffline(e))) return { data: null, error: { message: String(e.message || e) } }; }
        }
        return { data: { success: true, offline: true }, error: null };
      }
      if (name === 'admin_create_class') {
        if (state.online === false || !(await probe())) {
          return { data: null, error: { message: 'Création de classe impossible hors connexion : le mot de passe Direction doit être vérifié par le serveur. Reconnectez-vous à Internet puis réessayez.' } };
        }
      }
      return raw.rpc(name, args);
    }

    // ---- from() : enregistre la chaîne d'appels puis choisit lecture / écriture
    function from(table) {
      var calls = [], promise = null;
      function run() {
        if (promise) return promise;
        var has = function (n) { return calls.some(function (c) { return c[0] === n; }); };
        if (has('delete')) {
          var eq = calls.filter(function (c) { return c[0] === 'eq' && c[1][0] === 'id'; })[0];
          if (DELETE_TABLES[table] && eq && calls.length === 2) promise = mutate({ kind: 'delete', name: table, args: { id: eq[1][1] } });
        } else if (has('insert')) {
          var ins = calls.filter(function (c) { return c[0] === 'insert'; })[0];
          if (table === 'subjects' && ins && !Array.isArray(ins[1][0])) promise = mutate({ kind: 'insert', name: table, args: { row: ins[1][0] } });
        } else if (has('select') && !has('update') && !has('upsert')) {
          promise = runSelect(table, calls);
        }
        if (!promise) { // combinaison non gérée : appel direct inchangé
          var b = raw.from(table);
          calls.forEach(function (c) { b = b[c[0]].apply(b, c[1]); });
          promise = Promise.resolve(b);
        }
        return promise;
      }
      var proxy = new Proxy({}, {
        get: function (_, prop) {
          if (prop === 'then') return function (a, b) { return run().then(a, b); };
          if (prop === 'catch') return function (b) { return run().catch(b); };
          if (prop === 'finally') return function (f) { return run().finally(f); };
          return function () { calls.push([prop, Array.prototype.slice.call(arguments)]); return proxy; };
        }
      });
      return proxy;
    }

    // ---- authentification (connexion hors ligne incluse)
    async function saveVerifier(email, password, user) {
      var salt = b64e(root.crypto.getRandomValues(new Uint8Array(16))), iter = 150000;
      authInfo = { email: String(email).toLowerCase(), salt: salt, iter: iter, hash: await derive(password, salt, iter),
        user: { id: user.id, email: user.email, aud: user.aud, role: user.role }, active: true, lastOnline: Date.now() };
      await store.set('meta', 'auth', authInfo);
    }
    async function offlineLogin(cred) {
      await ready();
      var bad = { data: { user: null, session: null }, error: { message: 'Pas de connexion Internet. Lors de la première utilisation, la connexion à Internet est obligatoire sur cet ordinateur ; ensuite, la connexion hors ligne fonctionne avec les mêmes identifiants.' } };
      if (!authInfo || !authInfo.hash) return bad;
      if (String(cred.email).trim().toLowerCase() !== authInfo.email) return bad;
      if (Date.now() - (authInfo.lastOnline || 0) > OFFLINE_LOGIN_MAX_DAYS * 86400000) {
        return { data: { user: null, session: null }, error: { message: 'Connexion hors ligne expirée (plus de ' + OFFLINE_LOGIN_MAX_DAYS + ' jours sans Internet). Connectez-vous en ligne.' } };
      }
      var h = await derive(cred.password, authInfo.salt, authInfo.iter);
      if (h !== authInfo.hash) return { data: { user: null, session: null }, error: { message: 'Mot de passe incorrect.' } };
      authInfo.active = true; await store.set('meta', 'auth', authInfo);
      state.authed = true; emit();
      return { data: { user: authInfo.user, session: null }, error: null };
    }
    var auth = {
      async signInWithPassword(cred) {
        await ready();
        try {
          var r = await raw.auth.signInWithPassword(cred);
          if (!r.error && r.data && r.data.user) { state.authed = true; await saveVerifier(cred.email, cred.password, r.data.user); noteOnline(); return r; }
          if (r.error && !isNetErr(r.error)) return r;
          if (r.error && !(await trulyOffline(r.error))) return { data: { user: null, session: null }, error: { message: 'Le serveur est joignable mais la requête de connexion a échoué : ' + r.error.message } };
        } catch (e) {
          if (!isNetErr(e)) throw e;
          if (!(await trulyOffline(e))) return { data: { user: null, session: null }, error: { message: 'Le serveur est joignable mais la requête de connexion a échoué : ' + (e.message || e) } };
        }
        return offlineLogin(cred);
      },
      async getSession() {
        await ready();
        var r;
        try { r = await raw.auth.getSession(); } catch (e) { r = { data: { session: null }, error: e }; }
        if (r && r.data && r.data.session) { state.authed = true; return r; }
        if (authInfo && authInfo.active && !(await probe())) {
          state.authed = true; emit();
          return { data: { session: { user: authInfo.user, access_token: null, offline: true } }, error: null };
        }
        return r;
      },
      async getUser() {
        await ready();
        try {
          var r = await raw.auth.getUser();
          if (!r.error) { state.authed = true; return r; }
          if (!isNetErr(r.error)) return r;
        } catch (e) { if (!isNetErr(e)) throw e; }
        if (await probe()) return { data: { user: null }, error: { message: 'Le serveur est joignable mais la vérification de session a échoué.' } };
        if (authInfo && authInfo.active) { state.authed = true; return { data: { user: authInfo.user }, error: null }; }
        return { data: { user: null }, error: { message: 'Hors connexion.' } };
      },
      async signOut() {
        await ready();
        if (authInfo) { authInfo.active = false; await store.set('meta', 'auth', authInfo); }
        state.authed = false; emit();
        try { await withTimeout(raw.auth.signOut(), 5000); } catch (e) {}
        try { if (root.localStorage) Object.keys(root.localStorage).filter(function (k) { return k.indexOf('sb-') === 0; }).forEach(function (k) { root.localStorage.removeItem(k); }); } catch (e) {}
        return { error: null };
      }
    };

    // ---- session valide avant synchronisation (redemande le mot de passe si nécessaire)
    async function ensureSession(force, manual) {
      var s = null;
      try { s = (await raw.auth.getSession()).data.session; } catch (e) {}
      if (s && !force) return true;
      if (!manual && Date.now() - reauthDeclinedAt < 600000) return false;
      var email = authInfo && authInfo.email;
      if (!email) return false;
      var pwd = await hooks.askPassword('Session expirée : saisissez le mot de passe de ' + email + ' pour synchroniser vos modifications.');
      if (pwd === null || pwd === undefined) { reauthDeclinedAt = Date.now(); return false; }
      var r = await raw.auth.signInWithPassword({ email: email, password: pwd });
      if (r.error) { hooks.toast('Reconnexion refusée : ' + r.error.message, 'err'); reauthDeclinedAt = Date.now(); return false; }
      state.authed = true;
      try { await saveVerifier(email, pwd, r.data.user); } catch (e) {}
      return true;
    }

    // ---- synchronisation
    async function flush(manual) {
      await ready();
      if (state.syncing) return null;
      if (!(await recountAndHasPending())) return null;
      state.syncing = true; emit();
      var out = { done: 0, failed: 0, codes: [], stopped: null };
      try {
        if (!(await probe())) { out.stopped = 'offline'; return out; }
        if (!(await ensureSession(false, manual))) { out.stopped = 'auth'; return out; }
        var l = await listOps(), reauthTried = false;
        for (var i = 0; i < l.length; i++) {
          var op = l[i];
          if (op.status !== 'pending') continue;
          var args = resolveArgs(op.args);
          if (hasTmp(args)) { await markFailed(op, 'Élément lié introuvable (sa création a échoué ou a été annulée).'); out.failed++; continue; }
          var res;
          try { res = await execRaw(op, args); } catch (e) { res = { error: { message: String((e && e.message) || e) } }; }
          if (res.error && isNetErr(res.error)) { state.lastError = res.error.message; out.stopped = (await probe()) ? 'error' : 'offline'; break; }
          if (res.error && isAuthErr(res.error) && !reauthTried) {
            reauthTried = true;
            if (await ensureSession(true, true)) { i--; continue; }
            out.stopped = 'auth'; break;
          }
          if (res.error) { await markFailed(op, res.error.message); out.failed++; continue; }
          recordSuccess(op, args, res.data, out);
          await store.del('outbox', op.key);
          out.done++;
        }
      } finally {
        state.syncing = false;
        try { await flushMeta(); } catch (e) {}
        await recount();
      }
      if (out.done || out.failed) { try { await hooks.onSynced(out); } catch (e) {} }
      return out;
    }
    async function recountAndHasPending() { await recount(); return state.pending > 0; }
    async function markFailed(op, msg) { op.status = 'failed'; op.error = msg; await store.set('outbox', op.key, op); }
    function recordSuccess(op, args, data, out) {
      var id = null, d = data || {};
      switch (op.name) {
        case 'admin_create_parent': id = d.parent_id; out.codes.push({ role: 'parent', name: String(args.p_full_name || '').trim(), code: d.parent_code }); break;
        case 'admin_create_teacher': id = d.teacher_id; out.codes.push({ role: 'teacher', name: String(args.p_full_name || '').trim(), code: d.teacher_code }); break;
        case 'admin_create_student_for_parent': id = d.student_id; break;
        case 'admin_assign_teacher': id = d.assignment_id; break;
        case 'admin_create_announcement': id = d.announcement_id; break;
        case 'admin_reset_parent_code': out.codes.push({ role: 'parent', name: nm('parents', args.p_parent_id) || args.p_parent_id, code: d.parent_code, reset: true }); break;
        case 'admin_reset_teacher_code': out.codes.push({ role: 'teacher', name: nm('teachers', args.p_teacher_id) || args.p_teacher_id, code: d.teacher_code, reset: true }); break;
        case 'subjects': if (op.kind === 'insert') id = d.id; break;
      }
      if (op.tmpId && id) { idmap[op.tmpId] = id; persistSoon(); }
    }

    function describe(op) {
      var a = op.args || {}, n = function (t, id) { return nm(t, id) || '…'; };
      switch (op.kind + ':' + op.name) {
        case 'rpc:admin_create_parent': return 'Créer le parent « ' + a.p_full_name + ' »';
        case 'rpc:admin_create_teacher': return 'Créer l’enseignant « ' + a.p_full_name + ' »';
        case 'rpc:admin_create_student_for_parent': return 'Ajouter l’élève « ' + a.p_student_full_name + ' » (' + n('classes', a.p_class_id) + ')';
        case 'rpc:admin_link_student_to_parent': return 'Lier l’élève « ' + n('students', a.p_student_id) + ' » au parent « ' + n('parents', a.p_parent_id) + ' »';
        case 'rpc:admin_assign_teacher': return 'Affecter ' + n('teachers', a.p_teacher_id) + ' à ' + n('classes', a.p_class_id) + ' / ' + n('subjects', a.p_subject_id);
        case 'rpc:admin_update_teacher_assignment': return 'Modifier une affectation (' + n('teachers', a.p_teacher_id) + ' → ' + n('classes', a.p_class_id) + ' / ' + n('subjects', a.p_subject_id) + ')';
        case 'rpc:admin_create_announcement': return 'Envoyer le message « ' + a.p_title + ' »';
        case 'rpc:admin_delete_announcements': return 'Supprimer ' + (a.p_announcement_ids || []).length + ' message(s)';
        case 'rpc:admin_reset_parent_code': return 'Nouveau code pour le parent « ' + n('parents', a.p_parent_id) + ' »';
        case 'rpc:admin_reset_teacher_code': return 'Nouveau code pour l’enseignant « ' + n('teachers', a.p_teacher_id) + ' »';
        case 'insert:subjects': return 'Ajouter la matière « ' + (a.row && a.row.name) + ' »';
        case 'delete:classes': return 'Supprimer la classe « ' + n('classes', a.id) + ' »';
        case 'delete:subjects': return 'Supprimer la matière « ' + n('subjects', a.id) + ' »';
        case 'delete:teacher_assignments': return 'Retirer une affectation';
        case 'delete:notes': return 'Supprimer une note';
        default: return op.kind + ' ' + op.name;
      }
    }

    var client = {
      auth: new Proxy(auth, { get: function (t, p) { if (p in t) return t[p]; var v = raw.auth[p]; return typeof v === 'function' ? v.bind(raw.auth) : v; } }),
      from: from, rpc: rpc
    };
    client = new Proxy(client, { get: function (t, p) { if (p in t) return t[p]; var v = raw[p]; return typeof v === 'function' ? v.bind(raw) : v; } });

    var timer = null;
    function start() {
      ready().then(function () { return probe(); }).then(function () { if (state.pending > 0 && state.online) flush(); });
      if (o.noTimers) return;
      timer = setInterval(async function () { await probe(); if (state.online && state.pending > 0 && !state.syncing) flush(); }, 15000);
      if (root.addEventListener) {
        root.addEventListener('online', function () { probe().then(function () { if (state.pending > 0) flush(); }); });
        root.addEventListener('offline', noteOffline);
      }
    }

    return {
      client: client, start: start, flush: flush, probe: probe, state: state, describe: describe, ready: ready,
      listOps: listOps, recount: recount,
      lastQueuedAt: function () { return lastQueuedAt; },
      async retryFailed() { var l = await listOps(); for (var i = 0; i < l.length; i++) if (l[i].status === 'failed') { l[i].status = 'pending'; delete l[i].error; await store.set('outbox', l[i].key, l[i]); } await recount(); return flush(true); },
      async discard(key) { await store.del('outbox', key); await recount(); },
      _internal: { idmap: function () { return idmap; }, names: function () { return names; }, setOnline: function (v) { state.online = v; }, setAuthed: function (v) { state.authed = v; } }
    };
  }

  // ------------------------------------------------------------------ interface (navigateur uniquement)
  function browserHooks(getLayer) {
    var pill = null, toastBox = null;
    function el(tag, css, text) { var e = document.createElement(tag); if (css) e.style.cssText = css; if (text) e.textContent = text; return e; }
    function ensureUi() {
      if (pill || !document.body) return;
      pill = el('button', 'position:fixed;left:12px;bottom:12px;z-index:95;border:0;border-radius:999px;padding:8px 14px;font:700 12px/1 Arial,sans-serif;color:#fff;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.25)');
      pill.onclick = openPanel;
      document.body.appendChild(pill);
      toastBox = el('div', 'position:fixed;right:14px;bottom:14px;z-index:96;display:flex;flex-direction:column;gap:8px;max-width:380px');
      document.body.appendChild(toastBox);
    }
    function toast(msg, kind) {
      ensureUi(); if (!toastBox) return;
      var t = el('div', 'padding:11px 14px;border-radius:12px;color:#fff;font:600 13px/1.35 Arial,sans-serif;box-shadow:0 6px 20px rgba(0,0,0,.28);background:' + (kind === 'err' ? '#8B2D1C' : kind === 'warn' ? '#B7791F' : '#2F6B2F'), msg);
      toastBox.appendChild(t); setTimeout(function () { t.remove(); }, 7000);
    }
    function onState(s) {
      ensureUi(); if (!pill) return;
      var txt, bg;
      if (s.failed > 0) { txt = '⚠ ' + s.failed + ' modification(s) en erreur'; bg = '#8B2D1C'; }
      else if (s.syncing) { txt = '⟳ Synchronisation en cours…'; bg = '#2563A8'; }
      else if (s.online === false) { txt = '● Hors connexion' + (s.pending ? ' · ' + s.pending + ' en attente' : ''); bg = '#B7791F'; }
      else if (s.pending > 0) { txt = '⏳ ' + s.pending + ' en attente de synchronisation'; bg = '#2563A8'; }
      else { txt = '● En ligne · à jour'; bg = '#2F6B2F'; }
      pill.textContent = txt; pill.style.background = bg;
      pill.title = diagText(s);
    }
    function diagText(s) {
      var d = s.diag, t = [];
      if (d) t.push('Test réseau : ' + (d.ok ? 'serveur joignable' + (d.status ? ' (HTTP ' + d.status + ')' : '') : 'échec — ' + d.error));
      if (s.lastError) t.push('Dernière erreur de requête : ' + s.lastError);
      return t.join('\n') || 'Cliquez pour voir la synchronisation';
    }
    function modal(html) {
      var wrap = el('div'); wrap.className = 'modal'; wrap.style.zIndex = '97';
      var card = el('div'); card.className = 'modal-card'; card.style.width = 'min(720px,100%)'; card.innerHTML = html;
      wrap.appendChild(card);
      wrap.addEventListener('click', function (e) { if (e.target === wrap) wrap.remove(); });
      document.body.appendChild(wrap); return wrap;
    }
    function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
    async function openPanel() {
      var L = getLayer(), ops = await L.listOps();
      var rows = ops.map(function (op) {
        return '<tr><td>' + esc(new Date(op.ts).toLocaleString('fr-FR')) + '</td><td>' + esc(L.describe(op)) + '</td><td>' +
          (op.status === 'failed' ? '<span class="pill red">Erreur</span><div class="hint">' + esc(op.error) + '</div>' : '<span class="pill gray">En attente</span>') +
          '</td><td>' + (op.status === 'failed' ? '<button class="btn red small" data-discard="' + esc(op.key) + '">Abandonner</button>' : '') + '</td></tr>';
      }).join('') || '<tr><td colspan="4" class="empty">Aucune modification en attente. Tout est synchronisé.</td></tr>';
      var w = modal('<h2>Synchronisation</h2><p class="muted">' + (L.state.online === false ? 'Hors connexion : vos saisies sont enregistrées sur cet ordinateur et seront envoyées automatiquement au retour d’Internet.' : 'Connecté à Internet.') +
        '</p><p class="hint" style="white-space:pre-line">' + esc(diagText(L.state)) + '</p><div style="overflow:auto;max-height:50vh"><table><thead><tr><th>Date</th><th>Modification</th><th>Statut</th><th></th></tr></thead><tbody>' + rows + '</tbody></table></div>' +
        '<div class="row" style="margin-top:14px;justify-content:flex-end"><button class="btn ghost" data-close>Fermer</button><button class="btn" data-sync>Synchroniser maintenant</button></div>');
      w.addEventListener('click', async function (e) {
        var t = e.target;
        if (t.hasAttribute('data-close')) w.remove();
        if (t.hasAttribute('data-sync')) { w.remove(); var failed = ops.some(function (o) { return o.status === 'failed'; }); if (failed) await L.retryFailed(); else await L.flush(true); }
        if (t.getAttribute('data-discard')) { await L.discard(t.getAttribute('data-discard')); w.remove(); openPanel(); }
      });
    }
    async function onSynced(out) {
      if (out.done) toast('Synchronisation terminée : ' + out.done + ' modification(s) envoyée(s) à Supabase.', 'ok');
      if (out.failed) toast(out.failed + ' modification(s) refusée(s) par le serveur — voir le bouton en bas à gauche.', 'err');
      try { if (root.loadAll) await root.loadAll(); var m = document.getElementById('messages'); if (m && m.classList.contains('active') && root.loadMessages) await root.loadMessages(); } catch (e) {}
      if (out.codes.length) {
        var rows = out.codes.map(function (c) {
          return '<tr><td>' + (c.role === 'parent' ? 'Parent' : 'Enseignant') + '</td><td><b>' + esc(c.name) + '</b></td><td><span class="code">' + esc(c.code) + '</span></td><td>' + (c.reset ? 'Nouveau code' : 'Création') + '</td></tr>';
        }).join('');
        modal('<h2>Codes d’accès générés</h2><p class="muted">Ces codes ont été attribués par le serveur lors de la synchronisation. Notez-les ou retrouvez-les dans « Codes d’accès ».</p>' +
          '<table><thead><tr><th>Type</th><th>Nom</th><th>Code</th><th></th></tr></thead><tbody>' + rows + '</tbody></table>' +
          '<div class="row" style="margin-top:14px;justify-content:flex-end"><button class="btn" onclick="this.closest(\'.modal\').remove()">OK</button></div>');
      }
    }
    return {
      onState: onState, toast: toast, onSynced: onSynced,
      askPassword: function (m) { return root.askPassword ? root.askPassword(m) : Promise.resolve(null); }
    };
  }

  // Requêtes réseau via le processus principal d'Electron (pile réseau Chromium système : proxy, DNS, pas de CORS).
  function makeDesktopFetch() {
    if (!(root.desktop && typeof root.desktop.fetch === 'function')) return null;
    var native = root.fetch.bind(root);
    return async function (input, init) {
      init = init || {};
      if (typeof input !== 'string' || (init.body != null && typeof init.body !== 'string')) return native(input, init);
      var headers = {}, h = init.headers;
      if (h) {
        if (Array.isArray(h)) h.forEach(function (kv) { headers[kv[0]] = kv[1]; });
        else if (typeof h.forEach === 'function') h.forEach(function (v, k) { headers[k] = v; });
        else Object.assign(headers, h);
      }
      var r = await root.desktop.fetch({ url: input, method: init.method || 'GET', headers: headers, body: init.body == null ? null : init.body });
      if (!r.ok) throw new TypeError('Failed to fetch (' + r.error + ')');
      var nullBody = r.status === 204 || r.status === 205 || r.status === 304;
      return new Response(nullBody ? null : r.body, { status: r.status, statusText: r.statusText, headers: r.headers });
    };
  }

  function install(rawClient, url, key) {
    var layer;
    var hooks = browserHooks(function () { return layer; });
    layer = createLayer({ raw: rawClient, url: url, key: key, desktop: !!root.__amenDesktopFetch, fetch: root.__amenDesktopFetch || undefined, store: typeof indexedDB !== 'undefined' ? idbStore() : memoryStore(), hooks: hooks });
    root.AmenOffline = layer;
    layer.start();
    document.addEventListener('DOMContentLoaded', function () {
      hooks.onState(layer.state);
      // Complète les messages de succès quand l'action vient d'être mise en file d'attente.
      var n = root.notice;
      if (typeof n === 'function') {
        root.notice = function (id, text, good) {
          n.apply(this, arguments);
          if ((good === undefined || good === true) && Date.now() - layer.lastQueuedAt() < 2500) {
            var e = document.getElementById(id);
            if (e) e.textContent = text + ' — enregistré sur cet ordinateur, synchronisation automatique dès le retour d’Internet.';
          }
        };
      }
    });
    return layer.client;
  }

  var api = { createLayer: createLayer, memoryStore: memoryStore, idbStore: idbStore, PENDING_CODE: PENDING_CODE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root.supabase && typeof root.supabase.createClient === 'function' && typeof document !== 'undefined') {
    var orig = root.supabase.createClient.bind(root.supabase);
    root.supabase.createClient = function (url, key, opts) {
      var df = makeDesktopFetch();
      root.__amenDesktopFetch = df;
      if (df) { opts = Object.assign({}, opts); opts.global = Object.assign({}, opts.global, { fetch: df }); }
      return install(orig(url, key, opts), url, key);
    };
  }
})(typeof window !== 'undefined' ? window : globalThis);
