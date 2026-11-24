/** @jsxImportSource preact */
import { Fragment, type ComponentChildren, type JSX } from 'preact';
import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { Glyph } from './glyph.js';
import { Row } from './row.js';
import { StateMark } from './issues.js';
import type { MatrixActivityRow, MatrixCellView, MatrixIssueLink, MatrixListRow, MatrixRead, MatrixStanding, MatrixView } from '../wire.js';

/** Where the Matrix tab stands, as the address holds it: a matrix, and in it a cell, a row or a column. */
export interface MatrixAt {
  matrix: string | null;
  scenario: string | null;
  capability: string | null;
}

const STANDINGS: MatrixStanding[] = ['works', 'gap', 'unmeasured', 'n/a'];

/** A standing as a class name: `n/a` holds a slash no selector takes. */
const standingClass = (standing: MatrixStanding): string => `standing-${standing === 'n/a' ? 'na' : standing}`;

/** Each standing draws its own shape as well as its own colour, so the marks read apart without the colour. */
function StandingMark({ standing }: { standing: MatrixStanding }) {
  return <i class={`standingmark ${standingClass(standing)}`} role="img" aria-label={standing} title={standing} />;
}

/** The counts per standing, each beside its mark; a standing at zero is left out. */
function Counts({ counts }: { counts: Record<MatrixStanding, number> }) {
  return (
    <span class="matrixcounts">
      {STANDINGS.filter(standing => counts[standing] > 0).map(standing => (
        <span key={standing} class="matrixcount" title={`${counts[standing]} ${standing}`}>
          <StandingMark standing={standing} />{counts[standing]}
        </span>
      ))}
    </span>
  );
}

function emptyCounts(): Record<MatrixStanding, number> {
  return { works: 0, gap: 0, unmeasured: 0, 'n/a': 0 };
}

/** The layer a resolved value came from, in words: the capability's default, a layer table's entry, or the scenario. */
function layerWords(from: string | undefined, view: MatrixView): string {
  if (from === undefined) return '';
  if (from === 'capability') return 'capability default';
  if (from === 'scenario') return 'this scenario';
  const dot = from.indexOf('.');
  const table = from.slice(0, dot);
  const key = from.slice(dot + 1);
  const layer = view.layers.find(each => each.table === table);
  return `${table} · ${layer?.names[key] ?? key}`;
}

/** A scenario field's value, with the name its layer table gives it where the field keys a layer. */
function fieldWords(field: string, value: string, view: MatrixView): string {
  const name = view.layers.find(layer => layer.field === field)?.names[value];
  return name && name !== value ? `${name} (${value})` : value;
}

/** The issues linked to one cell, one row or one column, each once, lowest number first. */
function linkedTo(view: MatrixView, scenario: string | undefined, capability: string | undefined): MatrixIssueLink[] {
  return view.issues
    .filter(issue => issue.refs.some(ref => ref.scenario === scenario && ref.capability === capability))
    .sort((a, b) => a.id - b.id);
}

/** One linked issue as a mark: its type's glyph, struck faint once it is completed. */
function IssueBadge({ issue, onIssue }: { issue: MatrixIssueLink; onIssue: (id: number) => void }) {
  const said = `#${issue.id} ${issue.title} · ${issue.closed ? 'completed' : 'open'} ${issue.type}`;
  return (
    <button class={`matrixbadge issuetype-${issue.type}${issue.closed ? ' closed' : ''}`} title={said} aria-label={said}
      onClick={(e: Event) => { e.stopPropagation(); onIssue(issue.id); }}>
      <Glyph of={issue.type} />
    </button>
  );
}

function Badges({ issues, onIssue }: { issues: MatrixIssueLink[]; onIssue: (id: number) => void }) {
  if (issues.length === 0) return null;
  return <span class="matrixbadges">{issues.map(issue => <IssueBadge key={issue.id} issue={issue} onIssue={onIssue} />)}</span>;
}

/**
 * The capability matrices in `.devharness/matrix/`, read-only: a list of the
 * matrices, a grid per matrix with scenarios down and capabilities across,
 * and a page per cell, row and column.
 *
 * The list and the open matrix are read again every few seconds, as the
 * Issues tab reads its issues: the server drops its resolved copy of a matrix
 * on every change the store reports, and the issue links are read fresh on
 * every call.
 *
 * `onPlace` moves the address, so back returns from a cell to the grid and
 * from the grid to the list. `onSequence` opens a sequence on the Sequence
 * tab, `onIssue` an issue on the Issues tab.
 */
export function Matrix({ base, at, onPlace, onIssue, onSequence }: {
  base: string;
  at: MatrixAt;
  onPlace: (at: MatrixAt, replace?: boolean) => void;
  onIssue: (id: number) => void;
  onSequence: (name: string) => void;
}) {
  if (at.matrix === null) return <MatrixList base={base} onOpen={name => onPlace({ matrix: name, scenario: null, capability: null })} />;
  return <OpenMatrix key={at.matrix} base={base} name={at.matrix} at={at} onPlace={onPlace} onIssue={onIssue} onSequence={onSequence} />;
}

function MatrixList({ base, onOpen }: { base: string; onOpen: (name: string) => void }) {
  const [matrices, setMatrices] = useState<MatrixListRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [reading, setReading] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const poll = async () => {
      const res = await fetch(`${base}/matrix`).catch(() => null);
      if (!live) return;
      if (res?.ok) { setMatrices(await res.json()); setFailed(false); } else setFailed(true);
    };
    void poll();
    const timer = setInterval(poll, 3000);
    return () => { live = false; clearInterval(timer); };
  }, [base]);

  if (!matrices) return failed ? <p class="hint nothing">the matrices did not load</p> : <div class="hint">reading the matrices…</div>;
  if (matrices.length === 0) {
    return (
      <p class="hint nothing">
        No matrix in the store. <code>matrix({'{'} action: 'import', path {'}'})</code> copies one into <code>.devharness/matrix/</code>.
      </p>
    );
  }
  return (
    <section class="matrices">
      <div class="sectionhead">matrices <span class="quiet">{matrices.length}</span></div>
      <ol class="activitycards">
        {matrices.map(matrix => (
          <Row key={matrix.name} classes={matrix.problem ? ['matrixrow', 'matrixrow-broken'] : ['matrixrow']}
            source={matrix.problem ? 'broken' : `${matrix.scenarios} × ${matrix.capabilities}`}
            sourceTitle={matrix.problem ? undefined : `${matrix.scenarios} scenarios × ${matrix.capabilities} capabilities`}
            label={<>
              <span class="seqname">{matrix.name}</span>
              {matrix.about && <span class="what seqwhat">{matrix.about}</span>}
            </>}
            title={matrix.about}
            reading={matrix.problem ? <span class="bad">does not read</span> : <Counts counts={matrix.cells} />}
            columns={['open']}
            slots={{ open: () => onOpen(matrix.name) }}
            titles={{ open: 'open this matrix as a grid' }}
            open={reading === matrix.name}
            onOpen={() => setReading(reading === matrix.name ? null : matrix.name)}>
            <div class="matrixreadme">
              {matrix.problem && <p class="bad">{matrix.problem}</p>}
              {matrix.about && <p class="matrixabout">{matrix.about}</p>}
              {!matrix.problem && (
                <p class="matrixstandings">
                  {STANDINGS.map(standing => (
                    <span key={standing} class="matrixcount"><StandingMark standing={standing} />{matrix.cells[standing]} {standing}</span>
                  ))}
                </p>
              )}
              <button class="linkbtn" onClick={() => onOpen(matrix.name)}>Open the grid</button>
            </div>
          </Row>
        ))}
      </ol>
    </section>
  );
}

/** The grid's filters: one per layer field, then the fields matrix.html filters on where the file holds them. */
interface Filters {
  fields: Record<string, string>;
  standing: MatrixStanding | '';
  faults: boolean;
}

/** Scenario fields with a filter of their own beside the layer fields, where any scenario holds one. */
const PLAIN_FILTERS = ['page'];

/** Where the glance view's choice is kept, so the grid opens the way it was left. */
const GLANCE_KEY = 'bench.matrix.glance';

function OpenMatrix({ base, name, at, onPlace, onIssue, onSequence }: {
  base: string; name: string; at: MatrixAt;
  onPlace: (at: MatrixAt, replace?: boolean) => void;
  onIssue: (id: number) => void;
  onSequence: (name: string) => void;
}) {
  const [read, setRead] = useState<MatrixRead | null>(null);
  const [failed, setFailed] = useState(false);
  const [sequences, setSequences] = useState<string[] | null>(null);
  const [filters, setFilters] = useState<Filters>({ fields: {}, standing: '', faults: false });
  const gridScroll = useRef<GridScroll>({ left: 0, top: 0, page: 0 });
  const [glance, setGlance] = useState(() => localStorage.getItem(GLANCE_KEY) === 'on');
  const chooseGlance = (on: boolean) => {
    setGlance(on);
    gridScroll.current = { ...gridScroll.current, left: 0, top: 0 };
    localStorage.setItem(GLANCE_KEY, on ? 'on' : 'off');
  };

  useEffect(() => {
    let live = true;
    const poll = async () => {
      const res = await fetch(`${base}/matrix/read?name=${encodeURIComponent(name)}`).catch(() => null);
      if (!live) return;
      if (res?.ok) { setRead(await res.json()); setFailed(false); } else setFailed(true);
    };
    void poll();
    const timer = setInterval(poll, 3000);
    return () => { live = false; clearInterval(timer); };
  }, [base, name]);

  // The sequence names a `sequence:` basis is checked against.
  useEffect(() => {
    let live = true;
    fetch(`${base}/tools/values`)
      .then(res => (res.ok ? res.json() : null))
      .then((values: { sequences?: string[] } | null) => { if (live) setSequences(values?.sequences ?? []); })
      .catch(() => { if (live) setSequences([]); });
    return () => { live = false; };
  }, [base, name]);

  const toList = <button class="issueback" onClick={() => onPlace({ matrix: null, scenario: null, capability: null })}>‹ Matrices</button>;

  if (!read) return failed ? <p class="hint nothing">the matrix did not load</p> : <div class="hint">reading the matrix…</div>;
  if ('missing' in read) {
    return (
      <div class="matrixpage">
        {toList}
        <p class="hint nothing">No matrix named <code>{name}</code> is in the store.</p>
      </div>
    );
  }
  if ('broken' in read) {
    return (
      <div class="matrixpage">
        {toList}
        <h2 class="issuepagetitle">{name}</h2>
        <p class="bad">{read.problem}</p>
      </div>
    );
  }

  const view = read.view;
  const place = (scenario: string | null, capability: string | null) => onPlace({ matrix: name, scenario, capability });
  const back = <button class="issueback" onClick={() => place(null, null)}>‹ {name}</button>;
  const scenario = at.scenario === null ? undefined : view.scenarios.find(each => each.id === at.scenario);
  const capability = at.capability === null ? undefined : view.capabilities.find(each => each.id === at.capability);

  if ((at.scenario !== null && !scenario) || (at.capability !== null && !capability)) {
    return (
      <div class="matrixpage">
        {back}
        <p class="hint nothing">
          {at.scenario !== null && !scenario ? <>No scenario <code>{at.scenario}</code></> : <>No capability <code>{at.capability}</code></>} in {name}.
        </p>
      </div>
    );
  }
  const page = scenario && capability
    ? <CellPage base={base} view={view} scenarioId={scenario.id} capabilityId={capability.id} back={back} sequences={sequences}
        onPlace={place} onIssue={onIssue} onSequence={onSequence} />
    : scenario
      ? <RowPage base={base} view={view} scenarioId={scenario.id} back={back} sequences={sequences}
          onPlace={place} onIssue={onIssue} onSequence={onSequence} />
      : capability
        ? <ColumnPage base={base} view={view} capabilityId={capability.id} back={back} sequences={sequences}
            onPlace={place} onIssue={onIssue} onSequence={onSequence} />
        : <Grid view={view} toList={toList} filters={filters} onFilters={setFilters} onPlace={place} onIssue={onIssue} scroll={gridScroll} glance={glance} onGlance={chooseGlance} />;
  return <>{page}<ActivityDrawer base={base} view={view} onPlace={place} /></>;
}

function ago(at: string): string {
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(at)) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

const ACTIVITY_SOURCES: Record<string, string> = {
  bench: 'in the bench',
  session: 'by a session',
  cli: 'from the CLI',
  file: 'in the file',
};

/** Cell values one entry lists before the rest fold into a count. */
const CHANGES_SHOWN = 12;

/**
 * The changes logged for the open matrix, in a drawer on the pane's right
 * edge: a tab that stays in reach on the grid and on every cell, row and
 * column page, and behind it each change with its time, the channel it came
 * in on, and each cell value before and after. A change's cell opens that
 * cell's page with the drawer left open. The log is read while the drawer is
 * open and not before.
 */
function ActivityDrawer({ base, view, onPlace }: {
  base: string; view: MatrixView;
  onPlace: (scenario: string | null, capability: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<MatrixActivityRow[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    let live = true;
    const poll = async () => {
      const res = await fetch(`${base}/matrix/activity?name=${encodeURIComponent(view.name)}`).catch(() => null);
      if (!live) return;
      if (res?.ok) { setRows(await res.json()); setFailed(false); } else setFailed(true);
    };
    void poll();
    const timer = setInterval(poll, 3000);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => { live = false; clearInterval(timer); document.removeEventListener('keydown', onKey); };
  }, [open, base, view.name]);

  const scenarioName = (id: string) => view.scenarios.find(each => each.id === id)?.name ?? id;
  const capabilityName = (id: string) => view.capabilities.find(each => each.id === id)?.name ?? id;
  const inMatrix = (scenario: string, capability: string) =>
    view.scenarios.some(each => each.id === scenario) && view.capabilities.some(each => each.id === capability);
  const value = (text: string | undefined) => (text === undefined ? <span class="quiet">nothing</span> : <span class="matrixlogvalue">{text}</span>);

  return (
    <>
      <button class={`matrixlogtab${open ? ' on' : ''}`} aria-expanded={open} aria-controls="matrixlog"
        title={open ? 'close the activity log' : `what changed on ${view.name}, and when`}
        onClick={() => setOpen(!open)}>
        <Glyph of="history" /><span>Activity</span>
      </button>
      <aside id="matrixlog" class={`matrixlog${open ? ' open' : ''}`} aria-label={`Activity on ${view.name}`} aria-hidden={!open} inert={!open}>
        <div class="matrixloghead">
          <span class="matrixlisthead">Activity <span class="quiet">{view.name}</span></span>
          <button class="matrixlogclose" aria-label="close the activity log" onClick={() => setOpen(false)}>×</button>
        </div>
        {!rows && (failed ? <p class="hint nothing">the activity did not load</p> : <p class="hint">reading the activity…</p>)}
        {rows && rows.length === 0 && (
          <p class="hint nothing">No change is logged yet. A change made from here on shows: a standing pressed in the bench, an edit through the tool, an import, a write to the file.</p>
        )}
        {rows && rows.length > 0 && (
          <ol class="matrixlogrows">
            {rows.map((row, at) => (
              <li key={`${row.at}-${at}`} class="matrixlogrow">
                <div class="matrixlogwhen" title={new Date(row.at).toLocaleString()}>
                  <span>{ago(row.at)}</span>
                  <span class="quiet">{new Date(row.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} · {ACTIVITY_SOURCES[row.by] ?? row.by}{row.cause === 'import' ? ' · import' : ''}</span>
                </div>
                {row.notes?.map(note => <p key={note} class="matrixlognote">{note}</p>)}
                {row.changes.slice(0, CHANGES_SHOWN).map(change => (
                  <div key={`${change.scenario}/${change.capability}/${change.field}`} class="matrixlogchange">
                    {inMatrix(change.scenario, change.capability)
                      ? <button class="linkbtn" title="open this cell" onClick={() => onPlace(change.scenario, change.capability)}>
                          {scenarioName(change.scenario)} × {capabilityName(change.capability)}
                        </button>
                      : <span>{change.scenario} × {change.capability}</span>}
                    <div class="matrixlogfield">
                      <span class="quiet">{change.field === 'today' ? 'status' : change.field}</span> {value(change.from)} → {value(change.to)}
                    </div>
                  </div>
                ))}
                {row.changes.length > CHANGES_SHOWN && <p class="matrixlognote">and {row.changes.length - CHANGES_SHOWN} more cell values</p>}
              </li>
            ))}
          </ol>
        )}
      </aside>
    </>
  );
}

/** Where the grid stood when it last left the screen: its own scroll box, and the page under it. */
interface GridScroll { left: number; top: number; page: number }

function Grid({ view, toList, filters, onFilters, onPlace, onIssue, scroll, glance, onGlance }: {
  view: MatrixView;
  toList: JSX.Element;
  /** Held by the open matrix, which outlives the grid, so a return from a cell, row or column page lands where the grid was left. */
  scroll: { current: GridScroll };
  /** The marks alone: no cell text, no row or column sublines, column names leaning at 45 degrees. */
  glance: boolean;
  onGlance: (on: boolean) => void;
  filters: Filters;
  onFilters: (filters: Filters) => void;
  onPlace: (scenario: string | null, capability: string | null) => void;
  onIssue: (id: number) => void;
}) {
  // The row and the column the glance view shows in full: those of the header
  // or the cell under the pointer, taken after a short rest so a sweep across
  // the grid opens nothing on the way. Opening a line resizes the lines before
  // it, so the element under the pointer is measured before the change and the
  // grid scrolled by what it moved, which leaves it under the pointer.
  const [openColumn, setOpenColumn] = useState<string | null>(null);
  const [openRow, setOpenRow] = useState<string | null>(null);
  const resting = useRef<number | undefined>(undefined);
  const held = useRef<{ element: Element; left: number; top: number } | null>(null);
  const pointed = useRef<Element | null>(null);
  const open = (element: Element | null, row: string | null, column: string | null) => {
    const at = element?.getBoundingClientRect();
    held.current = element && at ? { element, left: at.left, top: at.top } : null;
    setOpenRow(row);
    setOpenColumn(column);
  };
  const over = (element: Element, row: string | null, column: string | null) => {
    if (!glance) return;
    window.clearTimeout(resting.current);
    resting.current = window.setTimeout(() => { pointed.current = element; open(element, row, column); }, 140);
  };
  const left = () => {
    window.clearTimeout(resting.current);
    resting.current = window.setTimeout(() => open(pointed.current, null, null), 120);
  };
  useEffect(() => () => window.clearTimeout(resting.current), []);
  useEffect(() => { if (!glance) open(null, null, null); }, [glance]);

  const wrap = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const kept = held.current;
    held.current = null;
    if (!kept || !wrap.current || !kept.element.isConnected) return;
    const now = kept.element.getBoundingClientRect();
    wrap.current.scrollLeft += now.left - kept.left;
    wrap.current.scrollTop += now.top - kept.top;
  }, [openRow, openColumn]);
  useLayoutEffect(() => {
    const box = wrap.current;
    if (!box) return;
    box.scrollLeft = scroll.current.left;
    box.scrollTop = scroll.current.top;
    window.scrollTo(window.scrollX, scroll.current.page);
    const keep = () => { scroll.current = { left: box.scrollLeft, top: box.scrollTop, page: window.scrollY }; };
    box.addEventListener('scroll', keep, { passive: true });
    window.addEventListener('scroll', keep, { passive: true });
    return () => { box.removeEventListener('scroll', keep); window.removeEventListener('scroll', keep); };
  }, []);
  const valuesOf = (field: string): string[] =>
    [...new Set(view.scenarios.flatMap(scenario => (field in scenario.fields ? [scenario.fields[field]] : [])))].sort();
  const plain = PLAIN_FILTERS.filter(field => valuesOf(field).length > 0);
  const hasFaults = view.scenarios.some(scenario => 'fault' in scenario.fields);
  const filtered = [...view.layers.map(layer => layer.field), ...plain];

  const rows = view.scenarios.filter(scenario =>
    filtered.every(field => !filters.fields[field] || scenario.fields[field] === filters.fields[field])
    && (!filters.faults || !!scenario.fields.fault)
    && (!filters.standing || view.capabilities.some(capability => view.cells[scenario.id][capability.id].today === filters.standing)));

  const counts = Object.fromEntries(view.capabilities.map(capability => {
    const tally = emptyCounts();
    for (const scenario of rows) tally[view.cells[scenario.id][capability.id].today]++;
    return [capability.id, tally];
  }));

  // Under a standing filter, a column none of whose shown cells stands there holds nothing to read and shuts to a sliver.
  const shut = new Set(filters.standing
    ? view.capabilities.filter(capability => counts[capability.id][filters.standing as MatrixStanding] === 0).map(capability => capability.id)
    : []);

  const choose = (field: string, value: string) => onFilters({ ...filters, fields: { ...filters.fields, [field]: value } });

  return (
    <div class={`matrixpage${glance ? ' glance' : ''}`}>
      {toList}
      <div class="matrixhead">
        <h2 class="matrixtitle">{view.name}</h2>
        <span class="quiet">{rows.length} of {view.scenarios.length} scenarios</span>
      </div>
      {view.about && <p class="matrixabout">{view.about}</p>}
      <div class="matrixfilters">
        {view.layers.map(layer => (
          <select key={layer.field} class="issueeditfield" aria-label={`Filter by ${layer.field}`}
            value={filters.fields[layer.field] ?? ''}
            onChange={(e: Event) => choose(layer.field, (e.target as HTMLSelectElement).value)}>
            <option value="">Any {layer.field}</option>
            {valuesOf(layer.field).map(value => <option key={value} value={value}>{layer.names[value] ?? value}</option>)}
          </select>
        ))}
        {plain.map(field => (
          <select key={field} class="issueeditfield" aria-label={`Filter by ${field}`}
            value={filters.fields[field] ?? ''}
            onChange={(e: Event) => choose(field, (e.target as HTMLSelectElement).value)}>
            <option value="">Any {field}</option>
            {valuesOf(field).map(value => <option key={value} value={value}>{value}</option>)}
          </select>
        ))}
        <select class="issueeditfield" aria-label="Filter by standing" value={filters.standing}
          onChange={(e: Event) => onFilters({ ...filters, standing: (e.target as HTMLSelectElement).value as Filters['standing'] })}>
          <option value="">Any standing</option>
          {STANDINGS.map(standing => <option key={standing} value={standing}>Only {standing}</option>)}
        </select>
        {hasFaults && (
          <label class="matrixcheck">
            <input type="checkbox" checked={filters.faults}
              onChange={(e: Event) => onFilters({ ...filters, faults: (e.target as HTMLInputElement).checked })} /> Faults only
          </label>
        )}
        <button class={`matrixglance${glance ? ' on' : ''}`} role="switch" aria-checked={glance}
          title={glance ? 'show the cell text, the counts and the issue marks again' : 'show the marks alone, with the column names leaning at 45 degrees'}
          onClick={() => onGlance(!glance)}>
          Glance
        </button>
      </div>
      <div class="matrixwrap" ref={wrap}>
        <table class="matrixgrid">
          <thead>
            <tr>
              <th class="matrixcorner" scope="col">Scenario</th>
              {view.capabilities.map(capability => (
                <th key={capability.id} scope="col" class={`matrixcolhead${openColumn === capability.id ? ' colopen' : ''}${shut.has(capability.id) ? ' colshut' : ''}`}
                  title={shut.has(capability.id) ? `${capability.name ?? capability.id}: no ${filters.standing} cell in the rows shown` : capability.question}
                  onMouseEnter={(e: Event) => over(e.currentTarget as Element, null, capability.id)} onMouseLeave={left}>
                  <button class="matrixheadbtn" onClick={() => onPlace(null, capability.id)}
                    onFocus={(e: Event) => over((e.currentTarget as Element).parentElement!, null, capability.id)} onBlur={left}>{capability.name ?? capability.id}</button>
                  <Counts counts={counts[capability.id]} />
                  <Badges issues={linkedTo(view, undefined, capability.id)} onIssue={onIssue} />
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(scenario => (
              <tr key={scenario.id} class={openRow === scenario.id ? 'rowopen' : undefined}>
                <th scope="row" class="matrixrowhead" onMouseEnter={(e: Event) => over(e.currentTarget as Element, scenario.id, null)} onMouseLeave={left}>
                  <button class="matrixheadbtn" title={scenario.name ?? scenario.id} onClick={() => onPlace(scenario.id, null)}
                    onFocus={(e: Event) => over((e.currentTarget as Element).parentElement!, scenario.id, null)} onBlur={left}>
                    {scenario.name ?? scenario.id}
                  </button>
                  {view.layers.some(layer => layer.field in scenario.fields) && (
                    <span class="matrixrowsub">
                      {view.layers.filter(layer => layer.field in scenario.fields)
                        .map(layer => layer.names[scenario.fields[layer.field]] ?? scenario.fields[layer.field]).join(' · ')}
                    </span>
                  )}
                  <Badges issues={linkedTo(view, scenario.id, undefined)} onIssue={onIssue} />
                </th>
                {view.capabilities.map(capability => {
                  const cell = view.cells[scenario.id][capability.id];
                  return (
                    <td key={capability.id} class={`matrixcell ${standingClass(cell.today)}${openColumn === capability.id ? ' colopen' : ''}${filters.standing && cell.today !== filters.standing ? ' faded' : ''}${shut.has(capability.id) ? ' colshut' : ''}`}
                      onMouseEnter={(e: Event) => over(e.currentTarget as Element, scenario.id, capability.id)} onMouseLeave={left}>
                      <button class="matrixcellbtn" onFocus={(e: Event) => over((e.currentTarget as Element).parentElement!, scenario.id, capability.id)} onBlur={left}
                        title={`${scenario.name ?? scenario.id} × ${capability.name ?? capability.id}: ${cell.today}${cell.expect ? ` · ${cell.expect}` : ''}`}
                        onClick={() => onPlace(scenario.id, capability.id)}>
                        <StandingMark standing={cell.today} />
                        {cell.expect && <span class="matrixcelltext">{cell.expect}</span>}
                      </button>
                      <Badges issues={linkedTo(view, scenario.id, capability.id)} onIssue={onIssue} />
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p class="matrixlegend">
        {STANDINGS.map(standing => <span key={standing}><StandingMark standing={standing} /> {standing}</span>)}
        <span><span class="issuetype-bug"><Glyph of="bug" /></span> bug</span>
        <span><span class="issuetype-feature"><Glyph of="feature" /></span> feature</span>
        <span><span class="matrixbadge closed"><Glyph of="bug" /></span> completed</span>
      </p>
    </div>
  );
}

/** A `sequence:<name>` basis opens that sequence; one the bench cannot find, and any other basis, reads as plain text. */
function Basis({ basis, sequences, onSequence }: { basis: string; sequences: string[] | null; onSequence: (name: string) => void }) {
  if (!basis.startsWith('sequence:')) return <span class="issuemono">{basis}</span>;
  const name = basis.slice('sequence:'.length);
  if (sequences === null) return <span class="issuemono">{basis}</span>;
  if (!sequences.includes(name)) {
    return <span class="issuemono">{basis} <span class="matrixmissing" title="no saved sequence carries this name">not found</span></span>;
  }
  return (
    <span class="issuemono">sequence:<button class="linkbtn" title={`open ${name} on the Sequence tab`} onClick={() => onSequence(name)}>{name}</button></span>
  );
}

/** One field of a cell with the layer it came from. */
function CellField({ label, from, view, children }: { label: string; from?: string; view: MatrixView; children: ComponentChildren }) {
  return (
    <section>
      <h3>{label}{from && <span class="matrixfrom"> · from {layerWords(from, view)}</span>}</h3>
      {children}
    </section>
  );
}

function CellFacts({ cell, view, sequences, onSequence }: {
  cell: MatrixCellView; view: MatrixView; sequences: string[] | null; onSequence: (name: string) => void;
}) {
  return (
    <>
      <CellField label="Today" from={cell.from.today} view={view}>
        <p class="matrixstanding"><StandingMark standing={cell.today} /> {cell.today}</p>
      </CellField>
      <CellField label="Expect" from={cell.from.expect} view={view}>
        {cell.expect ? <p>{cell.expect}</p> : <p class="quiet">None written</p>}
      </CellField>
      <CellField label="Basis" from={cell.from.basis} view={view}>
        {cell.basis ? <p><Basis basis={cell.basis} sequences={sequences} onSequence={onSequence} /></p> : <p class="quiet">None written</p>}
      </CellField>
      <CellField label="Note" from={cell.from.note} view={view}>
        {cell.note ? <p>{cell.note}</p> : <p class="quiet">None written</p>}
      </CellField>
    </>
  );
}

function ScenarioFacts({ view, scenarioId }: { view: MatrixView; scenarioId: string }) {
  const scenario = view.scenarios.find(each => each.id === scenarioId)!;
  return (
    <section>
      <h3>Scenario</h3>
      <p><b>{scenario.name ?? scenario.id}</b> <span class="issuemono quiet">{scenario.id}</span></p>
      {Object.keys(scenario.fields).length > 0 && (
        <dl class="matrixfields">
          {Object.entries(scenario.fields).map(([field, value]) => (
            <Fragment key={field}><dt>{field}</dt><dd>{fieldWords(field, value, view)}</dd></Fragment>
          ))}
        </dl>
      )}
    </section>
  );
}

function CapabilityFacts({ view, capabilityId }: { view: MatrixView; capabilityId: string }) {
  const capability = view.capabilities.find(each => each.id === capabilityId)!;
  return (
    <section>
      <h3>Capability</h3>
      <p><b>{capability.name ?? capability.id}</b> <span class="issuemono quiet">{capability.id}</span></p>
      {capability.question && <p class="matrixquestion">{capability.question}</p>}
      {capability.rule && <p class="matrixrule">{capability.rule}</p>}
    </section>
  );
}

/** Linked issues as a list, each labelled with the area its link names where more than one group is listed. */
function IssueList({ groups, onIssue }: {
  groups: Array<{ kind: 'cell' | 'row' | 'column'; issues: MatrixIssueLink[] }>;
  onIssue: (id: number) => void;
}) {
  const all = groups.flatMap(group => group.issues.map(issue => ({ kind: group.kind, issue })));
  return (
    <section>
      <h3>Issues</h3>
      {all.length === 0 ? <p class="quiet">None linked</p> : (
        <ul class="issuelinks">
          {all.map(({ kind, issue }) => (
            <li key={`${kind}-${issue.id}`} class="issuelinkrow">
              <StateMark shut={issue.closed} />
              <span class={`issuetype-${issue.type}`}><Glyph of={issue.type} /></span>
              <button class="issuereftitle" title={`open #${issue.id} on the Issues tab`} onClick={() => onIssue(issue.id)}>
                <span class="quiet">#{issue.id}</span> {issue.title}
              </button>
              {groups.length > 1 && <span class="matrixlinkkind">{kind}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface PageProps {
  base: string;
  view: MatrixView;
  back: JSX.Element;
  sequences: string[] | null;
  onPlace: (scenario: string | null, capability: string | null) => void;
  onIssue: (id: number) => void;
  onSequence: (name: string) => void;
}

function CellPage({ base, view, scenarioId, capabilityId, back, sequences, onPlace, onIssue, onSequence }: PageProps & { scenarioId: string; capabilityId: string }) {
  const scenario = view.scenarios.find(each => each.id === scenarioId)!;
  const capability = view.capabilities.find(each => each.id === capabilityId)!;
  const cell = view.cells[scenarioId][capabilityId];
  const [chosen, setChosen] = useState<MatrixStanding | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  useEffect(() => { if (chosen === cell.today) setChosen(null); }, [cell.today]);
  const standing = chosen ?? cell.today;
  const choose = async (today: MatrixStanding) => {
    if (today === standing) return;
    setChosen(today);
    setRefusal(null);
    const res = await fetch(`${base}/matrix/standing`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: view.name, scenario: scenarioId, capability: capabilityId, today }),
    }).catch(() => null);
    const answer: { failure?: string } | null = res?.ok ? await res.json() : null;
    if (answer && !answer.failure) return;
    setChosen(null);
    setRefusal(answer?.failure ?? 'The standing was not written: the bench did not answer.');
  };
  return (
    <div class="matrixpage">
      {back}
      <h2 class="issuepagetitle">
        <button class="matrixtitlebtn" title="open this row" onClick={() => onPlace(scenarioId, null)}>{scenario.name ?? scenario.id}</button>
        {' × '}
        <button class="matrixtitlebtn" title="open this column" onClick={() => onPlace(null, capabilityId)}>{capability.name ?? capability.id}</button>
      </h2>
      <div class="issuepagesub">
        <span class="matrixchoose" role="radiogroup" aria-label="standing">
          {STANDINGS.map(each => (
            <button key={each} role="radio" aria-checked={each === standing}
              class={`matrixstate ${standingClass(each)}${each === standing ? ' on' : ''}`}
              title={each === standing ? `stands at ${each}` : `set this cell to ${each}`}
              onClick={() => void choose(each)}>
              <StandingMark standing={each} /> {each}
            </button>
          ))}
        </span>
        <span class="issuemono">{view.name}#{scenarioId}/{capabilityId}</span>
      </div>
      {refusal && <p class="bad">{refusal}</p>}
      <div class="issueside-facts matrixfacts">
        <CellFacts cell={cell} view={view} sequences={sequences} onSequence={onSequence} />
        <IssueList onIssue={onIssue} groups={[
          { kind: 'cell', issues: linkedTo(view, scenarioId, capabilityId) },
          { kind: 'row', issues: linkedTo(view, scenarioId, undefined) },
          { kind: 'column', issues: linkedTo(view, undefined, capabilityId) },
        ]} />
        <ScenarioFacts view={view} scenarioId={scenarioId} />
        <CapabilityFacts view={view} capabilityId={capabilityId} />
      </div>
    </div>
  );
}

/** One cell as a line of a row's or a column's list: its mark, the other axis's name, and the cell's own words. */
function CellLine({ label, cell, issues, sequences, onOpen, onIssue, onSequence }: {
  label: string; cell: MatrixCellView; issues: MatrixIssueLink[]; sequences: string[] | null;
  onOpen: () => void; onIssue: (id: number) => void; onSequence: (name: string) => void;
}) {
  return (
    <li class="issueline matrixline">
      <StandingMark standing={cell.today} />
      <div class="issuemain">
        <div class="issuetitleline">
          <button class="issuetitle" onClick={onOpen}>{label}</button>
          <Badges issues={issues} onIssue={onIssue} />
        </div>
        {cell.expect && <div class="matrixlineexpect">{cell.expect}</div>}
        {(cell.basis || cell.note) && (
          <div class="issuesub">
            {cell.basis && <Basis basis={cell.basis} sequences={sequences} onSequence={onSequence} />}
            {cell.basis && cell.note && ' · '}
            {cell.note}
          </div>
        )}
      </div>
    </li>
  );
}

function RowPage({ view, scenarioId, back, sequences, onPlace, onIssue, onSequence }: PageProps & { scenarioId: string }) {
  const scenario = view.scenarios.find(each => each.id === scenarioId)!;
  const counts = emptyCounts();
  for (const capability of view.capabilities) counts[view.cells[scenarioId][capability.id].today]++;
  return (
    <div class="matrixpage">
      {back}
      <h2 class="issuepagetitle">{scenario.name ?? scenario.id}</h2>
      <div class="issuepagesub">
        <span>row · <Counts counts={counts} /></span>
        <span class="issuemono">{view.name}#{scenarioId}</span>
      </div>
      <div class="issueside-facts matrixfacts">
        <ScenarioFacts view={view} scenarioId={scenarioId} />
        <IssueList onIssue={onIssue} groups={[{ kind: 'row', issues: linkedTo(view, scenarioId, undefined) }]} />
      </div>
      <div class="issuebox">
        <div class="issueboxhead"><span class="matrixlisthead">{view.capabilities.length} cells</span></div>
        <ol class="issuelist">
          {view.capabilities.map(capability => (
            <CellLine key={capability.id} label={capability.name ?? capability.id} cell={view.cells[scenarioId][capability.id]}
              issues={linkedTo(view, scenarioId, capability.id)} sequences={sequences}
              onOpen={() => onPlace(scenarioId, capability.id)} onIssue={onIssue} onSequence={onSequence} />
          ))}
        </ol>
      </div>
    </div>
  );
}

function ColumnPage({ view, capabilityId, back, sequences, onPlace, onIssue, onSequence }: PageProps & { capabilityId: string }) {
  const capability = view.capabilities.find(each => each.id === capabilityId)!;
  const counts = emptyCounts();
  for (const scenario of view.scenarios) counts[view.cells[scenario.id][capabilityId].today]++;
  return (
    <div class="matrixpage">
      {back}
      <h2 class="issuepagetitle">{capability.name ?? capability.id}</h2>
      <div class="issuepagesub">
        <span>column · <Counts counts={counts} /></span>
        <span class="issuemono">{view.name}#/{capabilityId}</span>
      </div>
      <div class="issueside-facts matrixfacts">
        <CapabilityFacts view={view} capabilityId={capabilityId} />
        <IssueList onIssue={onIssue} groups={[{ kind: 'column', issues: linkedTo(view, undefined, capabilityId) }]} />
      </div>
      <div class="issuebox">
        <div class="issueboxhead"><span class="matrixlisthead">{view.scenarios.length} cells</span></div>
        <ol class="issuelist">
          {view.scenarios.map(scenario => (
            <CellLine key={scenario.id} label={scenario.name ?? scenario.id} cell={view.cells[scenario.id][capabilityId]}
              issues={linkedTo(view, scenario.id, capabilityId)} sequences={sequences}
              onOpen={() => onPlace(scenario.id, capabilityId)} onIssue={onIssue} onSequence={onSequence} />
          ))}
        </ol>
      </div>
    </div>
  );
}
