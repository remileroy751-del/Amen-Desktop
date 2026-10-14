// Banc de test de la couche hors connexion (lancer : node test/offline-layer.test.js)
const assert = require('assert');
const { createLayer, memoryStore, PENDING_CODE } = require('../renderer/offline-layer.js');

function makeServer() {
  const srv = { online: true, sessionOk: true, n: 0, calls: [], db: {
    classes: [{ id: 'c1', name: '6e', code: '6E' }, { id: 'c2', name: '5e', code: '5E' }],
    subjects: [{ id: 's1', name: 'Maths' }],
    parents: [], teachers: [{ id: 't1', full_name: 'M. Kossi', phone: null, created_at: '2026-01-01' }],
    students: [], teacher_assignments: [], notes: [], announcements: [], student_parents: [], codes: [] } };
  const NET = { data: null, error: { message: 'TypeError: Failed to fetch' } };
  const nid = p => p + (++srv.n);
  const name = (t, id) => { const r = srv.db[t].find(x => x.id === id); return r ? (r.name || r.full_name) : null; };
  const shape = (t, r) => {
    if (t === 'students') return { ...r, classes: { id: r.class_id, name: name('classes', r.class_id) } };
    if (t === 'teacher_assignments') return { ...r, teachers: { id: r.teacher_id, full_name: name('teachers', r.teacher_id) }, classes: { id: r.class_id, name: name('classes', r.class_id) }, subjects: { id: r.subject_id, name: name('subjects', r.subject_id) } };
    return r;
  };
  const authErr = () => !srv.sessionOk ? { data: null, error: { message: 'JWT expired' } } : null;
  const rpcs = {
    admin_create_parent: a => { if (!String(a.p_full_name || '').trim()) throw new Error('Nom du parent obligatoire.'); const id = nid('par'); const code = 'PC' + srv.n; srv.db.parents.push({ id, full_name: a.p_full_name.trim(), phone: a.p_phone, created_at: new Date().toISOString() }); return { success: true, parent_id: id, parent_code: code }; },
    admin_create_teacher: a => { const id = nid('tea'); srv.db.teachers.push({ id, full_name: a.p_full_name, phone: a.p_phone, created_at: new Date().toISOString() }); return { success: true, teacher_id: id, teacher_code: 'TC' + srv.n }; },
    admin_create_student_for_parent: a => { if (!srv.db.parents.find(p => p.id === a.p_parent_id)) throw new Error('Parent introuvable.'); const id = nid('stu'); srv.db.students.push({ id, full_name: a.p_student_full_name, class_id: a.p_class_id }); srv.db.student_parents.push({ student_id: id, parent_id: a.p_parent_id, relationship: a.p_relationship }); return { success: true, student_id: id }; },
    admin_assign_teacher: a => { if (!name('subjects', a.p_subject_id)) throw new Error('Matière introuvable.'); const id = nid('asg'); srv.db.teacher_assignments.push({ id, teacher_id: a.p_teacher_id, class_id: a.p_class_id, subject_id: a.p_subject_id, is_homeroom: a.p_is_homeroom, created_at: new Date().toISOString() }); return { success: true, assignment_id: id }; },
    admin_create_announcement: a => { const id = nid('ann'); srv.db.announcements.push({ id, title: a.p_title, body: a.p_body, importance: a.p_importance, target_type: a.p_target_type, created_at: new Date().toISOString() }); return { success: true, announcement_id: id }; },
    admin_delete_announcements: a => { srv.db.announcements = srv.db.announcements.filter(x => !a.p_announcement_ids.includes(x.id)); return a.p_announcement_ids.length; },
    admin_reset_parent_code: a => ({ success: true, parent_id: a.p_parent_id, parent_code: 'RESET' + (++srv.n) }),
    admin_access_codes: () => srv.db.parents.map(p => ({ id: 'r' + p.id, role: 'parent', parent_id: p.id, full_name: p.full_name, phone: p.phone, access_code: 'X', generated_at: p.created_at, is_current: true })),
    bootstrap_admin: () => ({ success: true })
  };
  srv.raw = {
    from(table) {
      const st = { table, calls: [] };
      const b = new Proxy({}, { get(_, p) {
        if (p === 'then') return (res, rej) => exec().then(res, rej);
        return (...args) => { st.calls.push([p, args]); return b; };
      } });
      const exec = async () => {
        if (!srv.online) return NET;
        const e = authErr(); if (e) return e;
        srv.calls.push(['from', table, st.calls.map(c => c[0]).join('.')]);
        const has = n => st.calls.some(c => c[0] === n);
        if (has('delete')) { const id = st.calls.find(c => c[0] === 'eq')[1][1]; srv.db[table] = srv.db[table].filter(x => x.id !== id); return { data: null, error: null }; }
        if (has('insert')) { const row = { id: nid('sub'), ...st.calls.find(c => c[0] === 'insert')[1][0], created_at: new Date().toISOString() }; srv.db[table].push(row); return { data: row, error: null }; }
        return { data: srv.db[table].map(r => shape(table, r)), error: null };
      };
      return b;
    },
    async rpc(nm, args) {
      if (!srv.online) return NET;
      const e = authErr(); if (e) return e;
      srv.calls.push(['rpc', nm]);
      try { return { data: rpcs[nm](args), error: null }; } catch (err) { return { data: null, error: { message: err.message } }; }
    },
    auth: {
      async signInWithPassword({ email, password }) { if (!srv.online) return { data: { user: null, session: null }, error: { message: 'Failed to fetch', status: 0 } }; if (password !== 'secret') return { data: { user: null, session: null }, error: { message: 'Invalid login credentials' } }; srv.sessionOk = true; return { data: { user: { id: 'u1', email }, session: {} }, error: null }; },
      async getSession() { return { data: { session: srv.sessionOk ? { user: { id: 'u1' } } : null }, error: null }; },
      async getUser() { if (!srv.online) return { data: { user: null }, error: { message: 'Failed to fetch', status: 0 } }; return { data: { user: { id: 'u1', email: 'dir@amen.tg' } }, error: null }; },
      async signOut() { return { error: null }; }
    }
  };
  srv.fetch = async () => { if (!srv.online) throw new TypeError('Failed to fetch'); return { status: 401 }; };
  return srv;
}

const Q = {
  classes: L => L.client.from('classes').select('*').order('name'),
  subjects: L => L.client.from('subjects').select('*').order('name'),
  parents: L => L.client.from('parents').select('id,full_name,phone,created_at').order('full_name'),
  teachers: L => L.client.from('teachers').select('id,full_name,phone,created_at').order('full_name'),
  students: L => L.client.from('students').select('id,full_name,class_id,classes(id,name)').order('full_name'),
  assign: L => L.client.from('teacher_assignments').select('id,teacher_id,class_id,subject_id,is_homeroom,teachers(id,full_name),classes(id,name),subjects(id,name)').order('created_at'),
  news: L => L.client.from('announcements').select('*').order('created_at', { ascending: false }),
  links: L => L.client.from('student_parents').select('student_id,parent_id,relationship')
};
const loadAll = async L => { const o = {}; for (const k of Object.keys(Q)) o[k] = (await Q[k](L)); return o; };

let passed = 0;
const test = async (title, fn) => { try { await fn(); passed++; console.log('  ✓', title); } catch (e) { console.error('  ✗', title, '\n   ', e.stack); process.exitCode = 1; } };

(async () => {
  const srv = makeServer(), store = memoryStore();
  const synced = [];
  const hooks = { onSynced: async o => synced.push(o), askPassword: async () => 'secret' };
  const L = createLayer({ raw: srv.raw, url: 'http://x', key: 'k', store, fetch: srv.fetch, noTimers: true, hooks });
  await L.ready();

  await test('connexion en ligne + lecture initiale mise en cache', async () => {
    const r = await L.client.auth.signInWithPassword({ email: 'dir@amen.tg', password: 'secret' });
    assert.ok(!r.error);
    const all = await loadAll(L);
    assert.equal(all.classes.data.length, 2);
    assert.equal(all.teachers.data.length, 1);
  });

  await test('hors connexion : lecture servie depuis le cache', async () => {
    srv.online = false; await L.probe();
    assert.equal(L.state.online, false);
    const r = await Q.classes(L);
    assert.equal(r.error, null); assert.equal(r.data.length, 2); assert.ok(r.offline);
  });

  let parentId, studentId, subjId;
  await test('hors connexion : création parent / élève / matière / affectation / message', async () => {
    const p = await L.client.rpc('admin_create_parent', { p_full_name: '  Mme Adjovi ', p_phone: '90000000' });
    assert.equal(p.error, null); assert.equal(p.data.parent_code, PENDING_CODE); parentId = p.data.parent_id;
    assert.ok(parentId.startsWith('tmp_'));
    const s = await L.client.rpc('admin_create_student_for_parent', { p_student_full_name: 'Koffi Adjovi', p_class_id: 'c1', p_parent_id: parentId, p_relationship: 'Parent' });
    assert.equal(s.error, null); studentId = s.data.student_id;
    const sub = await L.client.from('subjects').insert({ name: 'Physique' }).select().single();
    assert.equal(sub.error, null); subjId = sub.data.id;
    const a = await L.client.rpc('admin_assign_teacher', { p_teacher_id: 't1', p_class_id: 'c1', p_subject_id: subjId, p_is_homeroom: true });
    assert.equal(a.error, null);
    const n = await L.client.rpc('admin_create_announcement', { p_title: 'Réunion', p_body: 'Samedi', p_importance: 'urgent', p_target_type: 'all_parents', p_class_id: null, p_student_id: null, p_parent_id: null, p_teacher_id: null });
    assert.equal(n.error, null);
    assert.equal(L.state.pending, 5);
    assert.equal(srv.db.parents.length, 0, 'rien ne doit être parti vers le serveur');
  });

  await test('hors connexion : l’affichage reflète les saisies (jointures incluses)', async () => {
    const all = await loadAll(L);
    assert.equal(all.parents.data.length, 1); assert.equal(all.parents.data[0].full_name, 'Mme Adjovi');
    assert.equal(all.students.data[0].classes.name, '6e');
    assert.ok(all.links.data.some(x => x.student_id === studentId && x.parent_id === parentId));
    assert.equal(all.subjects.data.map(x => x.name).join(), 'Maths,Physique');
    assert.equal(all.assign.data[0].subjects.name, 'Physique'); assert.equal(all.assign.data[0].teachers.full_name, 'M. Kossi');
    assert.equal(all.news.data[0].title, 'Réunion');
    const codes = await L.client.rpc('admin_access_codes');
    assert.equal(codes.data.length, 1); assert.equal(codes.data[0].access_code, PENDING_CODE);
  });

  await test('hors connexion : suppression d’un élément non encore synchronisé annule sa création et ses dépendances', async () => {
    const t = await L.client.from('subjects').insert({ name: 'Temp' }).select().single();
    const a = await L.client.rpc('admin_assign_teacher', { p_teacher_id: 't1', p_class_id: 'c2', p_subject_id: t.data.id, p_is_homeroom: false });
    assert.equal(L.state.pending, 7);
    const d = await L.client.from('subjects').delete().eq('id', t.data.id);
    assert.equal(d.error, null);
    assert.equal(L.state.pending, 5);
    assert.ok(!(await Q.subjects(L)).data.some(x => x.name === 'Temp'));
  });

  await test('hors connexion : suppression d’une classe existante masquée localement ; création de classe refusée', async () => {
    await L.client.from('classes').delete().eq('id', 'c2');
    assert.equal((await Q.classes(L)).data.length, 1);
    const r = await L.client.rpc('admin_create_class', { p_name: 'X', p_code: 'X', p_password: 'pw' });
    assert.ok(r.error && /hors connexion/i.test(r.error.message));
    assert.equal(L.state.pending, 6);
  });

  await test('hors connexion : redémarrage — la file d’attente persiste', async () => {
    const L2 = createLayer({ raw: srv.raw, url: 'http://x', key: 'k', store, fetch: srv.fetch, noTimers: true, hooks });
    await L2.ready();
    assert.equal(L2.state.pending, 6);
    L2._internal.setOnline(false);
    const r = await L2.client.from('parents').select('id,full_name,phone,created_at').order('full_name');
    assert.equal(r.data.length, 1);
  });

  await test('retour de la connexion : synchronisation ordonnée avec remplacement des identifiants temporaires', async () => {
    srv.online = true;
    const out = await L.flush(true);
    assert.equal(out.failed, 0, JSON.stringify(out));
    assert.equal(out.done, 6);
    assert.equal(L.state.pending, 0);
    assert.equal(srv.db.parents.length, 1);
    const realParent = srv.db.parents[0].id;
    assert.equal(srv.db.students.length, 1);
    assert.equal(srv.db.student_parents[0].parent_id, realParent, 'élève rattaché au vrai parent');
    assert.equal(srv.db.teacher_assignments.length, 1);
    assert.equal(srv.db.teacher_assignments[0].subject_id, srv.db.subjects.find(s => s.name === 'Physique').id);
    assert.equal(srv.db.announcements.length, 1);
    assert.equal(srv.db.classes.length, 1, 'classe supprimée côté serveur');
    assert.equal(out.codes.length, 1); assert.ok(/^PC/.test(out.codes[0].code));
    assert.equal(synced.length, 1);
    const all = await loadAll(L);
    assert.ok(all.parents.data[0].id === realParent);
  });

  await test('après synchronisation, les anciens identifiants tmp_ restent utilisables (fenêtre déjà ouverte)', async () => {
    const r = await L.client.rpc('admin_create_student_for_parent', { p_student_full_name: 'Ama', p_class_id: 'c1', p_parent_id: parentId, p_relationship: 'Parent' });
    assert.equal(r.error, null);
    assert.equal(srv.db.students.length, 2);
    assert.equal(srv.db.student_parents[1].parent_id, srv.db.parents[0].id);
  });

  await test('erreur serveur : l’opération échoue sans bloquer les suivantes ; les dépendantes sont marquées en erreur', async () => {
    srv.online = false; await L.probe();
    const bad = await L.client.rpc('admin_create_parent', { p_full_name: '   ', p_phone: null });
    await L.client.rpc('admin_create_student_for_parent', { p_student_full_name: 'Orphelin', p_class_id: 'c1', p_parent_id: bad.data.parent_id, p_relationship: 'Parent' });
    await L.client.rpc('admin_create_teacher', { p_full_name: 'Mme Lawson', p_phone: null });
    srv.online = true;
    const out = await L.flush(true);
    assert.equal(out.done, 1); assert.equal(out.failed, 2);
    assert.ok(srv.db.teachers.some(t => t.full_name === 'Mme Lawson'));
    const ops = await L.listOps();
    assert.equal(ops.filter(o => o.status === 'failed').length, 2);
    assert.ok(/Nom du parent/.test(ops[0].error));
    assert.ok(/introuvable/i.test(ops[1].error));
    for (const o of ops) await L.discard(o.key);
    assert.equal(L.state.failed, 0);
  });

  await test('en ligne : écriture directe ; session expirée pendant la synchro → mot de passe redemandé', async () => {
    const d = await L.client.rpc('admin_create_teacher', { p_full_name: 'M. Direct', p_phone: null });
    assert.ok(d.data.teacher_id && !d.data.teacher_id.startsWith('tmp_'));
    srv.online = false; await L.probe();
    await L.client.rpc('admin_create_teacher', { p_full_name: 'M. Reauth', p_phone: null });
    srv.online = true; srv.sessionOk = false;
    const out = await L.flush(true);
    assert.equal(out.done, 1);
    assert.ok(srv.db.teachers.some(t => t.full_name === 'M. Reauth'));
  });

  await test('connexion hors ligne : bon mot de passe accepté, mauvais refusé, getUser local', async () => {
    srv.online = false;
    const L3 = createLayer({ raw: srv.raw, url: 'http://x', key: 'k', store, fetch: srv.fetch, noTimers: true, hooks });
    await L3.ready();
    const bad = await L3.client.auth.signInWithPassword({ email: 'dir@amen.tg', password: 'nope' });
    assert.ok(bad.error);
    const other = await L3.client.auth.signInWithPassword({ email: 'autre@amen.tg', password: 'secret' });
    assert.ok(other.error);
    const ok = await L3.client.auth.signInWithPassword({ email: 'dir@amen.tg', password: 'secret' });
    assert.equal(ok.error, null);
    const b = await L3.client.rpc('bootstrap_admin', { p_email: 'dir@amen.tg' });
    assert.equal(b.error, null);
    const u = await L3.client.auth.getUser();
    assert.equal(u.data.user.email, 'dir@amen.tg');
    const r = await L3.client.from('classes').select('*').order('name');
    assert.equal(r.error, null); assert.ok(r.data.length >= 1);
  });

  await test('un appel anonyme (avant connexion) n’écrase pas le cache', async () => {
    srv.online = true;
    const S2 = makeServer(), st2 = memoryStore();
    const A = createLayer({ raw: S2.raw, url: 'http://x', key: 'k', store: st2, fetch: S2.fetch, noTimers: true, hooks });
    await A.ready();
    S2.db.classes.length = 0;
    await Q.classes(A); // non authentifié : pas de mise en cache
    A._internal.setAuthed(true); S2.db.classes.push({ id: 'z', name: 'Z' });
    await Q.classes(A);
    S2.online = false; await A.probe();
    assert.equal((await Q.classes(A)).data[0].name, 'Z');
  });

  console.log(`\n${passed} tests réussis` + (process.exitCode ? ' — ÉCHECS ci-dessus' : ''));
})();
