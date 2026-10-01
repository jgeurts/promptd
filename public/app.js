// What the one-time form sends on save, from the hub's own build of src/jobFormRules.ts.
import { isActiveForSave, scheduledAtForSave } from '/shared/jobFormRules.js';

const view = document.getElementById('view');
const connEl = document.getElementById('conn');
const toastsEl = document.getElementById('toasts');
const updateBadgeEl = document.getElementById('update-badge');
const brandNameEl = document.getElementById('brand-name');

let logStream = null; // EventSource tailing one log file
let modelPollTimer = null; // set while model discovery is still running
let reloadTimer = null; // counting down to a reload after an update was started
let updateWatchTimer = null; // polling while an update waits for runs to finish
// Set by the Settings page so run activity can redraw its queue card without
// rebuilding the whole page under the user's cursor. Cleared on navigation.
let repaintQueue = null;
// The commit the server reported when this page loaded. If it ever differs, the
// server has been updated underneath us and this page is running old code.
let loadedCommit = null;
let staleBuild = false;

// ---- helpers ----------------------------------------------------------

async function api(url, options) {
  const res = await fetch(url, {
    headers: options?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
  });
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const body = isJson ? await res.json() : await res.text();
  if (res.status === 401 && url !== '/api/auth/logout') location.assign('/login');
  if (!res.ok) throw Object.assign(new Error(body?.error || `request failed (${res.status})`), { status: res.status });
  return body;
}

function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (key === 'class') node.className = value;
    else if (key === 'html') node.innerHTML = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (value !== null && value !== undefined && value !== false) node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

function fmtDateTime(iso) {
  if (!iso) return null;
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

/**
 * The same stamp with the weekday in front, for the schedule previews on the
 * two forms. "Sep 29" does not say whether the cron you just typed fires on a
 * working day; "Mon Sep 29" does.
 */
function fmtDateTimeWeekday(iso) {
  if (!iso) return null;
  // Formatted apart from the rest and joined with a space: asking for the
  // weekday inside the stamp gets a comma after it in most locales, and
  // "Tue, Sep 22, 8:00:00 PM" is one comma too many to read at a glance.
  const day = new Date(iso).toLocaleString(undefined, { weekday: 'short' });
  return `${day} ${fmtDateTime(iso)}`;
}

function fmtRelative(iso) {
  if (!iso) return '';
  const deltaMs = new Date(iso).getTime() - Date.now();
  const past = deltaMs < 0;
  let seconds = Math.round(Math.abs(deltaMs) / 1000);
  const units = [
    ['d', 86400],
    ['h', 3600],
    ['m', 60],
    ['s', 1],
  ];
  const parts = [];
  for (const [label, size] of units) {
    if (seconds >= size && parts.length < 2) {
      parts.push(`${Math.floor(seconds / size)}${label}`);
      seconds %= size;
    }
  }
  const text = parts.join(' ') || '0s';
  return past ? `${text} ago` : `in ${text}`;
}

/**
 * A time meant to be ahead of us, as a countdown.
 *
 * An estimate that has come and gone is not wrong — the run it was read off is
 * simply going longer than its average — so it reads as imminent rather than as
 * a time in the past, which for a "next slot" would make no sense at all.
 */
function fmtCountdown(iso) {
  if (!iso) return '';
  return new Date(iso).getTime() <= Date.now() ? 'any moment' : fmtRelative(iso);
}

/**
 * A run length, always down to the second so a live clock ticks visibly.
 * Minutes and hours are zero-padded so the digits do not jump around.
 */
function fmtDuration(ms) {
  let seconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  seconds %= 60;
  const pad = (value) => String(value).padStart(2, '0');
  if (hours) return `${hours}h ${pad(minutes)}m ${pad(seconds)}s`;
  if (minutes) return `${minutes}m ${pad(seconds)}s`;
  return `${seconds}s`;
}

/** How long a run that started at `iso` has been going. */
function fmtElapsed(iso) {
  return fmtDuration(Date.now() - new Date(iso).getTime());
}

/**
 * One interval drives every live clock on the page. An element opts in by
 * carrying data-runtime-start (the run's ISO start time); each tick rewrites
 * its text. Nothing to update is a single empty query, so this stays cheap.
 */
function tickRuntimes() {
  for (const node of document.querySelectorAll('[data-runtime-start]')) {
    node.textContent = fmtElapsed(node.dataset.runtimeStart);
  }
  // The same idea pointed the other way: an estimate counting down to the time
  // a queued job could start.
  for (const node of document.querySelectorAll('[data-countdown-to]')) {
    node.textContent = fmtCountdown(node.dataset.countdownTo);
  }
}

/**
 * Money, at the precision the number deserves: a run costs cents and needs four
 * decimals to say so, a lifetime total of hundreds does not.
 */
function fmtCost(usd) {
  if (!Number.isFinite(usd)) return '—';
  return usd >= 10 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`;
}

function fmtBytes(bytes) {
  if (!Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}

/**
 * Toasts stack, so several changes landing at once stay readable.
 *
 * A `key` makes one replace itself instead. That is what keeps a cron on a
 * 30-second schedule from stacking hundreds of identical drop notices through a
 * six hour pause: the same cron reuses its toast and updates the count.
 */
function toast(message, bad = false, key = null) {
  if (key) toastsEl.querySelector(`[data-toast-key="${CSS.escape(key)}"]`)?.remove();
  const node = el('div', { class: bad ? 'toast bad' : 'toast', text: message });
  if (key) node.dataset.toastKey = key;
  toastsEl.append(node);
  setTimeout(() => {
    node.classList.add('leaving');
    setTimeout(() => node.remove(), 200);
  }, bad ? 6000 : 3500);
  // Never let a burst pile up past a screenful.
  while (toastsEl.children.length > 5) toastsEl.firstElementChild.remove();
}

/**
 * Which API a job lives behind. Crons and one-time executions answer the same
 * run, stop and log routes under different prefixes, so every shared control
 * asks this rather than hard-coding one of them.
 */
function apiBase(job) {
  return job?.kind === 'execution' ? 'executions' : 'crons';
}

/** Where the page keeps a job: the crons tab and its pages, or the one-time ones. */
function hashBase(job) {
  return job?.kind === 'execution' ? '#/one-time' : '#';
}

function nodeOfflinePill(node) {
  return el('span', { class: 'pill warn', title: `Node "${node.name ?? 'default'}" is not connected, so nothing starts until it is.` }, [
    el('span', { class: 'led' }),
    'node offline',
  ]);
}

/**
 * A live run keeps its running badge through a pause and picks up the paused
 * badge when it finishes. A deactivated cron stays deactivated: a pause does
 * not change it, and lifting the pause will not arm it.
 */
function statusPill(cron, pause) {
  if (cron.isRunning) return el('span', { class: 'pill running' }, [el('span', { class: 'led' }), 'running']);
  if (cron.isDelayed) {
    return el('span', { class: 'pill delayed', title: delayTitle(cron.delayed) }, [el('span', { class: 'led' }), 'delayed']);
  }
  if (!cron.isActive) return el('span', { class: 'pill paused' }, [el('span', { class: 'led' }), 'deactivated']);
  if (cron.node && !cron.node.online) return nodeOfflinePill(cron.node);
  if (pause?.paused) {
    return el(
      'span',
      { class: 'pill held', title: pauseTitle(pause) },
      [el('span', { class: 'led' }), pause.badge],
    );
  }
  return el('span', { class: 'pill active' }, [el('span', { class: 'led' }), 'armed']);
}

/**
 * What a one-time execution is doing, which is a life rather than a schedule:
 * it is waiting for its date, running, or finished with whatever it finished as.
 *
 * `overdue` is the gap between a trigger being missed and the catch-up starting
 * the run — after a restart, or while a pause is holding it.
 */
function executionPill(execution, pause) {
  if (execution.isRunning) return el('span', { class: 'pill running' }, [el('span', { class: 'led' }), 'running']);
  if (execution.isDelayed) {
    return el('span', { class: 'pill delayed', title: delayTitle(execution.delayed) }, [el('span', { class: 'led' }), 'delayed']);
  }
  if (!execution.isActive) return el('span', { class: 'pill paused' }, [el('span', { class: 'led' }), 'deactivated']);
  if (execution.status === 'scheduled' && execution.node && !execution.node.online) return nodeOfflinePill(execution.node);
  if (execution.status === 'cancelled') {
    return el('span', { class: 'pill warn', title: `Dropped by ${execution.stoppedBy ?? 'the user'} before it ran.` }, [
      el('span', { class: 'led' }),
      'cancelled',
    ]);
  }
  // Neutral on purpose: how the run ended is the Outcome column's job, and a
  // row saying "succeeded" twice tells you nothing the second time.
  if (execution.status === 'done') {
    return el('span', { class: 'pill', title: `Ran ${fmtRelative(execution.lastRunAt)}.` }, [
      el('span', { class: 'led' }),
      'done',
    ]);
  }
  if (execution.isOverdue) {
    return el(
      'span',
      {
        class: 'pill delayed',
        title: pause?.paused
          ? 'Its time has passed while everything is paused. It runs when the pause lifts.'
          : 'Its time has passed and the run is being started now.',
      },
      [el('span', { class: 'led' }), pause?.paused ? 'held' : 'starting'],
    );
  }
  if (pause?.paused) {
    return el('span', { class: 'pill held', title: pauseTitle(pause) }, [el('span', { class: 'led' }), pause.badge]);
  }
  return el('span', { class: 'pill active' }, [el('span', { class: 'led' }), 'scheduled']);
}

/** The limits a held trigger is waiting on, e.g. "Session, Weekly". */
function delayNames(delayed) {
  return (delayed?.reasons ?? []).map((reason) => reason.label).join(', ');
}

/**
 * The tail of a list's summary line: what is waiting, split by what is holding
 * it. The two are different states — one waits on the clock, the other on a
 * running job — so one number for both would hide which.
 */
function waitingSummary(jobs) {
  const waiting = jobs.filter((job) => job.isDelayed);
  const queued = waiting.filter((job) => job.delayed?.hold === 'concurrency').length;
  const onUsage = waiting.length - queued;
  return `${onUsage ? ` · ${onUsage} waiting on usage` : ''}${queued ? ` · ${queued} queued for a slot` : ''}`;
}

/**
 * Hover text for a delayed badge: which limits are holding the trigger, what
 * each is at, and the earliest the run can start.
 */
function delayTitle(delayed) {
  if (!delayed) return '';
  if (delayed.hold === 'concurrency') return queueTitle(delayed);
  const lines = ['Waiting on a usage limit at or above its threshold.'];
  for (const reason of delayed.reasons ?? []) {
    const resets = reason.resetsAt
      ? `resets ${fmtRelative(reason.resetsAt)} (${fmtDateTime(reason.resetsAt)})`
      : 'no reset time reported';
    lines.push(`${reason.label}: ${Math.round(reason.usedPercent)}% used (delays at ${reason.threshold}%), ${resets}`);
  }
  // Usage is only read every five minutes, and a waiting run adds no lookups of
  // its own, so the start can trail the reset by that much.
  lines.push(
    delayed.resumeAt
      ? `Starts ${fmtRelative(delayed.resumeAt)} (${fmtDateTime(delayed.resumeAt)}), give or take the 5 minute usage check.`
      : 'Starts when the next usage check shows it clear. Usage is checked every 5 minutes.',
  );
  lines.push(`Waiting since ${fmtDateTime(delayed.delayedAt)}. Stop drops it.`);
  return lines.join('\n');
}

/**
 * Hover text for a queued badge: where the trigger is in line, what it is
 * behind, and when a slot is expected to come free.
 *
 * The estimate is the soonest a running job is due to finish, worked out from
 * what that job's own runs have averaged. A job that has never finished one has
 * no average and is left out, so the real start can come earlier than this says.
 */
function queueTitle(delayed) {
  const lines = [
    `Queued behind the concurrent job limit of ${delayed.limit}.`,
    `Position ${delayed.position + 1} of ${delayed.queueLength}, with ${delayed.runningCount} job${delayed.runningCount === 1 ? '' : 's'} running.`,
    delayed.resumeAt
      ? `Could start ${fmtCountdown(delayed.resumeAt)} (${fmtDateTime(delayed.resumeAt)}), estimated from what the running jobs average.`
      : 'No estimate: the running jobs have no completed runs to average.',
    `Waiting since ${fmtDateTime(delayed.delayedAt)}. Stop drops it.`,
  ];
  return lines.join('\n');
}

const WARN_ICON =
  '<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">' +
  '<path d="M8 1.8 15 14.2H1Z" fill="currentColor" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />' +
  '<path d="M8 6.2v3.6" style="stroke: var(--bg)" stroke-width="1.7" stroke-linecap="round" />' +
  '<circle cx="8" cy="12" r="1" style="fill: var(--bg)" /></svg>';

// Past this many, the list of jobs expected to hold a slot is cut short: the
// reason is the limit being full, not who in particular is filling it.
const RISK_JOB_LINES = 6;

/** One job expected to be holding a slot when this run is due, as a tooltip line. */
function riskJobLine(job) {
  if (job.state === 'queued') return `${job.name}: queued ahead of it`;
  if (job.state === 'scheduled') {
    const average = Number.isFinite(job.averageRuntimeSeconds)
      ? `, averages ${fmtDuration(job.averageRuntimeSeconds * 1000)} a run`
      : '';
    return `${job.name}: starts ${fmtDateTime(job.startsAt)}${average}`;
  }
  return job.until
    ? `${job.name}: running, expected to finish ${fmtDateTime(job.until)}`
    : `${job.name}: running, no finished run to estimate from`;
}

/**
 * Hover text for the warning on a next run time: what could hold that run
 * when it arrives. The server's forecast from what it knows now, so it says
 * "could" — a run can finish early, and a limit can be read again sooner.
 */
function delayRiskTitle(risk) {
  const sections = ['This run could start late.'];
  if (risk.usage?.length) {
    const lines = ['A usage limit this job waits on is at or above its threshold:'];
    for (const limit of risk.usage) {
      const resets = limit.resetsAt
        ? `resets ${fmtRelative(limit.resetsAt)} (${fmtDateTime(limit.resetsAt)})`
        : 'no reset time reported';
      lines.push(`${limit.label}: ${Math.round(limit.usedPercent)}% used (delays at ${limit.threshold}%), ${resets}`);
    }
    lines.push('The run waits until a usage check shows it clear. Usage is checked every 5 minutes.');
    sections.push(lines.join('\n'));
  }
  if (risk.concurrency) {
    const { limit, busy } = risk.concurrency;
    const lines = [`The concurrent job limit of ${limit} could be full. Expected to be going then:`];
    lines.push(...busy.slice(0, RISK_JOB_LINES).map(riskJobLine));
    if (busy.length > RISK_JOB_LINES) lines.push(`and ${busy.length - RISK_JOB_LINES} more`);
    lines.push('The run would queue for the next free slot.');
    sections.push(lines.join('\n'));
  }
  return sections.join('\n\n');
}

/**
 * The first line of a next run time: the countdown, with the warning in front
 * when that run could be held. A pause drops the trigger instead of holding it,
 * so while one is on the warning would be about a run that is not coming.
 */
function nextRunLine(text, risk, pause) {
  if (!risk || pause.paused) return el('div', { text });
  return el('div', { class: 'delay-risk', title: delayRiskTitle(risk) }, [el('span', { html: WARN_ICON }), text]);
}

/**
 * The Next run cell for a trigger that is waiting, either kind of job and
 * either reason: when it might go, and why it has not.
 */
function waitingCell(delayed) {
  const queued = delayed.hold === 'concurrency';
  const when = queued ? 'when a slot frees' : 'when usage clears';
  const why = queued ? `queued at ${delayed.position + 1} of ${delayed.queueLength}` : `held for ${delayNames(delayed)}`;
  return el('div', { title: delayTitle(delayed) }, [
    delayed.resumeAt
      ? el('div', { text: fmtCountdown(delayed.resumeAt), 'data-countdown-to': delayed.resumeAt })
      : el('div', { text: when }),
    el('div', {
      class: 'cron-desc',
      text: delayed.resumeAt ? `${fmtDateTime(delayed.resumeAt)}${queued ? ' · estimated' : ''}` : why,
    }),
  ]);
}

/** Hover text for a paused badge: when it lifts, or why it cannot be lifted. */
function pauseTitle(pause) {
  if (pause.mode === 'update') return 'An update is waiting for runs to finish, then the server restarts.';
  if (pause.until) return `Schedules resume ${fmtRelative(pause.until)}, at ${fmtDateTime(pause.until)}.`;
  return 'Schedules resume when the pause is cancelled or the server restarts.';
}

/**
 * Pause triggers for… while running normally, Cancel pause while the user paused, and
 * neither during an update — that pause is not the user's to lift.
 */
function pauseControl(pause, options, onChanged) {
  if (pause.paused && pause.mode === 'update') return null;

  if (pause.paused) {
    return el('button', {
      class: 'btn',
      text: 'Cancel pause',
      onclick: async (event) => {
        event.target.disabled = true;
        try {
          await api('/api/pause', { method: 'DELETE' });
          toast('Schedules resumed');
          onChanged?.();
        } catch (err) {
          toast(err.message, true);
          event.target.disabled = false;
        }
      },
    });
  }

  const select = el('select', { class: 'select pause-select', 'aria-label': 'Pause all crons' }, [
    el('option', { value: '', selected: 'selected' }, 'Pause triggers for…'),
    ...options.map((option) => el('option', { value: option.id }, option.label)),
  ]);
  select.addEventListener('change', async () => {
    const option = select.value;
    if (!option) return;
    select.disabled = true;
    try {
      const state = await api('/api/pause', { method: 'POST', body: JSON.stringify({ option }) });
      toast(`Paused ${state.label}`);
      onChanged?.();
    } catch (err) {
      toast(err.message, true);
      select.value = '';
      select.disabled = false;
    }
  });
  return select;
}

/**
 * Amber badge standing in for the outcome while a run is in flight: there is no
 * outcome yet, so the cell carries how long this run has been going instead.
 */
function runtimePill(startedAt) {
  if (!startedAt) return el('span', { class: 'pill running' }, [el('span', { class: 'led' }), 'running']);
  return el('span', { class: 'pill runtime', title: `Running since ${fmtDateTime(startedAt)}` }, [
    el('span', { class: 'led' }),
    el('span', { 'data-runtime-start': startedAt, text: fmtElapsed(startedAt) }),
  ]);
}

function outcomePill(status) {
  if (!status) return el('span', { class: 'muted' }, '—');
  const cls = status === 'succeeded' ? 'pill active' : status === 'stopped' ? 'pill warn' : 'pill failed';
  return el('span', { class: cls }, [el('span', { class: 'led' }), status]);
}

/**
 * One button that swaps role: Run now while idle, Stop while a run is in flight.
 * Stopping kills the child process; the schedule is untouched, so an armed cron
 * still fires at its next trigger. Run now is disabled while paused — a pause
 * means nothing new starts — but Stop never is, so a live run can always be
 * ended.
 */
function runControl(cron, { small = false, onStarted, pause } = {}) {
  const size = small ? 'btn small' : 'btn';

  if (cron.isRunning) {
    const stopping = Boolean(cron.currentRun?.stopping);
    return el('button', {
      class: `${size} danger`,
      text: stopping ? 'Stopping…' : 'Stop',
      disabled: stopping,
      onclick: async (event) => {
        event.target.disabled = true;
        try {
          await api(`/api/${apiBase(cron)}/${cron.id}/stop`, { method: 'POST' });
          toast(`Stopping "${cron.name}"`);
        } catch (err) {
          toast(err.message, true);
          event.target.disabled = false;
        }
      },
    });
  }

  // A held trigger is a pending execution, so the button that would start one
  // becomes the button that drops it. Never disabled by a pause, for the same
  // reason Stop is not: you can always take back something that is queued.
  if (cron.isDelayed) {
    return el('button', {
      class: `${size} danger`,
      text: 'Stop',
      title: delayTitle(cron.delayed),
      onclick: async (event) => {
        event.target.disabled = true;
        try {
          await api(`/api/${apiBase(cron)}/${cron.id}/stop`, { method: 'POST' });
          toast(`"${cron.name}" is no longer waiting`);
        } catch (err) {
          toast(err.message, true);
          event.target.disabled = false;
        }
      },
    });
  }

  if (pause?.paused) {
    // The title sits on a wrapper, not the button: a disabled control does not
    // reliably receive hover, so the tooltip would never appear on some browsers.
    return el(
      'span',
      {
        class: 'btn-hold',
        title:
          pause.mode === 'update'
            ? 'Paused for update — an update is waiting for runs to finish, so nothing new can start.'
            : `Everything is paused ${pause.label}. Cancel the pause to run one.`,
      },
      [
        el('button', {
          class: small ? 'btn small' : 'btn primary',
          text: 'Run now',
          disabled: 'disabled',
        }),
      ],
    );
  }

  return el('button', {
    class: small ? 'btn small' : 'btn primary',
    text: 'Run now',
    onclick: async (event) => {
      event.target.disabled = true;
      try {
        const result = await api(`/api/${apiBase(cron)}/${cron.id}/run`, { method: 'POST' });
        onStarted?.();
        // Run now overrides neither the usage delay nor the concurrent job
        // limit; a blocked press becomes the waiting trigger instead of starting
        // claude anyway.
        if (result?.delayed?.hold === 'concurrency') {
          toast(`"${cron.name}" is queued at position ${result.delayed.position + 1}; every slot is taken.`, true);
        } else if (result?.delayed) {
          toast(`"${cron.name}" is waiting on ${delayNames(result.delayed)}.`, true);
        } else toast(`Starting "${cron.name}"`);
      } catch (err) {
        toast(err.message, true);
        event.target.disabled = false;
      }
    },
  });
}

// ---- home -------------------------------------------------------------

/**
 * How much of the one-time list is on screen.
 *
 * Kept outside the render so that a run event redrawing the page does not throw
 * away the older pages the user has loaded: the redraw asks for the same number
 * of rows again rather than starting back at ten.
 */
const executionsState = { limit: 10, pageSize: 10 };

/** Counts home renders, so a slow one cannot paint over the one after it. */
let homeRenderId = 0;

/** The two tabs, and which one the hash is asking for. */
const TABS = [
  { id: 'crons', kind: 'cron', label: 'Crons', hash: '#/' },
  { id: 'executions', kind: 'execution', label: 'One-time Execution', hash: '#/one-time' },
];

/**
 * How many jobs of each kind have updates nobody has opened yet, as the hub
 * last said: { cron, execution }. Null until the first answer.
 */
let activityCounts = null;
let activityAnnounceTimer = null;
const activityStatusEl = document.getElementById('activity-status');

/** "Updated since you last looked: 2 crons and 1 one-time execution", or empty. */
function updatedPhrase(counts) {
  const parts = [];
  if (counts.cron) parts.push(`${counts.cron} cron${counts.cron === 1 ? '' : 's'}`);
  if (counts.execution) parts.push(`${counts.execution} one-time execution${counts.execution === 1 ? '' : 's'}`);
  return parts.length ? `Updated since you last looked: ${parts.join(' and ')}` : '';
}

/**
 * Takes the counts the hub sent and redraws the tabs' numbers. A rise is said
 * aloud, once for a burst of runs ending together; a fall is the reader's own
 * doing, and the first answer is the page loading, not news.
 */
function setActivityCounts(counts) {
  if (!counts) return;
  const next = { cron: Number(counts.cron) || 0, execution: Number(counts.execution) || 0 };
  const rose = activityCounts && (next.cron > activityCounts.cron || next.execution > activityCounts.execution);
  activityCounts = next;
  for (const tab of document.querySelectorAll('.tab[data-kind]')) paintTabCount(tab);
  if (!rose || !activityStatusEl) return;
  clearTimeout(activityAnnounceTimer);
  activityAnnounceTimer = setTimeout(() => {
    // Emptied first, so the same sentence as last time is still said.
    activityStatusEl.textContent = '';
    requestAnimationFrame(() => {
      activityStatusEl.textContent = updatedPhrase(activityCounts);
    });
  }, 1500);
}

function refreshActivityCounts() {
  api('/api/job-activity')
    .then((summary) => setActivityCounts(summary.counts))
    .catch(() => {});
}

/** A tab's number of updated jobs: drawn for the eye, said in words to a screen reader. */
function paintTabCount(tab) {
  const count = activityCounts?.[tab.dataset.kind] ?? 0;
  const badge = tab.querySelector('.tab-count');
  badge.hidden = !count;
  badge.textContent = count > 99 ? '99+' : String(count);
  tab.querySelector('.tab-count-words').textContent = count ? `, ${count} updated` : '';
  tab.title = count ? `${count} updated since you last opened ${count === 1 ? 'it' : 'them'}` : '';
}

function tabBar(current) {
  const tabs = TABS.map((tab) =>
    el(
      'a',
      {
        class: `tab${tab.id === current ? ' selected' : ''}`,
        href: tab.hash,
        role: 'tab',
        'aria-selected': tab.id === current ? 'true' : 'false',
        'data-kind': tab.kind,
        'data-focus': `tab:${tab.id}`,
      },
      [
        el('span', { text: tab.label }),
        el('span', { class: 'tab-count', 'aria-hidden': 'true', hidden: '' }),
        el('span', { class: 'sr-only tab-count-words' }),
      ],
    ),
  );
  for (const tab of tabs) paintTabCount(tab);
  return el('nav', { class: 'tabs', role: 'tablist' }, tabs);
}

/**
 * Each tab's orders, the first being where it starts. Activity is running,
 * then waiting, then updated, then the rest; the other is the order the list
 * had before there was an Activity one. Kept per browser.
 */
const SORTS = {
  crons: [
    { id: 'activity', label: 'Activity', title: 'Running first, then waiting to start, then updated, then the rest by latest activity' },
    { id: 'name', label: 'Name', title: 'By name, under each project' },
  ],
  executions: [
    { id: 'activity', label: 'Activity', title: 'Running first, then waiting to start, then updated, then the rest by latest activity' },
    { id: 'date', label: 'Date', title: 'Latest scheduled date first, under each project' },
  ],
};

/** The order picked on this page, which outlives storage that will not keep it. */
const pickedSorts = {};

function readSort(tab) {
  if (pickedSorts[tab]) return pickedSorts[tab];
  try {
    const saved = localStorage.getItem(`promptd.sort.${tab}`);
    if (SORTS[tab].some((option) => option.id === saved)) return saved;
  } catch {
    // No storage, as in a private window: every visit starts on Activity.
  }
  return SORTS[tab][0].id;
}

function saveSort(tab, sort) {
  pickedSorts[tab] = sort;
  try {
    localStorage.setItem(`promptd.sort.${tab}`, sort);
  } catch {
    // Kept for this page only.
  }
}

/** The words an update's hover says, by what it was. */
const UPDATE_WORDS = {
  started: 'A run started',
  succeeded: 'A run succeeded',
  failed: 'A run failed',
  stopped: 'A run was stopped',
  interrupted: 'A run was interrupted',
  waiting: 'A trigger started waiting on a usage limit',
  late: 'A trigger is still waiting on a usage limit, past its expected start',
};

function updateTitle(activity) {
  const what = UPDATE_WORDS[activity?.update?.kind] ?? 'Something happened';
  return `${what} ${fmtRelative(activity?.update?.at ?? activity?.lastActivityAt)}, since you last opened it. Opening its logs marks it read.`;
}

/**
 * A job's name, with what says it has news: a dot and the word Updated, so it
 * never rests on colour alone. The dot sits in the cell's padding, so a name
 * does not move when its job is read.
 */
function jobNameCell(job, lines) {
  const unread = Boolean(job.activity?.unread);
  return el('td', {}, [
    el('div', { class: 'job-title' }, [
      el('span', { class: 'unread-dot', 'aria-hidden': 'true' }),
      el('span', { class: 'cron-name', text: job.name }),
      unread ? el('span', { class: 'updated-tag', title: updateTitle(job.activity), text: 'Updated' }) : null,
    ]),
    ...lines,
  ]);
}

/** Gives the control in `node` a key the redraw can put focus back on. */
function focusable(node, key) {
  const target = node?.matches?.('a, button') ? node : node?.querySelector?.('a, button');
  target?.setAttribute('data-focus', key);
  return node;
}

/**
 * The order the open list was last drawn in. It is held while the pointer or
 * the keyboard is in the list, since a job rising to the top under a cursor
 * about to click would put the click on another job; the list catches up once
 * both have left it.
 */
const NO_ORDER = { key: null, ids: null, behind: false };
const listOrder = { ...NO_ORDER };

function holdingList() {
  const panel = view.querySelector('.tab-panel');
  return Boolean(panel && (panel.matches(':hover') || panel.contains(document.activeElement)));
}

/** Whether the list drawn as `key` is held now. */
function holding(key) {
  return listOrder.key === key && Boolean(listOrder.ids) && holdingList();
}

/**
 * The rows to draw, ranked and cut to `limit`, or while the list is held, the
 * rows it was last drawn with in the places they had: none moves and none
 * leaves, and one that has risen into the list from below joins at the
 * bottom. Answers the order to remember too, which the caller keeps only if
 * its render is the one drawn.
 */
function heldOrder(key, jobs, limit = jobs.length) {
  const ranked = jobs.slice(0, limit);
  if (!holding(key)) return { jobs: ranked, order: { key, ids: ranked.map((job) => job.id), behind: false } };
  const place = new Map(listOrder.ids.map((id, index) => [id, index]));
  const rank = (job) => place.get(job.id) ?? listOrder.ids.length + jobs.indexOf(job);
  const kept = jobs.filter((job, index) => place.has(job.id) || index < limit).sort((a, b) => rank(a) - rank(b));
  const behind = kept.length !== ranked.length || kept.some((job, index) => job.id !== ranked[index].id);
  return { jobs: kept, order: { key, ids: kept.map((job) => job.id), behind } };
}

/** The Sort buttons and Mark all read, above either list. */
function listTools(tab, sort, unread) {
  const label = `sort-label-${tab}`;
  return el('div', { class: 'list-tools' }, [
    el('div', { class: 'sort-group', role: 'group', 'aria-labelledby': label }, [
      el('span', { class: 'sort-label', id: label, text: 'Sort' }),
      ...SORTS[tab].map((option) =>
        el('button', {
          type: 'button',
          class: 'btn small',
          'aria-pressed': String(option.id === sort),
          'data-focus': `sort:${option.id}`,
          title: option.title,
          text: option.label,
          onclick: () => {
            if (option.id === sort) return;
            saveSort(tab, option.id);
            // An order asked for is drawn as it is, not held to the last one.
            Object.assign(listOrder, NO_ORDER);
            renderHome(tab).catch(() => {});
          },
        }),
      ),
    ]),
    el('button', {
      type: 'button',
      class: 'btn small',
      'data-focus': 'mark-all',
      // Not disabled when there is nothing to read: a disabled button drops the focus it had.
      'aria-disabled': unread.length ? null : 'true',
      title: unread.length
        ? `Marks the ${unread.length} updated here read. Anything that happens after this list was drawn stays updated.`
        : 'Nothing here is updated.',
      text: 'Mark all read',
      onclick: async (event) => {
        if (!unread.length || event.currentTarget.dataset.busy) return;
        const button = event.currentTarget;
        button.dataset.busy = '1';
        try {
          // What this list was drawn with: a run that ends after it stays updated.
          const items = unread.map(({ id, revision }) => ({ id, revision }));
          const result = await api('/api/job-activity/read', { method: 'POST', body: JSON.stringify({ items }) });
          setActivityCounts(result.counts);
          await renderHome(tab);
        } catch (err) {
          toast(err.message, true);
        } finally {
          delete button.dataset.busy;
        }
      },
    }),
  ]);
}

/**
 * The pause sentence both tabs share, since one pause holds both: crons stop
 * firing and one-time executions stop starting.
 */
function pauseSummary(pause) {
  if (!pause.paused) return null;
  if (pause.mode === 'update') {
    return pause.runningCount
      ? `Paused for update — waiting for ${pause.runningCount} run${pause.runningCount === 1 ? '' : 's'} to finish`
      : 'Paused for update — restarting';
  }
  return pause.until ? `paused ${pause.label}, resumes ${fmtRelative(pause.until)}` : `paused ${pause.label}`;
}

/**
 * The home page: one header, one pause control, and two tabs under it.
 *
 * The pause sits outside the tabs on purpose. It is not a property of either
 * list — it holds every cron and every one-time execution at once — so putting
 * a copy inside each tab would have suggested there were two of them.
 */
async function renderHome(tab = 'crons') {
  const renderId = ++homeRenderId;
  const hash = location.hash;
  const [pause, summary] = await Promise.all([api('/api/pause'), api('/api/job-activity').catch(() => null)]);
  if (summary) setActivityCounts(summary.counts);
  // What Mark all read reads: the updated jobs this list is drawn with, paged in or not.
  const unread = (summary?.unread ?? []).filter((job) => job.kind === (tab === 'executions' ? 'execution' : 'cron'));

  const subEl = el('p', { class: 'sub', text: '' });
  const head = el('div', { class: 'page-head' }, [
    el('div', {}, [el('h1', { text: 'promptd' }), subEl]),
    el('div', { class: 'head-actions' }, [
      pauseControl(pause, pause.options ?? [], () => renderHome(tab).catch(() => {})),
      tab === 'executions'
        ? el('a', { class: 'btn primary', href: '#/one-time/new', text: '+ New one-time execution' })
        : el('a', { class: 'btn primary', href: '#/new', text: '+ New cron' }),
    ]),
  ]);

  // Filled while detached and swapped in at once. Clearing the page first and
  // filling it after the fetch left it one header tall for a moment, which
  // threw the scroll back to the top on every refresh.
  const panel = el('div', { class: 'tab-panel', role: 'tabpanel' });
  const sub = (text) => {
    subEl.textContent = text;
  };

  const order = tab === 'executions' ? await paintExecutions(panel, pause, sub, unread) : await paintCrons(panel, pause, sub, unread);

  // A newer render, or a move to another page, landed while this one waited.
  if (renderId !== homeRenderId || location.hash !== hash) return;
  // What is on screen is what a held list holds to; Name and Date hold nothing.
  Object.assign(listOrder, order ?? NO_ORDER);
  // Redraws come with every run event, and must not throw the keyboard back to the top.
  const focused = view.contains(document.activeElement) ? document.activeElement.closest('[data-focus]')?.dataset.focus : null;
  view.replaceChildren(head, tabBar(tab), panel);
  if (focused) view.querySelector(`[data-focus="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true });
  panel.addEventListener('pointerleave', () => catchUp(0));
  panel.addEventListener('focusout', () => catchUp(0));
  catchUp();
}

/**
 * Redraws a held list once the pointer and the focus have both left it. Leaving
 * is also checked on a timer, since a list redrawn under a still pointer may
 * never be told the pointer has gone.
 */
let catchUpTimer = null;
function catchUp(delay = 500) {
  clearTimeout(catchUpTimer);
  if (!listOrder.behind) return;
  catchUpTimer = setTimeout(() => {
    if (!listOrder.behind || parseHash().section !== 'list') return;
    if (holdingList()) catchUp();
    else refreshCurrentView();
  }, delay);
}

/** A row that opens `href`, except from its own controls or when the click ends a text selection. */
function linkedRow(href) {
  return {
    class: 'linked-row',
    onclick: (event) => {
      if (event.target.closest('a, button, input, select, textarea')) return;
      if (window.getSelection()?.toString()) return;
      location.hash = href;
    },
  };
}

/** One heading row per project, in name order, with the jobs in no project last. */
function groupedRows(jobs, projects, row) {
  if (!projects.length) return jobs.map(row);
  const groups = [...projects.map((project) => ({ id: project.id, name: project.name })), { id: null, name: 'No project' }];
  const known = new Set(projects.map((project) => project.id));
  return groups.flatMap((group) => {
    const members = jobs.filter((job) => (known.has(job.projectId) ? job.projectId : null) === group.id);
    if (!members.length) return [];
    return [
      el('tr', { class: 'group-row' }, [
        el('td', { colspan: '6' }, [el('span', { text: group.name }), el('span', { class: 'group-count', text: String(members.length) })]),
      ]),
      ...members.map(row),
    ];
  });
}

/** The project a job is in, by name, for a list that is not grouped by project. */
function projectLine(job, projects) {
  const project = projects.find((candidate) => candidate.id === job.projectId);
  return project ? el('div', { class: 'cron-desc', text: project.name }) : null;
}

/**
 * The Crons tab: everything the home page showed before the tabs existed. In
 * the Activity order it is one list, since project headings would split what
 * is running across them; by name it is grouped as it always was.
 */
async function paintCrons(panel, pause, sub, unread) {
  const sort = readSort('crons');
  const [ranked, projects] = await Promise.all([api(sort === 'activity' ? '/api/crons?sort=activity' : '/api/crons'), api('/api/projects')]);
  const { jobs: crons, order } = sort === 'activity' ? heldOrder('crons', ranked) : { jobs: ranked, order: null };
  const armed = crons.filter((c) => c.isActive).length;

  let line;
  if (!crons.length) line = 'Nothing scheduled yet';
  else if (pause.paused && pause.mode === 'update') line = pauseSummary(pause);
  else if (pause.paused) line = `${armed} armed of ${crons.length} — ${pauseSummary(pause)}`;
  else line = `${armed} armed of ${crons.length}`;

  line += waitingSummary(crons);
  if (pause.paused && pause.droppedCount) {
    line += ` · ${pause.droppedCount} trigger${pause.droppedCount === 1 ? '' : 's'} dropped`;
  }
  sub(line);

  if (!crons.length) {
    panel.replaceChildren(
      el('div', { class: 'panel' }, [
        el('div', { class: 'empty' }, [
          el('p', { text: 'No crons yet.' }),
          el('a', { class: 'btn primary', href: '#/new', text: 'Create your first cron' }),
        ]),
      ]),
    );
    return order;
  }

  const row = (cron) =>
    el('tr', { ...linkedRow(`#/logs/${cron.id}`), class: `linked-row${cron.activity?.unread ? ' unread' : ''}` }, [
      jobNameCell(cron, [
        sort === 'activity' ? projectLine(cron, projects) : null,
        // Two lines on the page, all of it in the tooltip: a paragraph of
        // description must not push the row taller than the ones around it.
        cron.description ? el('div', { class: 'cron-desc clamp', text: cron.description, title: cron.description }) : null,
        el('div', { class: 'cron-desc mono', text: cron.timezone && cron.timezone !== BROWSER_TIMEZONE ? `${cron.cron} (${cron.timezone})` : cron.cron }),
      ]),
      el('td', {}, [statusPill(cron, pause)]),
      el('td', { class: 'hide-sm time-cell' }, [
        cron.lastRunAt
          ? el('div', {}, [
              el('div', { text: fmtRelative(cron.lastRunAt) }),
              el('div', { class: 'cron-desc', text: fmtDateTime(cron.lastRunAt) }),
            ])
          : el('span', { class: 'muted', text: 'never' }),
      ]),
      el('td', { class: 'hide-sm' }, [
        cron.isRunning ? runtimePill(cron.currentRun?.startedAt) : outcomePill(cron.lastRunStatus),
      ]),
      el('td', { class: 'hide-sm time-cell' }, [nextRunCell(cron, pause)]),
      el('td', {}, [
        el('div', { class: 'row-actions' }, [
          focusable(runControl(cron, { small: true, pause }), `run:${cron.id}`),
          el('a', { class: 'btn small', href: `#/edit/${cron.id}`, 'data-focus': `edit:${cron.id}`, text: 'Edit' }),
          el('a', { class: 'btn small', href: `#/logs/${cron.id}`, 'data-focus': `logs:${cron.id}`, text: 'View logs' }),
        ]),
      ]),
    ]);
  const rows = sort === 'activity' ? crons.map(row) : groupedRows(crons, projects, row);

  panel.replaceChildren(
    listTools('crons', sort, unread),
    el('div', { class: 'panel' }, [
      el('table', {}, [
        el('thead', {}, [
          el('tr', {}, [
            el('th', { text: 'Name' }),
            el('th', { text: 'Status' }),
            el('th', { class: 'hide-sm time-cell', text: 'Last ran' }),
            el('th', { class: 'hide-sm', text: 'Outcome' }),
            el('th', { class: 'hide-sm time-cell', text: 'Next run' }),
            el('th', {}, ''),
          ]),
        ]),
        el('tbody', {}, rows),
      ]),
    ]),
  );
  return order;
}

/** The Next run cell: a held trigger, a real schedule, or nothing to say. */
function nextRunCell(cron, pause) {
  if (cron.isDelayed) return waitingCell(cron.delayed);
  if (!cron.nextRunAt) return el('span', { class: 'muted', text: cron.isActive ? 'not scheduled' : 'deactivated' });
  // A pause leaves the schedule registered, so this time is real — it is when
  // the trigger arrives and is thrown away, not when it runs.
  return el(
    'div',
    {
      title: pause.paused
        ? 'Every schedule is paused, so this trigger is dropped when it arrives. A pause misses runs, it does not queue them.'
        : null,
    },
    [
      nextRunLine(fmtRelative(cron.nextRunAt), cron.delayRisk, pause),
      el('div', {
        class: 'cron-desc',
        text: pause.paused ? `${fmtDateTime(cron.nextRunAt)} · dropped` : fmtDateTime(cron.nextRunAt),
      }),
    ],
  );
}

/**
 * The One-time Execution tab: the ten most recent, newest first, and a button
 * that loads ten more.
 *
 * A one-time execution that has run stays here as history. It can be run again
 * by hand, and a save that moves its date arms it afresh; nothing re-fires it
 * on its own.
 */
async function paintExecutions(panel, pause, sub, unread) {
  const sort = readSort('executions');
  const [page, projects] = await Promise.all([
    api(`/api/executions?limit=${executionsState.limit}${sort === 'activity' ? '&sort=activity' : ''}`),
    api('/api/projects'),
  ]);
  let items = page.items;
  // Held, no row the list showed may leave it, so one that a rise has pushed
  // off the page is read on its own. Asked once the answer is in, since the
  // pointer may have come into the list while the page was on its way.
  if (sort === 'activity' && holding('executions')) {
    const fetched = new Set(items.map((execution) => execution.id));
    const missing = listOrder.ids.filter((id) => !fetched.has(id));
    // Only one that is gone leaves. Any other failure draws nothing, and the list stays as it is.
    const found = await Promise.all(
      missing.map((id) =>
        api(`/api/executions/${id}`).catch((err) => {
          if (err.status === 404) return null;
          throw err;
        }),
      ),
    );
    items = [...items, ...found.filter(Boolean)];
  }
  const { jobs: executions, order } =
    sort === 'activity' ? heldOrder('executions', items, executionsState.limit) : { jobs: items, order: null };

  let line;
  if (!page.total) line = 'Nothing scheduled yet';
  else if (pause.paused && pause.mode === 'update') line = pauseSummary(pause);
  else if (pause.paused) line = `${page.scheduled} scheduled of ${page.total} — ${pauseSummary(pause)}`;
  else line = `${page.scheduled} scheduled of ${page.total}`;

  sub(line + waitingSummary(executions));

  if (!page.total) {
    panel.replaceChildren(
      el('div', { class: 'panel' }, [
        el('div', { class: 'empty' }, [
          el('p', { text: 'No one-time executions yet.' }),
          el('p', {
            class: 'cron-desc',
            text: 'A one-time execution is a prompt with a date instead of a schedule. It runs once, then stays here as history.',
          }),
          el('a', { class: 'btn primary', href: '#/one-time/new', text: 'Schedule your first one' }),
        ]),
      ]),
    );
    return order;
  }

  const row = (execution) =>
    el('tr', { ...linkedRow(`#/one-time/logs/${execution.id}`), class: `linked-row${execution.activity?.unread ? ' unread' : ''}` }, [
      jobNameCell(execution, [
        sort === 'activity' ? projectLine(execution, projects) : null,
        execution.description
          ? el('div', { class: 'cron-desc clamp', text: execution.description, title: execution.description })
          : null,
        el('div', { class: 'cron-desc mono', text: 'one-time' }),
      ]),
      el('td', {}, [executionPill(execution, pause)]),
      el('td', { class: 'hide-sm time-cell' }, [
        execution.lastRunAt
          ? el('div', {}, [
              el('div', { text: fmtRelative(execution.lastRunAt) }),
              el('div', { class: 'cron-desc', text: fmtDateTime(execution.lastRunAt) }),
            ])
          : el('span', { class: 'muted', text: 'never' }),
      ]),
      el('td', { class: 'hide-sm' }, [
        execution.isRunning ? runtimePill(execution.currentRun?.startedAt) : outcomePill(execution.lastRunStatus),
      ]),
      el('td', { class: 'hide-sm time-cell' }, [scheduledCell(execution, pause)]),
      el('td', {}, [
        el('div', { class: 'row-actions' }, [
          focusable(runControl(execution, { small: true, pause }), `run:${execution.id}`),
          focusable(rearmControl(execution), `rearm:${execution.id}`),
          el('a', { class: 'btn small', href: `#/one-time/edit/${execution.id}`, 'data-focus': `edit:${execution.id}`, text: 'Edit' }),
          el('a', { class: 'btn small', href: `#/one-time/logs/${execution.id}`, 'data-focus': `logs:${execution.id}`, text: 'View logs' }),
        ]),
      ]),
    ]);
  const rows = sort === 'activity' ? executions.map(row) : groupedRows(executions, projects, row);

  const more = executions.length < page.total
    ? el('div', { class: 'load-more' }, [
        el('button', {
          class: 'btn',
          'data-focus': 'load-more',
          // By activity the next ten are further down the ranking, not older.
          text: `Load ${executionsState.pageSize} ${sort === 'activity' ? 'more' : 'older'}`,
          onclick: (event) => {
            event.target.disabled = true;
            event.target.textContent = 'Loading…';
            executionsState.limit += executionsState.pageSize;
            renderHome('executions').catch(() => {});
          },
        }),
        el('span', { class: 'cron-desc', text: `Showing ${executions.length} of ${page.total}` }),
      ])
    : executions.length > executionsState.pageSize
      ? el('div', { class: 'load-more' }, [el('span', { class: 'cron-desc', text: `All ${page.total} shown` })])
      : null;

  panel.replaceChildren(
    listTools('executions', sort, unread),
    el('div', { class: 'panel' }, [
      el('table', {}, [
        el('thead', {}, [
          el('tr', {}, [
            el('th', { text: 'Name' }),
            el('th', { text: 'Status' }),
            el('th', { class: 'hide-sm time-cell', text: 'Last ran' }),
            el('th', { class: 'hide-sm', text: 'Outcome' }),
            el('th', { class: 'hide-sm time-cell', text: 'Scheduled for' }),
            el('th', {}, ''),
          ]),
        ]),
        el('tbody', {}, rows),
      ]),
      more,
    ]),
  );
  return order;
}

/** When a one-time execution goes, or when it went and what became of it. */
function scheduledCell(execution, pause) {
  if (execution.isDelayed) return waitingCell(execution.delayed);
  const when = el('div', { text: fmtDateTime(execution.scheduledAt) ?? '—' });
  if (execution.status !== 'scheduled' || !execution.isActive) {
    const note =
      !execution.isActive
        ? 'deactivated'
        : execution.status === 'cancelled'
          ? `dropped by ${execution.stoppedBy ?? 'the user'}`
          : execution.status === 'running'
            ? 'running now'
            : 'already run';
    return el('div', {}, [when, el('div', { class: 'cron-desc', text: note })]);
  }
  return el(
    'div',
    {
      title: pause.paused
        ? 'Everything is paused. This one waits, and runs when the pause lifts.'
        : null,
    },
    [
      nextRunLine(execution.isOverdue ? 'overdue' : fmtRelative(execution.scheduledAt), execution.delayRisk, pause),
      el('div', { class: 'cron-desc', text: fmtDateTime(execution.scheduledAt) }),
    ],
  );
}

/**
 * Puts a finished or cancelled execution back on its own date, when that date
 * has not passed yet. Anything else is an edit, which the form already does.
 */
function rearmControl(execution) {
  if (execution.isRunning || execution.isDelayed) return null;
  if (execution.status === 'scheduled') return null;
  if (Date.parse(execution.scheduledAt ?? '') <= Date.now()) return null;
  return el('button', {
    class: 'btn small',
    text: 'Reschedule',
    title: `Arm it again for ${fmtDateTime(execution.scheduledAt)}.`,
    onclick: async (event) => {
      event.target.disabled = true;
      try {
        await api(`/api/executions/${execution.id}/rearm`, { method: 'POST' });
        toast(`"${execution.name}" is scheduled again`);
      } catch (err) {
        toast(err.message, true);
        event.target.disabled = false;
      }
    },
  });
}

// ---- edit / create ---------------------------------------------------

// Cron expressions are written, saved and read back in the zone of the browser writing them.
const BROWSER_TIMEZONE = Intl.DateTimeFormat().resolvedOptions().timeZone;

const DIR_HINT = 'Where claude runs. Type to search, ↑↓ to pick, Enter to accept.';

const CRON_FIELD_HELP = {
  s: 'Seconds — 0 to 59',
  m: 'Minutes — 0 to 59',
  h: 'Hours — 0 to 23',
  dom: 'Day of month — 1 to 31',
  mon: 'Month — 1 to 12, or JAN to DEC',
  dow: 'Day of week — 0 to 7, or SUN to SAT. 0 and 7 are both Sunday.',
};

/** Renders "(m h dom mon dow)" with each field name explaining itself on hover. */
function cronFieldLegend(fields) {
  const parts = [];
  fields.forEach((field, index) => {
    if (index) parts.push(' ');
    parts.push(el('abbr', { class: 'cron-field', 'data-tip': CRON_FIELD_HELP[field], text: field }));
  });
  return el('span', { class: 'legend' }, ['(', ...parts, ')']);
}

/**
 * Wraps the Cron input in shortcuts and live feedback: preset buttons, a
 * time-of-day entry, and the next fire time recomputed as the field changes.
 */
/**
 * `zone` is the time zone the expression is in: the one the cron was written in
 * while its expression is left alone, and the browser's once it is changed.
 */
function cronPicker(input, { zone = () => BROWSER_TIMEZONE, node = () => '', label = 'Cron' } = {}) {
  input.id ||= uid('cron');
  const preview = el('div', { class: 'hint' });
  const zoneNote = el('span', {});
  const paintZone = () => {
    const current = zone();
    zoneNote.textContent =
      current === BROWSER_TIMEZONE
        ? `. Times are in your time zone, ${current}, and every node fires them at that moment.`
        : `. Times are in ${current}, where this cron was written. Changing the expression puts it in your time zone, ${BROWSER_TIMEZONE}.`;
  };
  let debounce = null;
  let seq = 0;

  const update = () => {
    const mine = ++seq;
    const expression = input.value.trim();
    if (!expression) {
      preview.textContent = '';
      preview.className = 'hint';
      return;
    }
    paintZone();
    api(`/api/next-run?cron=${encodeURIComponent(expression)}&timezone=${encodeURIComponent(zone())}&node=${encodeURIComponent(node())}`)
      .then((result) => {
        if (mine !== seq) return; // a later keystroke already won
        if (!result.valid) {
          preview.textContent = result.error;
          preview.className = 'hint warn';
          return;
        }
        preview.textContent = `Next run: ${fmtRelative(result.nextRunAt)} · ${fmtDateTimeWeekday(result.nextRunAt)} your time`;
        preview.className = 'hint ok';
      })
      .catch(() => {});
  };

  input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(update, 200);
  });

  const apply = (expression) => {
    input.value = expression;
    update();
  };

  const preset = (label, expression, title) =>
    el('button', {
      type: 'button',
      class: 'btn small',
      text: label,
      title,
      onclick: () => apply(expression),
    });

  const timeEntry = el('input', { type: 'time', class: 'time-entry', value: '09:00' });
  const applyTime = () => {
    const [hours, minutes] = timeEntry.value.split(':');
    if (hours === undefined || minutes === undefined) return;
    apply(`${Number(minutes)} ${Number(hours)} * * *`);
  };
  timeEntry.addEventListener('change', applyTime);

  paintZone();
  update();

  const field = el('div', { class: 'field' }, [
    el('label', { for: input.id, text: label }),
    input,
    el('div', { class: 'preset-row' }, [
      preset('30s', '*/30 * * * * *', 'Every 30 seconds'),
      preset('15m', '*/15 * * * *', 'Every 15 minutes'),
      preset('1hr', '0 * * * *', 'Every hour, on the hour'),
      el('span', { class: 'preset-sep' }),
      el('span', { class: 'preset-label', text: 'Daily at' }),
      timeEntry,
      el('button', { type: 'button', class: 'btn small', text: 'Set', onclick: applyTime }),
    ]),
    el('div', { class: 'hint' }, [
      'Five fields ',
      cronFieldLegend(['m', 'h', 'dom', 'mon', 'dow']),
      '. For seconds, add a sixth field at the front ',
      cronFieldLegend(['s', 'm', 'h', 'dom', 'mon', 'dow']),
      zoneNote,
    ]),
    preview,
  ]);
  return { field, refresh: update };
}

/**
 * What the job forms take from the Settings page: where a new job's Prompt field
 * starts, and the common commands. The working directory default belongs to the
 * node, and arrives with the node picker. A settings read that fails falls back
 * to a blank prompt and no commands rather than blocking the form.
 */
async function jobFormSettings() {
  const settings = await api('/api/settings').catch(() => ({}));
  return {
    // The cluster's, which a job follows until its node's own arrive with the node list.
    jobDefaults: settings.jobDefaults ?? { usageDelay: {} },
    prompt: typeof settings.defaultPrompt === 'string' ? settings.defaultPrompt : '',
    commands:
      typeof settings.commonCommands === 'string'
        ? settings.commonCommands
            .split('\n')
            .map((line) => line.trim())
            .filter(Boolean)
            .sort((a, b) => a.localeCompare(b))
        : [],
  };
}

/**
 * A button per common command, under the Prompt field. Clicking one copies the
 * command to the clipboard for pasting into the prompt. Nothing is drawn when
 * there are no commands.
 */
function commandButtons(commands) {
  if (!commands.length) return null;
  return el(
    'div',
    { class: 'preset-row' },
    commands.map((command) =>
      el('button', {
        type: 'button',
        class: 'btn small mono command-button',
        text: command,
        title: command,
        onclick: async () => {
          try {
            await navigator.clipboard.writeText(command);
            toast(`Command copied to clipboard: ${command}`);
          } catch (err) {
            toast(`Could not copy to clipboard: ${err.message}`, true);
          }
        },
      }),
    ),
  );
}

/**
 * Wraps the Working Directory input in a directory picker: suggestions from the
 * server as you type, keyboard selection, and a live note of where the path lands.
 * A null label leaves the field unlabelled, for a place with a heading of its own.
 * `onResult` hears each answer, which says whether the folder is in a git
 * repository; `lookup` asks again without opening the menu, for a path set from script.
 */
function directoryPicker(input, { label = 'Working Directory', node = () => '', onResult = () => {} } = {}) {
  input.id ||= uid('directory');
  const menu = el('div', { class: 'combo-menu', hidden: 'hidden' });
  const hint = el('div', { class: 'hint', text: DIR_HINT });
  let items = [];
  let active = -1;
  let debounce = null;
  let seq = 0;

  const close = () => {
    menu.hidden = true;
    active = -1;
  };

  const paint = () => {
    menu.replaceChildren(
      ...items.map((suggestion, index) =>
        el(
          'button',
          {
            type: 'button',
            class: `combo-item mono${index === active ? ' active' : ''}`,
            // mousedown, not click: it fires before blur, so the menu is still open.
            onmousedown: (event) => {
              event.preventDefault();
              accept(index);
            },
          },
          suggestion,
        ),
      ),
    );
    // A lookup made from script, with the field not focused, updates the note and nothing else.
    menu.hidden = items.length === 0 || document.activeElement !== input;
    if (active >= 0) menu.children[active]?.scrollIntoView({ block: 'nearest' });
  };

  const accept = (index) => {
    if (!items[index]) return;
    input.value = items[index];
    input.focus();
    // Accepting ends in a slash, so re-querying lists what is inside it.
    lookup();
  };

  const lookup = () => {
    const mine = ++seq;
    api(`/api/browse?path=${encodeURIComponent(input.value)}&node=${encodeURIComponent(node())}`)
      .then((result) => {
        if (mine !== seq) return; // a later keystroke already won
        items = result.suggestions;
        active = -1;
        paint();
        if (!input.value.trim()) {
          hint.textContent = DIR_HINT;
          hint.className = 'hint';
        } else {
          // A node older than the git check answers without the flag, and then nothing is said about it.
          const repository =
            result.inGitRepository === undefined ? '' : result.inGitRepository ? ' · in a git repository' : ' · not in a git repository';
          hint.textContent = result.exists ? `→ ${result.resolved}${repository}` : `${result.resolved} does not exist`;
          hint.className = result.exists ? 'hint ok' : 'hint warn';
        }
        onResult(result);
      })
      .catch((err) => {
        if (mine !== seq) return;
        items = [];
        paint();
        hint.textContent = `No folder suggestions: ${err.message}`;
        hint.className = 'hint warn';
      });
  };

  input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(lookup, 120);
  });
  input.addEventListener('focus', lookup);
  input.addEventListener('blur', () => setTimeout(close, 120));

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !menu.hidden) {
      event.stopPropagation();
      close();
      return;
    }
    if (menu.hidden || !items.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      active = (active + step + items.length) % items.length;
      paint();
    } else if ((event.key === 'Enter' || event.key === 'Tab') && active >= 0) {
      // Without this, Enter would submit the form instead of taking the suggestion.
      event.preventDefault();
      accept(active);
    }
  });

  return {
    lookup,
    field: el('div', { class: 'field' }, [
      label ? el('label', { for: input.id, text: label }) : null,
      el('div', { class: 'combo' }, [input, menu]),
      hint,
    ]),
  };
}

/**
 * How a setting that can follow a default says which it is doing. A job
 * follows its node's defaults; a node's own defaults follow the cluster's. Null
 * is the Settings page itself, where there is nothing further up to follow.
 */
const JOB_FOLLOW = { marker: 'default', reset: 'Use default' };
const NODE_FOLLOW = { marker: 'cluster default', reset: 'Use the cluster default' };

let settingIds = 0;

/** A fresh id, so a label can name the input it belongs to. */
function uid(prefix) {
  settingIds += 1;
  return `${prefix}-${settingIds}`;
}

/**
 * One setting that can follow a default, on a checkbox or a select. The input
 * always shows the value in force. While the setting follows the default it is
 * marked as the default; once changed it offers to go back, which is what
 * saves null. `read` answers the setting's own value, or null while it follows.
 */
function followSetting(input, { own = null, inherited, follow = JOB_FOLLOW, what, onChange = () => {} }) {
  const isBox = input.type === 'checkbox';
  let value = follow ? own : (own ?? inherited);
  let fallback = inherited;
  const marker = el('span', { class: 'setting-default', text: follow?.marker ?? '' });
  const reset = el('button', {
    type: 'button',
    class: 'setting-reset',
    text: follow?.reset ?? '',
    'aria-label': `${follow?.reset ?? ''}: ${what}`,
  });
  const tag = follow ? el('span', { class: 'setting-tag' }, [marker, reset]) : null;

  const show = () => {
    const current = value ?? fallback;
    if (isBox) input.checked = Boolean(current);
    else input.value = current ?? '';
    marker.hidden = value !== null;
    reset.hidden = value === null;
  };

  input.addEventListener('change', () => {
    value = isBox ? input.checked : input.value;
    show();
    onChange(value);
  });
  reset.addEventListener('click', () => {
    value = null;
    show();
    onChange(null);
    input.focus();
  });
  show();

  return {
    tag,
    read: () => value,
    effective: () => value ?? fallback,
    isOwn: () => value !== null,
    /** Sets the setting's own value from the page, as the git check does. */
    set: (next) => {
      value = next;
      show();
    },
    /** A new default to follow, when the job moves to another node. */
    follow: (next) => {
      fallback = next;
      show();
    },
    refresh: show,
  };
}

/** A checkbox and its words, marked when it follows a default. */
function followCheck(text, options) {
  const box = el('input', { type: 'checkbox' });
  const setting = followSetting(box, { what: text, ...options });
  const row = el('span', { class: 'setting-row' }, [el('label', { class: 'check' }, [box, text]), setting.tag]);
  return { ...setting, box, row };
}

/**
 * Model dropdown, filled from whatever the installed CLI recognises. Both the
 * select and the Refresh button are disabled while discovery is running, since
 * it spawns a probe per candidate and takes a few seconds.
 */
function modelPicker({ own = null, inherited = '', follow = JOB_FOLLOW, onChange, onPaint = () => {} } = {}) {
  const select = el('select', { class: 'select mono', id: uid('model') });
  const refresh = el('button', { type: 'button', class: 'btn small', text: 'Refresh' });
  const note = el('div', { class: 'hint' });
  const setting = followSetting(select, { own, inherited, follow, what: 'Model', onChange });
  let state = { models: [], loading: true, error: null, discoveredAt: null };

  const paint = (next = state) => {
    state = next;
    const current = setting.effective() ?? '';
    const options = [{ value: '', label: 'CLI default (whatever the CLI is set to)' }, ...state.models];
    // A model saved earlier that this CLI no longer lists must not be silently dropped.
    if (current && !options.some((option) => option.value === current)) {
      options.push({ value: current, label: `${current} (not in this CLI's catalog)` });
    }
    select.replaceChildren(...options.map((option) => el('option', { value: option.value }, option.label)));
    setting.refresh();

    select.disabled = state.loading;
    refresh.disabled = state.loading;
    refresh.textContent = state.loading ? 'Looking up…' : 'Refresh';

    if (state.loading) {
      note.textContent = 'Asking claude which models it recognises…';
      note.className = 'hint';
    } else if (state.error) {
      note.textContent = `Could not list models: ${state.error}`;
      note.className = 'hint warn';
    } else {
      note.textContent = `${state.models.length} models, checked ${fmtRelative(state.discoveredAt)}. Passed to claude as --model.`;
      note.className = 'hint';
    }
    onPaint();
  };

  const load = () =>
    api('/api/models')
      .then((next) => {
        paint(next);
        // Discovery started at boot may still be running; check back until it lands.
        if (next.loading) {
          clearTimeout(modelPollTimer);
          modelPollTimer = setTimeout(load, 1000);
        }
      })
      .catch((err) => {
        note.textContent = err.message;
        note.className = 'hint warn';
      });

  refresh.addEventListener('click', async () => {
    paint({ models: [], loading: true, error: null, discoveredAt: null });
    try {
      paint(await api('/api/models/refresh', { method: 'POST' }));
      toast('Model list refreshed');
    } catch (err) {
      paint({ models: [], loading: false, error: err.message, discoveredAt: null });
    }
  });

  paint();
  load();

  return {
    read: setting.read,
    isOwn: setting.isOwn,
    follow: (next) => {
      setting.follow(next);
      paint();
    },
    /** The model in force, in the dropdown's words: "Sonnet" rather than "Sonnet (latest)". */
    describe: () => {
      const value = setting.effective() ?? '';
      if (!value) return 'CLI default model';
      const option = state.models.find((model) => model.value === value);
      return (option?.label ?? value).replace(/ \(latest\)$/, '');
    },
    field: el('div', { class: 'field' }, [
      el('label', { for: select.id, text: 'Model' }),
      el('div', { class: 'select-row' }, [select, refresh, setting.tag]),
      note,
    ]),
  };
}

/**
 * Effort dropdown. The levels come from the server, so the list here and the
 * value the run is allowed to pass stay one list. Empty leaves --effort off.
 */
function effortPicker({ own = null, inherited = '', follow = JOB_FOLLOW, onChange } = {}) {
  const select = el('select', { class: 'select mono', id: uid('effort') });
  const note = el('div', {
    class: 'hint',
    text: 'Passed to claude as --effort. Higher levels think longer, so runs cost more and take longer.',
  });
  const setting = followSetting(select, { own, inherited, follow, what: 'Effort', onChange });
  let levels = [];

  const paint = () => {
    const current = setting.effective() ?? '';
    const options = [
      { value: '', label: 'CLI default (whatever the CLI is set to)' },
      ...levels.map((level) => ({ value: level.id, label: level.label })),
    ];
    // An effort saved earlier that this server no longer offers must not be silently dropped.
    if (current && !options.some((option) => option.value === current)) {
      options.push({ value: current, label: `${current} (no longer offered)` });
    }
    select.replaceChildren(...options.map((option) => el('option', { value: option.value }, option.label)));
    setting.refresh();
  };

  paint();
  api('/api/config')
    .then((config) => {
      levels = config.effortLevels ?? [];
      paint();
    })
    .catch((err) => {
      note.textContent = `Could not load the effort levels: ${err.message}`;
      note.className = 'hint warn';
    });

  return {
    read: setting.read,
    isOwn: setting.isOwn,
    follow: (next) => {
      setting.follow(next);
      paint();
    },
    describe: () => {
      const value = setting.effective() ?? '';
      if (!value) return 'CLI default effort';
      return `${levels.find((level) => level.id === value)?.label ?? value} effort`;
    },
    field: el('div', { class: 'field' }, [
      el('label', { for: select.id, text: 'Effort' }),
      el('div', { class: 'select-row' }, [select, setting.tag]),
      note,
    ]),
  };
}

/**
 * Delay for usage: the limits a trigger should wait out rather than run through.
 * The categories come from the server, so the checkboxes here and the limits a
 * held trigger is actually checked against stay one list. Each box follows its
 * default on its own.
 */
function usageDelayPicker({ own = {}, inherited = {}, follow = JOB_FOLLOW, onChange = () => {}, brief = false } = {}) {
  const boxes = new Map();
  const grid = el('fieldset', { class: 'delay-grid' });
  const note = el('div', {
    class: 'hint',
    text:
      'A ticked limit at or above its percentage makes the run wait instead of starting, Run now included. ' +
      'It starts when usage clears, within about 5 minutes. Only one run waits at a time; any ' +
      'trigger that arrives while it waits is dropped.',
  });
  const thresholdsNote = el('div', { class: 'hint' }, [
    'The percentages belong to the node that runs the job, and are set on the ',
    // A new tab, so following it does not throw away what is typed in the form.
    el('a', { href: '#/settings', target: '_blank', rel: 'noopener', text: 'Settings page' }),
    '.',
  ]);
  let categories = [];
  let thresholds = null;
  let fallback = { ...inherited };
  // Boxes held ticked by another choice on the form, with the reason shown on them.
  const locks = new Map();

  // The reason stands where the default marker would, since the box follows neither while held.
  const applyLock = (id) => {
    const setting = boxes.get(id);
    if (!setting) return;
    const reason = locks.get(id);
    setting.box.disabled = Boolean(reason);
    if (reason) setting.box.checked = true;
    else setting.refresh();
    setting.lockNote ??= setting.row.appendChild(el('span', { class: 'setting-default' }));
    setting.lockNote.textContent = reason ?? '';
    setting.lockNote.hidden = !reason;
    if (setting.tag) setting.tag.hidden = Boolean(reason);
  };

  const paint = () => {
    // Redrawn when the categories or percentages arrive, keeping what is ticked so far.
    const kept = boxes.size ? Object.fromEntries([...boxes].map(([id, setting]) => [id, setting.read()])) : own;
    boxes.clear();
    grid.replaceChildren(
      el('legend', { class: 'sr-only', text: 'Delay for usage' }),
      ...categories.map((category) => {
        const threshold = thresholds?.[category.id] ?? category.threshold;
        const setting = followCheck(category.label, {
          own: kept?.[category.id] ?? null,
          inherited: Boolean(fallback[category.id]),
          follow,
          onChange: (value) => onChange(category.id, value),
        });
        setting.box.closest('label').append(' ', el('span', { class: 'muted', text: `(${threshold}%)` }));
        setting.box.closest('label').title = category.hint;
        boxes.set(category.id, setting);
        applyLock(category.id);
        return setting.row;
      }),
    );
  };

  paint();
  api('/api/config')
    .then((config) => {
      categories = config.usageDelayCategories ?? [];
      paint();
    })
    .catch((err) => {
      note.textContent = `Could not load the usage categories: ${err.message}`;
      note.className = 'hint warn';
    });

  return {
    setThresholds: (next) => {
      thresholds = next ?? null;
      paint();
    },
    follow: (next) => {
      fallback = { ...next };
      for (const [id, setting] of boxes) {
        setting.follow(Boolean(fallback[id]));
        applyLock(id);
      }
    },
    /** Holds one box ticked for `reason`, or lets it go again given null. */
    lock: (id, reason) => {
      if (reason) locks.set(id, reason);
      else locks.delete(id);
      applyLock(id);
    },
    read: () => Object.fromEntries([...boxes].map(([id, setting]) => [id, setting.read()])),
    /** The boxes set apart from the default, as [label, ticked] pairs. */
    own: () => categories.filter((category) => boxes.get(category.id)?.isOwn()).map((category) => [category.label, boxes.get(category.id).read()]),
    setting: (id) => boxes.get(id) ?? null,
    field: el('div', { class: 'field' }, [el('label', { text: 'Delay for usage' }), grid, brief ? null : note, brief ? null : thresholdsNote]),
  };
}

/**
 * The Worktree section both job forms share. `id` is the saved job's, so a new
 * or duplicated job, which has none yet, is described without one.
 *
 * A one-time execution runs once, so its worktree would only ever be left
 * behind: the clean up box is ticked and locked, and the server forces it too.
 */
function worktreePicker({ id = null, oneTime = false, own = {}, inherited = {}, follow = JOB_FOLLOW, onChange = () => {}, brief = false } = {}) {
  const useWorktree = followCheck('Use worktree', {
    own: own.useWorktree ?? null,
    inherited: Boolean(inherited.useWorktree),
    follow,
    onChange: (value) => onChange('useWorktree', value),
  });
  const cleanup = followCheck('Clean up worktree after execution', {
    own: oneTime ? true : (own.cleanupWorktree ?? null),
    inherited: Boolean(inherited.cleanupWorktree),
    follow: oneTime ? null : follow,
    onChange: (value) => onChange('cleanupWorktree', value),
  });
  if (oneTime) {
    cleanup.box.disabled = true;
    cleanup.box.closest('label').title = 'One-time executions always clean up';
  }
  const note = el('div', { class: 'hint warn', hidden: 'hidden' });

  const code = (text) => el('span', { class: 'mono', text });

  return {
    useWorktree,
    cleanup,
    /** Says why Use worktree is off, or clears that when given nothing. */
    explain: (text) => {
      note.textContent = text ?? '';
      note.hidden = !text;
    },
    read: () => ({ useWorktree: useWorktree.read(), cleanupWorktree: oneTime ? true : cleanup.read() }),
    follow: (next) => {
      useWorktree.follow(Boolean(next?.useWorktree));
      if (!oneTime) cleanup.follow(Boolean(next?.cleanupWorktree));
    },
    field: el('div', { class: 'field' }, [
      el('label', { text: 'Worktree' }),
      useWorktree.row,
      cleanup.row,
      note,
      brief
        ? null
        : el('div', { class: 'hint' }, [
            'With Use worktree on, each run starts Claude in a git worktree named after this job\'s ID',
            id ? [' (', code(id), ')'] : ', given when it is first saved',
            '. The name stays the same between executions, so without clean up every execution reuses one worktree. ',
            'Using a worktree adds a little spin-up time to each execution, and cleaning up adds tear-down time. ',
            'One-time executions always clean up.',
          ].flat()),
      el('div', { class: 'hint warn', text: 'Clean up force-removes the worktree after each execution. Uncommitted files in it are not kept.' }),
      brief
        ? null
        : el('div', { class: 'hint' }, [
            'The default ',
            code('.worktreeinclude'),
            ', which lists the files copied into new worktrees, is set on the ',
            // A new tab, so following it does not throw away what is typed in the form.
            el('a', { href: '#/settings', target: '_blank', rel: 'noopener', text: 'Settings page' }),
            '.',
          ]),
    ]),
  };
}

/** The Retrospective box both job forms share. */
function retrospectivePicker({ own = null, inherited = false, follow = JOB_FOLLOW, onChange = () => {}, brief = false } = {}) {
  const box = followCheck('Run a retrospective at the end of each execution', { own, inherited, follow, onChange });
  return {
    ...box,
    read: () => ({ retrospective: box.read() }),
    field: el('div', { class: 'field' }, [
      el('label', { text: 'Retrospective' }),
      box.row,
      brief
        ? null
        : el('div', { class: 'hint' }, [
            "Adds the retrospective prompt to the end of this job's prompt, so Claude reviews the run once the task is done. ",
            "A retrospective with something in it is written at the end of the run's log, marked in the run list, and sent as a notification. ",
            'One with nothing to report leaves no trace. The prompt is set on the ',
            el('a', { href: '#/settings', target: '_blank', rel: 'noopener', text: 'Settings page' }),
            '.',
          ]),
    ]),
  };
}

/**
 * The six job defaults as a block of their own: the Settings page's New job
 * defaults, and each node's own version of them. `own` is what is set here and
 * `inherited` what shows through where nothing is; `save` gets one change at a
 * time, shaped as the API takes it.
 */
function jobDefaultsParts({ own = {}, inherited = {}, follow = null, save }) {
  const worktree = worktreePicker({
    own,
    inherited,
    follow,
    brief: true,
    onChange: (key, value) => save({ [key]: value }),
  });
  const model = modelPicker({ own: own.model ?? null, inherited: inherited.model ?? '', follow, onChange: (value) => save({ model: value }) });
  const effort = effortPicker({ own: own.effort ?? null, inherited: inherited.effort ?? '', follow, onChange: (value) => save({ effort: value }) });
  const usageDelay = usageDelayPicker({
    own: own.usageDelay ?? {},
    inherited: inherited.usageDelay ?? {},
    follow,
    brief: true,
    onChange: (id, value) => save({ usageDelay: { [id]: value } }),
  });
  const retrospective = retrospectivePicker({
    own: own.retrospective ?? null,
    inherited: Boolean(inherited.retrospective),
    follow,
    brief: true,
    onChange: (value) => save({ retrospective: value }),
  });
  return { usageDelay, parts: [worktree.field, model.field, effort.field, usageDelay.field, retrospective.field] };
}

/**
 * Wraps the date field in the same live feedback the Cron field gets: presets
 * for the times you actually pick, and a line saying how far off it is.
 *
 * The field is a plain datetime-local, so what you type is your own clock. The
 * server stores it as UTC, which is why the note under it reads the time back.
 */
function scheduledAtPicker(input) {
  const preview = el('div', { class: 'hint' });

  const update = () => {
    const raw = input.value.trim();
    if (!raw) {
      preview.textContent = '';
      preview.className = 'hint';
      return;
    }
    const at = new Date(raw);
    if (Number.isNaN(at.getTime())) {
      preview.textContent = 'That is not a date this browser understands.';
      preview.className = 'hint warn';
      return;
    }
    if (at.getTime() <= Date.now()) {
      // Allowed on purpose: the same rule that runs a trigger missed over a
      // restart runs this one the moment it is saved.
      preview.textContent = `That time has passed — saving this runs it now (${fmtDateTimeWeekday(at.toISOString())}).`;
      preview.className = 'hint warn';
      return;
    }
    // Word for word what the cron form says, so the two green lines read alike.
    preview.textContent = `Next run: ${fmtRelative(at.toISOString())} · ${fmtDateTimeWeekday(at.toISOString())}`;
    preview.className = 'hint ok';
  };

  input.addEventListener('input', update);
  input.addEventListener('change', update);

  /** Local time in the shape datetime-local wants, which is not toISOString. */
  const asFieldValue = (date) => {
    const pad = (value) => String(value).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };

  const inMinutes = (label, minutes, title) =>
    el('button', {
      type: 'button',
      class: 'btn small',
      text: label,
      title,
      onclick: () => {
        input.value = asFieldValue(new Date(Date.now() + minutes * 60000));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      },
    });

  /**
   * The calendar, for a date the presets do not reach. It opens on whatever
   * Runs at already says rather than on today, so opening the picker and
   * closing it again cannot quietly move a date that was already set.
   */
  const chooser = el('input', { type: 'datetime-local', class: 'time-entry', value: input.value });
  chooser.addEventListener('change', () => {
    if (!chooser.value) return;
    input.value = chooser.value;
    update();
  });
  // Typing in the field, or a preset button, moves the calendar with it.
  const syncChooser = () => {
    chooser.value = input.value;
  };
  input.addEventListener('input', syncChooser);
  input.addEventListener('change', syncChooser);

  update();

  return el('div', { class: 'field' }, [
    el('label', { for: input.id || null, text: 'Runs at' }),
    input,
    el('div', { class: 'preset-row' }, [
      // The buttons are all relative to now, and the row reads as a sentence
      // once it says so: Now +30m, +1hr, +3hr.
      inMinutes('Now', 0, 'Run as soon as it is saved'),
      inMinutes('+30m', 30, 'Thirty minutes from now'),
      inMinutes('+1hr', 60, 'One hour from now'),
      inMinutes('+3hr', 180, 'Three hours from now'),
      el('span', { class: 'preset-sep' }),
      el('span', { class: 'preset-label', text: 'Select datetime' }),
      chooser,
    ]),
    el('div', { class: 'hint', text: 'Your local time. It runs once, then stays in the list as history.' }),
    preview,
  ]);
}

/**
 * The six settings a job can leave to its node's defaults, each showing what it
 * will use. What the job has not set follows the node it runs on, so picking
 * another node moves them with it; `followNode` takes that node's listing.
 * `onChange` hears any change, so the More options line can keep up.
 */
function jobSettingPickers(job, clusterDefaults, { id = null, oneTime = false, onChange = () => {} } = {}) {
  const own = job ?? {};
  const inherited = clusterDefaults;
  const worktree = worktreePicker({ id, oneTime, own, inherited, onChange });
  const model = modelPicker({ own: own.model ?? null, inherited: inherited.model ?? '', onChange, onPaint: onChange });
  const effort = effortPicker({ own: own.effort ?? null, inherited: inherited.effort ?? '', onChange });
  const usageDelay = usageDelayPicker({ own: own.usageDelay ?? {}, inherited: inherited.usageDelay ?? {}, onChange });
  const retrospective = retrospectivePicker({ own: own.retrospective ?? null, inherited: Boolean(inherited.retrospective), onChange });
  const onOff = (value) => (value ? 'on' : 'off');
  return {
    worktree,
    model,
    effort,
    usageDelay,
    retrospective,
    followNode: (listing) => {
      const next = listing?.config?.jobDefaults ?? clusterDefaults;
      worktree.follow(next);
      model.follow(next.model ?? '');
      effort.follow(next.effort ?? '');
      usageDelay.follow(next.usageDelay ?? {});
      retrospective.follow(Boolean(next.retrospective));
      usageDelay.setThresholds(listing?.config?.usageDelayThresholds);
      onChange();
    },
    /** What this job sets for itself, in a few words each: "Worktree off", "Sonnet", "waits for Weekly". */
    overrides: () =>
      [
        worktree.useWorktree.isOwn() ? `Worktree ${onOff(worktree.useWorktree.read())}` : null,
        !oneTime && worktree.cleanup.isOwn() ? (worktree.cleanup.read() ? 'Cleans up worktree' : 'Keeps worktree') : null,
        model.isOwn() ? model.describe() : null,
        effort.isOwn() ? effort.describe() : null,
        ...usageDelay.own().map(([label, ticked]) => (ticked ? `waits for ${label}` : `no ${label} wait`)),
        retrospective.isOwn() ? `Retrospective ${onOff(retrospective.read().retrospective)}` : null,
      ].filter(Boolean),
    read: () => ({
      ...worktree.read(),
      model: model.read(),
      effort: effort.read(),
      usageDelay: usageDelay.read(),
      ...retrospective.read(),
    }),
  };
}

/**
 * A new job's Working Directory starts at its node's default, and follows a
 * change of node until someone types in it. An edited or duplicated job keeps its own.
 */
function followNodeDirectory(input, listing, keep) {
  if (keep) return;
  const next = listing?.config?.defaultWorkingDirectory ?? '~/';
  const previous = input.dataset.nodeDefault ?? '~/';
  if (input.value === previous) input.value = next;
  input.dataset.nodeDefault = next;
}

/**
 * Which node runs the job. Blank follows the default node, so changing the default moves it.
 * `onChange` gets the listing of the node that would run it, once the nodes load and on every pick.
 */
/** Hidden until a project exists, so a server that uses none never sees it. */
function projectPicker(selected) {
  const select = el('select', { class: 'select' });
  const field = el('div', { class: 'field', hidden: 'hidden' }, [
    el('label', { text: 'Project' }),
    select,
    el('div', { class: 'hint' }, ['Groups this job with others on the home page. Projects are added on the ', el('a', { href: '#/settings', target: '_blank', rel: 'noopener', text: 'Settings page' }), '.']),
  ]);
  const current = selected ?? '';
  api('/api/projects')
    .then((projects) => {
      if (!projects.length) return;
      select.replaceChildren(
        el('option', { value: '' }, 'No project'),
        ...projects.map((project) => el('option', { value: project.id, selected: project.id === current }, project.name)),
      );
      select.value = projects.some((project) => project.id === current) ? current : '';
      field.hidden = false;
    })
    .catch(() => {});
  return { read: () => select.value, field };
}

function nodePicker(selected, { onChange = () => {} } = {}) {
  const select = el('select', { class: 'select mono' });
  const note = el('div', { class: 'hint', text: 'The machine that runs this job. The default node is set on the Settings page.' });
  const current = selected ?? '';
  let byId = new Map();
  let fallbackId = '';
  const chosen = () => byId.get(select.value || fallbackId) ?? null;
  select.addEventListener('change', () => onChange(chosen()));

  const paint = ({ nodes = [], defaultNodeId = '' }) => {
    byId = new Map(nodes.map((node) => [node.id, node]));
    fallbackId = defaultNodeId;
    const label = (node) => `${node.name}${node.online ? '' : ' (offline)'}`;
    const fallback = byId.get(defaultNodeId);
    const options = [
      { value: '', label: fallback ? `Default node (${label(fallback)})` : 'Default node' },
      ...nodes.map((node) => ({ value: node.id, label: label(node) })),
    ];
    if (current && !byId.has(current)) options.push({ value: current, label: `${current} (not connected)` });
    select.replaceChildren(
      ...options.map((option) => el('option', { value: option.value, selected: option.value === current }, option.label)),
    );
    select.value = current;
  };

  paint({});
  api('/api/nodes')
    .then((state) => {
      paint(state);
      onChange(chosen());
    })
    .catch((err) => {
      note.textContent = `Could not load the nodes: ${err.message}`;
      note.className = 'hint warn';
    });

  return {
    read: () => select.value,
    field: el('div', { class: 'field' }, [el('label', { text: 'Node' }), select, note]),
  };
}

/**
 * The rule a blank Name is filled by, from the hub's own build of it. Loaded
 * once; a page that cannot load it just shows a plainer placeholder.
 */
const NAMING = import('/shared/naming.js').catch(() => null);

/**
 * Both job forms. They differ in when the job runs, and in Is Active, which
 * only a cron has: a new one-time execution is saved active, and an edit keeps
 * what it had. Everything else reads
 * the same, in the order a person fills it: the prompt, which has the focus;
 * when; where; an optional name; and the rest folded under More options, with
 * a line saying what in there differs from the defaults.
 *
 * One form serves three jobs. Duplicating loads the source exactly as editing
 * does, so every field arrives filled in; only the name carries a suffix, and
 * Save creates a new job instead of writing back to the source.
 */
async function renderJobForm(kind, id, duplicateOf) {
  const oneTime = kind === 'execution';
  const words = oneTime
    ? { noun: 'one-time execution', api: '/api/executions', home: '#/one-time', back: '← All one-time executions', duplicate: '#/one-time/new/', created: 'One-time execution created' }
    : { noun: 'cron', api: '/api/crons', home: '#/', back: '← All crons', duplicate: '#/new/', created: 'Cron created' };
  const sourceId = id ?? duplicateOf;
  const [job, defaults, naming] = await Promise.all([
    sourceId ? api(`${words.api}/${sourceId}`) : null,
    jobFormSettings(),
    NAMING,
  ]);
  const errorBox = el('div', { class: 'error', role: 'alert', tabindex: '-1', hidden: 'hidden' });

  const inputs = {
    prompt: el('textarea', { class: 'prompt-input', id: uid('prompt'), placeholder: 'What claude should do. Passed to claude -p.' }),
    name: el('input', {
      type: 'text',
      id: uid('name'),
      value: duplicateOf ? `${job.name} - Duplicate` : (job?.name ?? ''),
      maxlength: '120',
      autocomplete: 'off',
    }),
    description: el('input', { type: 'text', id: uid('description'), value: job?.description ?? '', placeholder: 'What this run is for' }),
    cron: el('input', { type: 'text', class: 'mono', value: job?.cron ?? '', placeholder: '0 9 * * *' }),
    workingDirectory: el('input', {
      type: 'text',
      class: 'mono',
      // New jobs start at the node's default; editing or duplicating shows the source's.
      value: job ? (job.workingDirectory ?? '') : '~/',
      placeholder: '~/code/project',
      autocomplete: 'off',
      spellcheck: 'false',
    }),
    isActive: el('input', { type: 'checkbox', id: uid('active') }),
  };
  inputs.prompt.value = job ? (job.prompt ?? '') : defaults.prompt;
  inputs.isActive.checked = job ? Boolean(job.isActive) : true;

  // ---- name: blank takes the name the save will give it ----
  const paintNamePlaceholder = () => {
    const prompt = inputs.prompt.value;
    inputs.name.placeholder = prompt.trim() && naming ? naming.nameFromPrompt(prompt) : 'Named from the prompt when left blank';
  };
  inputs.prompt.addEventListener('input', paintNamePlaceholder);
  paintNamePlaceholder();

  // ---- more options ----
  const summary = el('span', { class: 'more-summary' });
  // Assigned just below; the pickers report changes while they are still being built.
  let settings = null;
  const paintSummary = () => {
    const overrides = settings?.overrides() ?? [];
    summary.textContent = overrides.length ? overrides.join(' · ') : 'Cluster defaults';
  };
  settings = jobSettingPickers(job, defaults.jobDefaults, { id, oneTime, onChange: () => paintSummary() });
  const project = projectPicker(job?.projectId);

  // ---- where: the node, and a folder on it; a worktree needs a git repository ----
  const gitNote = el('div', { class: 'hint warn', hidden: 'hidden', text: 'Not in a git repository, so no worktree' });
  // Set when the form turned Use worktree off itself, so a folder in a repository can turn it back.
  let worktreeTurnedOff = false;
  settings.worktree.useWorktree.box.addEventListener('change', () => {
    worktreeTurnedOff = false;
  });
  const directory = directoryPicker(inputs.workingDirectory, {
    node: () => node.read(),
    onResult: (result) => {
      if (!result.exists || result.inGitRepository === undefined) return;
      const useWorktree = settings.worktree.useWorktree;
      if (!result.inGitRepository) {
        if (useWorktree.effective()) {
          useWorktree.set(false);
          worktreeTurnedOff = true;
        }
      } else if (worktreeTurnedOff) {
        useWorktree.set(null);
        worktreeTurnedOff = false;
      }
      gitNote.hidden = result.inGitRepository;
      settings.worktree.explain(result.inGitRepository ? null : 'Not in a git repository, so no worktree');
      paintSummary();
    },
  });
  const node = nodePicker(job?.nodeId ?? '', {
    onChange: (listing) => {
      followNodeDirectory(inputs.workingDirectory, listing, Boolean(job));
      settings.followNode(listing);
      directory.lookup();
      schedule?.refresh();
    },
  });

  // ---- when ----
  let schedule = null;
  let whenField;
  let asSoonAsPossible = () => false;
  let scheduledAt = () => '';
  if (oneTime) {
    const choice = (value, text) => {
      const radio = el('input', { type: 'radio', name: 'when', value });
      return { radio, label: el('label', { class: 'check' }, [radio, text]) };
    };
    const asap = choice('asap', 'As soon as possible');
    const atTime = choice('time', 'At a time');
    const asapHint = el('div', { class: 'hint when-hint', text: 'Runs now, or as soon as the session limit has room.' });
    inputs.scheduledAt = el('input', {
      type: 'datetime-local',
      class: 'mono',
      id: uid('runs-at'),
      // A duplicate of something already run gets a fresh default rather than
      // the source's date, which is in the past and would fire on save.
      value: scheduledFieldValue(duplicateOf ? null : job?.scheduledAt),
    });
    // What the field said on opening, so a save can tell whether it was changed.
    const shownAtOpen = inputs.scheduledAt.value;
    const timeField = scheduledAtPicker(inputs.scheduledAt);
    timeField.classList.add('when-time');
    // A new one, or a duplicate, goes as soon as it can; an edit keeps the time it has.
    (id ? atTime : asap).radio.checked = true;
    const paintWhen = () => {
      timeField.hidden = !atTime.radio.checked;
      asapHint.hidden = !asap.radio.checked;
      settings.usageDelay.lock('session', asap.radio.checked ? 'on for As soon as possible' : null);
      paintSummary();
    };
    // The time field comes next in the tab order, so choosing At a time leaves the focus where it is.
    asap.radio.addEventListener('change', paintWhen);
    atTime.radio.addEventListener('change', paintWhen);
    paintWhen();
    asSoonAsPossible = () => asap.radio.checked;
    scheduledAt = () => scheduledAtForSave(duplicateOf ? null : job?.scheduledAt, shownAtOpen, inputs.scheduledAt.value);
    whenField = el('fieldset', { class: 'field when' }, [el('legend', { text: 'When' }), asap.label, asapHint, atTime.label, timeField]);
  } else {
    // Left as saved, an expression keeps the zone it was written in; any change to it is written in this browser's.
    const cronZone = () => (job?.timezone && inputs.cron.value.trim() === job.cron.trim() ? job.timezone : BROWSER_TIMEZONE);
    schedule = cronPicker(inputs.cron, { zone: cronZone, node: () => node.read(), label: 'When' });
    schedule.zone = cronZone;
    whenField = schedule.field;
  }

  const showError = (message) => {
    errorBox.textContent = message;
    errorBox.hidden = false;
    errorBox.scrollIntoView({ behavior: 'smooth', block: 'center' });
    errorBox.focus({ preventScroll: true });
  };

  const save = async (event) => {
    event.preventDefault();
    errorBox.hidden = true;
    const payload = {
      prompt: inputs.prompt.value,
      name: inputs.name.value,
      description: inputs.description.value,
      projectId: project.read(),
      nodeId: node.read(),
      workingDirectory: inputs.workingDirectory.value,
      ...settings.read(),
    };
    if (oneTime) {
      const typed = inputs.scheduledAt.value.trim();
      if (!asSoonAsPossible() && typed && Number.isNaN(new Date(typed).getTime())) return showError('Date and time is not a valid date.');
      Object.assign(payload, {
        // As soon as possible is dated by the hub's clock; a time is sent as a
        // full instant rather than the field's bare local string, so the
        // server is not left guessing which clock it was typed on.
        ...(asSoonAsPossible() ? { asSoonAsPossible: true } : { scheduledAt: scheduledAt() }),
        isActive: isActiveForSave(id ? job : null),
      });
    } else {
      Object.assign(payload, { cron: inputs.cron.value, timezone: schedule.zone(), isActive: inputs.isActive.checked });
    }
    try {
      if (id) await api(`${words.api}/${id}`, { method: 'PUT', body: JSON.stringify(payload) });
      else await api(words.api, { method: 'POST', body: JSON.stringify(payload) });
      toast(id ? 'Saved' : words.created);
      location.hash = words.home;
    } catch (err) {
      showError(err.message);
    }
  };

  const remove = async () => {
    if (!confirm(`Delete "${job.name}"? Its log history is kept on disk.`)) return;
    try {
      await api(`${words.api}/${id}`, { method: 'DELETE' });
      toast(`${oneTime ? 'One-time execution' : 'Cron'} deleted`);
      location.hash = words.home;
    } catch (err) {
      showError(err.message);
    }
  };

  const field = (label, input, hint) =>
    el('div', { class: 'field' }, [el('label', { for: input.id, text: label }), input, hint ? el('div', { class: 'hint', text: hint }) : null]);

  const more = el('details', { class: 'more-options' }, [
    el('summary', {}, [el('span', { class: 'more-title', text: 'More options' }), summary]),
    el('div', { class: 'more-body' }, [
      settings.worktree.field,
      settings.model.field,
      settings.effort.field,
      settings.usageDelay.field,
      project.field,
      settings.retrospective.field,
      field('Description', inputs.description),
      oneTime
        ? null
        : el('div', { class: 'field' }, [
            el('label', { class: 'check' }, [inputs.isActive, 'Is Active']),
            el('div', { class: 'hint', text: 'Off keeps the cron but stops it firing.' }),
          ]),
    ]),
  ]);
  // An edit or a duplicate opens it when anything in it is not what a new job would have.
  // A one-time execution always cleans up, so its stored clean up is not one of those.
  const setsOwn = (key) => !(oneTime && key === 'cleanupWorktree') && job[key] !== null && job[key] !== undefined;
  more.open = Boolean(
    job &&
      (JOB_SETTINGS.some(setsOwn) ||
        Object.values(job.usageDelay ?? {}).some((value) => value !== null) ||
        job.projectId ||
        job.description ||
        (!oneTime && !job.isActive)),
  );
  paintSummary();

  view.replaceChildren(
    el('div', { class: 'breadcrumb' }, [el('a', { href: words.home, text: words.back })]),
    el('div', { class: 'page-head' }, [
      el('div', {}, [
        el('h1', { text: id ? `Edit ${words.noun}` : duplicateOf ? `Duplicate ${words.noun}` : `New ${words.noun}` }),
        el('p', {
          class: 'sub',
          text: oneTime ? 'Runs claude -p with the prompt below, once.' : 'Runs claude -p with the prompt below on the schedule you set.',
        }),
      ]),
    ]),
    el('form', { class: 'card job-form', onsubmit: save }, [
      errorBox,
      el('div', { class: 'field' }, [el('label', { for: inputs.prompt.id, text: 'Prompt' }), inputs.prompt, commandButtons(defaults.commands)]),
      whenField,
      el('div', { class: 'where-row', role: 'group', 'aria-label': 'Where' }, [node.field, directory.field]),
      gitNote,
      field('Name (optional)', inputs.name, 'Left blank, it is named from the prompt, then given a short title by Claude.'),
      more,
      el('div', { class: 'form-actions' }, [
        el('button', { class: 'btn primary', type: 'submit', text: 'Save' }),
        el('a', { class: 'btn', href: words.home, text: 'Cancel' }),
        id ? el('a', { class: 'btn', href: `${words.duplicate}${id}`, text: 'Duplicate' }) : null,
        el('div', { class: 'spacer' }),
        id ? el('button', { class: 'btn danger', type: 'button', text: 'Delete', onclick: remove }) : null,
      ]),
    ]),
  );
  inputs.prompt.focus();
}

/** The settings a job stores null for while it follows the defaults, apart from the Delay for usage boxes. */
const JOB_SETTINGS = ['useWorktree', 'cleanupWorktree', 'model', 'effort', 'retrospective'];

/**
 * An ISO time in the shape the datetime-local field wants: local, no zone.
 *
 * With nothing to read — a new execution, or a duplicate of one already run —
 * it offers tomorrow at 8am, for someone who picks At a time: most timed
 * one-time runs are "do this overnight", and a morning is one nobody has to clear first.
 */
function scheduledFieldValue(iso) {
  let date;
  if (iso) date = new Date(iso);
  else {
    date = new Date();
    date.setDate(date.getDate() + 1);
    date.setHours(8, 0, 0, 0);
  }
  if (Number.isNaN(date.getTime())) return '';
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function renderForm(id, duplicateOf) {
  return renderJobForm('cron', id, duplicateOf);
}

function renderExecutionForm(id, duplicateOf) {
  return renderJobForm('execution', id, duplicateOf);
}

// ---- settings ---------------------------------------------------------

/**
 * There is nothing to count down to when Update now is pressed: the server first
 * holds the schedules and waits for any run to finish, and only then restarts.
 * So report the wait, and start the 5 second countdown once this page notices the
 * server is on a new commit — the same signal behind the "live - refresh window"
 * badge in the header.
 */
function watchUpdate(status, updateButton, updateLog) {
  clearTimeout(reloadTimer);
  clearTimeout(updateWatchTimer);

  const countdown = (secondsLeft) => {
    if (secondsLeft <= 0) {
      location.reload();
      return;
    }
    status.textContent = `Update applied. Reloading in ${secondsLeft}s…`;
    status.className = 'hint ok';
    reloadTimer = setTimeout(() => countdown(secondsLeft - 1), 1000);
  };

  const poll = async () => {
    await checkHealth();
    if (staleBuild) {
      countdown(5);
      return;
    }
    try {
      const pause = await api('/api/pause');
      if (!pause.paused) {
        // The pause was lifted without a restart: the script refused, or it gave
        // up waiting. Either way the update log has the reason.
        status.textContent = `Update did not proceed; schedules have resumed. See ${updateLog}`;
        status.className = 'hint warn';
        updateButton.textContent = 'Update now';
        updateButton.disabled = false;
        return;
      }
      const waiting = pause.runningCount;
      status.textContent = waiting
        ? `Waiting for ${waiting} cron${waiting === 1 ? '' : 's'} to finish executing before restarting…`
        : 'All crons idle. Waiting for the server to restart…';
      status.className = 'hint';
    } catch {
      // The restart drops connections; that is expected here.
      status.textContent = 'Restarting…';
      status.className = 'hint';
    }
    updateWatchTimer = setTimeout(poll, 2000);
  };

  poll();
}

function databaseLabel(database) {
  if (!database) return 'the database';
  return database.dialect === 'postgres' ? `Postgres at ${database.location}` : `SQLite at ${database.location}`;
}

function readOnlyField(label, value) {
  return el('div', { class: 'field' }, [el('label', { text: label }), el('div', { class: 'path-value mono', text: value })]);
}

function statTile(value, label, sub) {
  return el('div', { class: 'stat' }, [
    value.nodeType ? value : el('div', { class: 'stat-value', text: value }),
    el('div', { class: 'stat-label', text: label }),
    el('div', { class: 'stat-sub', text: sub }),
  ]);
}

/** Settings save as you change them; there is no Save button to forget. */
async function saveSettings(patch, description) {
  try {
    await api('/api/settings', { method: 'PUT', body: JSON.stringify(patch) });
    toast(description);
    return true;
  } catch (err) {
    toast(err.message, true);
    return false;
  }
}

/** One node's commit against the hub's, and what to do when they differ. */
function versionText(node, hubCommit) {
  if (!node.commit) return 'unknown';
  if (!hubCommit || node.commit === hubCommit) return `${node.commit}${hubCommit ? ', same as the hub' : ''}`;
  return `${node.commit}; the hub runs ${hubCommit}. Pull main in this node's checkout and restart it to match.`;
}

/**
 * The settings each node keeps for itself: its job limit and queue, usage
 * delays and default working directory. Returned in pieces, because
 * a single local node shows them on the Settings page and any other setup shows
 * them on the node's own page.
 */
function nodeSettingsParts(node, config, clusterJobDefaults = {}) {
  const url = `/api/nodes/${encodeURIComponent(node.id)}/settings`;
  const save = async (patch, description) => {
    try {
      Object.assign(node, await api(url, { method: 'PUT', body: JSON.stringify(patch) }));
      toast(description);
      return true;
    } catch (err) {
      toast(err.message, true);
      return false;
    }
  };

  // ---- concurrent job limit ----
  const processors = node.processors ?? 1;
  // Tracked so a rejected entry restores the value in force rather than the one the page loaded with.
  let jobLimit = node.config.maxConcurrentJobs;
  const limitInput = el('input', { type: 'text', class: 'mono narrow', value: String(jobLimit) });
  const limitReset = el('button', { class: 'btn small', text: `Use ${processors} (processors)` });
  const queueBody = el('div', { class: 'queue-body' });

  const applyLimit = async (value, patch = { maxConcurrentJobs: value }) => {
    if (!Number.isInteger(value) || value < 0) {
      toast('Concurrent jobs must be 0 or a whole number', true);
      limitInput.value = String(jobLimit);
      return;
    }
    jobLimit = value;
    limitInput.value = String(value);
    await save(patch, value === 0 ? 'Running jobs with no limit' : `Running at most ${value} job${value === 1 ? '' : 's'} at once`);
    paintQueue();
  };
  limitInput.addEventListener('change', () => applyLimit(Number(limitInput.value)));
  limitReset.addEventListener('click', () => applyLimit(processors, { maxConcurrentJobs: null }));

  /**
   * The live queue: what is running under the limit and what is behind it.
   *
   * Redrawn on its own rather than with the page, so a run starting while the
   * limit field has focus does not take the half-typed number away.
   */
  const paintQueue = async () => {
    let state;
    try {
      state = await api(`/api/queue?node=${encodeURIComponent(node.id)}`);
    } catch (err) {
      queueBody.replaceChildren(el('div', { class: 'hint warn', text: err.message }));
      return;
    }

    const nextSlot = state.nextSlotAt
      ? el('div', { class: 'stat-value', text: fmtCountdown(state.nextSlotAt), 'data-countdown-to': state.nextSlotAt })
      : el('div', { class: 'stat-value', text: '—' });

    const parts = [
      el('div', { class: 'stat-strip' }, [
        statTile(state.limit === 0 ? '∞' : String(state.limit), 'job limit', state.limit === 0 ? 'no limit' : `${processors} processors`),
        statTile(String(state.runningCount), state.runningCount === 1 ? 'job running' : 'jobs running', 'right now'),
        statTile(String(state.queuedCount), 'queued', state.queuedCount ? 'oldest goes first' : 'nothing waiting'),
        statTile(nextSlot, 'next slot', state.nextSlotAt ? 'estimated' : 'no estimate yet'),
      ]),
    ];

    if (state.running.length) {
      parts.push(el('h3', { text: 'Running now' }));
      parts.push(
        el(
          'div',
          { class: 'queue-list' },
          state.running.map((run) =>
            el('div', { class: 'queue-row' }, [
              el('span', { class: 'queue-pos running', text: '▸' }),
              el('div', {}, [
                el('a', { class: 'cron-name link', href: `${hashBase(run)}/logs/${run.cronId}`, text: run.cronName }),
                el('div', {
                  class: 'cron-desc',
                  text: Number.isFinite(run.averageRuntimeSeconds)
                    ? `averages ${fmtDuration(run.averageRuntimeSeconds * 1000)} a run`
                    : 'no finished runs to average yet',
                }),
              ]),
              el('div', { class: 'queue-when mono', 'data-runtime-start': run.startedAt, text: fmtElapsed(run.startedAt) }),
            ]),
          ),
        ),
      );
    }

    if (state.queued.length) {
      parts.push(el('h3', { text: 'Waiting for a slot' }));
      parts.push(
        el(
          'div',
          { class: 'queue-list' },
          state.queued.map((entry) =>
            el('div', { class: 'queue-row', title: delayTitle(entry) }, [
              el('span', { class: 'queue-pos', text: String(entry.position + 1) }),
              el('div', {}, [
                el('a', { class: 'cron-name link', href: `${hashBase(entry)}/logs/${entry.cronId}`, text: entry.cronName }),
                el('div', { class: 'cron-desc' }, [
                  `${entry.kind === 'execution' ? 'one-time' : 'cron'} · ${entry.source} trigger · waiting `,
                  el('span', { 'data-runtime-start': entry.arrivedAt, text: fmtElapsed(entry.arrivedAt) }),
                ]),
              ]),
              entry.resumeAt
                ? el('div', { class: 'queue-when mono', 'data-countdown-to': entry.resumeAt, text: fmtCountdown(entry.resumeAt) })
                : el('div', { class: 'queue-when muted', text: 'no estimate' }),
            ]),
          ),
        ),
      );
    }

    if (!state.running.length && !state.queued.length) {
      parts.push(el('div', { class: 'hint', text: node.online ? 'Nothing is running and nothing is queued.' : 'This node is offline, so nothing runs.' }));
    }

    queueBody.replaceChildren(...parts);
  };

  // ---- usage delay thresholds ----
  const usageCategories = config.usageDelayCategories ?? [];
  const thresholds = { ...node.config.usageDelayThresholds };
  const thresholdInputs = new Map();

  const applyThreshold = async (category, value) => {
    const input = thresholdInputs.get(category.id);
    if (!Number.isInteger(value) || value < 1 || value > 100) {
      toast(`${category.label} must be a whole number from 1 to 100`, true);
      input.value = String(thresholds[category.id]);
      return;
    }
    thresholds[category.id] = value;
    input.value = String(value);
    await save({ usageDelayThresholds: { [category.id]: value } }, `${category.label} delays at ${value}%`);
  };

  const thresholdRow = el(
    'div',
    { class: 'preset-row' },
    usageCategories.flatMap((category, index) => {
      const input = el('input', {
        type: 'text',
        class: 'mono narrow',
        value: String(thresholds[category.id] ?? category.defaultThreshold),
        'aria-label': `${category.label} threshold`,
      });
      input.addEventListener('change', () => applyThreshold(category, Number(input.value)));
      thresholdInputs.set(category.id, input);
      return [
        index ? el('span', { class: 'preset-sep' }) : null,
        el('span', { class: 'preset-label', text: category.label }),
        input,
        el('span', { class: 'preset-label', text: '%' }),
      ];
    }),
  );

  const thresholdDefaults = usageCategories.map((category) => `${category.label} ${category.defaultThreshold}%`).join(', ');
  const thresholdReset = el('button', { class: 'btn small', text: 'Use defaults' });
  thresholdReset.addEventListener('click', async () => {
    const defaults = Object.fromEntries(usageCategories.map((category) => [category.id, category.defaultThreshold]));
    Object.assign(thresholds, defaults);
    for (const [id, input] of thresholdInputs) input.value = String(defaults[id]);
    await save({ usageDelayThresholds: null }, 'Usage delays back to their defaults');
  });

  // ---- default working directory ----
  let startDirectory = node.config.defaultWorkingDirectory || '~/';
  const startDirectoryInput = el('input', {
    type: 'text',
    class: 'mono',
    value: startDirectory,
    placeholder: '~/',
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-label': 'Default working directory',
  });
  // Blur rather than change: taking a suggestion sets the value from script,
  // which a change event can miss. Clicking a suggestion keeps the focus.
  startDirectoryInput.addEventListener('blur', () => {
    const value = startDirectoryInput.value.trim() || '~/';
    startDirectoryInput.value = value;
    if (value === startDirectory) return;
    startDirectory = value;
    save({ defaultWorkingDirectory: value }, `New jobs on ${node.name} start in ${value}`);
  });

  // ---- job defaults ----
  // Built only for the node's own page: each follows the cluster's until set
  // here, and the node's listing carries what it sets itself.
  const jobDefaults = () => {
    const defaults = jobDefaultsParts({
      own: node.jobDefaultOverrides ?? {},
      inherited: clusterJobDefaults,
      follow: NODE_FOLLOW,
      save: (patch) => save({ jobDefaults: patch }, `New job defaults on ${node.name} saved`),
    });
    defaults.usageDelay.setThresholds(node.config.usageDelayThresholds);
    return [
      el('h3', { text: 'New job defaults' }),
      el('div', { class: 'hint' }, [
        'What a job on this node uses for each of these when its form leaves it alone. ',
        'Each follows the New job defaults on the ',
        el('a', { href: '#/settings', text: 'Settings page' }),
        ' until it is changed here; Use the cluster default puts it back.',
      ]),
      ...defaults.parts,
    ];
  };

  return {
    paintQueue,
    jobDefaults,
    limit: [
      el('h3', { text: 'Limit concurrent jobs' }),
      el('div', { class: 'preset-row' }, [
        el('span', { class: 'preset-label', text: 'Run at most' }),
        limitInput,
        el('span', { class: 'preset-label', text: 'jobs at once' }),
        el('span', { class: 'preset-sep' }),
        limitReset,
      ]),
      el('div', { class: 'hint' }, [
        'A trigger that arrives with every slot taken is held as ',
        el('span', { class: 'mono', text: 'delayed' }),
        ' and started when a run finishes. The queue is first in, first out, so runs keep the order their triggers fired. ',
        `Set 0 for no limit. The default is this node's processor count (${processors}).`,
      ]),
      el('div', { class: 'hint warn' }, [
        'Lowering this never stops a run already going — it only holds the next ones. ',
        'The queue lives in memory: a restart clears it, and the next trigger of each cron starts it afresh.',
      ]),
    ],
    queue: [
      queueBody,
      el('div', { class: 'hint' }, [
        'Next slot is the soonest a running job is due to finish: its own average run length, less how long it has been going. ',
        'A job with no finished runs behind it has no average and is left out, so a slot can come free sooner than this says.',
      ]),
    ],
    usage: [
      el('h3', { text: 'Delay for usage' }),
      thresholdRow,
      el('div', { class: 'preset-row' }, [thresholdReset]),
      el('div', { class: 'hint' }, [
        'A cron or one-time execution on this node with a limit ticked under Delay for usage waits while that limit is at or above its percentage here. ',
        "Usage is read from the Claude account this node is signed in to, and a change reaches the next trigger. ",
        `The defaults are ${thresholdDefaults}.`,
      ]),
    ],
    directory: [
      el('h3', { text: 'Default working directory' }),
      directoryPicker(startDirectoryInput, { label: null, node: () => node.id }).field,
      el('div', { class: 'hint' }, [
        'Where the Working Directory field of a new cron or one-time execution on this node starts. ',
        'Editing or duplicating a job keeps the directory it already has, and changing this moves no saved job. ',
        'The default is ',
        el('span', { class: 'mono', text: '~/' }),
        '.',
      ]),
    ],
  };
}

/** The project list on the Settings page: rename, describe, delete, and add. */
function projectsList() {
  const body = el('div', { class: 'project-list' });
  const row = (project) => {
    const name = el('input', { type: 'text', value: project?.name ?? '', placeholder: 'Project name', maxlength: '120' });
    const description = el('input', { type: 'text', value: project?.description ?? '', placeholder: 'Description (optional)' });
    const send = async (button, request, done) => {
      button.disabled = true;
      try {
        await request();
        toast(done);
        await paint();
      } catch (err) {
        toast(err.message, true);
        button.disabled = false;
      }
    };
    const payload = () => JSON.stringify({ name: name.value, description: description.value });
    const actions = project
      ? [
          el('button', {
            class: 'btn small',
            type: 'button',
            text: 'Save',
            onclick: (event) => send(event.target, () => api(`/api/projects/${project.id}`, { method: 'PUT', body: payload() }), 'Project saved'),
          }),
          el('button', {
            class: 'btn small danger',
            type: 'button',
            text: 'Delete',
            onclick: (event) => {
              if (!confirm(`Delete "${project.name}"? Its jobs keep running, with no project.`)) return;
              send(event.target, () => api(`/api/projects/${project.id}`, { method: 'DELETE' }), 'Project deleted');
            },
          }),
        ]
      : [
          el('button', {
            class: 'btn small primary',
            type: 'button',
            text: 'Add project',
            onclick: (event) => send(event.target, () => api('/api/projects', { method: 'POST', body: payload() }), 'Project added'),
          }),
        ];
    return el('div', { class: `project-row${project ? '' : ' project-add'}` }, [name, description, el('div', { class: 'row-actions' }, actions)]);
  };
  const paint = async () => {
    let projects;
    try {
      projects = await api('/api/projects');
    } catch (err) {
      body.replaceChildren(el('div', { class: 'hint warn', text: `Could not load the projects: ${err.message}` }));
      return;
    }
    body.replaceChildren(...projects.map(row), row(null));
  };
  return {
    paint,
    parts: [
      body,
      el('div', { class: 'hint' }, [
        'A project groups crons and one-time executions on the home page. Pick one on each job\'s form. ',
        'Deleting a project keeps its jobs, with no project. With no projects, the home page shows one ungrouped list.',
      ]),
    ],
  };
}

/** The node list on the Settings page, each linking to the node's own page. */
function nodesList() {
  const body = el('div', {});
  const paint = async () => {
    let state;
    try {
      state = await api('/api/nodes');
    } catch (err) {
      body.replaceChildren(el('div', { class: 'hint warn', text: `Could not load the nodes: ${err.message}` }));
      return;
    }
    const describe = (node) =>
      [
        node.hostname,
        node.online ? `${node.running} running, ${node.queued} queued, ${node.scheduled} scheduled` : `last seen ${fmtRelative(node.lastSeenAt)}`,
        `limit ${node.config.maxConcurrentJobs || 'none'}`,
      ]
        .filter(Boolean)
        .join(' · ');
    const rows = state.nodes.map((node) =>
      el('div', { class: 'field' }, [
        el('label', {}, [
          el('a', { class: 'link', href: `#/nodes/${encodeURIComponent(node.id)}`, text: node.name }),
          node.isDefault ? ' (default)' : '',
        ]),
        el('div', { class: 'preset-row' }, [
          el('span', { class: `pill ${node.online ? 'active' : 'paused'}` }, [el('span', { class: 'led' }), node.online ? 'online' : 'offline']),
          node.commit && state.hubCommit && node.commit !== state.hubCommit
            ? el('span', { class: 'pill warn', title: versionText(node, state.hubCommit), text: `runs ${node.commit}` })
            : null,
          el('span', { class: 'preset-label mono', text: describe(node) }),
          el('span', { class: 'preset-sep' }),
          el('a', { class: 'btn small', href: `#/nodes/${encodeURIComponent(node.id)}`, text: 'Settings' }),
        ]),
      ]),
    );
    body.replaceChildren(...(rows.length ? rows : [el('div', { class: 'hint warn', text: 'No node has connected yet, so nothing runs.' })]));
  };

  // The command is a read-only field rather than text so it can be selected in
  // one click, and Copy falls back to execCommand: the clipboard API is missing
  // on a page served over plain HTTP, as it is through `tailscale serve --http`.
  const joinCommand = el('input', {
    type: 'text',
    class: 'mono join-command',
    readonly: 'readonly',
    'aria-label': 'Command that adds a Mac as a node',
    onfocus: () => joinCommand.select(),
  });
  const copyJoin = el('button', {
    type: 'button',
    class: 'btn small',
    text: 'Copy',
    onclick: async () => {
      joinCommand.select();
      try {
        if (navigator.clipboard) await navigator.clipboard.writeText(joinCommand.value);
        else if (!document.execCommand('copy')) throw new Error('the browser refused');
        toast('Command copied to clipboard');
      } catch (err) {
        toast(`Could not copy to clipboard: ${err.message}. The command is selected; press ⌘C.`, true);
      }
    },
  });
  const joinRow = el('div', { class: 'preset-row', hidden: 'hidden' }, [joinCommand, copyJoin]);
  const joinNote = el('div', { class: 'hint' });
  // Each press makes a new one-time code, which the new node trades for this server's token.
  const addMac = el('button', {
    type: 'button',
    class: 'btn small',
    text: 'Add a Mac',
    onclick: async () => {
      let join;
      try {
        join = await api('/api/join', { method: 'POST' });
      } catch (err) {
        joinNote.className = 'hint warn';
        joinNote.textContent = `Could not make a join code: ${err.message}`;
        return;
      }
      joinCommand.value = join.command;
      joinRow.hidden = false;
      const until = new Date(join.expiresAt).toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
      joinNote.className = join.hubUrl ? 'hint' : 'hint warn';
      joinNote.replaceChildren(
        ...(join.hubUrl
          ? [
              join.fromCheckout ? 'Run it in a checkout of this project on the other Mac. ' : 'Run it in a terminal on the other Mac. ',
              `Its code works once, until ${until}, and points the node at `,
              el('span', { class: 'mono', text: join.hubUrl }),
              '.',
            ]
          : [
              'Other Macs cannot reach this server yet: it listens on this machine only. Share it on your tailnet with ',
              el('span', { class: 'mono', text: `tailscale serve --bg --http=${join.port} ${join.port}` }),
              ' and press Add a Mac again, or see the README for your own network.',
            ]),
      );
    },
  });

  return {
    paint,
    parts: [
      body,
      el('div', { class: 'hint' }, [
        'A node is a machine that runs jobs. Each one fetches its work from this server and reports back every few seconds, ',
        'so only this server needs to be reachable. A job with no node of its own runs on the default node. ',
        'To add a Mac, install Claude Code there and sign in, then press Add a Mac for the command to run on it.',
      ]),
      el('div', { class: 'preset-row' }, [addMac]),
      joinRow,
      joinNote,
    ],
  };
}

async function renderSettings() {
  // Health comes along for the boot time: it is the one fact on this page that
  // belongs to the running process rather than to a file on disk.
  const [settings, config, health, notifications, auth, nodeState] = await Promise.all([
    api('/api/settings'),
    api('/api/config'),
    api('/api/health').catch(() => ({})),
    // One item's worth of payload; it is the counts either side of it we want.
    api('/api/notifications?limit=1').catch(() => ({})),
    api('/api/auth/status').catch(() => ({ required: false })),
    api('/api/nodes').catch(() => ({ nodes: [] })),
  ]);

  // One node beside the hub is a local install, and its settings stay on this
  // page as they always were. Anything else gets a page per node.
  const soleLocal = nodeState.nodes.length === 1 && nodeState.nodes[0].isLocal ? nodeState.nodes[0] : null;
  const local = soleLocal ? nodeSettingsParts(soleLocal, config) : null;
  const nodes = nodesList();
  const projects = projectsList();

  const signOut = auth.required
    ? el('button', {
        class: 'btn small',
        type: 'button',
        text: 'Sign out',
        onclick: async () => {
          await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
          location.assign('/login');
        },
      })
    : null;

  const status = el('div', { class: 'hint' });
  const checkButton = el('button', { class: 'btn small', text: 'Check for updates' });
  const updateButton = el('button', { class: 'btn primary', text: 'Update now', disabled: 'disabled' });

  const selfUpdate = el('input', { type: 'checkbox' });
  selfUpdate.checked = Boolean(settings.selfUpdate);

  // Tracked separately so rejecting a bad entry restores the value in force now,
  // not the one the page happened to load with.
  let intervalHours = Number(settings.updateCheckIntervalHours) || 24;
  const interval = el('input', { type: 'text', class: 'mono narrow', value: String(intervalHours) });

  const serverNameInput = el('input', {
    type: 'text',
    value: typeof settings.serverName === 'string' ? settings.serverName : '',
    placeholder: 'e.g. Office Mac mini',
    autocomplete: 'off',
    'aria-label': 'Server name',
  });
  // `change` fires on blur, and only when the text differs from what it held on focus.
  serverNameInput.addEventListener('change', async () => {
    const name = serverNameInput.value.trim();
    serverNameInput.value = name;
    if (await saveSettings({ serverName: name }, name ? `Server name set to ${name}` : 'Server name cleared')) setServerName(name);
  });

  // ---- server color ----
  // Tracked like the fields below, so a failed save puts back the color in force.
  let serverColor = /^#[0-9a-f]{6}$/i.test(settings.serverColor ?? '') ? settings.serverColor.toLowerCase() : DEFAULT_SERVER_COLOR;
  const swatches = SERVER_COLORS.map((color) =>
    el('button', { type: 'button', class: 'swatch', style: `background: ${color.hex}`, title: color.label, 'aria-label': color.label }),
  );
  const customColor = el('input', { type: 'color', class: 'swatch-custom', title: 'Custom color', 'aria-label': 'Custom server color' });

  const markColor = (hex) => {
    swatches.forEach((swatch, i) => swatch.setAttribute('aria-pressed', SERVER_COLORS[i].hex === hex ? 'true' : 'false'));
    customColor.value = hex;
    customColor.classList.toggle('selected', !SERVER_COLORS.some((color) => color.hex === hex));
  };

  const applyServerColor = async (hex) => {
    const previous = serverColor;
    serverColor = hex;
    markColor(hex);
    setServerColor(hex);
    const named = SERVER_COLORS.find((color) => color.hex === hex);
    const saved = await saveSettings(
      { serverColor: hex === DEFAULT_SERVER_COLOR ? '' : hex },
      hex === DEFAULT_SERVER_COLOR ? 'Server color back to the default' : `Server color set to ${named?.label ?? hex}`,
    );
    if (saved) return;
    serverColor = previous;
    markColor(previous);
    setServerColor(previous);
  };

  swatches.forEach((swatch, i) => swatch.addEventListener('click', () => applyServerColor(SERVER_COLORS[i].hex)));
  // `change` fires once the picker closes; dragging inside it saves nothing.
  customColor.addEventListener('change', () => applyServerColor(customColor.value.toLowerCase()));
  markColor(serverColor);

  selfUpdate.addEventListener('change', () =>
    saveSettings({ selfUpdate: selfUpdate.checked }, selfUpdate.checked ? 'Self update on' : 'Self update off'),
  );

  interval.addEventListener('change', () => {
    const hours = Number(interval.value);
    if (!Number.isFinite(hours) || hours <= 0) {
      toast('Check interval must be a positive number of hours', true);
      interval.value = String(intervalHours);
      return;
    }
    intervalHours = hours;
    saveSettings({ updateCheckIntervalHours: hours }, `Checking every ${hours}h`);
  });

  // ---- new job defaults ----
  const clusterDefaults = jobDefaultsParts({
    own: settings.jobDefaults ?? {},
    inherited: settings.jobDefaults ?? {},
    follow: null,
    save: (patch) => saveSettings({ jobDefaults: patch }, 'New job defaults saved'),
  });
  if (local) clusterDefaults.usageDelay.setThresholds(soleLocal.config.usageDelayThresholds);

  // ---- default prompt ----
  const defaultPrompt = el('textarea', {
    class: 'compact',
    'aria-label': 'Default prompt',
    text: typeof settings.defaultPrompt === 'string' ? settings.defaultPrompt : '',
  });
  // `change` fires on blur, and only when the text differs from what it held on focus.
  defaultPrompt.addEventListener('change', () =>
    saveSettings({ defaultPrompt: defaultPrompt.value }, defaultPrompt.value.trim() ? 'Default prompt saved' : 'Default prompt cleared'),
  );

  // ---- retrospective prompt ----
  // A blank setting runs the default, so the box shows the default then.
  const defaultRetrospective = typeof settings.defaultRetrospectivePrompt === 'string' ? settings.defaultRetrospectivePrompt : '';
  const retrospectivePrompt = el('textarea', {
    'aria-label': 'Retrospective prompt',
    text: typeof settings.retrospectivePrompt === 'string' && settings.retrospectivePrompt.trim() ? settings.retrospectivePrompt : defaultRetrospective,
  });
  const resetRetrospective = el('button', { type: 'button', class: 'btn small', text: 'Reset to default' });
  const saveRetrospective = async (text) => {
    const isDefault = !text.trim() || text.trim() === defaultRetrospective.trim();
    if (await saveSettings({ retrospectivePrompt: isDefault ? '' : text }, isDefault ? 'Retrospective prompt set to the default' : 'Retrospective prompt saved')) {
      if (isDefault) retrospectivePrompt.value = defaultRetrospective;
    }
  };
  // `change` fires on blur, and only when the text differs from what it held on focus.
  retrospectivePrompt.addEventListener('change', () => saveRetrospective(retrospectivePrompt.value));
  resetRetrospective.addEventListener('click', () => saveRetrospective(''));

  // ---- common commands ----
  const commonCommands = el('textarea', {
    class: 'compact mono',
    placeholder: '/review\n/babysit-pr',
    'aria-label': 'Common commands',
    text: typeof settings.commonCommands === 'string' ? settings.commonCommands : '',
  });
  // Not through saveSettings(): the server sorts the lines, and the box shows what it kept.
  commonCommands.addEventListener('change', async () => {
    try {
      const saved = await api('/api/settings', { method: 'PUT', body: JSON.stringify({ commonCommands: commonCommands.value }) });
      commonCommands.value = saved.commonCommands;
      toast(saved.commonCommands ? 'Common commands saved' : 'Common commands cleared');
    } catch (err) {
      toast(err.message, true);
    }
  });

  // ---- worktrees ----
  const worktreeInclude = el('textarea', {
    class: 'compact',
    placeholder: '.env\napps/*/.env.local',
    'aria-label': 'Default .worktreeinclude',
    text: typeof settings.defaultWorktreeInclude === 'string' ? settings.defaultWorktreeInclude : '',
  });
  // `change` fires on blur, and only when the text differs from what it held on focus.
  worktreeInclude.addEventListener('change', () =>
    saveSettings(
      { defaultWorktreeInclude: worktreeInclude.value },
      worktreeInclude.value.trim() ? 'Default .worktreeinclude saved' : 'Default .worktreeinclude cleared',
    ),
  );

  const showCheck = (result) => {
    setUpdateBadge(Boolean(result.updatable), result.behind);
    if (result.updatable) {
      status.textContent = `Update available: ${result.behind} commit${result.behind === 1 ? '' : 's'} behind origin/main.`;
      status.className = 'hint warn';
      updateButton.disabled = false;
    } else {
      status.textContent = result.reason === 'already up to date' ? 'Up to date with origin/main.' : `No update: ${result.reason}`;
      status.className = result.reason === 'already up to date' ? 'hint ok' : 'hint warn';
      updateButton.disabled = true;
    }
  };

  const check = async () => {
    checkButton.disabled = true;
    checkButton.textContent = 'Checking…';
    status.textContent = 'Fetching origin/main…';
    status.className = 'hint';
    try {
      showCheck(await api('/api/update/check'));
    } catch (err) {
      status.textContent = err.message;
      status.className = 'hint warn';
    } finally {
      checkButton.disabled = false;
      checkButton.textContent = 'Check for updates';
    }
  };

  checkButton.addEventListener('click', check);

  updateButton.addEventListener('click', async () => {
    updateButton.disabled = true;
    updateButton.textContent = 'Updating…';
    try {
      const result = await api('/api/update/run', { method: 'POST' });
      toast(`Update started — progress in ${result.updateLog}`);
      status.textContent = 'Holding schedules…';
      status.className = 'hint';
      watchUpdate(status, updateButton, result.updateLog ?? settings.updateLog);
    } catch (err) {
      status.textContent = err.message;
      status.className = 'hint warn';
      updateButton.textContent = 'Update now';
      updateButton.disabled = false;
    }
  });

  const divider = () => el('div', { class: 'card-divider' });
  const updates = config.selfUpdate
    ? [
        divider(),
        el('h3', { text: 'Updates' }),
        el('label', { class: 'check' }, [selfUpdate, 'Check for updates once per interval and apply them automatically']),
        el('div', { class: 'hint warn' }, [
          'Every cron is paused while an update runs. ',
          'A trigger due in that window is missed, not queued. ',
          'With this off, the server still checks and shows an Update available badge in the header.',
        ]),
        el('div', { class: 'preset-row' }, [
          checkButton,
          updateButton,
          el('span', { class: 'preset-sep' }),
          el('span', { class: 'preset-label', text: 'Check every' }),
          interval,
          el('span', { class: 'preset-label', text: 'hours' }),
        ]),
        status,
        el('div', { class: 'hint' }, [
          'An update pulls ',
          el('span', { class: 'mono', text: 'origin/main' }),
          ' and restarts the service. Update now works even with self update off.',
        ]),
      ]
    : [];
  const dates = [
    divider(),
    el('h3', { text: 'Dates' }),
    ...(config.selfUpdate
      ? [
          readOnlyField('Last check for updates', settings.lastUpdateCheckAt ? `${fmtDateTime(settings.lastUpdateCheckAt)} (${fmtRelative(settings.lastUpdateCheckAt)})` : 'never'),
          readOnlyField(
            'Last update started',
            settings.lastUpdateLaunchedAt
              ? `${fmtDateTime(settings.lastUpdateLaunchedAt)}${settings.lastUpdateFromCommit ? `, from ${settings.lastUpdateFromCommit}` : ''}`
              : 'never',
          ),
        ]
      : []),
    // An update restarts the service, so this says whether the last one landed.
    readOnlyField('Server last boot time', health.startedAt ? `${fmtDateTime(health.startedAt)} (${fmtRelative(health.startedAt)})` : 'unknown'),
  ];

  view.replaceChildren(
    el('div', { class: 'breadcrumb' }, [el('a', { href: '#/', text: '← All crons' })]),
    el('div', { class: 'page-head' }, [
      el('div', {}, [el('h1', { text: 'Settings' }), el('p', { class: 'sub', text: `Stored in ${databaseLabel(settings.database)}` })]),
    ]),
    el('div', { class: 'card' }, [
      el('div', { class: 'card-head' }, [el('h2', { text: 'Server Settings' }), signOut]),
      el('h3', { text: 'Server Name' }),
      el('div', { class: 'field' }, [serverNameInput]),
      el('div', { class: 'hint' }, [
        'Shown in the header bar as ',
        el('span', { class: 'mono', text: 'promptd - <name>' }),
        ', so two open servers can be told apart. Leave it blank to show promptd alone.',
      ]),
      divider(),
      el('h3', { text: 'Server Color' }),
      el('div', { class: 'preset-row' }, [...swatches, el('span', { class: 'preset-sep' }), el('span', { class: 'preset-label', text: 'Custom' }), customColor]),
      el('div', { class: 'hint' }, [
        'Colors the band across the top of every page, the dot beside the name, and the buttons and highlights. ',
        'Give each server its own and you can tell which one is open before reading anything. Orange is the default.',
      ]),
      ...updates,
      ...dates,
      ...(local ? [divider(), ...local.limit, divider(), ...local.queue] : []),
    ]),
    el('div', { class: 'card' }, [
      el('h2', { text: 'Job Settings' }),
      el('section', { class: 'settings-section', id: 'job-defaults', 'aria-labelledby': 'job-defaults-title' }, [
        el('h3', { id: 'job-defaults-title', text: 'New job defaults' }),
        el('div', { class: 'hint' }, [
          'What a cron or one-time execution uses for each of these when its form leaves it alone. ',
          'A job that leaves one alone follows it, so a change here reaches that job from its next run; a job that set its own keeps it. ',
          'Each node can change any of them for the jobs it runs, on its page under Nodes.',
        ]),
        ...clusterDefaults.parts,
      ]),
      divider(),
      ...(local
        ? [...local.usage, divider(), ...local.directory, divider()]
        : [
            el('div', { class: 'hint' }, [
              'The job limit, usage delays and default working directory belong to each node. ',
              'Open a node under Nodes to set them. What is here applies to every node.',
            ]),
            divider(),
          ]),
      el('h3', { text: 'Default prompt' }),
      el('div', { class: 'field' }, [defaultPrompt]),
      el('div', { class: 'hint' }, [
        'Where the Prompt field of a new cron or one-time execution starts. ',
        'Editing or duplicating a job keeps the prompt it already has, and changing this rewrites no saved job. ',
        'Leave it blank to start new jobs with an empty prompt.',
      ]),
      divider(),
      el('h3', { text: 'Retrospective prompt' }),
      el('div', { class: 'field' }, [retrospectivePrompt]),
      el('div', { class: 'hint' }, [
        'Added to the end of the prompt of every job with Retrospective on. ',
        'Claude is also told to open the retrospective with a marker line, so the log can show it as a section of its own, ',
        'and to answer only "NO RETROSPECTIVE" when it has nothing to report. ',
        'Clearing the box, or saving the default unchanged, keeps it on the default.',
      ]),
      el('div', { class: 'form-actions' }, [resetRetrospective]),
      divider(),
      el('h3', { text: 'Common commands' }),
      el('div', { class: 'field' }, [commonCommands]),
      el('div', { class: 'hint' }, [
        'One per line. Each becomes a button under the Prompt field of the cron and one-time execution forms, ',
        'and clicking it copies the command to the clipboard for pasting into the prompt. ',
        'Saving sorts the lines and drops blank ones, and the buttons follow the same order.',
      ]),
      divider(),
      el('h3', { text: 'Default .worktreeinclude' }),
      el('div', { class: 'field' }, [worktreeInclude]),
      el('div', { class: 'hint' }, [
        'Written as ',
        el('span', { class: 'mono', text: '.worktreeinclude' }),
        ' before each run of a job with Use worktree on, to the main checkout of the git repository its working directory is in. ',
        'That is the only place Claude Code reads it, so it goes there even when the working directory is a subfolder or a linked worktree. ',
        'Nothing is written while this is empty, or when the working directory is not in a git repository. ',
        'Claude Code copies the files it lists into each new worktree: one pattern per line, written like ',
        el('span', { class: 'mono', text: '.gitignore' }),
        ', matching only files git ignores, such as ',
        el('span', { class: 'mono', text: '.env' }),
        ' files. The copies are made when a worktree is created, so a reused worktree keeps the ones it started with.',
      ]),
      el('div', { class: 'hint warn' }, [
        'Any ',
        el('span', { class: 'mono', text: '.worktreeinclude' }),
        ' already in the main checkout is overwritten with this text on every run, including one the repo has committed.',
      ]),
    ]),
    el('div', { class: 'card' }, [el('h2', { text: 'Projects' }), ...projects.parts]),
    el('div', { class: 'card' }, [el('h2', { text: 'Nodes' }), ...nodes.parts]),
    el('div', { class: 'card' }, [
      el('h2', { text: 'Storage' }),
      readOnlyField('Storage root', config.storageRoot),
      readOnlyField('Database', databaseLabel(config.database)),
      readOnlyField('Logs', `${config.logsDir} (newest ${config.maxLogsPerCron} runs kept per cron)`),
      readOnlyField(
        'Notifications',
        Number.isFinite(notifications.total) ? `${notifications.total} stored, ${notifications.unread} unread` : 'in the database',
      ),
      readOnlyField('Project folder', settings.projectDir),
      ...(config.selfUpdate ? [readOnlyField('Update log', settings.updateLog)] : []),
      el('div', { class: 'hint' }, [
        'Crons, one-time executions, settings and notifications are kept in the database; run logs are plain files under the storage root. ',
        'Set DATABASE_URL to a postgres:// address to use Postgres instead of the SQLite file. ',
        `The newest ${config.maxNotifications} notifications are kept, and the oldest are deleted as new ones arrive.`,
      ]),
    ]),
  );

  if (config.selfUpdate) check();
  local?.paintQueue();
  nodes.paint();
  projects.paint();
  // Run activity redraws the queue on its own from here; the page is not rebuilt.
  repaintQueue = () => {
    local?.paintQueue();
    nodes.paint();
  };
}

async function renderNode(id) {
  const [node, config, settings] = await Promise.all([
    api(`/api/nodes/${encodeURIComponent(id)}`),
    api('/api/config'),
    api('/api/settings').catch(() => ({})),
  ]);
  const parts = nodeSettingsParts(node, config, settings.jobDefaults ?? {});
  const statusBody = el('div', {});

  const paintStatus = async () => {
    let current;
    try {
      current = await api(`/api/nodes/${encodeURIComponent(id)}`);
    } catch (err) {
      statusBody.replaceChildren(el('div', { class: 'hint warn', text: err.message }));
      return;
    }
    const actions = [
      current.isDefault
        ? null
        : el('button', {
            class: 'btn small',
            text: 'Make default',
            onclick: async () => {
              if (await saveSettings({ defaultNodeId: current.id }, `${current.name} is now the default node`)) paintStatus();
            },
          }),
      current.online
        ? null
        : el('button', {
            class: 'btn small danger',
            text: 'Remove',
            onclick: async () => {
              try {
                await api(`/api/nodes/${encodeURIComponent(current.id)}`, { method: 'DELETE' });
                toast(`Removed ${current.name}`);
                location.hash = '#/settings';
              } catch (err) {
                toast(err.message, true);
              }
            },
          }),
    ].filter(Boolean);
    statusBody.replaceChildren(
      el('div', { class: 'preset-row' }, [
        el('span', { class: `pill ${current.online ? 'active' : 'paused'}` }, [el('span', { class: 'led' }), current.online ? 'online' : 'offline']),
        current.isDefault ? el('span', { class: 'pill', text: 'default node' }) : null,
        el('span', {
          class: 'preset-label',
          text: current.online
            ? `${current.running} running, ${current.queued} queued, ${current.scheduled} scheduled`
            : `last seen ${fmtRelative(current.lastSeenAt)}`,
        }),
        ...(actions.length ? [el('span', { class: 'preset-sep' }), ...actions] : []),
      ]),
      readOnlyField('Claude account', current.account?.email ?? 'unknown: signed out, or on a build that does not say'),
      readOnlyField('Version', versionText(current, current.hubCommit)),
      readOnlyField('Started', current.startedAt ? `${fmtDateTime(current.startedAt)} (${fmtRelative(current.startedAt)})` : 'unknown'),
      readOnlyField('Machine', [current.hostname, current.platform, current.processors ? `${current.processors} processors` : null].filter(Boolean).join(' · ')),
      readOnlyField('Clock time zone', current.clockTimezone ?? 'unknown'),
      readOnlyField('Node id', current.id),
    );
  };

  view.replaceChildren(
    el('div', { class: 'breadcrumb' }, [el('a', { href: '#/settings', text: '← Settings' })]),
    el('div', { class: 'page-head' }, [
      el('div', {}, [
        el('h1', { text: node.name }),
        el('p', { class: 'sub', text: 'A machine that runs jobs. What is set here applies only to the jobs it runs.' }),
      ]),
    ]),
    el('div', { class: 'card' }, [el('h2', { text: 'Node' }), statusBody]),
    machineCard(node.id, node.system),
    el('div', { class: 'card' }, [el('h2', { text: 'Jobs' }), ...parts.limit, el('div', { class: 'card-divider' }), ...parts.queue]),
    el('div', { class: 'card' }, [
      el('h2', { text: 'Job defaults' }),
      ...parts.directory,
      el('div', { class: 'card-divider' }),
      ...parts.usage,
      el('div', { class: 'card-divider' }),
      ...parts.jobDefaults(),
    ]),
  );

  paintStatus();
  parts.paintQueue();
  repaintQueue = () => {
    parts.paintQueue();
    paintStatus();
  };
}

// ---- logs -------------------------------------------------------------

const logsState = {
  cronId: null,
  kind: 'cron',
  selected: null,
  atBottom: true,
  query: '', // the run list shows only logs containing this, ignoring case
  searchTimer: null,
  renderSeq: 0, // a slow search response must not overwrite a newer one
  paintedSeq: 0, // the render on screen, which alone may mark its job read
  toRetrospective: false, // scroll the selected log to its retrospective once it has loaded
};

// The section the server writes a retrospective under; kept in step with
// RETROSPECTIVE_HEADING and RETROSPECTIVE_END in src/retrospective.ts.
const RETRO_HEADING = '--- retrospective ---';
const RETRO_END = '--- end of retrospective ---';

/**
 * Sets a finished log's retrospective apart from the output around it, and
 * answers the element it now sits in, or null when the log has none.
 */
function markRetrospective(body) {
  const text = body.textContent;
  const start = text.lastIndexOf(`\n${RETRO_HEADING}\n`);
  if (start < 0) return null;
  const after = text.indexOf(`\n${RETRO_END}\n`, start);
  const end = after < 0 ? text.length : after + RETRO_END.length + 2;
  const inner = text.slice(start + RETRO_HEADING.length + 2, after < 0 ? text.length : after);
  const section = el('div', { class: 'log-retro' }, [el('div', { class: 'log-retro-title', text: 'Retrospective' }), inner]);
  body.replaceChildren(text.slice(0, start + 1), section, text.slice(end));
  return section;
}

/**
 * Lifetime totals for one cron, drawn under its name on the logs page.
 *
 * These count completed runs only, and they outlive the logs below them — the
 * newest 50 runs are all that is kept on disk, while these keep counting. A
 * cron whose counters were read back from its logs therefore starts from
 * whatever had not been pruned yet.
 */
function statStrip(stats) {
  if (!stats) return null;

  const stat = (value, label, sub, tip) =>
    el('div', { class: 'stat', title: tip }, [
      el('div', { class: 'stat-value', text: value }),
      el('div', { class: 'stat-label', text: label }),
      el('div', { class: 'stat-sub', text: sub }),
    ]);

  const runs = stats.runs ?? 0;
  const perRun = runs > 0 ? `over ${runs} run${runs === 1 ? '' : 's'}` : 'no completed runs yet';

  return el('div', { class: 'stat-strip' }, [
    stat(
      runs.toLocaleString(),
      runs === 1 ? 'run completed' : 'runs completed',
      'lifetime',
      'Runs that finished successfully. Failed and stopped runs are not counted.',
    ),
    stat(
      fmtCost(stats.costUsd),
      'total cost',
      runs > 0 ? `${fmtCost(stats.averageCostUsd)} per run` : perRun,
      'What every successful run has cost, as the CLI reported it.',
    ),
    stat(
      Number.isFinite(stats.runtimeSeconds) ? fmtDuration(stats.runtimeSeconds * 1000) : '—',
      'total runtime',
      runs > 0 ? `${fmtDuration(stats.averageRuntimeSeconds * 1000)} per run` : perRun,
      'Wall-clock time across every successful run.',
    ),
  ]);
}

/**
 * The run history of one job, cron or one-time execution. Both write into the
 * same logs folder under their own id, so this page is the same page; only the
 * route it reads and the crumb it goes back to differ.
 */
async function renderLogs(id, kind = 'cron') {
  const base = kind === 'execution' ? 'executions' : 'crons';
  if (logsState.cronId !== id || logsState.kind !== kind) logsState.query = '';
  logsState.cronId = id;
  logsState.kind = kind;
  const seq = ++logsState.renderSeq;
  const query = logsState.query.trim();
  const logsUrl = `/api/${base}/${id}/logs${query ? `?q=${encodeURIComponent(query)}` : ''}`;
  const [{ cron, logs, stats, total }, pause] = await Promise.all([api(logsUrl), api('/api/pause')]);
  if (seq !== logsState.renderSeq) return;
  // A move to another page landed while this one waited.
  const open = parseHash();
  if (open.section !== 'logs' || open.id !== id || open.kind !== kind) return;

  // Default to the live run if there is one, else the newest run.
  if (!logsState.selected || !logs.some((log) => log.file === logsState.selected)) {
    logsState.selected = logs.find((log) => log.isRunning)?.file ?? logs[0]?.file ?? null;
  }

  const runList = el(
    'div',
    { class: 'run-list' },
    logs.length
      ? logs.flatMap((log) => [
          el(
            'button',
            {
              class: `run-item${log.file === logsState.selected ? ' selected' : ''}`,
              onclick: () => {
                logsState.selected = log.file;
                logsState.atBottom = true;
                renderLogs(id, kind);
              },
            },
            [
              el('div', { class: 'when', text: fmtDateTime(log.startedAt) ?? log.file }),
              el('div', { class: 'meta' }, [
                log.isRunning
                  ? el('span', { class: 'pill running' }, [el('span', { class: 'led' }), 'live'])
                  : el('span', { text: fmtRelative(log.startedAt) }),
                el('span', { text: fmtBytes(log.size) }),
              ]),
            ],
          ),
          // Only a retrospective that said something is written, so this is only ever worth opening.
          log.hasRetrospective
            ? el('button', {
                class: `run-subitem${log.file === logsState.selected ? ' selected' : ''}`,
                title: "Open this run's retrospective",
                text: '↳ Retrospective',
                onclick: () => {
                  logsState.selected = log.file;
                  logsState.atBottom = false;
                  logsState.toRetrospective = true;
                  renderLogs(id, kind);
                },
              })
            : null,
        ])
      : [el('div', { class: 'empty', text: query ? 'No runs match' : 'No runs yet' })],
  );

  const search = el('input', {
    type: 'search',
    class: 'log-search',
    placeholder: 'Search all runs',
    'aria-label': 'Search all runs of this job',
    value: logsState.query,
    oninput: (event) => {
      logsState.query = event.target.value;
      clearTimeout(logsState.searchTimer);
      logsState.searchTimer = setTimeout(() => renderLogs(id, kind).catch(() => {}), 250);
    },
  });
  // Live activity redraws this page; keep the caret in the box while typing.
  const typing = document.activeElement?.classList.contains('log-search')
    ? [document.activeElement.selectionStart, document.activeElement.selectionEnd]
    : null;

  const body = el('pre', { class: 'log-body', text: logsState.selected ? 'Loading…' : 'Select a run' });
  body.addEventListener('scroll', () => {
    logsState.atBottom = body.scrollHeight - body.scrollTop - body.clientHeight < 40;
  });

  const liveBadge = el('span', { class: 'pill', text: '' });
  const selectedLog = logs.find((log) => log.file === logsState.selected);
  // Live runs tick from their start time; a finished run's total is read off the
  // log's closing line once the stream has replayed it.
  const runtimeEl = selectedLog?.isRunning
    ? el('span', {
        class: 'log-runtime',
        title: `Running since ${fmtDateTime(selectedLog.startedAt)}`,
        'data-runtime-start': selectedLog.startedAt,
        text: fmtElapsed(selectedLog.startedAt),
      })
    : el('span', { class: 'log-runtime', text: '' });

  const panel = el('div', { class: 'log-panel' }, [
    el('div', { class: 'log-head' }, [
      el('span', { class: 'mono', text: selectedLog ? (fmtDateTime(selectedLog.startedAt) ?? selectedLog.file) : '—' }),
      liveBadge,
      runtimeEl,
      el('div', { class: 'spacer' }),
      selectedLog
        ? el('a', {
            class: 'btn small',
            href: `/api/${base}/${id}/logs/${encodeURIComponent(selectedLog.file)}`,
            target: '_blank',
            text: 'Raw',
          })
        : null,
    ]),
    body,
  ]);

  const scheduleLine =
    kind === 'execution'
      ? `Scheduled for ${fmtDateTime(cron.scheduledAt) ?? 'an unreadable date'}.`
      : '';

  logsState.paintedSeq = seq;
  view.replaceChildren(
    el('div', { class: 'breadcrumb' }, [
      kind === 'execution'
        ? el('a', { href: '#/one-time', text: '← All one-time executions' })
        : el('a', { href: '#/', text: '← All crons' }),
    ]),
    el('div', { class: 'page-head' }, [
      el('div', {}, [
        el('h1', { text: `Logs · ${cron.name}` }),
        el('p', {
          class: 'sub',
          text: `${scheduleLine}${scheduleLine ? ' ' : ''}${
            query
              ? `${logs.length} of ${total} run${total === 1 ? '' : 's'} match "${query}", newest first.`
              : `${logs.length} run${logs.length === 1 ? '' : 's'} kept, newest first. Oldest are pruned past 50.`
          }`,
        }),
        statStrip(stats),
      ]),
      el('div', { class: 'row-actions' }, [
        kind === 'execution'
          ? el('a', { class: 'btn', href: `#/one-time/edit/${cron.id}`, text: 'Edit execution' })
          : el('a', { class: 'btn', href: `#/edit/${cron.id}`, text: 'Edit cron' }),
        runControl(cron, {
          pause,
          onStarted: () => {
            logsState.selected = null; // jump to the new run's log
          },
        }),
      ]),
    ]),
    el('div', { class: 'logs-layout' }, [el('div', { class: 'run-sidebar' }, [search, runList]), panel]),
  );

  if (typing) {
    search.focus();
    search.setSelectionRange(...typing);
  }

  // Read once the run is on screen, by the render on screen: a log that never
  // loads reads nothing, nor does one whose page has been left or redrawn.
  const newest = query ? null : (logs[0]?.file ?? null);
  // The run this render streams, which a click on another changes in logsState before it is drawn.
  const displayed = logsState.selected;
  const shown = () => {
    if (seq === logsState.paintedSeq && body.isConnected) acknowledgeJob(cron, displayed, newest);
  };
  if (displayed) openLogStream(id, displayed, body, liveBadge, runtimeEl, base, shown);
  else shown();
}

/** The revision each job was last reported read at from this page, so a redraw does not say it again. */
const reportedRead = new Map();

/**
 * Marks a job read once its logs page shows what its latest update is about:
 * the run it names, or the newest run, or, for a wait on usage, which has no
 * run, the page itself. Opening an older run leaves a newer update unread, and
 * a tab nobody is looking at marks nothing; it is redrawn when it is looked at.
 */
function acknowledgeJob(job, selected, newest) {
  const activity = job?.activity;
  if (!activity?.unread || document.visibilityState !== 'visible') return;
  const about = activity.update?.logFile ?? null;
  if (about && selected !== about && !(selected && selected === newest)) return;
  if (reportedRead.get(job.id) === activity.revision) return;
  reportedRead.set(job.id, activity.revision);
  // The revision this page was drawn with: an update since leaves the job unread.
  api('/api/job-activity/read', { method: 'POST', body: JSON.stringify({ items: [{ id: job.id, revision: activity.revision }] }) })
    .then((result) => setActivityCounts(result.counts))
    .catch(() => reportedRead.delete(job.id));
}

/**
 * The run length a finished log reports on its own closing line, e.g.
 * "--- succeeded after 12.3s ---". Null while the log has no closing line yet,
 * which is every log that is still being written.
 */
function durationFromLog(text) {
  const matches = [...text.matchAll(/^--- \w+ after ([\d.]+)s/gm)];
  const last = matches.at(-1);
  return last ? Number(last[1]) * 1000 : null;
}

/** Streams one log file into the pre element, appending chunks as they arrive. */
function openLogStream(cronId, file, body, liveBadge, runtimeEl, base = 'crons', onShown = () => {}) {
  closeLogStream();
  body.textContent = '';
  liveBadge.textContent = 'streaming';
  liveBadge.className = 'pill running';

  const stream = new EventSource(`/api/${base}/${cronId}/logs/${encodeURIComponent(file)}/stream`);
  logStream = stream;

  // Called once, when the log is first on screen: its first chunk, or its end.
  let shown = false;
  const show = () => {
    if (shown) return;
    shown = true;
    onShown();
  };

  stream.addEventListener('chunk', (event) => {
    body.append(JSON.parse(event.data).text);
    if (logsState.atBottom) body.scrollTop = body.scrollHeight;
    show();
  });

  stream.addEventListener('done', () => {
    liveBadge.textContent = 'finished';
    liveBadge.className = 'pill';
    if (runtimeEl) {
      // The clock stops here: whatever the run took is now written in the log.
      delete runtimeEl.dataset.runtimeStart;
      const ms = durationFromLog(body.textContent);
      runtimeEl.textContent = ms === null ? '' : fmtDuration(ms);
    }
    if (!body.textContent) body.textContent = '(empty log)';
    const retro = markRetrospective(body);
    if (retro && logsState.toRetrospective) body.scrollTop = retro.offsetTop - body.offsetTop;
    logsState.toRetrospective = false;
    show();
    closeLogStream();
  });

  stream.onerror = () => {
    liveBadge.textContent = 'stream lost';
    liveBadge.className = 'pill failed';
    closeLogStream();
  };
}

function closeLogStream() {
  logStream?.close();
  logStream = null;
}

// ---- routing ----------------------------------------------------------

/**
 * The hash, split into what it is asking for.
 *
 * One-time executions hang off a `one-time` prefix — `#/one-time/edit/:id` —
 * so the two kinds have parallel URLs and every page of either is linkable.
 */
function parseHash() {
  const parts = (location.hash.replace(/^#/, '') || '/').split('/').filter(Boolean);
  const rest = parts[0] === 'one-time' ? parts.slice(1) : parts;
  return {
    kind: parts[0] === 'one-time' ? 'execution' : 'cron',
    section: rest[0] ?? 'list',
    id: rest[1] ?? null,
    // A logs link can name one run, `#/logs/:id/:file`, and end in `/retro` to open its retrospective.
    file: rest[2] ? decodeURIComponent(rest[2]) : null,
    retro: rest[3] === 'retro',
  };
}

/** The link to one run's log, or to its retrospective. */
function logHash(kind, jobId, file, { retro = false } = {}) {
  return `${kind === 'execution' ? '#/one-time' : '#'}/logs/${jobId}/${encodeURIComponent(file)}${retro ? '/retro' : ''}`;
}

/**
 * Selects the run a logs link names, then drops it from the address: the page
 * moves between runs without touching the hash, and a stale one would pull a
 * reload back to this run.
 */
function openLinkedLog(kind, id, file, retro) {
  logsState.cronId = id;
  logsState.kind = kind;
  logsState.query = '';
  logsState.selected = file;
  logsState.atBottom = !retro;
  logsState.toRetrospective = retro;
  history.replaceState(null, '', `${kind === 'execution' ? '#/one-time' : '#'}/logs/${id}`);
}

async function route() {
  closeLogStream();
  clearTimeout(logsState.searchTimer);
  repaintQueue = null;
  nodeMachine = null;
  clearTimeout(modelPollTimer);
  clearTimeout(reloadTimer);
  clearTimeout(updateWatchTimer);
  const { kind, section, id, file, retro } = parseHash();
  if (section === 'logs' && id && file) openLinkedLog(kind, id, file, retro);
  try {
    if (section === 'settings') await renderSettings();
    else if (section === 'nodes' && id) await renderNode(decodeURIComponent(id));
    else if (kind === 'execution') {
      if (section === 'new') await renderExecutionForm(null, id || null);
      else if (section === 'edit' && id) await renderExecutionForm(id);
      else if (section === 'logs' && id) await renderLogs(id, 'execution');
      else await renderHome('executions');
    } else if (section === 'new') await renderForm(null, id || null);
    else if (section === 'edit' && id) await renderForm(id);
    else if (section === 'logs' && id) await renderLogs(id);
    else await renderHome('crons');
  } catch (err) {
    view.replaceChildren(
      el('div', { class: 'breadcrumb' }, [el('a', { href: '#/', text: '← All crons' })]),
      el('div', { class: 'error', text: err.message }),
    );
  }
}

/** Re-renders the current view when the server reports activity. */
function refreshCurrentView() {
  const { kind, section, id } = parseHash();
  if (section === 'logs' && id) {
    // Keep the open stream; only the run list and header need refreshing.
    renderLogs(id, kind).catch(() => {});
  } else if (section === 'list') {
    renderHome(kind === 'execution' ? 'executions' : 'crons').catch(() => {});
  }
  // The Settings page only has one live part; redrawing all of it would throw
  // away whatever the user is typing into a field.
  repaintQueue?.();
}

/** One redraw for a burst of activity, such as Mark all read in another tab. */
let refreshSoonTimer = null;
function refreshSoon() {
  clearTimeout(refreshSoonTimer);
  refreshSoonTimer = setTimeout(refreshCurrentView, 150);
}

function connectEvents() {
  const events = new EventSource('/api/events');
  let connectedBefore = false;

  events.addEventListener('hello', () => {
    setConnState();
    checkHealth();
    // Also the reconnect path: whatever happened while the stream was down is
    // counted, and the page drawn again, since none of it was heard.
    refreshActivityCounts();
    if (connectedBefore) refreshCurrentView();
    connectedBefore = true;
    // Also the reconnect path: a node page that dropped samples fills its charts back in.
    nodeMachine?.reload();
  });

  // Every node's samples arrive; only the open node page wants them, and only its own.
  events.addEventListener('system:sample', (event) => {
    const payload = JSON.parse(event.data);
    if (nodeMachine && payload.nodeId === nodeMachine.id) nodeMachine.push(payload);
  });

  events.addEventListener('notification:new', (event) => {
    const { notification, counts } = JSON.parse(event.data);
    setBellBadge(counts);
    prependNotification(notification);
  });

  // Another tab read something; this one's badge is now wrong.
  events.addEventListener('notification:read', (event) => setBellBadge(JSON.parse(event.data).counts));

  // A machine alert is worth interrupting for; it is also in the drawer. One
  // found already under way when a node restarted is not news, so it is quiet.
  events.addEventListener('system:alert', (event) => {
    const { metric, label, summary, seeded } = JSON.parse(event.data);
    if (!seeded) toast(`${label}: ${summary}`, true, `system-alert:${metric}`);
  });

  for (const type of ['crons:changed', 'run:started', 'run:finished', 'run:skipped', 'run:stopping', 'run:delayed', 'run:released', 'run:dropped']) {
    events.addEventListener(type, (event) => {
      const payload = JSON.parse(event.data);
      // Matches the wording the server writes into the notification drawer.
      const named = payload.kind === 'execution' ? `one-time "${payload.cronName}"` : `"${payload.cronName}"`;
      // Matches the drawer: a run with no footer has no duration to report.
      if (type === 'run:finished') {
        toast(
          Number.isFinite(payload.seconds)
            ? `${named} ${payload.status} in ${payload.seconds}s`
            : `${named} ${payload.status}`,
        );
      }
      if (type === 'run:delayed') {
        if (payload.hold === 'concurrency') {
          const when = payload.resumeAt ? ` Could start ${fmtCountdown(payload.resumeAt)}.` : '';
          toast(`${named} is queued at position ${payload.position + 1} of ${payload.queueLength}.${when}`, true);
        } else if (payload.late) {
          toast(`${named} is still waiting on ${delayNames(payload)}, past the time it was expected to start`, true);
        } else {
          const when = payload.resumeAt ? ` Starts ${fmtRelative(payload.resumeAt)}.` : '';
          toast(`${named} is waiting on ${delayNames(payload)}.${when}`, true);
        }
      }
      // Only the release that actually starts the run is worth a toast; a
      // cancelled or dropped one already reported itself where it happened.
      if (type === 'run:released' && payload.ran) {
        toast(
          payload.hold === 'concurrency'
            ? `${named} reached the front of the queue, starting now`
            : `${named} usage cleared, starting now`,
        );
      }
      if (type === 'run:dropped') {
        // A pause is missed time, not queued time, so the count says how many
        // runs this cron has now lost rather than how many are waiting.
        const sofar = payload.droppedCount > 1 ? ` (${payload.droppedCount} missed so far)` : '';
        toast(`${named} trigger dropped: ${payload.reason}${sofar}`, true, `dropped:${payload.cronId}`);
      }
      if (type === 'run:skipped') {
        toast(payload.reason ? `${named} skipped: ${payload.reason}` : `${named} was still running; trigger skipped`, true);
      }
      refreshJobs();
      refreshCurrentView();
    });
  }

  // A job's updates were written, or read in some browser: the lists show both.
  // The logs page only needs the first, to mark read what it is now showing.
  events.addEventListener('job:activity', (event) => {
    const { id, counts } = JSON.parse(event.data);
    setActivityCounts(counts);
    const { section, id: open } = parseHash();
    if (section === 'list' || (section === 'logs' && open === id)) refreshSoon();
  });
  events.addEventListener('job:read', (event) => {
    setActivityCounts(JSON.parse(event.data).counts);
    if (parseHash().section === 'list') refreshSoon();
  });

  // Matches the wording the server writes into the notification drawer.
  events.addEventListener('run:retrospective', (event) => {
    const payload = JSON.parse(event.data);
    const named = payload.kind === 'execution' ? `one-time "${payload.cronName}"` : `"${payload.cronName}"`;
    toast(`${named} left a retrospective`);
    refreshCurrentView();
  });
  events.addEventListener('worktree:include-failed', (event) => {
    const payload = JSON.parse(event.data);
    const named = payload.kind === 'execution' ? `one-time "${payload.cronName}"` : `"${payload.cronName}"`;
    toast(`${named} could not write .worktreeinclude: ${payload.error}`, true);
  });
  events.addEventListener('worktree:cleanup-failed', (event) => {
    const payload = JSON.parse(event.data);
    const named = payload.kind === 'execution' ? `one-time "${payload.cronName}"` : `"${payload.cronName}"`;
    toast(`${named} worktree clean up failed: ${payload.error}`, true);
  });

  // Pause and update progress: the badges and the sub line both come from it.
  events.addEventListener('update:availability', (event) => {
    const { updateAvailable, updateBehind } = JSON.parse(event.data);
    setUpdateBadge(Boolean(updateAvailable), updateBehind);
  });
  events.addEventListener('queue:changed', (event) => {
    setJobs(JSON.parse(event.data));
    repaintQueue?.();
  });
  events.addEventListener('pause:changed', () => refreshCurrentView());
  events.addEventListener('update:waiting', () => refreshCurrentView());
  events.addEventListener('update:launched', () => refreshCurrentView());
  events.addEventListener('update:abandoned', (event) => {
    const { runningCount } = JSON.parse(event.data);
    toast(`Update gave up waiting on ${runningCount} run(s); schedules resumed`, true);
    refreshCurrentView();
  });
  events.addEventListener('update:failed', (event) => {
    const { code } = JSON.parse(event.data);
    toast(`Update script failed (exit ${code}); schedules resumed`, true);
    refreshCurrentView();
  });

  // A one-time execution whose trigger was missed: the catch-up is starting it
  // now, which is worth saying out loud since nobody asked for it just then.
  events.addEventListener('execution:overdue', (event) => {
    const payload = JSON.parse(event.data);
    toast(`One-time "${payload.cronName}" missed its trigger by ${payload.lateBy}; running now`);
    refreshCurrentView();
  });

  events.onerror = () => {
    connEl.textContent = 'reconnecting';
    connEl.className = 'conn down';
  };
}

/**
 * The header offer. Shown whenever main is behind, whether or not the server is
 * allowed to apply it itself, and clicking through goes to Settings.
 */
function setUpdateBadge(available, behind = 0) {
  if (!updateBadgeEl) return;
  updateBadgeEl.hidden = !available;
  if (!available) return;
  const commits = behind ? `${behind} commit${behind === 1 ? '' : 's'} behind origin/main. ` : '';
  updateBadgeEl.title = `${commits}Open Settings to update.`;
}

/** The header bar names the server, so two open ones can be told apart. */
function setServerName(name) {
  if (!brandNameEl) return;
  brandNameEl.textContent = name ? `promptd - ${name}` : 'promptd';
}

/** The Server Color swatches. The first is the stylesheet's own accent, saved as blank. */
const SERVER_COLORS = [
  { label: 'Orange', hex: '#d97757' },
  { label: 'Blue', hex: '#5b9cf5' },
  { label: 'Green', hex: '#4cc38a' },
  { label: 'Purple', hex: '#a58af5' },
  { label: 'Pink', hex: '#ec79b4' },
  { label: 'Teal', hex: '#3cc4c4' },
  { label: 'Amber', hex: '#e0a846' },
  { label: 'Red', hex: '#ef6b6b' },
];
const DEFAULT_SERVER_COLOR = SERVER_COLORS[0].hex;

/** Recolors the accent, and the band across the header bar with it. Blank puts the default back. */
function setServerColor(hex) {
  const root = document.documentElement.style;
  if (!/^#[0-9a-f]{6}$/i.test(hex ?? '')) {
    for (const name of ['--accent', '--accent-soft', '--accent-ink']) root.removeProperty(name);
    return;
  }
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const [lr, lg, lb] = [r, g, b].map((v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4));
  root.setProperty('--accent', hex);
  root.setProperty('--accent-soft', `rgba(${r}, ${g}, ${b}, 0.14)`);
  // Dark text on a light pick and white on a dark one, so a primary button
  // stays readable whatever custom color is chosen. 0.2 is where they cross.
  root.setProperty('--accent-ink', 0.2126 * lr + 0.7152 * lg + 0.0722 * lb > 0.2 ? '#1b1207' : '#ffffff');
}

// ---- feedback ---------------------------------------------------------

/**
 * The header's bug and suggestion button. The hub turns what is typed here into
 * a one-time execution, dated now, that has claude file the GitHub issue, so
 * the run is followed like any other on the One-time Execution tab.
 */
const feedbackEl = document.getElementById('feedback');
const feedbackFormEl = document.getElementById('feedback-form');
const feedbackDetailsEl = document.getElementById('feedback-details');
const feedbackErrorEl = document.getElementById('feedback-error');
const feedbackSubmitEl = document.getElementById('feedback-submit');

function openFeedback() {
  feedbackFormEl.reset();
  feedbackErrorEl.hidden = true;
  feedbackSubmitEl.disabled = false;
  feedbackEl.showModal();
  feedbackDetailsEl.focus();
}

document.getElementById('feedback-open').addEventListener('click', openFeedback);
document.getElementById('feedback-close').addEventListener('click', () => feedbackEl.close());
document.getElementById('feedback-cancel').addEventListener('click', () => feedbackEl.close());
// A click on the backdrop lands on the dialog itself, outside its form.
feedbackEl.addEventListener('click', (event) => {
  if (event.target === feedbackEl) feedbackEl.close();
});

feedbackFormEl.addEventListener('submit', async (event) => {
  event.preventDefault();
  const form = new FormData(feedbackFormEl);
  feedbackErrorEl.hidden = true;
  feedbackSubmitEl.disabled = true;
  try {
    const execution = await api('/api/feedback', {
      method: 'POST',
      body: JSON.stringify({ kind: form.get('kind'), details: form.get('details') }),
    });
    feedbackEl.close();
    toast(`Sent. Claude is filing "${execution.name}" as a GitHub issue.`);
    if (parseHash().section === 'list') refreshCurrentView();
  } catch (err) {
    feedbackErrorEl.textContent = err.message;
    feedbackErrorEl.hidden = false;
    feedbackSubmitEl.disabled = false;
  }
});

// ---- notifications ----------------------------------------------------

/**
 * The bell, and the drawer behind it.
 *
 * Toasts are gone in a few seconds and nobody watches a dashboard all day, so
 * the server writes the same events down and this reads them back. Each record
 * has a level, and the level decides everything here: the bell counts what
 * needs action, marks what is worth knowing, and never mentions routine.
 */
const bellEl = document.getElementById('bell');
const bellBadgeEl = document.getElementById('bell-badge');
const bellDotEl = document.getElementById('bell-dot');
const bellStatusEl = document.getElementById('bell-status');
const drawerEl = document.getElementById('drawer');
const drawerListEl = document.getElementById('drawer-list');
const drawerBackdropEl = document.getElementById('drawer-backdrop');
const drawerCloseEl = document.getElementById('drawer-close');
const drawerUnreadEl = document.getElementById('drawer-unread');
const drawerReadAllEl = document.getElementById('drawer-read-all');
const drawerNodesEl = document.getElementById('drawer-nodes');

/** On screen this long and it counts as read. */
const READ_AFTER_MS = 3000;

/**
 * The drawer's sections, in the order they are read. Each has a glyph as well
 * as a colour, so the level is never carried by colour alone.
 */
const LEVELS = [
  { level: 'action', title: 'Needs action', glyph: '!', empty: 'Nothing needs action.' },
  { level: 'worth', title: 'Worth knowing', glyph: '~', empty: 'Nothing worth knowing.' },
  { level: 'routine', title: 'Routine', glyph: '·', empty: 'Nothing routine.' },
];

let drawerOpen = false;
let loadingPage = false;
let listGeneration = 0; // bumped by every reset, so an answer to an older list is dropped
const drawnIds = new Set(); // a notification arriving as both a page and an event
const readTimers = new Map(); // id -> the timer counting out its three seconds
const pendingRead = new Map(); // seen, not yet reported to the server: id -> the count it had when seen
let readFlushTimer = null;
let viewObserver = null; // watches items for the three-second rule
let moreObserver = null; // watches the end of the list for the next page
let sentinelEl = null;
let unreadOnly = false; // the filter button: show only what is still unread
let nodeFilter = null; // the node chip: show one machine's notifications
let drawerNodes = []; // every machine a row can name; empty when there is only one
let sections = new Map(); // level -> its heading, list and paging cursor
let bellCounts = null; // the last counts drawn, so only an increase is announced

/** "2 need action, 3 worth knowing", or empty when neither. */
function countPhrase(action, worth) {
  return [action ? `${action} need${action === 1 ? 's' : ''} action` : '', worth ? `${worth} worth knowing` : '']
    .filter(Boolean)
    .join(', ');
}

/**
 * The badge is a number only for what needs action; worth knowing is a hollow
 * dot beside it, and routine never touches it. The label says both in words.
 */
function setBellBadge(counts) {
  if (!bellBadgeEl || !counts) return;
  const action = Number(counts.action) || 0;
  const worth = Number(counts.worth) || 0;
  bellBadgeEl.hidden = action === 0;
  bellBadgeEl.textContent = `!${action > 99 ? '99+' : action}`;
  if (bellDotEl) bellDotEl.hidden = worth === 0;
  const phrase = countPhrase(action, worth);
  const label = phrase ? `Notifications — ${phrase}` : 'Notifications';
  bellEl?.setAttribute('title', label);
  bellEl?.setAttribute('aria-label', label);
  // Said aloud only when something arrives: a count going down is the reader's
  // own doing, and the first reading is the page loading, not news.
  if (bellStatusEl && bellCounts && (action > bellCounts.action || worth > bellCounts.worth)) bellStatusEl.textContent = phrase;
  bellCounts = { action, worth, nodes: counts.nodes ?? {} };
  syncNodeChips();
}

/** When a run of repeats began: a time today, a weekday this week, a date before that. */
function fmtSince(iso) {
  const date = new Date(iso);
  const now = new Date();
  if (date.toDateString() === now.toDateString()) return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (now.getTime() - date.getTime() < 6 * 86400000) return date.toLocaleDateString(undefined, { weekday: 'short' });
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function renderNotification(record, { arriving = false } = {}) {
  // One row can stand for several of the same thing: say how many, and since when.
  const repeats = record.count > 1 ? `×${record.count} · since ${fmtSince(record.since)} · ` : '';
  const meta = `${repeats}${fmtRelative(record.at)} · ${fmtDateTime(record.at)}`;
  const classes = ['note', record.read ? '' : 'unread', arriving ? 'arriving' : ''].filter(Boolean);
  const level = LEVELS.find((entry) => entry.level === record.level) ?? LEVELS.at(-1);
  // With several machines a row says which one it is about. A record from before
  // nodes were named has no name, and gets none rather than a guess.
  const named = drawerNodes.length && record.nodeName;
  const node = el('div', { class: classes.join(' '), 'data-id': record.id, 'data-level': level.level, 'data-count': record.count ?? 1 }, [
    // The section heading says the level to a screen reader; this is for the eye.
    el('span', { class: `note-glyph ${level.level}`, 'aria-hidden': 'true', text: level.glyph }),
    el('div', { class: 'note-body' }, [
      el('div', { class: 'note-message' }, [named ? el('span', { class: 'note-node', text: `${record.nodeName} · ` }) : null, record.message]),
      el('div', { class: 'note-meta', text: meta }),
    ]),
  ]);
  // A notification about a job is a shortcut to that job's runs, on whichever
  // of the two logs pages it belongs to.
  if (record.cronId) {
    node.classList.add('linked');
    node.addEventListener('click', () => {
      closeDrawer();
      location.hash = record.logFile
        ? logHash(record.jobKind, record.cronId, record.logFile, { retro: record.kind === 'retrospective' })
        : record.jobKind === 'execution'
          ? `#/one-time/logs/${record.cronId}`
          : `#/logs/${record.cronId}`;
    });
  } else if (named && record.nodeId !== 'hub' && drawerNodes.some((known) => known.id === record.nodeId)) {
    // Not about a job, so about the machine: a disk filling up, a busy CPU.
    node.classList.add('linked');
    node.addEventListener('click', () => {
      closeDrawer();
      location.hash = `#/nodes/${encodeURIComponent(record.nodeId)}`;
    });
  }
  return node;
}

/** Reports what has been seen, in one request rather than one per item. */
function flushRead() {
  clearTimeout(readFlushTimer);
  readFlushTimer = setTimeout(async () => {
    const seen = new Map(pendingRead);
    if (!seen.size) return;
    pendingRead.clear();
    try {
      // With the count each row had on screen, so a repeat that landed on it
      // since is not marked read unseen.
      const body = { ids: [...seen.keys()], revisions: Object.fromEntries(seen) };
      const result = await api('/api/notifications/read', { method: 'POST', body: JSON.stringify(body) });
      setBellBadge(result.counts);
    } catch {
      // Put them back: the next flush tries again, and the worst case is that
      // something stays unread rather than being marked read without proof.
      for (const [id, count] of seen) if (!pendingRead.has(id)) pendingRead.set(id, count);
    }
  }, 400);
}

/**
 * One item has now been on screen long enough.
 *
 * Under the unread filter the row stays where it is and only loses its
 * emphasis. Pulling it out from under the reader who is in the middle of
 * reading it would be the one thing the filter must not do.
 */
function markSeen(id, node) {
  node.classList.remove('unread');
  viewObserver?.unobserve(node);
  pendingRead.set(id, Number(node.dataset.count) || 1);
  flushRead();
}

/** Only unread items are watched; the rest have nothing left to change. */
function observeItem(node, record) {
  if (record.read || !viewObserver) return;
  viewObserver.observe(node);
}

// ---- the drawer's sections and node chips

/** One heading and list per level. Routine starts folded away: it is the long, quiet one. */
function buildSections() {
  sections = new Map();
  return LEVELS.map(({ level, title }) => {
    const open = level !== 'routine';
    const listId = `note-section-${level}`;
    const count = el('span', { class: 'note-section-count' });
    const toggle = el('button', { class: 'note-section-toggle', type: 'button', 'aria-expanded': String(open), 'aria-controls': listId }, [
      el('span', {
        class: 'note-section-chevron',
        'aria-hidden': 'true',
        html: '<svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M6 4l4 4-4 4"/></svg>',
      }),
      el('span', { class: `note-glyph ${level}`, 'aria-hidden': 'true', text: LEVELS.find((entry) => entry.level === level).glyph }),
      el('span', { class: 'note-section-title', text: title }),
      count,
    ]);
    const list = el('div', { class: 'note-section-list', id: listId, hidden: open ? null : '' });
    const section = { level, toggle, count, list, open, cursor: null, done: false, total: 0 };
    toggle.addEventListener('click', () => toggleSection(section));
    sections.set(level, section);
    return el('section', { class: `note-section ${level}` }, [el('h3', { class: 'note-section-head' }, [toggle]), list]);
  });
}

function toggleSection(section) {
  section.open = !section.open;
  section.toggle.setAttribute('aria-expanded', String(section.open));
  section.list.hidden = !section.open;
  placeSentinel();
  if (section.open && !section.done) loadNextPage();
}

function renderSectionCount(section) {
  section.count.textContent = section.total ? String(section.total) : '';
}

/**
 * The first open section with more to fetch. Sections page in order, so the
 * one sentinel sits at the end of whichever of them is still filling.
 */
function pagingSection() {
  return LEVELS.map(({ level }) => sections.get(level)).find((section) => section?.open && !section.done) ?? null;
}

function placeSentinel() {
  const section = pagingSection();
  if (section) section.list.append(sentinelEl);
  else sentinelEl?.remove();
}

function appendRow(section, node) {
  if (sentinelEl?.parentNode === section.list) section.list.insertBefore(node, sentinelEl);
  else section.list.append(node);
}

/** A section with nothing in it says so, rather than being a bare heading. */
function markEmpty(section) {
  if (section.list.querySelector('.note, .drawer-empty')) return;
  section.list.append(el('div', { class: 'drawer-empty', text: unreadOnly ? 'Nothing unread.' : LEVELS.find((entry) => entry.level === section.level).empty }));
}

/** The chips only change when the machines do; their counts change as things are read. */
function setDrawerNodes(nodes) {
  const same = nodes.length === drawerNodes.length && nodes.every((node, index) => node.id === drawerNodes[index].id && node.name === drawerNodes[index].name);
  drawerNodes = nodes;
  if (!same) renderNodeChips();
}

function renderNodeChips() {
  if (!drawerNodesEl) return;
  drawerNodesEl.hidden = drawerNodes.length === 0;
  const chips = [{ id: '', name: 'All' }, ...drawerNodes].map(({ id, name }) => {
    const chip = el('button', { class: 'chip', type: 'button', 'data-node': id, 'data-name': name }, [
      el('span', { text: name }),
      el('span', { class: 'chip-count', 'aria-hidden': 'true' }),
    ]);
    chip.addEventListener('click', () => {
      if ((nodeFilter ?? '') === id) return;
      nodeFilter = id || null;
      syncNodeChips();
      if (!drawerOpen) return;
      resetList();
      loadNextPage();
    });
    return chip;
  });
  drawerNodesEl.replaceChildren(...chips);
  syncNodeChips();
}

/** Which chip is pressed, and how many things on each machine need action. */
function syncNodeChips() {
  for (const chip of drawerNodesEl?.querySelectorAll('.chip') ?? []) {
    const id = chip.dataset.node;
    const action = id ? Number(bellCounts?.nodes?.[id]) || 0 : 0;
    chip.setAttribute('aria-pressed', String((nodeFilter ?? '') === id));
    chip.setAttribute('aria-label', action ? `${chip.dataset.name}, ${countPhrase(action, 0)}` : chip.dataset.name);
    const countEl = chip.querySelector('.chip-count');
    countEl.hidden = !action;
    countEl.textContent = action ? `!${action}` : '';
  }
}

async function loadNextPage() {
  if (loadingPage || !drawerOpen) return;
  const section = pagingSection();
  if (!section) return;
  loadingPage = true;
  const generation = listGeneration;
  try {
    const params = new URLSearchParams({ level: section.level });
    if (section.cursor) params.set('before', section.cursor);
    if (unreadOnly) params.set('unread', '1');
    if (nodeFilter) params.set('node', nodeFilter);
    const page = await api(`/api/notifications?${params}`);
    // The list was reset while this was in flight: its filter is not this one's.
    if (generation !== listGeneration) return;
    setDrawerNodes(page.nodes ?? []);
    // The machine being shown is no longer listed — down to one node, or
    // forgotten — so its chip is gone and nothing on screen could clear the
    // filter. Drop it, and this answer to it, and start again unfiltered.
    if (nodeFilter && !drawerNodes.some((node) => node.id === nodeFilter)) {
      nodeFilter = null;
      syncNodeChips();
      resetList();
      return;
    }
    setBellBadge(page.counts);
    for (const other of sections.values()) {
      other.total = page.levels?.[other.level] ?? other.total;
      renderSectionCount(other);
    }
    for (const record of page.items) {
      if (drawnIds.has(record.id)) continue;
      drawnIds.add(record.id);
      const node = renderNotification(record);
      appendRow(section, node);
      observeItem(node, record);
    }
    section.cursor = page.nextBefore;
    section.done = !page.nextBefore;
    if (section.done) markEmpty(section);
    placeSentinel();
    // A short page leaves the sentinel on screen, and an observer that is
    // already intersecting will not fire again — so ask once more by hand.
    if (pagingSection()) {
      requestAnimationFrame(() => {
        if (!sentinelEl?.isConnected) return;
        const list = drawerListEl.getBoundingClientRect();
        const end = sentinelEl.getBoundingClientRect();
        if (end.top <= list.bottom + 120) loadNextPage();
      });
    }
  } catch (err) {
    if (generation !== listGeneration) return;
    section.done = true;
    section.list.append(el('div', { class: 'drawer-empty', text: err.message }));
    placeSentinel();
  } finally {
    loadingPage = false;
    // A reset that landed mid-request asked for a first page and was turned away.
    if (generation !== listGeneration) loadNextPage();
  }
}

/**
 * A repeat that landed on a row already drawn.
 *
 * A row whose level changed always moves to the top of its new section, with
 * both sections' totals moved with it: left where it was, a hold that now
 * needs action would sit under Worth knowing, out of sight if that is folded.
 * A row at the same level moves up only when the reader is at the top — the
 * rule a new row follows — and otherwise takes the new wording where it is.
 */
function replaceNotification(existing, record) {
  // Whatever was counted or seen of the old version says nothing about this one.
  clearTimeout(readTimers.get(record.id));
  readTimers.delete(record.id);
  pendingRead.delete(record.id);
  viewObserver?.unobserve(existing);
  const node = renderNotification(record, { arriving: true });
  const from = sections.get(existing.dataset.level);
  const to = sections.get(record.level) ?? from;
  if (from && to && from !== to) {
    existing.remove();
    to.list.querySelector('.drawer-empty')?.remove();
    to.list.prepend(node);
    from.total = Math.max(0, from.total - 1);
    to.total += 1;
    renderSectionCount(from);
    renderSectionCount(to);
    if (from.done) markEmpty(from);
  } else if (to && drawerListEl.scrollTop <= 40) {
    existing.remove();
    to.list.prepend(node);
  } else {
    existing.replaceWith(node);
  }
  observeItem(node, record);
}

/** A notification that lands while the drawer is open, from the event stream. */
function prependNotification(record) {
  if (!drawerOpen) return;
  const existing = drawerListEl.querySelector(`.note[data-id="${CSS.escape(record.id)}"]`);
  if (existing) {
    replaceNotification(existing, record);
    return;
  }
  if (drawnIds.has(record.id)) return;
  // The filter means what it says: a notice that arrives already read — a run
  // that succeeded — has no business appearing in a list of unread ones.
  if (unreadOnly && record.read) return;
  if (nodeFilter && record.nodeId !== nodeFilter) return;
  // Only when the reader is at the top. Inserting above where they are reading
  // would move the list under them.
  if (drawerListEl.scrollTop > 40) return;
  const section = sections.get(record.level) ?? sections.get('routine');
  if (!section) return;
  drawnIds.add(record.id);
  section.list.querySelector('.drawer-empty')?.remove();
  const node = renderNotification(record, { arriving: true });
  section.list.prepend(node);
  observeItem(node, record);
  section.total += 1;
  renderSectionCount(section);
}

/** Empties the list and starts paging again, for an open and for either filter. */
function resetList() {
  listGeneration += 1;
  drawnIds.clear();
  for (const timer of readTimers.values()) clearTimeout(timer);
  readTimers.clear();
  if (sentinelEl) moreObserver?.unobserve(sentinelEl);
  sentinelEl = el('div', { class: 'drawer-sentinel' });
  drawerListEl.replaceChildren(...buildSections());
  placeSentinel();
  moreObserver?.observe(sentinelEl);
  drawerListEl.scrollTop = 0;
}

function openDrawer() {
  if (drawerOpen) return;
  drawerOpen = true;
  resetList();
  drawerEl.classList.add('open');
  drawerEl.setAttribute('aria-hidden', 'false');
  drawerBackdropEl.classList.add('open');

  viewObserver = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const id = entry.target.dataset.id;
        if (entry.isIntersecting) {
          if (readTimers.has(id)) continue;
          readTimers.set(id, setTimeout(() => {
            readTimers.delete(id);
            markSeen(id, entry.target);
          }, READ_AFTER_MS));
        } else {
          // Scrolled past, or folded away, before the three seconds were up: it does not count.
          clearTimeout(readTimers.get(id));
          readTimers.delete(id);
        }
      }
    },
    { root: drawerListEl, threshold: 0.6 },
  );

  moreObserver = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadNextPage();
    },
    { root: drawerListEl, rootMargin: '120px' },
  );
  moreObserver.observe(sentinelEl);

  loadNextPage();
  drawerListEl.focus({ preventScroll: true });
}

function closeDrawer() {
  if (!drawerOpen) return;
  drawerOpen = false;
  drawerEl.classList.remove('open');
  drawerEl.setAttribute('aria-hidden', 'true');
  drawerBackdropEl.classList.remove('open');
  viewObserver?.disconnect();
  moreObserver?.disconnect();
  viewObserver = null;
  moreObserver = null;
  for (const timer of readTimers.values()) clearTimeout(timer);
  readTimers.clear();
  // Anything that earned its three seconds still counts, even if the drawer
  // closed before the debounce ran.
  if (pendingRead.size) flushRead();
}

/** The filter button shows which of the two lists you are looking at. */
function syncUnreadButton() {
  if (!drawerUnreadEl) return;
  drawerUnreadEl.classList.toggle('primary', unreadOnly);
  drawerUnreadEl.setAttribute('aria-pressed', String(unreadOnly));
  drawerUnreadEl.textContent = unreadOnly ? 'Showing unread' : 'Unread only';
}

bellEl?.addEventListener('click', () => (drawerOpen ? closeDrawer() : openDrawer()));
drawerCloseEl?.addEventListener('click', closeDrawer);
drawerUnreadEl?.addEventListener('click', () => {
  unreadOnly = !unreadOnly;
  syncUnreadButton();
  if (!drawerOpen) return;
  resetList();
  loadNextPage();
});
drawerReadAllEl?.addEventListener('click', async () => {
  drawerReadAllEl.disabled = true;
  try {
    const result = await api('/api/notifications/read', { method: 'POST', body: JSON.stringify({ all: true }) });
    setBellBadge(result.counts);
    // Everything on screen is read now, including the rows still counting out
    // their three seconds and anything queued for the next flush.
    for (const timer of readTimers.values()) clearTimeout(timer);
    readTimers.clear();
    pendingRead.clear();
    for (const node of drawerListEl.querySelectorAll('.note.unread')) {
      node.classList.remove('unread');
      viewObserver?.unobserve(node);
    }
  } catch (err) {
    toast(err.message, true);
  } finally {
    drawerReadAllEl.disabled = false;
  }
});
drawerBackdropEl?.addEventListener('click', closeDrawer);
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') closeDrawer();
});

// ---- cluster header ---------------------------------------------------

/**
 * The header's middle: the nodes, the jobs running across them, one chip per
 * Claude account, and a machine reading only when one is out of line. Every
 * chip is a button onto the one panel that has the rest.
 *
 * All of it comes from the cluster summary /api/health carries, so what is
 * worth a chip is decided on the server, where it is tested, not here.
 */
const clusterEl = document.getElementById('cluster');
const clusterPanelEl = document.getElementById('cluster-panel');
const clusterPanelBodyEl = document.getElementById('cluster-panel-body');
const clusterPanelFootEl = document.getElementById('cluster-panel-foot');
const clusterPanelCloseEl = document.getElementById('cluster-panel-close');
let clusterState = null; // the summary from the last health poll
let jobsState = null; // running and queued counts, from health polls and queue events
let jobsRefreshTimer = null;
let panelOpener = null; // the chip that opened the panel, which focus returns to
let panelTimer = null; // re-reads the panel while it is open
let panelPaint = 0; // the newest panel request; an older one landing late is dropped

/**
 * What the Limit figure means when it is 0: no limit, which the panel spells
 * out against the processor count it would otherwise have defaulted to.
 */
function jobsScale({ limit, defaultLimit }) {
  const ceiling = Number(limit) > 0 ? Number(limit) : Number(defaultLimit);
  return Number.isFinite(ceiling) && ceiling > 0 ? ceiling : 1;
}

/** "41m", "2h", "3d": the one largest unit, for text that has to stay short. */
function fmtSpanShort(ms) {
  const minutes = Math.max(0, Math.round(ms / 60000));
  if (minutes < 60) return `${Math.max(1, minutes)}m`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`;
}

/** "just now", "3 min ago", or the two-unit form past the hour. */
function fmtAgo(iso) {
  const minutes = Math.floor((Date.now() - Date.parse(iso)) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  return fmtRelative(iso);
}

/** A reset time written out: "Thu, Oct 2, 3:00 PM (in 2d 4h)". */
function fmtReset(iso) {
  const at = new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  return `${at} (${fmtRelative(iso)})`;
}

function localPart(email) {
  return String(email ?? '').split('@')[0];
}

/**
 * The glyph a warning carries, plus the word for a screen reader, so severity
 * is never told by colour alone.
 */
function severityMark(severity) {
  if (severity !== 'warning' && severity !== 'critical') return [];
  return [el('span', { class: 'glyph', 'aria-hidden': 'true', text: '▲' }), el('span', { class: 'sr-only', text: `${severity}: ` })];
}

/** Items with a separator between them, as children for `el`. */
function joined(items, separator = ' · ') {
  return items.flatMap((item, index) => (index ? [separator, item] : [item]));
}

/** The summary names an account's headline windows by key rather than repeating them. */
function windowByKey(account, key) {
  return account.windows.find((window) => window.key === key) ?? null;
}

/** "▲ Weekly · Fable 100% · resets 2h": a critical window says when it clears. */
function windowText(window) {
  const critical = window.severity === 'critical' && window.resetsAt;
  return el('span', { class: `win ${window.severity}` }, [
    ...severityMark(window.severity),
    `${window.label} `,
    el('span', { class: 'num', text: `${Math.round(window.usedPercent)}%` }),
    critical ? ` · resets ${fmtSpanShort(Date.parse(window.resetsAt) - Date.now())}` : null,
  ]);
}

function chip(key, children, className = '') {
  return el(
    'button',
    {
      type: 'button',
      class: `chip ${className}`.trim(),
      'data-chip': key,
      'aria-haspopup': 'dialog',
      'aria-controls': 'cluster-panel',
      'aria-expanded': String(!clusterPanelEl.hidden),
      onclick: () => toggleClusterPanel(key),
    },
    children,
  );
}

function runningText() {
  const running = Number(jobsState?.runningCount) || 0;
  const limit = Number(jobsState?.limit) || 0;
  return limit > 0 ? `${running}/${limit}` : String(running);
}

/** Shown with two or more nodes, or when the only one is down. */
function nodesChip({ total, online, offline }) {
  if (total === 1 && online === 1) return null;
  const down = offline.length === 1 ? `${offline[0].name} offline` : offline.length ? `${offline.length} offline` : null;
  const warn = Boolean(down) || total === 0;
  return chip(
    'nodes',
    [...severityMark(warn ? 'warning' : 'normal'), el('span', { class: 'chip-label', text: 'Nodes ' }), el('span', { class: 'num', text: `${online}/${total}` }), down ? ` · ${down}` : null],
    warn ? 'warning' : '',
  );
}

/**
 * One account. The wide form is Session and the tightest other window; below
 * 1160px the email shortens and only the tightest window stays. Both are in
 * the button and the stylesheet picks one, so a resize needs no redraw.
 */
function usageChip({ key, full, short, labelled, usage }) {
  const stale = usage.stale && usage.checkedAt;
  const tightest = windowByKey(usage, usage.tightest);
  return chip(
    key,
    [
      el('span', { class: `chip-email${labelled ? ' chip-label' : ''}` }, [
        el('span', { class: 'email-full', text: full }),
        el('span', { class: 'email-short', text: short }),
        labelled ? ' ·' : null,
      ]),
      el('span', { class: 'chip-wide' }, joined(usage.headline.map((headline) => windowByKey(usage, headline)).filter(Boolean).map(windowText))),
      el('span', { class: 'chip-narrow' }, tightest ? [windowText(tightest)] : []),
      stale ? el('span', { class: 'chip-stale', text: ` · read ${fmtSpanShort(Date.now() - Date.parse(usage.checkedAt))} ago` }) : null,
    ],
    `account${stale ? ' stale' : ''}`,
  );
}

/**
 * What goes in the header for usage: one entry per account, then one per node
 * that reports usage without naming its account, typically on an older build.
 * Those are never merged, since they may be on different accounts, and name
 * their node once there is more than one to tell apart.
 */
function usageEntries({ accounts, unknownAccountUsage = [], nodes }) {
  const several = nodes.total > 1;
  return [
    ...accounts
      .filter((account) => account.windows.length)
      .map((account) => ({ key: `account:${account.id}`, full: account.email, short: localPart(account.email), folded: `${localPart(account.email)}@…`, labelled: false, usage: account })),
    ...unknownAccountUsage.map((entry) => {
      const where = several ? ` (${entry.nodeName})` : '';
      return { key: `unknown:${entry.nodeId}`, full: `Account unknown${where}`, short: `unknown${where}`, folded: `unknown${where}`, labelled: true, usage: entry };
    }),
  ];
}

/** Below 900px the usage chips fold into one button that names only those at warning or worse. */
function usageSummaryChip(entries) {
  const flagged = entries
    .map((entry) => ({ entry, tightest: windowByKey(entry.usage, entry.usage.tightest) }))
    .filter(({ entry, tightest }) => entry.usage.severity !== 'normal' && tightest);
  const children = flagged.length
    ? joined(
        flagged.map(({ entry, tightest }) =>
          el('span', { class: `win ${entry.usage.severity}` }, [
            ...severityMark(entry.usage.severity),
            `${entry.folded} `,
            el('span', { class: 'num', text: `${Math.round(tightest.usedPercent)}%` }),
          ]),
        ),
      )
    : ['usage ok'];
  return chip('usage', children, 'usage-summary');
}

/** The worst machine reading over its alert line, and how many more there are. */
function exceptionChip(exceptions) {
  const [worst] = exceptions;
  return chip(
    'machine',
    [
      el('span', { class: `win ${worst.severity}` }, [
        ...severityMark(worst.severity),
        `${worst.label} `,
        el('span', { class: 'num', text: fmtMetricValue(worst, worst.value) }),
        ` · ${worst.nodeName}`,
      ]),
      exceptions.length > 1 ? el('span', { class: 'chip-more' }, [`+${exceptions.length - 1}`, el('span', { class: 'sr-only', text: ' more' })]) : null,
    ],
    'machine',
  );
}

/**
 * Redraws the chips from the last summary. They are rebuilt rather than
 * patched, so the one holding focus is found again by its key afterwards.
 */
function paintHeader() {
  if (!clusterEl || !clusterState) return;
  const focused = document.activeElement?.closest?.('[data-chip]')?.dataset.chip ?? null;
  const { nodes, builds, exceptions } = clusterState;
  const behind = builds?.differing?.length ?? 0;
  const usage = usageEntries(clusterState);
  clusterEl.replaceChildren(
    ...[
      nodesChip(nodes),
      behind ? chip('builds', `${behind} old build${behind === 1 ? '' : 's'}`, 'muted') : null,
      chip('running', [el('span', { class: 'chip-label', text: 'Running ' }), el('span', { class: 'num running-count', text: runningText() })]),
      ...usage.map(usageChip),
      usage.length ? usageSummaryChip(usage) : null,
      exceptions.length ? exceptionChip(exceptions) : null,
    ].filter(Boolean),
  );
  clusterEl.hidden = false;
  if (focused) clusterEl.querySelector(`[data-chip="${CSS.escape(focused)}"]`)?.focus();
}

/**
 * The job counts, from a health poll or straight off the queue. Only the
 * Running figure is in the header, so that is written in place.
 */
function setJobs(state) {
  if (!state) return;
  jobsState = state;
  const count = clusterEl?.querySelector('.running-count');
  if (count) count.textContent = runningText();
  if (!clusterPanelEl.hidden) paintPanelFoot();
}

/**
 * Re-reads the queue after run activity, coalesced: a burst of starts and
 * finishes is one request rather than one each.
 */
function refreshJobs() {
  clearTimeout(jobsRefreshTimer);
  jobsRefreshTimer = setTimeout(async () => {
    try {
      setJobs({ ...jobsState, ...(await api('/api/queue')) });
    } catch {
      /* the next health poll draws it instead */
    }
  }, 250);
}

// ---- cluster panel ----------------------------------------------------

function syncExpanded() {
  for (const node of clusterEl.querySelectorAll('[data-chip]')) node.setAttribute('aria-expanded', String(!clusterPanelEl.hidden));
}

/** Where a chip points inside the panel: its account's group, or the node a machine reading is from. */
function panelAnchor(key) {
  if (key?.startsWith('account:')) return key;
  if (key?.startsWith('unknown:')) return `node:${key.slice('unknown:'.length)}`;
  if (key === 'machine' && clusterState?.exceptions?.[0]) return `node:${clusterState.exceptions[0].nodeId}`;
  return null;
}

function toggleClusterPanel(key) {
  if (!clusterPanelEl.hidden) closeClusterPanel();
  else openClusterPanel(key);
}

function openClusterPanel(key) {
  panelOpener = key;
  clusterPanelEl.hidden = false;
  syncExpanded();
  clusterPanelBodyEl.replaceChildren(el('p', { class: 'hint', text: 'Loading nodes…' }));
  paintPanelFoot();
  clusterPanelEl.focus();
  paintClusterPanel(panelAnchor(key));
  clearInterval(panelTimer);
  panelTimer = setInterval(() => paintClusterPanel(null), 5000);
}

function closeClusterPanel({ restoreFocus = true } = {}) {
  if (clusterPanelEl.hidden) return;
  clusterPanelEl.hidden = true;
  clearInterval(panelTimer);
  panelTimer = null;
  syncExpanded();
  // Found by key: the chip that opened the panel may have been redrawn since.
  if (restoreFocus && panelOpener) clusterEl.querySelector(`[data-chip="${CSS.escape(panelOpener)}"]`)?.focus();
  panelOpener = null;
}

/** "online", or when an offline node was last heard from. */
function nodeStatusText(node) {
  return node.online ? 'online' : `offline · seen ${fmtRelative(node.lastSeenAt)}`;
}

/** One machine reading, marked when it is over its alert line. */
function metricCell(metric, node) {
  const value = node.latestSample?.[metric.id];
  const exception = node.exceptions?.find((entry) => entry.metric === metric.id);
  const severity = exception?.severity ?? 'normal';
  return el('td', { class: `n ${exception ? `win ${severity}` : ''}`.trim(), 'data-label': metric.label }, [
    ...severityMark(severity),
    Number.isFinite(value) ? fmtMetricValue(metric, value) : '—',
  ]);
}

/** A node's build, or that it is behind the hub's. Muted, not amber: it is worth knowing, not alarming. */
function buildCell(node, hubCommit) {
  if (!node.commit) return el('td', { class: 'muted', 'data-label': 'Build', text: 'unknown' });
  if (hubCommit && node.commit !== hubCommit) {
    return el('td', { class: 'muted', 'data-label': 'Build', title: versionText(node, hubCommit), text: 'behind hub' });
  }
  return el('td', { class: 'mono', 'data-label': 'Build', text: node.commit });
}

/**
 * The windows a node with no account named reports, in a row under its own.
 * They are its numbers alone: the next such node may be on another account.
 */
function nodeUsageRow(node, span) {
  const usage = node.usage;
  if (!node.online || !usage?.windows?.length) return null;
  return el('tr', { class: 'node-usage' }, [
    el('td', { colspan: String(span) }, [
      el('div', { class: `acct-read${usage.stale ? ' stale' : ''}`, text: `${node.name}'s usage, ${readLine(usage)}` }),
      el('div', { class: 'acct-windows' }, usage.windows.map(windowRow)),
    ]),
  ]);
}

function nodeTable(nodes, metrics, hubCommit, { usageUnderNodes = false } = {}) {
  const count = (node, key) => (node.online ? String(node[key]) : '—');
  const limit = (node) => {
    const value = node.concurrencyLimit ?? node.config?.maxConcurrentJobs ?? 0;
    return value > 0 ? String(value) : 'none';
  };
  const columns = ['Node', 'Status', 'Running', 'Queued', 'Scheduled', 'Limit', ...metrics.map((metric) => metric.label), 'Build'];
  const numeric = new Set(['Running', 'Queued', 'Scheduled', 'Limit', ...metrics.map((metric) => metric.label)]);
  // Fixed widths, so the tables under each account line up column for column.
  const widths = { Node: 14, Status: 17, Running: 8, Queued: 7, Scheduled: 9, Limit: 6, 'I/O': 9, Build: 11 };
  return el('table', { class: 'node-table' }, [
    el('colgroup', {}, columns.map((column) => el('col', { style: `width: ${widths[column] ?? 6}%` }))),
    el('thead', {}, [el('tr', {}, columns.map((column) => el('th', { scope: 'col', class: numeric.has(column) ? 'n' : '', text: column })))]),
    el(
      'tbody',
      {},
      nodes.flatMap((node) => [
        el('tr', { 'data-anchor': `node:${node.id}`, class: node.online ? '' : 'offline' }, [
          el('td', { class: 'node-name', 'data-label': 'Node' }, [
            el('a', { class: 'link', href: `#/nodes/${encodeURIComponent(node.id)}`, 'data-key': `node:${node.id}`, title: node.name, text: node.name }),
            node.isDefault ? el('span', { class: 'node-default', text: ' default' }) : null,
          ]),
          el('td', { class: node.online ? '' : 'muted', 'data-label': 'Status', text: nodeStatusText(node) }),
          el('td', { class: 'n', 'data-label': 'Running', text: count(node, 'running') }),
          el('td', { class: 'n', 'data-label': 'Queued', text: count(node, 'queued') }),
          el('td', { class: 'n', 'data-label': 'Scheduled', text: count(node, 'scheduled') }),
          el('td', { class: 'n', 'data-label': 'Limit', text: limit(node) }),
          ...metrics.map((metric) => metricCell(metric, node)),
          buildCell(node, hubCommit),
        ]),
        usageUnderNodes ? nodeUsageRow(node, columns.length) : null,
      ].filter(Boolean)),
    ),
  ]);
}

/** One usage window with its bar, percentage and reset time, all as text as well as drawn. */
function windowRow(window) {
  const used = Math.max(0, Math.min(100, Number(window.usedPercent) || 0));
  const reset = window.resetsAt ? `resets ${fmtReset(window.resetsAt)}` : 'no reset time reported';
  return el('div', { class: `win-row ${window.severity}` }, [
    el('span', { class: 'win-label' }, [...severityMark(window.severity), window.label]),
    el('span', { class: 'usage-track', 'aria-hidden': 'true' }, [el('span', { class: 'usage-fill', style: `width: ${used}%` })]),
    el('span', { class: 'win-pct num', text: `${Math.round(used)}%` }),
    el('span', { class: 'win-reset', text: window.note ? `${reset}. ${window.note}` : reset }),
  ]);
}

/** When a reading was taken, and why it has not moved since if it is stale. */
function readLine(usage) {
  if (!usage) return 'Signed out, or on a build that does not say which account it uses.';
  if (!usage.checkedAt) return usage.reason ? `No usage reading: ${usage.reason}` : 'No usage reading yet';
  const read = `read ${fmtAgo(usage.checkedAt)}`;
  return usage.stale && usage.reason ? `${read}; not refreshed since: ${usage.reason}` : read;
}

/** One account: its windows, then a row per node signed in to it. Null is the nodes that have not said. */
function accountGroup(account, nodes, metrics, hubCommit) {
  const anchor = account ? `account:${account.id}` : 'account:unknown';
  const headingId = `cluster-group-${anchor.replace(/[^a-z0-9-]/gi, '-')}`;
  return el('section', { class: 'acct-group', 'data-anchor': anchor, 'aria-labelledby': headingId }, [
    el('div', { class: 'acct-head' }, [
      el('h3', { id: headingId, text: account ? account.email : 'Account unknown' }),
      el('span', { class: `acct-read${account?.stale ? ' stale' : ''}`, text: readLine(account) }),
    ]),
    account?.windows.length ? el('div', { class: 'acct-windows' }, account.windows.map(windowRow)) : null,
    // With no account to group them under, each node's own numbers sit under its row.
    nodeTable(nodes, metrics, hubCommit, { usageUnderNodes: !account }),
  ]);
}

/** The footer: the job counts the Running chip sums up, now against merely armed. */
function paintPanelFoot() {
  const state = jobsState ?? {};
  const limit = Number(state.limit) || 0;
  const item = (label, value) => el('div', { class: 'foot-item' }, [el('dt', { text: label }), el('dd', { class: 'num', text: String(value) })]);
  clusterPanelFootEl.replaceChildren(
    el('dl', { class: 'foot-group' }, [
      item('Running', Number(state.runningCount) || 0),
      item('Limit', limit > 0 ? limit : `none (of ${jobsScale(state)})`),
      item('Queued', Number(state.queuedCount) || 0),
      item('Usage Delay', Number(state.usageDelayedCount) || 0),
    ]),
    el('dl', { class: 'foot-group' }, [item('Crons Armed', Number(state.armedCrons) || 0), item('OTE Scheduled', Number(state.armedExecutions) || 0)]),
  );
}

/**
 * Reads the nodes and redraws the groups, keeping focus on whatever link held
 * it. `anchor` scrolls a chip's own group or node into view on opening.
 */
async function paintClusterPanel(anchor) {
  const paint = ++panelPaint;
  let state;
  try {
    state = await api('/api/nodes');
  } catch (err) {
    if (paint === panelPaint && !clusterPanelEl.hidden) {
      clusterPanelBodyEl.replaceChildren(el('div', { class: 'hint warn', text: `Could not load the nodes: ${err.message}` }));
    }
    return;
  }
  if (paint !== panelPaint || clusterPanelEl.hidden) return;
  const focusedKey = clusterPanelBodyEl.contains(document.activeElement) ? document.activeElement.dataset.key : null;
  const byId = new Map(state.nodes.map((node) => [node.id, node]));
  const pick = (ids) => ids.map((id) => byId.get(id)).filter(Boolean);
  const metrics = state.metrics ?? [];
  const groups = state.cluster.accounts.map((account) => accountGroup(account, pick(account.nodeIds), metrics, state.hubCommit));
  const unknown = pick(state.cluster.unknownAccountNodeIds);
  if (unknown.length) groups.push(accountGroup(null, unknown, metrics, state.hubCommit));
  clusterPanelBodyEl.replaceChildren(...(groups.length ? groups : [el('p', { class: 'hint warn', text: 'No node has connected yet, so nothing runs.' })]));
  if (focusedKey) clusterPanelBodyEl.querySelector(`[data-key="${CSS.escape(focusedKey)}"]`)?.focus();
  if (anchor) clusterPanelBodyEl.querySelector(`[data-anchor="${CSS.escape(anchor)}"]`)?.scrollIntoView({ block: 'nearest' });
}

clusterPanelCloseEl?.addEventListener('click', () => closeClusterPanel());
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !clusterPanelEl.hidden) {
    event.preventDefault();
    closeClusterPanel();
  }
});
// A click anywhere else closes it. A chip is left to its own click, which toggles.
document.addEventListener('pointerdown', (event) => {
  if (clusterPanelEl.hidden || clusterPanelEl.contains(event.target) || event.target.closest?.('[data-chip]')) return;
  closeClusterPanel({ restoreFocus: false });
});
// So does tabbing out of it: left open, it would cover whatever focus moved to.
clusterPanelEl?.addEventListener('focusout', (event) => {
  const next = event.relatedTarget;
  if (!next || clusterPanelEl.contains(next) || next.closest?.('[data-chip]')) return;
  closeClusterPanel({ restoreFocus: false });
});
window.addEventListener('hashchange', () => closeClusterPanel({ restoreFocus: false }));

// ---- machine charts ---------------------------------------------------

/**
 * A node's machine over the last fifteen minutes, one chart per reading, on
 * the node's own page. The hub pushes every node's samples down /api/events
 * tagged with the node, so the open page appends to its own copy of the window
 * rather than polling.
 */
let nodeMachine = null; // the charts on the open node page: { id, push, reload }

const SPARK_WIDTH = 228;
const SPARK_HEIGHT = 52;
const SPARK_TOP = 3;
const SPARK_BOTTOM = SPARK_HEIGHT - 3;

/**
 * What the chart is full of. A percentage fills against 100. A rate has no
 * ceiling, so it fills against the busiest moment still in the window — never
 * less than the metric's floor, or an idle disk would draw a full chart off a
 * 0.2 MB/s blip.
 */
function metricScale(metric, samples) {
  if (metric.kind !== 'rate') return 100;
  let peak = metric.minScale ?? 1;
  for (const sample of samples) {
    const value = sample[metric.id];
    if (Number.isFinite(value) && value > peak) peak = value;
  }
  return peak;
}

function fmtMetricValue(metric, value) {
  if (!Number.isFinite(value)) return '—';
  if (metric.kind === 'rate') return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${metric.unit}`;
  return `${Math.round(value)}${metric.unit}`;
}

/** The API hands out its own severity for usage; here the thresholds are ours. */
function metricSeverity(metric, value) {
  if (!Number.isFinite(value) || metric.kind !== 'percent') return 'normal';
  if (Number.isFinite(metric.critical) && value >= metric.critical) return 'critical';
  if (Number.isFinite(metric.warning) && value >= metric.warning) return 'warning';
  return 'normal';
}

/**
 * The average and the peak across the window, ignoring gaps. `now` is the
 * newest sample rather than the newest reading: if the last sample could not
 * read this metric, the chart says so instead of repeating an older number.
 */
function metricSummary(metric, samples) {
  const values = samples.map((sample) => sample[metric.id]).filter((value) => Number.isFinite(value));
  if (!values.length) return { now: null, average: null, peak: null };
  return {
    now: samples.at(-1)?.[metric.id] ?? null,
    average: values.reduce((sum, value) => sum + value, 0) / values.length,
    peak: Math.max(...values),
  };
}

/**
 * The 15-minute line, as an SVG path.
 *
 * Points are placed by their timestamp rather than their position in the array,
 * so a gap in the samples — a restart, a metric the platform could not read —
 * shows as a gap rather than being drawn through. Each run of readings is its
 * own subpath for the same reason.
 */
function sparkPaths(metric, samples, windowMs) {
  const scale = metricScale(metric, samples);
  const endsAt = Date.now();
  const x = (iso) => {
    const at = Date.parse(iso);
    const ratio = (at - (endsAt - windowMs)) / windowMs;
    return Math.max(0, Math.min(1, ratio)) * SPARK_WIDTH;
  };
  const y = (value) => SPARK_BOTTOM - (Math.min(value, scale) / scale) * (SPARK_BOTTOM - SPARK_TOP);

  const runs = [];
  let run = [];
  for (const sample of samples) {
    const value = sample[metric.id];
    if (!Number.isFinite(value)) {
      if (run.length) runs.push(run);
      run = [];
      continue;
    }
    run.push([x(sample.at), y(value)]);
  }
  if (run.length) runs.push(run);

  const point = ([px, py]) => `${px.toFixed(1)} ${py.toFixed(1)}`;
  const line = runs
    .map((points) => points.map((p, index) => `${index ? 'L' : 'M'}${point(p)}`).join(' '))
    .join(' ');
  const area = runs
    .filter((points) => points.length > 1)
    .map(
      (points) =>
        `M${points[0][0].toFixed(1)} ${SPARK_BOTTOM} ` +
        points.map((p) => `L${point(p)}`).join(' ') +
        ` L${points.at(-1)[0].toFixed(1)} ${SPARK_BOTTOM} Z`,
    )
    .join(' ');
  return { line, area, scale };
}

/** The line under the chart: what is actually behind the percentage. */
function metricDetailText(metric, detail) {
  const reading = detail?.[metric.id];
  if (!reading) return null;
  if (metric.id === 'cpu') {
    const load = Number.isFinite(reading.loadAverage) ? ` · load ${reading.loadAverage}` : '';
    return `${reading.cores} cores${load}`;
  }
  if (metric.id === 'memory') return `${fmtBytes(reading.usedBytes)} of ${fmtBytes(reading.totalBytes)} in use`;
  if (metric.id === 'io') {
    return Number.isFinite(reading.transfersPerSecond) ? `${reading.transfersPerSecond} transfers/s` : null;
  }
  if (metric.id === 'disk') return `${fmtBytes(reading.usedBytes)} used · ${fmtBytes(reading.freeBytes)} free`;
  return null;
}

/** One chart and the numbers under it; `update` redraws it from the window. */
function metricTile(metric, windowMs) {
  const area = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  area.setAttribute('class', 'spark-area');
  const line = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  line.setAttribute('class', 'spark-line');
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'spark');
  svg.setAttribute('viewBox', `0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('role', 'img');
  svg.append(area, line);

  const value = el('span', { class: 'tile-value' });
  const top = el('span', { class: 'spark-top' });
  const now = el('dd', { text: '—' });
  const average = el('dd', { text: '—' });
  const peak = el('dd', { text: '—' });
  const detail = el('div', { class: 'pop-detail' });
  const note = el('div', { class: 'pop-note' });
  const minutes = Math.round(windowMs / 60000);

  const root = el('div', { class: 'metric-tile' }, [
    el('div', { class: 'pop-title' }, [el('span', { text: metric.title }), value]),
    el('div', { class: 'pop-sub', text: metric.detail }),
    svg,
    el('div', { class: 'pop-axis' }, [el('span', { text: `${minutes}m ago` }), top, el('span', { text: 'now' })]),
    el('dl', { class: 'pop-stats' }, [
      el('div', {}, [el('dt', { text: 'Now' }), now]),
      el('div', {}, [el('dt', { text: 'Avg' }), average]),
      el('div', {}, [el('dt', { text: 'Peak' }), peak]),
    ]),
    detail,
    note,
  ]);

  const update = ({ samples, detail: details, notes }) => {
    const latest = samples.at(-1)?.[metric.id];
    const severity = metricSeverity(metric, latest);
    const summary = metricSummary(metric, samples);
    const paths = sparkPaths(metric, samples, windowMs);
    root.className = `metric-tile ${severity}`;
    value.replaceChildren(...severityMark(severity), fmtMetricValue(metric, latest));
    line.setAttribute('d', paths.line);
    area.setAttribute('d', paths.area);
    // A rate's chart is only readable if it says what the top of it means; a percentage's top is 100.
    top.textContent = metric.kind === 'rate' ? `top ${fmtMetricValue(metric, paths.scale)}` : '';
    now.textContent = fmtMetricValue(metric, summary.now);
    average.textContent = fmtMetricValue(metric, summary.average);
    peak.textContent = fmtMetricValue(metric, summary.peak);
    svg.setAttribute(
      'aria-label',
      `${metric.title}, last ${minutes} minutes: now ${now.textContent}, average ${average.textContent}, peak ${peak.textContent}`,
    );
    const detailText = metricDetailText(metric, details);
    detail.textContent = detailText ?? '';
    detail.hidden = !detailText;
    const why = notes?.[metric.id] ?? null;
    note.textContent = why ?? '';
    note.hidden = !why;
  };
  return { root, update };
}

/**
 * The Machine card on a node's page. `system` is what /api/nodes/:id answers:
 * the metric definitions and the window the hub has kept for this node.
 */
function machineCard(nodeId, system) {
  const body = el('div', {});
  const card = el('div', { class: 'card' }, [el('h2', { text: 'Machine' }), body]);
  let state = null;
  let tiles = [];

  const draw = (next) => {
    if (!next?.enabled || !next.metrics?.length) {
      state = null;
      tiles = [];
      body.replaceChildren(el('p', { class: 'hint', text: 'Machine readings show here while the node is online and sampling.' }));
      return;
    }
    state = { windowMs: next.windowMs, samples: next.samples ?? [], detail: next.detail ?? {}, notes: next.notes ?? {} };
    tiles = next.metrics.map((metric) => metricTile(metric, state.windowMs));
    body.replaceChildren(el('div', { class: 'metric-grid' }, tiles.map((tile) => tile.root)));
    for (const tile of tiles) tile.update(state);
  };
  draw(system);

  nodeMachine = {
    id: nodeId,
    /** One sample off the event stream, appended and trimmed to the window. */
    push(payload) {
      if (!state || !payload?.sample) return;
      state.samples.push(payload.sample);
      state.detail = payload.detail ?? state.detail;
      state.notes = payload.notes ?? state.notes;
      const cutoff = Date.now() - state.windowMs;
      while (state.samples.length && Date.parse(state.samples[0].at) < cutoff) state.samples.shift();
      for (const tile of tiles) tile.update(state);
    },
    /** After a reconnect: the page missed samples, and this fills the gap back in. */
    async reload() {
      try {
        draw((await api(`/api/nodes/${encodeURIComponent(nodeId)}`)).system);
      } catch {
        /* the next sample draws what it can */
      }
    },
  };
  return card;
}

/** Live, or live-but-out-of-date once the server has moved to another commit. */
function setConnState() {
  if (staleBuild) {
    connEl.textContent = 'live - refresh window';
    connEl.className = 'conn stale';
    connEl.title = `This page loaded from ${loadedCommit}; the server now runs newer code. Reload to catch up.`;
    return;
  }
  connEl.textContent = 'live';
  connEl.className = 'conn live';
  connEl.title = 'Live connection';
}

/** Notices when the running commit changes, which means an update landed. */
async function checkHealth() {
  try {
    const health = await api('/api/health');
    if (health.authRequired) {
      location.assign('/login');
      return;
    }
    setUpdateBadge(Boolean(health.updateAvailable), health.updateBehind);
    setBellBadge(health.notificationCounts);
    // The cluster's own figures when there are any: its limit counts online nodes only.
    clusterState = health.cluster ?? null;
    setJobs({
      runningCount: health.cluster?.running ?? health.running,
      queuedCount: health.queued,
      usageDelayedCount: health.usageDelayed,
      limit: health.cluster?.concurrencyLimit ?? health.concurrencyLimit,
      defaultLimit: health.defaultConcurrencyLimit,
      armedCrons: health.armedCrons,
      armedExecutions: health.armedExecutions,
    });
    paintHeader();
    if (!health.commit) return; // not a git checkout, nothing to compare
    if (!loadedCommit) loadedCommit = health.commit;
    else if (health.commit !== loadedCommit) staleBuild = true;
    setConnState();
  } catch {
    /* the SSE error handler already reports a lost connection */
  }
}

window.addEventListener('hashchange', route);
// A logs page in a background tab marks nothing read; it does once it is looked at.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && parseHash().section === 'logs') refreshCurrentView();
});
// Live run clocks, wherever they are on the page.
setInterval(tickRuntimes, 1000);
// Cheap, and a restart is exactly when the running commit changes.
setInterval(checkHealth, 20000);
// Keeps "3m ago" / "in 20m" honest without hammering the API.
// Keeps "in 20m" honest on whichever list is open. Both tabs are a `list`
// section, so this has to read the hash the way the router does rather than
// assume the home page is the one with nothing after the slash.
setInterval(() => {
  if (parseHash().section === 'list') refreshCurrentView();
}, 15000);

checkHealth();
api('/api/settings')
  .then((settings) => {
    setServerName(settings.serverName);
    setServerColor(settings.serverColor);
  })
  .catch(() => {});
connectEvents();
route();
