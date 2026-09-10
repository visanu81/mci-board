// Production-source regression tests. No Firebase/network access or patient data.
export async function runSafetyTests(html) {
  const results = [];
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const equal = (a, b, message) => assert(JSON.stringify(a) === JSON.stringify(b), message);
  const test = async (name, fn) => {
    try { await fn(); results.push({ name, passed: true }); }
    catch (error) { results.push({ name, passed: false, error: error.message }); }
  };
  const between = (start, end) => {
    const a = html.indexOf(start), b = html.indexOf(end, a);
    if (a < 0 || b < 0) throw new Error('Source boundary missing: ' + start);
    return html.slice(a, b);
  };
  function harness(options = {}) {
    let raw = options.raw ?? null;
    const writes = [], statuses = {}, notices = [];
    const storage = {
      getItem() { if (options.readError) throw new Error('SecurityError'); return raw; },
      setItem(key, value) {
        if (options.quota || (options.evictSent && value.includes('"status":"sent"'))) throw new Error('QuotaExceededError');
        raw = value;
      }
    };
    const remoteWrite = (method) => (r, value) => {
      writes.push({ method, path: r, value });
      return options.online === false ? new Promise(() => {}) : Promise.resolve();
    };
    const core = between('const OUTBOX_KEY =', '// 미전송 배지(');
    const saves = between('async function saveCasualty(', '// ==================== 데이터 내보내기');
    const patch = html.includes('function changedCardFields(')
      ? between('function changedCardFields(', 'function currentCasualtyDraft(') : '';
    const source = core + '\n' + saves + '\n' + patch + `
      return {
        saveCasualty, saveMciCasualty, deleteCasualty, deleteMciCasualty,
        outboxCleanup, replayOutbox, outboxEnqueue,
        changedCardFields: typeof changedCardFields === 'function' ? changedCardFields : null
      };`;
    const api = new Function('localStorage', 'navigator', 'window', 'ref', 'set', 'update', 'remove', 'push',
      'db', 'state', 'incPath', 'assertCanWrite', 'setSaveStatus', 'clearSaveStatus', 'setTimeout',
      'POPOUT_DISPLAY', 'authReady', 'updateOutboxBadge', source)(
      storage, { onLine: options.online !== false },
      { __mciShowOutboxStatus: (m) => notices.push(m) },
      (db, path) => path, remoteWrite('set'), remoteWrite('update'), remoteWrite('remove'),
      () => ({ key: 'new-card' }), {}, { currentIncidentId: 'test', casualties: [], mciCasualties: [] },
      (suffix) => 'mci2/incidents/test/' + suffix, () => true,
      (key, value) => { statuses[key] = value; }, () => {}, () => 0, false, Promise.resolve(), () => {});
    return { ...api, raw: () => raw, writes, statuses, notices };
  }
  const card = () => ({ cardNo: 1, name: 'TEST', triage: 'urgent', hospital: '', notes: '' });
  await test('MCI save rejects quota failure before any network write', async () => {
    const x = harness({ quota: true });
    assert(await x.saveMciCasualty(card(), 'medical', 'tester') === false, 'save incorrectly succeeded');
    assert(x.writes.length === 0, 'network write started without durable storage');
    assert(x.statuses.mciCasualty.error, 'no visible save error');
    assert(!x.statuses.mciCasualty.savedAt, 'displayed saved status');
  });
  await test('General casualty save rejects quota failure', async () => {
    const x = harness({ quota: true });
    assert(await x.saveCasualty(card(), 'medical', 'tester') === false, 'save incorrectly succeeded');
    assert(x.statuses.casualty.error, 'general save error missing');
  });
  await test('Offline quota failure does not claim queued data', async () => {
    const x = harness({ quota: true, online: false });
    assert(await x.saveMciCasualty(card(), 'medical', 'tester') === false, 'lost input reported as queued');
    assert(x.writes.length === 0, 'unpersisted write sent');
  });
  await test('Corrupt outbox remains intact after attempted save', async () => {
    const raw = '{"v":1,"ops":BROKEN';
    const x = harness({ raw });
    assert(await x.saveMciCasualty(card(), 'medical', 'tester') === false, 'corrupt queue accepted');
    equal(x.raw(), raw, 'corrupt queue overwritten');
    assert(x.writes.length === 0, 'write started after corrupt read');
  });
  await test('Malformed outbox structure cannot be replaced', async () => {
    const raw = JSON.stringify({ v: 1, seq: 1, ops: [] });
    const x = harness({ raw });
    assert(await x.saveMciCasualty(card(), 'medical', 'tester') === false, 'malformed queue accepted');
    equal(x.raw(), raw, 'original malformed queue overwritten');
  });
  await test('Unavailable browser storage fails visibly', async () => {
    const x = harness({ readError: true });
    assert(await x.saveMciCasualty(card(), 'medical', 'tester') === false, 'unreadable storage accepted');
    assert(x.statuses.mciCasualty.error, 'read failure not shown');
  });
  await test('Cleanup and replay preserve a corrupt queue', async () => {
    const raw = '{"broken"';
    const x = harness({ raw });
    x.outboxCleanup();
    await x.replayOutbox({ manual: true });
    equal(x.raw(), raw, 'maintenance overwrote corrupt data');
    assert(x.writes.length === 0, 'maintenance sent corrupt data');
  });
  await test('Storage failure prevents both delete routes', async () => {
    for (const method of ['deleteCasualty', 'deleteMciCasualty']) {
      const x = harness({ quota: true });
      assert(await x[method]('existing') === false, method + ' reported success');
      assert(x.writes.length === 0, method + ' sent an unpersisted deletion');
    }
  });
  await test('Offline card is persisted before returning queued success', async () => {
    const x = harness({ online: false });
    assert(await x.saveMciCasualty(card(), 'medical', 'tester'), 'offline save failed');
    const entries = Object.values(JSON.parse(x.raw()).ops);
    assert(entries.length === 1 && entries[0].payload.name === 'TEST', 'offline data missing');
    assert(x.statuses.mciCasualty.queued, 'queued status missing');
    const restarted = harness({ raw: x.raw() });
    // Simulate a subsequent boot after the interrupted send expires.
    const data = JSON.parse(restarted.raw());
    Object.values(data.ops).forEach(op => { op.updatedAt = Date.now() - 20000; });
    const boot = harness({ raw: JSON.stringify(data) });
    boot.outboxCleanup();
    await boot.replayOutbox();
    assert(boot.writes.length === 1, 'persisted record not replayed');
    equal(boot.writes[0].path, entries[0].path, 'replay created a different card');
  });
  await test('Online card is acknowledged only after successful write', async () => {
    const x = harness();
    assert(await x.saveMciCasualty(card(), 'medical', 'tester'), 'online save failed');
    assert(!x.statuses.mciCasualty.queued, 'successful write marked queued');
    assert(Object.values(JSON.parse(x.raw()).ops)[0].status === 'sent', 'acknowledgment missing');
  });
  await test('Space recovery removes sent entries and retains pending entries', async () => {
    const pending = { opId: 'keep', seq: 1, status: 'pending', payload: { name: 'PENDING' } };
    const raw = JSON.stringify({ v: 1, seq: 3, ops: {
      keep: pending, done: { opId: 'done', seq: 2, status: 'sent' }
    } });
    const x = harness({ raw, evictSent: true, online: false });
    assert(await x.saveMciCasualty(card(), 'medical', 'tester'), 'recovery save failed');
    const ops = JSON.parse(x.raw()).ops;
    equal(ops.keep, pending, 'pending record modified/removed');
    assert(!ops.done && Object.keys(ops).length === 2, 'wrong records evicted');
  });
  await test('Editing sends changed fields without clearing another operators hospital', async () => {
    const x = harness();
    const base = card();
    await x.saveMciCasualty({ ...base, notes: 'updated' }, 'resource', 'editor', 'existing', base);
    const patch = x.writes[0].value;
    assert(patch.notes === 'updated', 'changed field absent');
    assert(!('hospital' in patch) && !('triage' in patch), 'untouched fields sent');
    const server = { ...base, hospital: 'OTHER-HOSPITAL', author: 'creator', ...patch };
    assert(server.hospital === 'OTHER-HOSPITAL' && server.author === 'creator', 'concurrent value or author lost');
    assert(patch._updatedBy === 'editor', 'editor metadata missing');
  });
  await test('Explicitly clearing a field is retained in the patch', async () => {
    const x = harness();
    const base = { ...card(), notes: 'old' };
    await x.saveMciCasualty({ ...base, notes: '' }, 'medical', 'tester', 'existing', base);
    assert(x.writes[0].value.notes === '', 'explicit clear discarded');
  });
  await test('Editing an auto-named card does not rename its original author', async () => {
    const x = harness();
    const base = { ...card(), name: '#001 -creator' };
    await x.saveMciCasualty({ ...base, notes: 'updated' }, 'resource', 'editor', 'existing', base);
    assert(!('name' in x.writes[0].value), 'auto-name replaced while editing notes');
  });
  await test('Both edit entry points retain photos, zero vitals, and independent baselines', () => {
    const list = between("  // 수정 진입\n  document.querySelectorAll('.mci-edit-btn')", '  // 삭제\n');
    const modal = between('function bindMciCardDetailModalEvents()', '// ==================== 외부(야외)');
    for (const section of [list, modal]) {
      const start = section.indexOf('const editDraft = {');
      assert(start >= 0, 'edit draft not found');
      const end = section.indexOf('\n      };', start);
      const draftSource = section.slice(start, end + '\n      };'.length);
      const create = new Function('c', 'btn', 'mechList', draftSource + '; return editDraft;');
      const draft = create({ _key: 'existing', cardNo: 1, cardPhoto: 'CARD', patientPhoto: 'PATIENT',
        rr: 0, pulse: 0, bpSys: 0, bpDia: 0, spo2: 0, temp: 0 },
        { dataset: { mciEdit: 'existing' } }, () => []);
      assert(draft.cardPhoto === 'CARD' && draft.patientPhoto === 'PATIENT', 'photos lost');
      assert(draft.rr === 0 && draft.spo2 === 0, 'zero vital values lost');
      assert(section.includes('JSON.parse(JSON.stringify(cardDraftPayload(editDraft)))'), 'baseline is mutable');
    }
    assert(list.includes("if (state.mode === 'general') csDraft = editDraft; else mciDraft = editDraft;"), 'general mode edits MCI draft');
  });
  await test('Production routing defaults all other hosts to test data', () => {
    const config = between('const PRODUCTION_HOSTS =', '// ==================== 표출 팝아웃');
    const root = new Function('location', config + '; return DB_ROOT;');
    equal(root({ hostname: 'mci.visanu81.workers.dev' }), '', 'production route incorrect');
    for (const hostname of ['mci2.visanu81.workers.dev', 'localhost', 'preview.example', 'mci.visanu81.workers.dev.evil.example']) {
      equal(root({ hostname }), 'mci2', 'non-production host reached production data');
    }
  });
  await test('Every inline application script parses', () => {
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/g)];
    assert(scripts.length > 0, 'no scripts found');
    for (const [, attrs, body] of scripts) {
      if (attrs.includes('src=') || attrs.includes('application/ld+json')) continue;
      const source = body.replace(/import\s+[\s\S]*?\s+from\s+["'][^"']+["'];/g, '');
      new Function(source);
    }
  });
  return results;
}
