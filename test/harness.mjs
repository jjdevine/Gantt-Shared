// Functional harness for Gantt-Shared/index.html: jsdom + a mock GitHub Contents API.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { JSDOM } from 'jsdom';
import { fileURLToPath } from 'node:url';

const REPO = process.argv[2] || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const API = 'https://api.github.com';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let failures = 0, passes = 0;
function check(cond, label, extra){
  if(cond){ passes++; console.log('  ok   ' + label); }
  else { failures++; console.log('  FAIL ' + label + (extra !== undefined ? '  -> ' + JSON.stringify(extra).slice(0, 400) : '')); }
}

// ---------- mock GitHub ----------
class MockGitHub {
  constructor(){ this.files = new Map(); this.commits = []; this.requests = []; this.readOnly = false; this.offline = false; this.badToken = false; }
  blobSha(content){ return crypto.createHash('sha1').update('blob ' + Buffer.byteLength(content) + '\0' + content).digest('hex'); }
  set(p, content){ this.files.set(p, { content, sha: this.blobSha(content) }); }
  json(status, body, headers){ return new Response(body === null ? null : JSON.stringify(body), { status, headers: Object.assign({ 'content-type': 'application/json' }, headers || {}) }); }
  async handle(url, init){
    init = init || {};
    const method = (init.method || 'GET').toUpperCase();
    const u = new URL(url);
    const headers = new Headers(init.headers || {});
    this.requests.push({ method, path: u.pathname, ifNoneMatch: headers.get('if-none-match'), accept: headers.get('accept') });
    if(this.offline) throw new TypeError('Failed to fetch');
    const auth = headers.get('authorization') || '';
    if(this.badToken || !auth.startsWith('Bearer ')) return this.json(401, { message: 'Bad credentials' });
    if(!u.pathname.startsWith('/')) return this.json(404, { message: 'Not Found' });
    if(u.pathname === '/user') return this.json(200, { login: 'tester' });
    const m = u.pathname.match(/^\/repos\/([^/]+)\/([^/]+)(?:\/contents\/(.*))?$/);
    if(!m) return this.json(404, { message: 'Not Found' });
    if(m[3] === undefined) return this.json(200, { full_name: m[1] + '/' + m[2], permissions: { push: !this.readOnly, pull: true } });
    const p = decodeURIComponent(m[3]);
    const body = init.body ? JSON.parse(init.body) : null;
    if(method === 'GET'){
      if(this.files.has(p)){
        const f = this.files.get(p);
        if((headers.get('accept') || '').includes('raw')) return new Response(f.content, { status: 200 });
        return this.json(200, { name: path.basename(p), path: p, sha: f.sha, type: 'file', content: Buffer.from(f.content).toString('base64') });
      }
      const prefix = p.replace(/\/+$/, '') + '/';
      const list = [...this.files.entries()].filter(([k]) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/'))
        .map(([k, f]) => ({ name: k.slice(prefix.length), path: k, sha: f.sha, type: 'file' }));
      if(!list.length) return this.json(404, { message: 'Not Found' });
      const etag = 'W/"' + crypto.createHash('sha1').update(JSON.stringify(list)).digest('hex') + '"';
      if(headers.get('if-none-match') === etag) return new Response(null, { status: 304, headers: { etag } });
      return this.json(200, list, { etag });
    }
    if(method === 'PUT'){
      if(this.readOnly) return this.json(403, { message: 'Resource not accessible by personal access token' });
      const existing = this.files.get(p);
      if(existing && !body.sha) return this.json(422, { message: 'Invalid request. "sha" wasn\'t supplied.' });
      if(existing && body.sha !== existing.sha) return this.json(409, { message: p + ' does not match ' + body.sha });
      if(!existing && body.sha) return this.json(422, { message: 'sha supplied for new file' });
      const content = Buffer.from(body.content, 'base64').toString('utf8');
      this.set(p, content);
      this.commits.push({ op: 'put', path: p, message: body.message, branch: body.branch });
      return this.json(existing ? 200 : 201, { content: { path: p, sha: this.files.get(p).sha } });
    }
    if(method === 'DELETE'){
      if(this.readOnly) return this.json(403, { message: 'Resource not accessible by personal access token' });
      const existing = this.files.get(p);
      if(!existing) return this.json(404, { message: 'Not Found' });
      if(body.sha !== existing.sha) return this.json(409, { message: 'sha mismatch' });
      this.files.delete(p);
      this.commits.push({ op: 'delete', path: p, message: body.message });
      return this.json(200, { content: null });
    }
    return this.json(405, { message: 'nope' });
  }
}

// ---------- page loader ----------
const d3src = fs.readFileSync(path.join(REPO, 'd3.v7.min.js'), 'utf8');
const cfgsrc = fs.readFileSync(path.join(REPO, 'config.js'), 'utf8');
const rawHtml = fs.readFileSync(path.join(REPO, 'index.html'), 'utf8');

function loadPage({ gh, withConfig = true, token = 'tok', preStorage = {} }){
  let html = rawHtml.replace('<script src="d3.v7.min.js"></script>', () => '<script>' + d3src + '</script>');
  html = html.replace('<script src="config.js"></script>', () => withConfig ? '<script>' + cfgsrc + '</script>' : '');
  const errors = [];
  const dom = new JSDOM(html, {
    url: 'http://localhost/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    beforeParse(window){
      window.fetch = (u, i) => gh.handle(u, i);
      window.Headers = Headers;
      window.TextEncoder = TextEncoder;
      window.TextDecoder = TextDecoder;
      window.ResizeObserver = class { observe(){} disconnect(){} unobserve(){} };
      window.confirm = () => true;
      window.addEventListener('error', (e) => errors.push(e.message || String(e.error)));
      if(token) window.localStorage.setItem('gantt_github_token_v1', token);
      for(const [k, v] of Object.entries(preStorage)) window.localStorage.setItem(k, v);
    }
  });
  dom.window.console.error = () => {}; // silence jsdom "not implemented" noise (location.reload)
  const d = dom.window.document;
  const $ = (id) => d.getElementById(id);
  const status = () => $('syncStatus').textContent;
  const tasks = () => JSON.parse($('json').value).tasks;
  const setAndSave = (data) => { $('json').value = JSON.stringify(data, null, 2); $('saveBtn').click(); };
  const visible = (id) => !$(id).classList.contains('modal-hidden');
  return { dom, w: dom.window, d, $, status, tasks, setAndSave, visible, errors };
}

function task(person, name, extra){
  return Object.assign({ person, task: name, workItemType: 'Feature', description: '', start: '2026-10-06', end: '', durationWeeks: 4,
    capacityImpact: 'medium', utilisationPercent: 50, complete: false, milestones: {} }, extra || {});
}
const body = (tasks) => JSON.stringify({ tasks }, null, 2) + '\n';

// ================= scenario 1: the shared-mode life cycle =================
console.log('\n[1] shared mode: load, save, refresh, conflicts, delete, read-only, offline');
{
  const gh = new MockGitHub();
  gh.set('data/people/alice.json', body([task('alice', 'alice task 1')]));
  gh.set('data/people/bob.json', body([task('bob', 'bob task 1')]));
  const page = loadPage({ gh });
  const { $, status, tasks, setAndSave, visible, errors } = page;
  await sleep(150);
  check(errors.length === 0, 'no uncaught errors on load', errors);
  check($('syncArea').style.display !== 'none', 'sync UI shown');
  check($('resetBtn').style.display === 'none', 'Reset Example hidden in shared mode');
  check(status().startsWith('Synced'), 'status Synced after startup load', status());
  check(tasks().length === 2 && tasks().map(t => t.person).sort().join(',') === 'alice,bob', 'both people loaded from repo', tasks());
  check($('svg').querySelectorAll('rect').length > 0, 'chart rendered bars');

  // 304 fast path on a second refresh
  const before = gh.requests.length;
  $('refreshBtn').click(); await sleep(100);
  const reqs = gh.requests.slice(before);
  check(reqs.length === 1 && reqs[0].ifNoneMatch && status().startsWith('Synced'), 'unchanged refresh is one conditional request (304)', reqs);

  // local edit: modify alice, add a new person -> two commits after debounce
  const t = tasks();
  t[0].task = 'alice task 1 (edited)';
  t.push(task('Carol Smith', 'carol task'));
  setAndSave({ tasks: t });
  check(status() === 'Changes not yet saved', 'status pending right after save', status());
  await sleep(2600);
  check(status().startsWith('Synced'), 'status Synced after debounce flush', status());
  check(gh.commits.length === 2, 'two commits (alice updated, carol created)', gh.commits);
  check(gh.files.has('data/people/carol-smith.json'), 'new person file is slugged carol-smith.json', [...gh.files.keys()]);
  check(JSON.parse(gh.files.get('data/people/alice.json').content).tasks[0].task === 'alice task 1 (edited)', 'alice.json holds the edit');
  check(JSON.parse(gh.files.get('data/people/carol-smith.json').content).tasks[0].person === 'Carol Smith', 'display name kept inside file');
  check(gh.commits.every(c => c.branch === 'main'), 'commits target main');

  // someone else changes bob -> refresh picks it up, only bob fetched
  gh.set('data/people/bob.json', body([task('bob', 'bob task 2 (remote)')]));
  const b2 = gh.requests.length;
  $('refreshBtn').click(); await sleep(150);
  const r2 = gh.requests.slice(b2).filter(r => r.accept && r.accept.includes('raw'));
  check(tasks().some(x => x.task === 'bob task 2 (remote)'), 'remote change visible after refresh', tasks().map(x => x.task));
  check(r2.length === 1 && r2[0].path.endsWith('bob.json'), 'only the changed file was fetched', r2);

  // conflict, keep mine
  gh.set('data/people/alice.json', body([task('alice', 'alice changed remotely')]));
  const t2 = tasks(); t2.find(x => x.person === 'alice').task = 'alice changed locally';
  setAndSave({ tasks: t2 });
  await sleep(2600);
  check(status().startsWith('Conflict'), 'status Conflict on sha mismatch', status());
  check(JSON.parse(gh.files.get('data/people/alice.json').content).tasks[0].task === 'alice changed remotely', 'repo untouched while in conflict');
  $('syncStatus').click();
  check(visible('conflictModal'), 'conflict modal opens from indicator');
  check($('conflictTheirs').value.includes('alice changed remotely') && $('conflictMine').value.includes('alice changed locally'), 'modal shows both versions');
  $('conflictKeepMine').click(); await sleep(200);
  check(!visible('conflictModal'), 'conflict modal closed');
  check(JSON.parse(gh.files.get('data/people/alice.json').content).tasks[0].task === 'alice changed locally', 'Keep mine wrote local version');
  check(status().startsWith('Synced'), 'status Synced after keep mine', status());

  // conflict, keep theirs
  gh.set('data/people/carol-smith.json', body([task('Carol Smith', 'carol remote')]));
  const t3 = tasks(); t3.find(x => x.person === 'Carol Smith').task = 'carol local';
  setAndSave({ tasks: t3 });
  await sleep(2600);
  check(status().startsWith('Conflict'), 'second conflict detected', status());
  $('syncStatus').click();
  $('conflictKeepTheirs').click(); await sleep(200);
  check(tasks().find(x => x.person === 'Carol Smith').task === 'carol remote', 'Keep theirs reloaded repository version locally', tasks());
  check(JSON.parse(gh.files.get('data/people/carol-smith.json').content).tasks[0].task === 'carol remote', 'repo still has theirs');
  check(status().startsWith('Synced'), 'status Synced after keep theirs', status());

  // delete all of bob's tasks -> file removed
  const t4 = tasks().filter(x => x.person !== 'bob');
  setAndSave({ tasks: t4 });
  await sleep(2600);
  check(!gh.files.has('data/people/bob.json'), 'bob.json deleted when last task removed', [...gh.files.keys()]);
  check(gh.commits.at(-1).op === 'delete', 'delete commit recorded', gh.commits.at(-1));

  // read-only token
  gh.readOnly = true;
  const t5 = tasks(); t5[0].task += ' ro';
  setAndSave({ tasks: t5 });
  await sleep(2600);
  check(status().startsWith('Read-only'), 'status Read-only on 403', status());
  gh.readOnly = false;

  // offline then sync now
  gh.offline = true;
  $('syncNowBtn').click(); await sleep(200);
  check(status().startsWith('Offline'), 'status Offline on network error', status());
  gh.offline = false;
  $('syncNowBtn').click(); await sleep(300);
  check(status().startsWith('Synced'), 'Sync now recovers', status());
  check(gh.files.get('data/people/alice.json').content.includes(' ro'), 'queued edit written after recovery');

  // unsaved textarea edits are not clobbered by a refresh
  $('json').value = '{ "tasks": [] }  /* typing */';
  gh.set('data/people/alice.json', body([task('alice', 'alice newer')]));
  $('refreshBtn').click(); await sleep(150);
  check($('json').value.includes('/* typing */'), 'refresh skipped while textarea has unsaved edits');

  // bad token
  gh.badToken = true;
  $('json').value = JSON.stringify({ tasks: tasks0(page) }, null, 2);
  $('refreshBtn').click(); await sleep(150);
  check(status().startsWith('Token rejected'), 'status Token rejected on 401', status());
  gh.badToken = false;

  check(errors.length === 0, 'no uncaught errors during scenario', errors);
  page.w.close();
}
function tasks0(page){ try{ return JSON.parse(page.w.localStorage.getItem('gantt_tasks_v1')).tasks; }catch(e){ return []; } }

// ================= scenario 2: empty repository =================
console.log('\n[2] empty repository (no data/people yet)');
{
  const gh = new MockGitHub();
  const page = loadPage({ gh });
  await sleep(150);
  check(page.status().startsWith('Synced'), 'empty repo loads as Synced', page.status());
  check(page.tasks().length === 0, 'no tasks');
  page.setAndSave({ tasks: [task('dave', 'first ever task')] });
  await sleep(2600);
  check(gh.files.has('data/people/dave.json') && gh.commits[0].op === 'put', 'first file created in empty repo', gh.commits);
  check(page.errors.length === 0, 'no uncaught errors', page.errors);
  page.w.close();
}

// ================= scenario 3: local-only mode (no config.js) =================
console.log('\n[3] local-only mode: no config.js');
{
  const gh = new MockGitHub();
  const page = loadPage({ gh, withConfig: false, token: '' });
  await sleep(150);
  check(page.$('syncArea').style.display === 'none', 'sync UI hidden');
  check(page.$('syncNowBtn').style.display === 'none', 'Sync now hidden');
  check(page.$('resetBtn').style.display !== 'none', 'Reset Example visible');
  check(page.$('json').value.includes('sales report'), 'default example loaded');
  check(gh.requests.length === 0, 'no network calls');
  page.setAndSave({ tasks: [task('x', 'local task')] });
  await sleep(2600);
  check(gh.requests.length === 0 && page.w.localStorage.getItem('gantt_tasks_v1').includes('local task'), 'save goes to localStorage only');
  check(page.errors.length === 0, 'no uncaught errors', page.errors);
  page.w.close();
}

// ================= scenario 4: configured but no token =================
console.log('\n[4] configured, no token yet');
{
  const gh = new MockGitHub();
  const page = loadPage({ gh, token: '' });
  await sleep(150);
  check(page.status().startsWith('Not connected'), 'status Not connected', page.status());
  check(page.visible('settingsModal'), 'settings modal opened automatically');
  check(page.$('stOwner').value === 'jjdevine' && page.$('stRepo').value === 'Gantt-Shared', 'settings prefilled from config.js');
  page.$('stToken').value = 'tok';
  page.$('settingsTestBtn').click(); await sleep(150);
  check(page.$('settingsInfo').textContent.includes('Connected as tester') && page.$('settingsInfo').textContent.includes('write access'), 'Test connection reports user and access', page.$('settingsInfo').textContent);
  gh.readOnly = true;
  page.$('settingsTestBtn').click(); await sleep(150);
  check(page.$('settingsInfo').textContent.includes('READ-ONLY'), 'Test connection reports read-only', page.$('settingsInfo').textContent);
  page.$('stToken').value = 'wrong'; gh.badToken = true;
  page.$('settingsTestBtn').click(); await sleep(150);
  check(page.$('settingsError').textContent.includes('rejected'), 'Test connection reports bad token', page.$('settingsError').textContent);
  check(page.errors.length === 0, 'no uncaught errors', page.errors);
  page.w.close();
}

// ================= scenario 5: migration of legacy local data =================
console.log('\n[5] migration offer for tasks that exist only in this browser');
{
  const gh = new MockGitHub();
  gh.set('data/people/alice.json', body([task('alice', 'alice task')]));
  const legacy = JSON.stringify({ tasks: [task('alice', 'stale alice'), task('erin', 'erin local only')] }, null, 2);
  const page = loadPage({ gh, preStorage: { gantt_tasks_v1: legacy } });
  await sleep(2800);
  check(gh.files.has('data/people/erin.json'), 'erin uploaded after confirm', [...gh.files.keys()]);
  check(JSON.parse(gh.files.get('data/people/alice.json').content).tasks[0].task === 'alice task', 'existing alice in repo not overwritten by stale local copy');
  check(page.tasks().length === 2, 'local view shows repo alice + uploaded erin', page.tasks().map(t => t.task));
  check(page.errors.length === 0, 'no uncaught errors', page.errors);
  page.w.close();
}

// ================= scenario 6: outbox survives a reload =================
console.log('\n[6] dirty outbox flushed on next start-up');
{
  const gh = new MockGitHub();
  gh.set('data/people/alice.json', body([task('alice', 'alice task')]));
  const p1 = loadPage({ gh });
  await sleep(150);
  gh.offline = true;
  const t = p1.tasks(); t[0].task = 'edited while offline';
  p1.setAndSave({ tasks: t });
  await sleep(2600);
  check(p1.status().startsWith('Offline'), 'edit queued while offline', p1.status());
  const carried = {};
  for(let i = 0; i < p1.w.localStorage.length; i++){ const k = p1.w.localStorage.key(i); carried[k] = p1.w.localStorage.getItem(k); }
  p1.w.close();
  gh.offline = false;
  const p2 = loadPage({ gh, token: '', preStorage: carried });
  await sleep(300);
  check(JSON.parse(gh.files.get('data/people/alice.json').content).tasks[0].task === 'edited while offline', 'queued edit written on next start-up');
  check(p2.status().startsWith('Synced'), 'status Synced after start-up flush', p2.status());
  check(p2.errors.length === 0, 'no uncaught errors', p2.errors);
  p2.w.close();
}

console.log('\n' + passes + ' passed, ' + failures + ' failed');
process.exit(failures ? 1 : 0);
