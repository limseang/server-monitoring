import { parseDocument, Document, isMap, isSeq, Scalar } from 'yaml';

/*
 * A GitHub workflow file as a "flow" the visual editor understands, and back.
 *
 *   flow = {
 *     name,
 *     triggers: { push: { on, branches[] }, pull_request: { on, branches[] }, manual, schedule: [cron], other: [event names] },
 *     jobs: [{ id, name, runs_on: { kind: 'github'|'server'|'custom', image, label, raw }, needs: [id], if, steps: [step],
 *              extra: [keys the editor does not change, e.g. strategy, outputs], approval }]
 *   }
 *   step = { name, uses, run, with: {}, if }
 *
 * applyFlow() writes the edited flow into the ORIGINAL text with the yaml Document API: only what changed is
 * rewritten, so comments, untouched jobs and untouched steps stay exactly as they were.
 */

const JOB_ID_RE = /^[A-Za-z_][A-Za-z0-9_-]{0,99}$/;
const EDITED_JOB_KEYS = new Set(['name', 'runs-on', 'needs', 'if', 'steps']);
const STEP_KEYS = ['name', 'uses', 'run', 'with', 'if'];

const arr = (x) => (x == null ? [] : Array.isArray(x) ? x : [x]);
const str = (x) => (x == null ? '' : String(x));
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** runs-on → where the job runs: GitHub's machine, a self-hosted server (by label), or something else. */
export function runsOnOf(v) {
  if (typeof v === 'string' && !v.includes('${{')) return /^(ubuntu|windows|macos)-/i.test(v) ? { kind: 'github', image: v } : { kind: 'server', label: v };
  if (Array.isArray(v) && v.every((x) => typeof x === 'string')) {
    const rest = v.filter((x) => x !== 'self-hosted');
    if (v.includes('self-hosted') && rest.length >= 1 && !rest.some((x) => x.includes('${{'))) return { kind: 'server', label: rest[rest.length - 1], extra: rest.slice(0, -1) };
  }
  return { kind: 'custom', raw: typeof v === 'string' ? v : JSON.stringify(v ?? '') };
}
export function runsOnValue(r) {
  if (!r || r.kind === 'github') return r?.image || 'ubuntu-latest';
  if (r.kind === 'server') return ['self-hosted', ...arr(r.extra), r.label];
  const raw = str(r.raw).trim();
  if (raw.startsWith('[')) {
    try {
      return JSON.parse(raw);
    } catch {}
  }
  return raw || 'ubuntu-latest';
}

function stepOf(s) {
  const o = s && typeof s === 'object' ? s : {};
  const step = { name: str(o.name), uses: str(o.uses), run: str(o.run), with: o.with && typeof o.with === 'object' ? o.with : {}, if: str(o.if) };
  const other = Object.keys(o).filter((k) => !STEP_KEYS.includes(k));
  if (other.length) step.extra = other;
  return step;
}

function triggersOf(on) {
  const t = { push: { on: false, branches: [] }, pull_request: { on: false, branches: [] }, manual: false, schedule: [], other: [] };
  const names = typeof on === 'string' ? [on] : Array.isArray(on) ? on : on && typeof on === 'object' ? Object.keys(on) : [];
  for (const n of names) {
    const v = on && typeof on === 'object' && !Array.isArray(on) ? on[n] : null;
    if (n === 'push' || n === 'pull_request') t[n] = { on: true, branches: arr(v?.branches).map(String) };
    else if (n === 'workflow_dispatch') t.manual = true;
    else if (n === 'schedule') t.schedule = arr(v).map((x) => str(x?.cron)).filter(Boolean);
    else t.other.push(n);
  }
  return t;
}

/** Workflow text → flow (+ errors). Never throws. */
export function parseFlow(content) {
  const doc = parseDocument(String(content || ''), { prettyErrors: true });
  const errors = doc.errors.map((e) => e.message);
  const js = errors.length ? null : doc.toJS({ maxAliasCount: 100 });
  if (!js || typeof js !== 'object') return { flow: null, errors: errors.length ? errors : ['The file is empty or is not a workflow'] };
  const jobs = js.jobs && typeof js.jobs === 'object' ? js.jobs : {};
  const flow = {
    name: str(js.name),
    triggers: triggersOf(js.on ?? js.true),
    jobs: Object.entries(jobs).map(([id, j]) => {
      const job = j && typeof j === 'object' ? j : {};
      return {
        id,
        name: str(job.name),
        runs_on: job.uses ? { kind: 'custom', raw: '' } : runsOnOf(job['runs-on']),
        needs: arr(job.needs).map(String),
        if: str(job.if),
        steps: arr(job.steps).map(stepOf),
        uses: str(job.uses), // a reusable workflow: shown, not edited
        environment: job.environment ? str(job.environment.name ?? job.environment) : '',
        extra: Object.keys(job).filter((k) => !EDITED_JOB_KEYS.has(k)),
      };
    }),
  };
  if (!Object.keys(jobs).length) errors.push('No jobs: — a workflow needs at least one job');
  return { flow, errors };
}

/* ------------------------------------------------------------------ flow → text */
function node(doc, v) {
  if (typeof v === 'string' && v.includes('\n')) {
    const s = new Scalar(v.endsWith('\n') ? v : `${v}\n`);
    s.type = Scalar.BLOCK_LITERAL;
    return s;
  }
  return doc.createNode(v, { flow: false });
}
function stepValue(s) {
  const o = {};
  if (s.name) o.name = s.name;
  if (s.if) o.if = s.if;
  if (s.uses) o.uses = s.uses;
  if (s.with && Object.keys(s.with).length) o.with = s.with;
  if (s.run) o.run = s.run;
  return o;
}
function stepNode(doc, s) {
  const m = doc.createNode({});
  for (const [k, v] of Object.entries(stepValue(s))) m.set(k, node(doc, v));
  return m;
}
const needsValue = (n) => (n.length === 1 ? n[0] : n);
const runsOnNode = (doc, r) => {
  const n = doc.createNode(runsOnValue(r));
  if (isSeq(n)) n.flow = true;
  return n;
};

/** Set or delete one key of a map node. */
const setKey = (doc, map, key, value, empty) => (empty ? map.delete(key) : map.set(key, value));

/* Text splicing: only the parts that changed are re-rendered; every other byte of the file stays as it was. */
const lineStart = (text, pos) => text.lastIndexOf('\n', pos - 1) + 1;
const colOf = (text, pos) => pos - lineStart(text, pos);
const indent = (t, n) => t.split('\n').map((l) => (l ? ' '.repeat(n) + l : l)).join('\n');
const RENDER = { lineWidth: 0, flowCollectionPadding: false, nullStr: '' };
function renderPair(key, value, ind) {
  const head = `${' '.repeat(ind)}${key}:`;
  if (value == null || (value instanceof Scalar && value.value == null)) return head;
  const s = renderNode(value);
  if ((isMap(value) || isSeq(value)) && !value.flow && value.items.length) return `${head}\n${indent(s, ind + 2)}`;
  return `${head} ${s}`;
}
const renderNode = (value) => String(new Document(value).toString(RENDER)).replace(/\n+$/, '');
/** One "- step" of a block sequence at column `ind`. */
const renderItem = (value, ind) => renderNode(value).split('\n').map((l, i) => (i ? (l ? ' '.repeat(ind + 2) + l : l) : `${' '.repeat(ind)}- ${l}`)).join('\n');
function findPair(map, key) {
  return isMap(map) ? map.items.find((p) => (p.key?.value ?? p.key) === key) : null;
}

/** Write `flow` into `content` (the text it was read from), changing only what differs. */
export function applyFlow(content, flow) {
  const text = String(content || '');
  const doc = parseDocument(text);
  if (doc.errors.length) throw new Error(`The YAML has errors — fix them in the text first: ${doc.errors[0].message}`);
  const before = parseFlow(text).flow || { name: '', triggers: triggersOf({}), jobs: [] };
  if (!isMap(doc.contents)) doc.contents = doc.createNode({});
  const root = doc.contents;
  const changedTop = new Set();

  if (str(flow.name) !== before.name) {
    setKey(doc, root, 'name', flow.name, !flow.name);
    changedTop.add('name');
  }

  // Triggers
  const t = flow.triggers || before.triggers;
  if (!same(t, before.triggers)) {
    changedTop.add('on');
    let on = root.get('on', true);
    if (!isMap(on)) {
      const names = triggersOf(on?.toJSON?.() ?? on).other;
      on = doc.createNode({});
      for (const n of names) on.set(n, null);
      root.set('on', on);
    }
    for (const ev of ['push', 'pull_request']) {
      if (same(t[ev], before.triggers[ev])) continue;
      if (!t[ev].on) on.delete(ev);
      else {
        let ev0 = on.get(ev, true);
        if (!isMap(ev0)) on.set(ev, (ev0 = doc.createNode({})));
        const br = (t[ev].branches || []).map((b) => b.trim()).filter(Boolean);
        if (br.length) {
          const n = doc.createNode(br);
          n.flow = true;
          ev0.set('branches', n);
        } else ev0.delete('branches');
        if (!ev0.items.length) on.set(ev, null);
      }
    }
    if (t.manual !== before.triggers.manual) {
      if (t.manual) on.set('workflow_dispatch', null);
      else on.delete('workflow_dispatch');
    }
    if (!same(t.schedule, before.triggers.schedule)) {
      const cr = (t.schedule || []).map((c) => c.trim()).filter(Boolean);
      if (cr.length) on.set('schedule', doc.createNode(cr.map((cron) => ({ cron }))));
      else on.delete('schedule');
    }
  }

  // Jobs
  let jobsNode = root.get('jobs', true);
  if (!isMap(jobsNode)) {
    root.set('jobs', (jobsNode = doc.createNode({})));
    changedTop.add('jobs');
  }
  const ids = new Set();
  for (const j of flow.jobs || []) {
    if (!JOB_ID_RE.test(j.id || '')) throw new Error(`Job id "${j.id}" can only have letters, numbers, - and _ (and must start with a letter)`);
    if (ids.has(j.id)) throw new Error(`Two jobs are called "${j.id}"`);
    ids.add(j.id);
  }
  const deleted = before.jobs.filter((b) => !ids.has(b.id)).map((b) => b.id);
  const stepSrc = new Map(); // job id → for each new step, the index of the unchanged old step (or -1)
  const changedJobs = new Set();
  const added = [];
  for (const j of flow.jobs || []) {
    for (const n of j.needs || []) if (!ids.has(n)) throw new Error(`"${j.id}" runs after "${n}", which is not a job any more`);
    const old = before.jobs.find((b) => b.id === j.id);
    let m = jobsNode.get(j.id, true);
    if (!old || !isMap(m)) {
      m = doc.createNode({});
      jobsNode.set(j.id, m);
      added.push(j.id);
    }
    const mark = () => old && changedJobs.add(j.id);
    if (!old || j.name !== old.name) (setKey(doc, m, 'name', j.name, !j.name), mark());
    if (!j.uses && (!old || !same(j.runs_on, old.runs_on))) (m.set('runs-on', runsOnNode(doc, j.runs_on)), mark());
    if (!old || !same(j.needs, old.needs)) {
      const n = doc.createNode(needsValue(j.needs || []));
      if (isSeq(n)) n.flow = true;
      setKey(doc, m, 'needs', n, !(j.needs || []).length);
      mark();
    }
    if (!old || j.if !== old.if) (setKey(doc, m, 'if', j.if, !j.if), mark());
    if (!j.uses && (!old || !same(j.steps, old.steps))) {
      const oldSeq = m.get('steps', true);
      const seq = doc.createNode([]);
      const used = new Set();
      const src = [];
      for (const s of j.steps || []) {
        // An unchanged step keeps its node (and, in the text, its exact lines and comments).
        const i = old ? old.steps.findIndex((o, k) => !used.has(k) && same(o, s)) : -1;
        if (i >= 0) used.add(i);
        src.push(i);
        seq.items.push(i >= 0 && isSeq(oldSeq) && oldSeq.items[i] ? oldSeq.items[i] : stepNode(doc, s));
      }
      stepSrc.set(j.id, src);
      m.set('steps', seq);
      mark();
    }
    if (!old) m.items.sort((a, b) => ['name', 'runs-on', 'needs', 'if', 'steps'].indexOf(a.key.value) - ['name', 'runs-on', 'needs', 'if', 'steps'].indexOf(b.key.value));
  }

  // Nothing changed: the file as it was.
  if (!changedTop.size && !deleted.length && !changedJobs.size && !added.length) return text;
  const origRoot = parseDocument(text).contents;
  const origJobs = findPair(origRoot, 'jobs')?.value;
  // A file without a normal "jobs:" block map: write the whole document.
  if (!text.trim() || !isMap(origRoot) || !isMap(origJobs) || origJobs.flow || changedTop.has('jobs')) return doc.toString(RENDER);

  const edits = []; // [start, end, replacement]
  const lineAfter = (pos) => (text[pos - 1] === '\n' ? pos : (text.indexOf('\n', pos) + 1 || text.length));
  const endOf = (pair) => (pair.value && pair.value.range ? pair.value.range[1] : pair.key.range[1]);
  const replacePair = (origPair, key, value, ind) => {
    const start = lineStart(text, origPair.key.range[0]);
    const end = endOf(origPair);
    const tail = text.slice(start, end).match(/\s*$/)[0]; // keep the blank lines that followed it
    edits.push([start, end, renderPair(key, value, ind) + tail]);
  };
  const removePair = (origPair) => edits.push([lineStart(text, origPair.key.range[0]), lineAfter(endOf(origPair)), '']);
  const sameVal = (o, n) => JSON.stringify(o?.toJSON?.() ?? o ?? null) === JSON.stringify(n?.toJSON?.() ?? n ?? null);
  /** Key by key: unchanged keys keep their exact text; a new key goes after the one before it in `order`. */
  function patchMap(om, nm, keys, order, special) {
    const ind = colOf(text, om.items[0].key.range[0]);
    for (const key of keys) {
      const o = findPair(om, key);
      const has = nm.has(key);
      const nv = nm.get(key, true);
      if (o && has && sameVal(o.value, nv)) continue;
      if (special && o && has && special(key, o, nv)) continue;
      if (o && has) replacePair(o, key, nv, ind);
      else if (o) removePair(o);
      else if (has) {
        const k = order.indexOf(key);
        const prev = order.slice(0, Math.max(0, k)).reverse().map((x) => findPair(om, x)).find(Boolean);
        const at = prev ? lineAfter(endOf(prev)) : k === 0 ? lineStart(text, om.items[0].key.range[0]) : lineAfter(endOf(om.items[om.items.length - 1]));
        edits.push([at, at, `${renderPair(key, nv, ind)}\n`]);
      }
    }
  }
  if (changedTop.has('name')) {
    const op = findPair(origRoot, 'name');
    if (op && root.has('name')) replacePair(op, 'name', root.get('name', true), colOf(text, op.key.range[0]));
    else if (op) removePair(op);
    else edits.push([0, 0, `${renderPair('name', root.get('name', true), 0)}\n`]);
  }
  if (changedTop.has('on')) {
    const op = findPair(origRoot, 'on') || findPair(origRoot, true);
    const nv = root.get('on', true);
    if (op && isMap(op.value) && !op.value.flow && op.value.items.length && isMap(nv)) {
      const keys = [...new Set([...op.value.items.map((p) => p.key?.value ?? p.key), ...nv.items.map((p) => p.key?.value ?? p.key)])];
      patchMap(op.value, nv, keys, ['push', 'pull_request', 'workflow_dispatch', 'schedule']);
    } else if (op) replacePair(op, 'on', nv, colOf(text, op.key.range[0]));
    else edits.push([0, 0, `${renderPair('on', nv, 0)}\n`]);
  }
  const jobInd = origJobs.items.length ? colOf(text, origJobs.items[0].key.range[0]) : 2;
  for (const id of deleted) removePair(findPair(origJobs, id));
  for (const id of changedJobs) {
    const op = findPair(origJobs, id);
    const om = op?.value;
    const nm = jobsNode.get(id, true);
    if (!isMap(om) || om.flow || !om.items.length) {
      replacePair(op, id, nm, jobInd);
      continue;
    }
    // Key by key inside the job — its other keys (env, strategy, …) are not touched.
    patchMap(om, nm, ['name', 'runs-on', 'needs', 'if', 'steps'], ['name', 'runs-on', 'needs', 'if', 'steps'], (key, o, nv) => {
      if (key !== 'steps' || !isSeq(o.value) || o.value.flow || !o.value.items.length || !isSeq(nv)) return false;
      // Step by step: unchanged steps keep their exact lines (with the comments above them).
      const items = o.value.items;
      const src = stepSrc.get(id) || [];
      const first = lineStart(text, items[0].range[0]);
      const seqInd = (text.slice(first).match(/^( *)- /m) || [, '      '])[1].length;
      const slice = (i) => text.slice(lineStart(text, items[i].range[0]), i + 1 < items.length ? lineStart(text, items[i + 1].range[0]) : items[i].range[1]).replace(/\n+$/, '');
      const out = nv.items.map((it, k) => (src[k] >= 0 && items[src[k]] ? slice(src[k]) : renderItem(it, seqInd)));
      const end = items[items.length - 1].range[1];
      const tail = text.slice(first, end).match(/\s*$/)[0];
      edits.push([first, end, out.join('\n') + tail]);
      return true;
    });
  }
  if (added.length) {
    const end = origJobs.range[1];
    const nl = text.indexOf('\n', end);
    const at = nl < 0 ? text.length : nl + 1;
    const block = added.map((id) => renderPair(id, jobsNode.get(id, true), jobInd)).join('\n\n');
    edits.push([at, at, `${nl < 0 ? '\n' : ''}\n${block}\n`]);
  }
  edits.sort((a, b) => b[0] - a[0]);
  let out = text;
  for (const [a, b, r] of edits) out = out.slice(0, a) + r + out.slice(b);
  return out;
}

/** A new workflow file from a flow (no original text). */
export const flowToYaml = (flow) => applyFlow('', flow);

/** Change which servers the jobs run on: { oldLabel: newLabel | 'github' }. For copying a flow to another project/server. */
export function remapServers(content, map) {
  const { flow, errors } = parseFlow(content);
  if (!flow) throw new Error(errors[0] || 'Not a workflow');
  for (const j of flow.jobs) {
    if (j.runs_on.kind !== 'server' || !(j.runs_on.label in map)) continue;
    const to = map[j.runs_on.label];
    const from = j.runs_on.label;
    if (!to || to === from) continue;
    j.runs_on = to === 'github' ? { kind: 'github', image: 'ubuntu-latest' } : { ...j.runs_on, label: to };
    if (j.name.includes(from)) j.name = j.name.split(from).join(to === 'github' ? 'GitHub' : to);
  }
  return applyFlow(content, flow);
}
