'use strict';

// The work of a run: summaries for the documentation, and comments for new, changed, and
// backlog files, each checked for accuracy. It reads files but never writes them: it returns
// a result per file, which apply.js applies.

const fs = require('fs');
const path = require('path');

const { PER_RUN, checkComments, finishComments, needsCheck, planTargets, proposeNext, replaceInaccurate, replySummary, settleProposals } = require('./comments');
const { createCaller } = require('./docs');
const ollama = require('./ollama');
const { importersOf, nameUsage } = require('./importance');
const { knownUrls } = require('./links');
const { proposalSummary } = require('./report');
const { hashContent } = require('./state');
const { callLabel, fallbackPurpose, planFolderCalls, splitCall, summarizeFolder } = require('./folders');
const { fileStructure, symbolsOf } = require('./structure');
const { languageForPath } = require('./languages');

// The time the README keeps for itself at the end of the budget.
const README_RESERVE_MINUTES = 8;
// After the comments, the layer docs that the run's changes touch are rewritten: about
// DOC_MINUTES each with the docs model, and at most DOCS_RESERVE_MINUTES with the README's
// time. Docs that do not fit are written on the next run, so comments come first.
const DOC_MINUTES = 2.5;
const DOCS_RESERVE_MINUTES = 15;
// In the documentation pass, the time kept free after the last folder summary for planning the
// layers and writing every layer doc and the README with the docs model.
const DOCS_PASS_RESERVE_MINUTES = 40;
// Proposals stop at least this long before the checks must end.
const CHECK_MINUTES = 2;
// The accuracy check's time, estimated before it runs, since every request is made first:
// a request, and each comment in it, with the docs model on a hosted runner (about 15 s and
// 6.5 s), a quarter more for safety; and loading the docs model ahead of the checks.
const CHECK_REQUEST_MS = 20000;
const CHECK_COMMENT_MS = 8000;
const LOAD_MS = 60000;
// The accuracy check sends this many comments per request (see comments.js).
const CHECK_BATCH = 8;
// How long Ollama keeps the docs model loaded after it is loaded ahead of the accuracy check.
const DOCS_MODEL_KEEP_ALIVE = '30m';

// The minutes kept for the docs after the checks, for a run that rewrites `docs` layer docs.
function docsReserveMinutes(docs) {
  return Math.min(DOCS_RESERVE_MINUTES, README_RESERVE_MINUTES + DOC_MINUTES * docs);
}

// When proposals stop starting (commentDeadline), when checks stop starting (checkDeadline),
// and the end of the budget. A short budget keeps at least half of itself for comments.
function deadlines(started, budgetMinutes, reserveMinutes = DOCS_RESERVE_MINUTES) {
  const end = started + budgetMinutes * 60000;
  const checkDeadline = end - Math.min(reserveMinutes, budgetMinutes / 2) * 60000;
  const commentDeadline = checkDeadline - Math.min(CHECK_MINUTES, budgetMinutes / 10) * 60000;
  return { commentDeadline, checkDeadline, end };
}

// How many layer docs the comment items will make the docs rewrite: the ones holding a new
// or changed file, and the ones an earlier run left. A batch of existing code changes no
// doc: its files change only by their comments. With no layers yet, every doc is new.
function docsToRewrite(previous, items) {
  if (!previous.layers.length) return Infinity;
  const changed = new Set(items.filter((i) => i.kind === 'comment' && i.reason !== 'backlog').map((i) => i.path));
  const touched = previous.layers.filter((l) => l.files.some((f) => changed.has(f))).length;
  return touched + (previous.staleDocs || []).filter((s) => s !== 'README').length;
}

// items: [{ path, kind: 'summary' | 'comment', reason }], in the order to work on them.
// Returns { results, docsCaller }, where each result is
//   { path, kind, reason, outcome: 'commented' | 'summarized' | 'skipped' | 'left',
//     originalHash, text (only when the file changes), entry (its new state), report, why }.
async function processItems({ cwd, items, previous, config, models, chat, now = Date.now, started = now(), log = console.log, docsCaller }) {
  const docsAfter = docsToRewrite(previous, items);
  const { commentDeadline, checkDeadline } = deadlines(started, config.timeBudgetMinutes, docsReserveMinutes(docsAfter));
  const results = [];
  // A file left for the next run keeps its old state, so the next run processes it again.
  const leave = (item, originalHash, why, detail = why) => {
    results.push({ path: item.path, kind: item.kind, reason: item.reason, outcome: 'left', originalHash, why });
    log(`${item.path}: deferred to the next run, ${detail}`);
  };
  const read = (file) => fs.readFileSync(path.join(cwd, file));
  // A file the run can read: UTF-8, in a known language. Anything else is skipped.
  const readable = (item) => {
    const buffer = read(item.path);
    const originalHash = hashContent(buffer);
    const text = buffer.toString('utf8');
    const why = !Buffer.from(text, 'utf8').equals(buffer) ? 'not UTF-8' : !languageForPath(item.path) ? 'unsupported language' : null;
    return { item, originalHash, path: item.path, text, language: languageForPath(item.path), why };
  };
  const skip = (r) => results.push({ path: r.path, kind: r.item.kind, reason: r.item.reason, outcome: 'skipped', originalHash: r.originalHash, entry: { hash: r.originalHash, skipped: r.why }, why: r.why });

  // One call per folder gives each file's purpose and the folder's summary. Each call's answer
  // is checked. One that cannot be used is split in half and tried again, down to single
  // files, and the files a usable answer leaves out are tried again on their own. Every retry
  // is smaller than the call before it, so this ends. A file that a call of its own cannot
  // describe gets a purpose built from its structure: no file is left out.
  // record(path, summary, symbols) takes each file's description; left(r, why, detail) a file
  // the deadline or a model that did not answer left out.
  const folders = [];
  const summarizedDirs = new Set();
  let summaryCalls = 0;
  let fromStructure = 0;
  const describe = async (files, deadline, record, left, { newFoldersOnly = false } = {}) => {
    const byPath = new Map(files.map((r) => [r.path, r]));
    const calls = planFolderCalls(files, config.contextTokens);
    const queue = [...calls];
    while (queue.length) {
      const call = queue.shift();
      if (now() > deadline) {
        for (const f of call.files) left(byPath.get(f.path), 'time budget');
        continue;
      }
      let answer;
      try {
        summaryCalls++;
        answer = await summarizeFolder({ call, model: models.comment, contextTokens: config.contextTokens, chat });
      } catch (err) {
        for (const f of call.files) left(byPath.get(f.path), 'the model did not respond', `the model did not respond (${ollama.describeError(err)})`);
        continue;
      }
      if (!answer.failed) {
        // A call with only a folder's changed files sees part of it: it describes only a folder
        // that has no summary yet.
        if (!summarizedDirs.has(call.dir) && !(newFoldersOnly && typeof (previous.folders || {})[call.dir] === 'string')) {
          summarizedDirs.add(call.dir);
          folders.push({ dir: call.dir, summary: answer.summary });
        }
        for (const described of answer.files) record(described.path, described.summary, described.symbols);
      }
      // Files whose leading comment gives their purpose need nothing from a failed answer.
      if (answer.failed) for (const f of call.files.filter((x) => x.purpose)) record(f.path, f.purpose, symbolsOf(f.structure));
      const rest = answer.failed ? call.files.filter((f) => !f.purpose) : call.files.filter((f) => answer.missing.includes(f.path));
      if (!rest.length) {
        if (answer.failed) log(`${callLabel(call)}: no folder summary, the answer could not be used (${answer.failed})`);
        continue;
      }
      const why = answer.failed || `${rest.length} of ${call.files.length} files missing from the answer`;
      if (rest.length === 1 && call.files.length === 1) {
        const only = rest[0];
        record(only.path, fallbackPurpose(only.path, only.structure), symbolsOf(only.structure));
        fromStructure++;
        log(`${only.path}: described from its structure, the answer could not be used (${why})`);
      } else if (rest.length === 1) {
        log(`${callLabel(call)}: ${why}, trying again with 1 file`);
        queue.unshift({ ...call, files: rest, retry: true });
      } else if (answer.failed) {
        const halves = splitCall({ ...call, files: rest });
        log(`${callLabel(call)}: the answer could not be used (${why}), trying again with ${halves[0].files.length} and ${halves[1].files.length} files`);
        queue.unshift(...halves);
      } else {
        const again = rest.length === 1 ? [{ ...call, files: rest, retry: true }] : splitCall({ ...call, files: rest });
        log(`${callLabel(call)}: ${why}, trying them again`);
        queue.unshift(...again);
      }
    }
    return calls;
  };

  // Summaries first, one call per folder: the documentation needs every one. In the
  // documentation pass they stop early enough that the layer docs and the README are always
  // written; folders not reached are described on the next run.
  const summaryItems = items.filter((i) => i.kind === 'summary');
  const summaryStarted = now();
  const summaryDeadline = summaryItems.length && !items.some((i) => i.kind === 'comment')
    ? started + Math.max(config.timeBudgetMinutes - DOCS_PASS_RESERVE_MINUTES, config.timeBudgetMinutes / 3) * 60000
    : commentDeadline;
  const toSummarize = [];
  for (const r of summaryItems.map(readable)) {
    if (r.why) skip(r);
    else toSummarize.push(r);
  }
  const summaryByPath = new Map(toSummarize.map((r) => [r.path, r]));
  const summaryCallsPlanned = await describe(toSummarize, summaryDeadline, (file, summary, symbols) => {
    const r = summaryByPath.get(file);
    const before = previous.files[r.path] || {};
    // A file whose content is unchanged keeps its comment level and Docturnal's records.
    const same = before.hash === r.originalHash;
    const entry = { hash: r.originalHash, summary, symbols, level: same ? before.level ?? null : null };
    if (same && before.comments) entry.comments = before.comments;
    results.push({ path: r.path, kind: r.item.kind, reason: r.item.reason, outcome: 'summarized', originalHash: r.originalHash, entry });
  }, (r, why, detail) => leave(r.item, r.originalHash, why, detail));
  const summaryStats = {
    files: summaryItems.length,
    folders: new Set(summaryCallsPlanned.map((c) => c.dir)).size,
    calls: summaryCalls,
    fromStructure,
    ms: now() - summaryStarted,
  };

  const commentItems = items.filter((i) => i.kind === 'comment');
  const toComment = [...commentItems.filter((i) => i.reason !== 'backlog'), ...commentItems.filter((i) => i.reason === 'backlog')];
  // New and changed files get a new purpose for the docs, from the same folder calls; a file
  // in a batch keeps the one its docs were written from. A file the calls do not reach gets
  // one from its structure.
  const described = new Map();
  const changed = toComment.filter((i) => i.reason !== 'backlog').map(readable).filter((r) => !r.why);
  if (changed.length) {
    await describe(changed, commentDeadline, (file, summary, symbols) => described.set(file, { summary, symbols }), () => {}, { newFoldersOnly: true });
  }

  // Which other files use each file's exports, to rank its targets.
  let importers = null;
  const texts = new Map();
  const textOf = (file) => {
    if (!texts.has(file)) {
      try {
        texts.set(file, read(file).toString('utf8'));
      } catch {
        texts.set(file, '');
      }
    }
    return texts.get(file);
  };
  const usageOf = (file, names) => {
    if (!importers) {
      const codeFiles = [...new Set([...Object.keys(previous.files), ...items.map((i) => i.path)])].filter((f) => languageForPath(f));
      importers = importersOf(codeFiles, textOf);
    }
    return nameUsage(file, names, importers, textOf);
  };

  // Comments: 1a chooses every file's targets in code, then asks the comment model to write
  // them in turns, one request per file at a time, each file's highest-ranked targets first,
  // new and changed files before the backlog, while the requests and their checks fit before
  // the checks must end. So the time spreads over the files instead of going to the first big
  // one. 1b checks every selected comment for accuracy with the docs model (it is loaded next
  // for the docs anyway). 1c inserts and verifies, without a model.
  const caller = docsCaller || createCaller({ chat, model: models.docs, fallbackModel: models.comment !== models.docs ? models.comment : null });
  const pace = { proposeMs: 0, proposeRequests: 0, checkMs: 0, checkRequests: 0 };
  const perRequestMs = () => (pace.proposeRequests ? pace.proposeMs / pace.proposeRequests : 0);
  let docsLoaded = false;

  // Every file's plan, without a model.
  const planAll = () => {
    const planned = [];
    for (const item of toComment.splice(0)) {
      const r = readable(item);
      if (r.why) {
        skip(r);
        log(`${item.path}: skipped, ${r.why}`);
        continue;
      }
      const before = previous.files[item.path] || {};
      const structure = fileStructure(item.path, r.text, r.language);
      const plan = planTargets({
        path: item.path,
        text: r.text,
        level: config.commentLevel,
        contextTokens: config.contextTokens,
        records: before.comments || [],
        knownUrls: knownUrls(cwd),
        exportNames: structure.exports,
        usage: usageOf(item.path, symbolsOf(structure)),
      });
      planned.push({ item, originalHash: r.originalHash, plan, structure });
    }
    return planned;
  };

  // The requests, in turns. A file counts toward the checks once it is started, or from the
  // start when it needs no request (its earlier comments are checked). A request is made only
  // while it, at the pace of the ones before, and the checks of everything written so far,
  // its own included, still fit before the checks must end.
  const proposeAll = async (all) => {
    const counted = (p) => p.plan.ctx && (p.plan.next > 0 || !p.plan.planned.length);
    // The checks' time for every file counted, with `next` more comments for file `extra`.
    const checksMs = (extra, next) => {
      let requests = 0;
      let comments = 0;
      for (const p of all) {
        if (!counted(p) && p !== extra) continue;
        const n = p.plan.groups.flat().length + p.plan.ctx.owned.length + (p === extra ? next : 0);
        requests += Math.ceil(n / CHECK_BATCH);
        comments += n;
      }
      return requests ? (docsLoaded ? 0 : LOAD_MS) + requests * CHECK_REQUEST_MS + comments * CHECK_COMMENT_MS : 0;
    };
    const fits = (p, next) => now() <= commentDeadline && now() + perRequestMs() + checksMs(p, next) <= checkDeadline;
    let outOfTime = false;
    for (const group of [all.filter((p) => p.item.reason !== 'backlog'), all.filter((p) => p.item.reason === 'backlog')]) {
      let made = true;
      while (made && !outOfTime) {
        made = false;
        for (const p of group) {
          const request = p.plan.planned[p.plan.next];
          if (!request) continue;
          if (!fits(p, request.targets.length)) {
            outOfTime = true;
            break;
          }
          const before = p.plan.proposeMs;
          await proposeNext(p.plan, { model: models.comment, contextTokens: config.contextTokens, chat, now });
          pace.proposeMs += p.plan.proposeMs - before;
          pace.proposeRequests++;
          made = true;
        }
      }
    }
    const plans = [];
    for (const p of all) {
      const { item, originalHash, plan } = p;
      settleProposals(plan);
      // A file the time gave no request waits for the next run as it is.
      if (plan.planned.length && !plan.requests) {
        leave(item, originalHash, 'time budget');
        continue;
      }
      const replies = replySummary(plan);
      if (replies) log(`${item.path}: ${replies}`);
      if (plan.requests && plan.failedRequests === plan.requests && !(plan.built && plan.built.candidates.length)) {
        leave(item, originalHash, 'the model did not respond', `the model did not respond (${plan.errors.join('; ')})`);
        continue;
      }
      plans.push(p);
    }
    return { plans };
  };

  const finish = ({ item, originalHash, plan, structure }) => {
    const result = finishComments(plan);
    const changedText = result.text !== plan.text;
    const finalHash = changedText ? hashContent(Buffer.from(result.text, 'utf8')) : originalHash;
    const base = { path: item.path, kind: item.kind, reason: item.reason, originalHash, ...(changedText ? { text: result.text } : {}) };
    if (result.skipped) {
      results.push({ ...base, outcome: 'skipped', entry: { hash: finalHash, skipped: result.skipped }, why: result.skipped });
      log(`${item.path}: skipped, ${result.skipped}`);
      return;
    }
    // A file in a batch keeps the summary its docs were written from: only its comments changed.
    const before = previous.files[item.path] || {};
    const kept = item.reason === 'backlog' && typeof before.summary === 'string';
    const fresh = described.get(item.path) || { summary: fallbackPurpose(item.path, structure), symbols: symbolsOf(structure) };
    // A file the time left before all its targets were asked for, or with more targets than
    // one run takes, keeps what it got, and is not yet commented at the level: a later batch
    // asks for the rest.
    const entry = { hash: finalHash, summary: kept ? before.summary : fresh.summary, symbols: kept ? before.symbols || [] : fresh.symbols, level: plan.unfinished || plan.more ? null : config.commentLevel };
    if (result.records.length) entry.comments = result.records;
    results.push({
      ...base,
      outcome: 'commented',
      entry,
      report: { path: item.path, verifier: plan.ctx ? plan.ctx.language.verifier : undefined, added: result.added, rejections: result.rejections, stats: result.stats },
    });
    for (const r of result.rejections) {
      if (r.coverage !== undefined) log(`${item.path}: line ${r.line} dropped as restating the code (${r.narrates ? 'narrates the declaration, ' : ''}coverage ${r.coverage === null ? 'none' : r.coverage.toFixed(2)})`);
    }
    log(`${item.path}: ${plan.targets.length} ${plan.targets.length === 1 ? 'target' : 'targets'}, ${proposalSummary(result.stats, { reasons: true })}`);
    log(`${item.path}: ${timing(plan)}`);
    if (plan.unfinished) log(`${item.path}: ${plan.requests} of ${plan.planned.length} requests made before the time budget, the other targets wait for a later batch`);
    if (plan.more) log(`${item.path}: ${plan.more} more ${plan.more === 1 ? 'target waits' : 'targets wait'} for a later batch, at most ${PER_RUN[config.commentLevel]} new comments a file each run at the ${config.commentLevel} level`);
  };

  // The docs model checks every round: it answers short requests, and is loaded next for the
  // docs anyway, and the rounds keep time for it. It is loaded first, with the same context
  // size as every later call, so the check does not start against a cold model and the docs
  // do not reload it. If it cannot load, the caller switches to the comment model for the
  // rest of the run.
  const checkRound = async ({ plans }) => {
    const toCheck = plans.filter(({ plan }) => needsCheck(plan));
    let checkWithDocs = toCheck.length > 0 && models.docs !== models.comment;
    if (checkWithDocs && !docsLoaded) {
      try {
        await caller.call(`loading ${models.docs}`, { messages: [], options: { num_ctx: config.contextTokens }, keepAlive: DOCS_MODEL_KEEP_ALIVE });
        docsLoaded = true;
      } catch {
        checkWithDocs = false;
      }
    }
    const checkWith = (model) => (model === models.comment
      ? { chat, model: models.comment, contextTokens: config.contextTokens, now }
      : { chat: (request) => caller.call('accuracy check', request), contextTokens: config.contextTokens, now });
    if (toCheck.length) log(`Docturnal: checking comments in ${toCheck.length} ${toCheck.length === 1 ? 'file' : 'files'} with ${checkWithDocs ? caller.activeModel : models.comment}`);
    for (const planned of plans) {
      const { item, originalHash, plan } = planned;
      if (needsCheck(plan)) {
        if (now() > checkDeadline) {
          leave(item, originalHash, 'time budget');
          continue;
        }
        // A check that fails with the docs model is tried once more with the comment model.
        const checkers = checkWithDocs && caller.activeModel !== models.comment ? [models.docs, models.comment] : [models.comment];
        let passed = null;
        for (const model of checkers) {
          try {
            await checkComments(plan, checkWith(model));
            passed = model;
            break;
          } catch (err) {
            log(`${item.path}: the accuracy check with ${model} failed (${ollama.describeError(err)})`);
          }
        }
        pace.checkMs += plan.checkMs;
        pace.checkRequests += plan.checkRequests;
        if (!passed) {
          leave(item, originalHash, 'the accuracy check failed', 'accuracy check failed');
          continue;
        }
        // An earlier Docturnal comment found inaccurate gets a new one in its place, checked by
        // the same model.
        if (now() < checkDeadline) await replaceInaccurate(plan, { write: { chat, model: models.comment }, check: checkWith(passed), now });
      }
      finish(planned);
    }
  };

  if (toComment.length) await checkRound(await proposeAll(planAll()));

  return { results, docsCaller: caller, folders, summaryStats };
}

// How long a file's comments took, for the log: the requests and the accuracy check.
function timing(plan) {
  const seconds = (ms) => `${(ms / 1000).toFixed(1)} s`;
  const requests = (n) => `${n} ${n === 1 ? 'request' : 'requests'}`;
  const check = plan.checkRequests ? `accuracy check in ${seconds(plan.checkMs)} (${requests(plan.checkRequests)})` : 'no accuracy check needed';
  return `proposals in ${seconds(plan.proposeMs)} (${requests(plan.requests)}), ${check}`;
}

module.exports = { DOCS_PASS_RESERVE_MINUTES, DOCS_RESERVE_MINUTES, README_RESERVE_MINUTES, deadlines, docsReserveMinutes, docsToRewrite, processItems };
