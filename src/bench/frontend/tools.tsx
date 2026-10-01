/** @jsxImportSource preact */
import { h, Fragment, type ComponentChildren } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { ToolGlyph } from './tool-glyph.js';
import { Glyph } from './glyph.js';
import { Row } from './row.js';
import { NO_TOOL_VALUES, type ToolCard, type ToolFavourite, type ToolGroup, type ToolRun, type ToolValues } from '../wire.js';

type Schema = Record<string, any>;

/** The schema one payload is built against: the first branch of a union, or the schema itself. */
function branchOf(schema: Schema): Schema {
  return schema.anyOf?.[0] ?? schema.oneOf?.[0] ?? schema;
}

/** A value of the schema's type: its const, default or first enum value where it has one. */
function valueOf(schema: Schema): unknown {
  const branch = branchOf(schema);
  if (branch.const !== undefined) return branch.const;
  if (branch.default !== undefined) return branch.default;
  if (Array.isArray(branch.enum)) return branch.enum[0];
  const type = Array.isArray(branch.type) ? branch.type[0] : branch.type;
  if (type === 'object') return payloadOf(branch);
  if (type === 'array') return [];
  if (type === 'number' || type === 'integer') return 0;
  if (type === 'boolean') return false;
  return '';
}

/**
 * The starting payload: every required property, and `action`, filled with a
 * value of its type. Optional properties stay out, so a grouped tool's
 * payload holds only what its first action needs.
 */
function payloadOf(schema: Schema): Record<string, unknown> {
  const branch = branchOf(schema);
  const required = new Set<string>(branch.required ?? []);
  const payload: Record<string, unknown> = {};
  for (const [name, property] of Object.entries<Schema>(branch.properties ?? {})) {
    if (required.has(name) || name === 'action') payload[name] = valueOf(property);
  }
  return payload;
}

/** A property's type in a few characters: its enum values where it has them. */
function typeOf(schema: Schema): string {
  const branch = branchOf(schema);
  if (Array.isArray(branch.enum)) return branch.enum.map(String).join(' | ');
  const type = Array.isArray(branch.type) ? branch.type.join(' | ') : branch.type;
  if (type === 'array' && branch.items) return `${typeOf(branch.items)}[]`;
  return String(type ?? 'any');
}

/** The description's first sentence, for the row's line. */
function gistOf(description: string): string {
  return description.split(/(?<=\.)\s/)[0] ?? description;
}

/** A grouped tool's actions, from the enum on its `action` property; empty for a tool without one. */
function actionsOf(schema: Schema): string[] {
  const values = branchOf(branchOf(schema).properties?.action ?? {}).enum;
  return Array.isArray(values) ? values.map(String) : [];
}

/**
 * What the tool says of one action, as in `list (list all tabs)`: read from
 * the `action` parameter's description, then from the tool's own, which is
 * where a trimmed schema lists its actions. Empty where neither says anything.
 */
function actionGistOf(tool: ToolCard, action: string): string {
  const escaped = action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const said = new RegExp(`\\b${escaped}\\s*[:(-]\\s*([^),;]+)`);
  const fromAction = String(branchOf(branchOf(tool.inputSchema).properties?.action ?? {}).description ?? '');
  return (fromAction.match(said) ?? tool.description.match(said))?.[1]?.trim() ?? '';
}

/**
 * The folds the tab shows, by what a tool is for. The server groups tools by
 * the toolset config toggles, and since the merge most toolsets hold one tool,
 * so a fold per toolset is a fold per tool. A tool named in no fold here lands
 * in `other`, so a new tool is listed before it is placed.
 */
const PURPOSES: Array<[string, string[]]> = [
  ['connect', ['connection', 'browser', 'server']],
  ['debug', ['breakpoint', 'execution', 'inspect', 'source', 'console']],
  ['page', ['navigate', 'input', 'dom', 'content', 'modal', 'screenshot', 'storage', 'download']],
  ['traffic', ['network', 'proxy', 'hold', 'request']],
  ['sequences', ['replay', 'check', 'assert', 'wait', 'bench']],
  ['project', ['issues', 'message', 'dashboard', 'config']],
];

/** The served tools regrouped into PURPOSES' folds, in that order, with empty folds left out. */
function byPurpose(groups: ToolGroup[]): ToolGroup[] {
  const tools = new Map(groups.flatMap(group => group.tools).map(tool => [tool.name, tool] as const));
  const placed = new Set<string>();
  const folds: ToolGroup[] = PURPOSES.map(([name, names]) => ({
    name,
    tools: names.flatMap(tool => {
      const card = tools.get(tool);
      if (!card) return [];
      placed.add(tool);
      return [card];
    }),
  }));
  folds.push({ name: 'other', tools: [...tools.values()].filter(tool => !placed.has(tool.name)) });
  return folds.filter(fold => fold.tools.length > 0);
}

/** A call to open the tab on: its tool, and the arguments its form starts from. */
export interface ToolSeed {
  tool: string;
  args: Record<string, unknown>;
}

/**
 * The Favourites section's place in the address, where a tool name would go.
 * The star keeps it from matching any tool's name.
 */
const FAVOURITES = '*favourites';

/** Where the tool list's open or shut state is kept, per browser. */
const RAIL_KEY = 'devharness.bench.toolsRail';

function railStartsOpen(): boolean {
  try { return localStorage.getItem(RAIL_KEY) !== 'shut'; } catch { return true; }
}

/** Where the payload JSON's open or folded state is kept, per browser, for every call alike. */
const JSON_KEY = 'devharness.bench.toolsJson';

function jsonStartsOpen(): boolean {
  try { return localStorage.getItem(JSON_KEY) === 'open'; } catch { return false; }
}

/**
 * Every tool this devharness serves: a list on the left, by purpose, and the
 * chosen tool on the right, with its actions as tabs and the chosen action's
 * form, payload, Run, and what the last run returned. History lists a run as a
 * call from the bench. The list shuts to a strip of marks.
 *
 * Drafts and results are held here, keyed by tool and action, so choosing
 * another and coming back keeps what was typed and what came back.
 *
 * `client` is the id this bench's own poll reads the state under, so reading
 * it here confirms that client as primary rather than competing with it.
 *
 * `tool` and `action` are the chosen call, as the bench's address holds them,
 * and `onPlace` moves the address to another; the browser's back and forward
 * move between the calls chosen. With no tool the first one listed opens.
 *
 * `seed` fills one call's draft with its arguments, as a History row's Go to
 * does; the draft key is the same one the form writes under.
 */
export function Tools({ base, client, seed, tool, action: placedAction, onPlace }: {
  base: string;
  client: string;
  seed?: ToolSeed | null;
  tool: string | null;
  action: string | null;
  onPlace: (tool: string, action: string | null) => void;
}) {
  const seedAction = typeof seed?.args.action === 'string' ? seed.args.action : undefined;
  const [groups, setGroups] = useState<ToolGroup[] | null>(null);
  const [failed, setFailed] = useState(false);
  // The action last chosen on each tool, so choosing a tool again opens where it was left.
  const [actionOf, setActionOf] = useState<Record<string, string>>(
    seed && seedAction !== undefined ? { [seed.tool]: seedAction } : {});
  const [filter, setFilter] = useState('');
  const [railOpen, setRailOpen] = useState(railStartsOpen);
  const [jsonShown, setJsonShown] = useState(jsonStartsOpen);
  const [drafts, setDrafts] = useState<Record<string, string>>(() => (seed
    ? { [seedAction === undefined ? seed.tool : `${seed.tool}.${seedAction}`]: JSON.stringify(seed.args, null, 2) }
    : {}));
  const [runs, setRuns] = useState<Record<string, ToolRun | 'running'>>({});
  const [context, setContext] = useState<ToolContext>({ connection: '', pageUrl: '' });
  const [values, setValues] = useState<ToolValues>(NO_TOOL_VALUES);
  const [favourites, setFavourites] = useState<ToolFavourite[]>([]);
  const [readingFavourite, setReadingFavourite] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    fetch(`${base}/favourites`)
      .then(res => (res.ok ? res.json() : []))
      .then((read: ToolFavourite[]) => { if (live) setFavourites(read); })
      .catch(() => {});
    return () => { live = false; };
  }, [base]);

  // Read again whenever a call is chosen, so a payload starts from the page as it is now.
  useEffect(() => {
    let live = true;
    fetch(`${base}/state?client=${encodeURIComponent(client)}`)
      .then(res => (res.ok ? res.json() : null))
      .then((view: { connection: string; pageUrl: string; sequence?: { name?: string } } | null) => {
        if (live && view) setContext({ connection: view.connection, pageUrl: view.pageUrl, sequence: view.sequence?.name });
      })
      .catch(() => {});
    fetch(`${base}/tools/values`)
      .then(res => (res.ok ? res.json() : null))
      .then((read: ToolValues | null) => { if (live && read) setValues(read); })
      .catch(() => {});
    return () => { live = false; };
  }, [base, client, tool, placedAction]);

  useEffect(() => {
    let live = true;
    fetch(`${base}/tools`)
      .then(res => (res.ok ? res.json() : Promise.reject(new Error(String(res.status)))))
      .then(read => { if (live) setGroups(read); })
      .catch(() => { if (live) setFailed(true); });
    return () => { live = false; };
  }, [base]);

  if (failed) return <p class="hint nothing">the tool list did not load</p>;
  if (!groups) return <div class="hint">reading the tools…</div>;

  const keyOf = (tool: string, action?: string) => (action === undefined ? tool : `${tool}.${action}`);

  const draftOf = (tool: ToolCard, action?: string) => drafts[keyOf(tool.name, action)]
    ?? JSON.stringify(startingPayload(tool, action, context), null, 2);

  const run = async (key: string, toolName: string, args: Record<string, unknown>) => {
    setRuns(now => ({ ...now, [key]: 'running' }));
    const result: ToolRun = await fetch(`${base}/tools/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: toolName, args }),
    })
      .then(async res => (res.ok
        ? res.json()
        : { failed: true, result: `The bench answered ${res.status}: ${await res.text()}` }))
      .catch((error: unknown) => ({ failed: true, result: `The bench did not answer: ${String(error)}` }));
    setRuns(now => ({ ...now, [key]: result }));
  };

  const folds = byPurpose(groups);
  const cards = new Map(folds.flatMap(group => group.tools).map(tool => [tool.name, tool] as const));
  const showingFavourites = tool === FAVOURITES;
  const toolName = showingFavourites ? undefined : (tool && cards.has(tool) ? tool : undefined) ?? folds[0]?.tools[0]?.name;
  const card = toolName ? cards.get(toolName) : undefined;
  const actions = card ? actionsOf(card.inputSchema) : [];
  const action = card && actions.length
    ? (placedAction && tool === card.name && actions.includes(placedAction) ? placedAction : actionOf[card.name] ?? actions[0])
    : undefined;

  // A tool is listed while the filter is in its name or in one of its actions'.
  const query = railOpen ? filter.trim().toLowerCase() : '';
  const matching = (tool: ToolCard) => !query || tool.name.toLowerCase().includes(query)
    || actionsOf(tool.inputSchema).some(name => name.toLowerCase().includes(query));
  const shownFolds = folds
    .map(group => ({ ...group, tools: group.tools.filter(matching) }))
    .filter(group => group.tools.length > 0);

  // Choosing a tool the filter reached through an action opens that action.
  const pick = (picked: ToolCard) => {
    const hit = query && !picked.name.toLowerCase().includes(query)
      ? actionsOf(picked.inputSchema).find(name => name.toLowerCase().includes(query))
      : undefined;
    if (hit) setActionOf(now => ({ ...now, [picked.name]: hit }));
    onPlace(picked.name, hit ?? actionOf[picked.name] ?? null);
  };

  const toggleRail = () => {
    const next = !railOpen;
    setRailOpen(next);
    try { localStorage.setItem(RAIL_KEY, next ? 'open' : 'shut'); } catch { /* kept for this page only */ }
  };

  const toggleJson = () => {
    const next = !jsonShown;
    setJsonShown(next);
    try { localStorage.setItem(JSON_KEY, next ? 'open' : 'folded'); } catch { /* kept for this page only */ }
  };

  const failedRun = (key: string) => {
    const last = runs[key];
    return !!last && last !== 'running' && last.failed;
  };

  // A favourite's own key for its last run, apart from the drafts' keys.
  const favouriteKey = (favourite: ToolFavourite) => `${FAVOURITES}.${favourite.id}`;
  // Opened in its tool with its arguments as the draft, to change before running.
  const goToFavourite = (favourite: ToolFavourite) => {
    const favouriteAction = typeof favourite.args.action === 'string' ? favourite.args.action : undefined;
    setDrafts(now => ({ ...now, [keyOf(favourite.tool, favouriteAction)]: JSON.stringify(favourite.args, null, 2) }));
    if (favouriteAction !== undefined) setActionOf(now => ({ ...now, [favourite.tool]: favouriteAction }));
    onPlace(favourite.tool, favouriteAction ?? null);
  };
  const unstar = async (favourite: ToolFavourite) => {
    const res = await fetch(`${base}/favourites/remove`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: favourite.id }),
    }).catch(() => null);
    if (res?.ok) setFavourites(await res.json());
  };

  // Below 640px the rail gives way to this dropdown, in the head of whichever pane is shown.
  const toolPicker = (
    <select class="toolpick" aria-label="Tool" value={showingFavourites ? FAVOURITES : toolName}
      onChange={(e: Event) => {
        const picked = (e.target as HTMLSelectElement).value;
        onPlace(picked, picked === FAVOURITES ? null : actionOf[picked] ?? null);
      }}>
      {/* Chrome's customizable select copies the chosen option, mark included, into
          `selectedcontent`; Preact's JSX types do not list the element. */}
      <button type="button">{h('selectedcontent', null)}</button>
      <optgroup label="yours">
        <option value={FAVOURITES}><Glyph of="starred" /><span>favourites</span></option>
      </optgroup>
      {folds.map(group => (
        <optgroup key={group.name} label={group.name}>
          {group.tools.map(tool => (
            <option key={tool.name} value={tool.name}><ToolGlyph tool={tool.name} /><span>{tool.name}</span></option>
          ))}
        </optgroup>
      ))}
    </select>
  );

  return (
    <div class={railOpen ? 'toolsplit' : 'toolsplit railshut'}>
      <nav class="toolrail" aria-label="Tools">
        <div class="railhead">
          {railOpen && (
            <input class="railfilter" type="search" placeholder="Filter tools and actions" value={filter}
              aria-label="Filter tools and actions"
              onInput={(e: Event) => setFilter((e.target as HTMLInputElement).value)} />
          )}
          <button class="railtoggle" aria-expanded={railOpen}
            title={railOpen ? 'Collapse the tool list' : 'Expand the tool list'}
            aria-label={railOpen ? 'Collapse the tool list' : 'Expand the tool list'}
            onClick={toggleRail}>{railOpen ? '‹' : '›'}</button>
        </div>
        <div class="railgroup">
          {railOpen && <div class="railgrouphead">yours</div>}
          <button class={showingFavourites ? 'toolline chosen' : 'toolline'}
            title={railOpen ? 'Calls starred from History' : 'favourites'}
            aria-current={showingFavourites ? 'true' : undefined}
            onClick={() => onPlace(FAVOURITES, null)}>
            <Glyph of="starred" />
            {railOpen && <span class="toollinename">favourites</span>}
            {railOpen && favourites.length > 0 && <span class="toollinecount">{favourites.length}</span>}
          </button>
        </div>
        {shownFolds.map(group => (
          <div key={group.name} class="railgroup">
            {railOpen && <div class="railgrouphead">{group.name}</div>}
            {group.tools.map(tool => {
              const count = actionsOf(tool.inputSchema).length;
              return (
                <button key={tool.name} class={tool.name === toolName ? 'toolline chosen' : 'toolline'}
                  title={railOpen ? gistOf(tool.description) : tool.name}
                  aria-current={tool.name === toolName ? 'true' : undefined}
                  onClick={() => pick(tool)}>
                  <ToolGlyph tool={tool.name} />
                  {railOpen && <span class="toollinename">{tool.name}</span>}
                  {railOpen && count > 0 && <span class="toollinecount">{count}</span>}
                </button>
              );
            })}
          </div>
        ))}
        {railOpen && shownFolds.length === 0 && <p class="hint">No tool or action matches "{filter.trim()}".</p>}
      </nav>
      <section class="tooldetail">
        {showingFavourites ? (
          <>
            <div class="detailhead">
              <span class="toolmark"><Glyph of="starred" /></span>
              <b class="toolname">favourites</b>
              {toolPicker}
              <span class="toolgist">Calls starred from History: run one as it was, or open it in its tool to change it first.</span>
            </div>
            {favourites.length === 0 ? (
              <p class="hint">Nothing starred yet. Point at a row on the History tab and press its star.</p>
            ) : (
              <ol class="activitycards">
                {favourites.map(favourite => {
                  const key = favouriteKey(favourite);
                  const last = runs[key];
                  return (
                    <Row key={favourite.id}
                      classes={['historyrow', last && last !== 'running' && last.failed ? 'failed' : last === 'running' ? 'running' : '']}
                      source={favourite.tool}
                      label={<span class="what">{favourite.label}</span>}
                      reading={<span class="meta">
                        {last === 'running' ? 'running…' : last ? (last.failed ? <span class="bad">failed</span> : 'ran') : ''}
                      </span>}
                      columns={['here', 'open', 'remove']}
                      slots={{
                        here: () => void run(key, favourite.tool, favourite.args),
                        open: () => goToFavourite(favourite),
                        remove: () => void unstar(favourite),
                      }}
                      titles={{
                        here: 'run this call as it was starred',
                        open: 'open this call in its tool, to change it before running',
                        remove: 'take this call off Favourites',
                      }}
                      open={readingFavourite === favourite.id}
                      onOpen={() => setReadingFavourite(readingFavourite === favourite.id ? null : favourite.id)}>
                      <div class="body historybody">
                        <div class="pbox">
                          <div class="pboxhead">given</div>
                          <pre class="pboxbody">{JSON.stringify(favourite.args, null, 2)}</pre>
                        </div>
                        {last && last !== 'running' && (
                          <div class="pbox">
                            <div class="pboxhead">{last.failed ? <span class="bad">failed</span> : 'returned'}</div>
                            <pre class="pboxbody">{last.result || '(no text)'}</pre>
                          </div>
                        )}
                        <div class="bodyfoot">
                          <span class="footactions">
                            <button class="tool plain" disabled={last === 'running'}
                              onClick={() => void run(key, favourite.tool, favourite.args)}>Run</button>
                          </span>
                        </div>
                      </div>
                    </Row>
                  );
                })}
              </ol>
            )}
          </>
        ) : card ? (
          <>
            <ToolBody key={keyOf(card.name, action)} tool={card}
              toolPicker={toolPicker} action={action} context={context} values={values}
              actions={actions} failedActions={actions.filter(name => failedRun(keyOf(card.name, name)))}
              onAction={name => { setActionOf(now => ({ ...now, [card.name]: name })); onPlace(card.name, name); }}
              draft={draftOf(card, action)} last={runs[keyOf(card.name, action)]}
              jsonShown={jsonShown} onToggleJson={toggleJson}
              onDraft={text => setDrafts(now => ({ ...now, [keyOf(card.name, action)]: text }))}
              onReset={() => setDrafts(now => {
                const { [keyOf(card.name, action)]: _, ...rest } = now;
                return rest;
              })}
              onRun={args => run(keyOf(card.name, action), card.name, args)} />
          </>
        ) : (
          <p class="hint">Choose a tool on the left to fill in and run a call.</p>
        )}
      </section>
    </div>
  );
}

/**
 * The actions a grouped tool's parameter description names, from each sentence
 * that opens with them: `launch/attach: the name ... rename: the new name`
 * names launch, attach and rename. Empty where no sentence opens that way.
 */
function actionsNamedIn(description: string): string[] {
  return [...description.matchAll(/(?:^|[.;]\s+)([A-Za-z]+(?:\/[A-Za-z]+)*):\s/g)].flatMap(match => match[1].split('/'));
}

/**
 * Whether a parameter belongs to `action`: one whose description names
 * actions of this tool belongs to those, and one naming none belongs to every action.
 */
function takenBy(description: string | undefined, action: string | undefined, actions: string[]): boolean {
  if (action === undefined || !description) return true;
  const named = actionsNamedIn(description).filter(name => actions.includes(name));
  return named.length === 0 || named.includes(action);
}

/** What the bench is looking at, for filling a payload's values it already holds. */
export interface ToolContext {
  connection: string;
  pageUrl: string;
  sequence?: string;
}

/**
 * The options `action` takes: its schema's properties, less `action` and those
 * described as another action's. A property in `kept` stays whatever its
 * description names, so a field a run failed on has a row to be marked on.
 */
function optionsOf(tool: ToolCard, action: string | undefined, kept: string[] = []): Array<[string, Schema]> {
  const actions = actionsOf(tool.inputSchema);
  return Object.entries<Schema>(branchOf(tool.inputSchema).properties ?? {})
    .filter(([name]) => action === undefined || name !== 'action')
    .filter(([name, property]) => kept.includes(name) || takenBy(branchOf(property).description, action, actions));
}

/**
 * A value the bench holds for an option, or undefined: the bench's own
 * connection, the page's URL for navigate, the open sequence for a replay that
 * reads one, and a reason saying where the call came from. A connection launch
 * or attach names the connection it creates, so it starts empty.
 */
function knownValue(tool: string, action: string | undefined, name: string, context: ToolContext): unknown {
  if (name === 'connection') return tool === 'connection' && (action === 'launch' || action === 'attach') ? undefined : context.connection;
  if (name === 'url' && tool === 'navigate') return context.pageUrl;
  if (name === 'name' && tool === 'replay' && context.sequence && ['run', 'get', 'export'].includes(action ?? '')) return context.sequence;
  if (name === 'reason') return 'from the bench Tools tab';
  return undefined;
}

/**
 * Whether an option is this action's by name: required, or its description
 * opens with this action. `reason` is only filled where it is, since a tool
 * taking a reason for one action lists it under every action.
 */
function namedFor(tool: ToolCard, action: string | undefined, name: string, property: Schema): boolean {
  if ((branchOf(tool.inputSchema).required ?? []).includes(name)) return true;
  return !!action && actionsNamedIn(String(branchOf(property).description ?? '')).includes(action);
}

/** The starting payload for a call: required options, `action`, and every option the bench holds a value for. */
function startingPayload(tool: ToolCard, action: string | undefined, context: ToolContext): Record<string, unknown> {
  const payload: Record<string, unknown> = { ...payloadOf(tool.inputSchema), ...(action === undefined ? {} : { action }) };
  for (const [name, property] of optionsOf(tool, action)) {
    if (name === 'reason' && !namedFor(tool, action, name, property)) continue;
    const known = knownValue(tool.name, action, name, context);
    if (known !== undefined && known !== '') payload[name] = known;
  }
  return payload;
}

/** Values devharness holds for an option, offered as the field's suggestions. */
function suggestionsFor(tool: string, name: string, values: ToolValues, context: ToolContext): string[] {
  if (name === 'connection') return values.connections;
  if ((name === 'serverId' || name === 'id') && tool === 'server') return values.servers;
  if ((name === 'name' && tool === 'replay') || (name === 'sequence' && tool === 'bench')) return values.sequences;
  if (name === 'profile') return values.profiles;
  if (name === 'url' && tool === 'navigate' && context.pageUrl) return [context.pageUrl];
  return [];
}

/** The JSON type of an option, as the form picks its field by. */
function kindOf(schema: Schema): 'enum' | 'boolean' | 'number' | 'json' | 'text' {
  const branch = branchOf(schema);
  if (Array.isArray(branch.enum)) return 'enum';
  const type = Array.isArray(branch.type) ? branch.type[0] : branch.type;
  if (type === 'boolean') return 'boolean';
  if (type === 'number' || type === 'integer') return 'number';
  if (type === 'array' || type === 'object') return 'json';
  return 'text';
}

/**
 * An opened call: the action, a field for every option it takes, the payload
 * folded behind "JSON", Run, and what the last run returned.
 *
 * An empty field leaves its option out of the payload and a filled one puts it
 * in, so the form and the JSON hold the same set of options. A required option
 * emptied stays in the payload as its empty value, and the call returns the
 * tool's own error for it.
 */
function ToolBody({ tool, toolPicker, action, actions, failedActions, onAction, context, values, draft, last, jsonShown, onToggleJson, onDraft, onReset, onRun }: {
  tool: ToolCard;
  /** The tool dropdown that stands in for the heading's name below 640px, where the rail is hidden. */
  toolPicker: ComponentChildren;
  context: ToolContext;
  values: ToolValues;
  /** The action this body runs, chosen in the form's first row from `actions`; empty for a tool without actions. */
  action?: string;
  actions: string[];
  /** Actions whose last run failed, marked in the action dropdown. */
  failedActions: string[];
  onAction: (action: string) => void;
  draft: string;
  last: ToolRun | 'running' | undefined;
  /** Whether the JSON is open; held above, so it holds across calls and reloads. */
  jsonShown: boolean;
  onToggleJson: () => void;
  onDraft: (text: string) => void;
  onReset: () => void;
  onRun: (args: Record<string, unknown>) => void;
}) {
  const branch = branchOf(tool.inputSchema);
  const required = new Set<string>(branch.required ?? []);
  // The fields the last run failed on, each with what was wrong, marked on their rows until the next run.
  const rejected: Record<string, string> = last && last !== 'running' && last.failed ? last.parameters ?? {} : {};
  // Required options first, then the rest in schema order. The order holds
  // while fields fill, so a row stays under the pointer that is typing in it.
  const properties = optionsOf(tool, action, Object.keys(rejected))
    .sort(([a], [b]) => Number(required.has(b)) - Number(required.has(a)));

  // A payload that does not parse to an object is held back here: the route
  // would otherwise read it as no arguments and run the tool with none.
  let parsed: Record<string, unknown> | null = null;
  let parseError: string | null = null;
  try {
    const value = JSON.parse(draft);
    if (value && typeof value === 'object' && !Array.isArray(value)) parsed = value;
    else parseError = 'the payload is JSON but not an object';
  } catch (error) {
    parseError = error instanceof Error ? error.message : String(error);
  }

  const running = last === 'running';
  const submit = () => { if (parsed && !running) onRun(parsed); };
  const rejectNote = (name: string) => rejected[name] !== undefined && (
    <>
      <span />
      <span class="rejectnote">{rejected[name]}</span>
    </>
  );
  // Open while it does not parse, since the form cannot show what an unparsed payload holds.
  const jsonOpen = jsonShown || !!parseError;

  const set = (name: string, value: unknown) => {
    if (!parsed) return;
    const next = { ...parsed };
    if (value === undefined) delete next[name];
    else next[name] = value;
    onDraft(JSON.stringify(next, null, 2));
  };
  // An emptied field: the option leaves the payload, or holds its empty value where it is required.
  const emptied = (name: string, property: Schema) => (required.has(name) ? valueOf(property) : undefined);

  return (
    <div class="toolbody"
      onKeyDown={(e: KeyboardEvent) => {
        if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
      }}>
      {/* Reset and Run sit in the head, so they hold one place whatever the form's length. */}
      <div class="detailhead">
        <span class="toolmark"><ToolGlyph tool={tool.name} /></span>
        <b class="toolname">{tool.name}</b>
        {toolPicker}
        <span class="toolgist">{gistOf(tool.description)}</span>
        <button class="resetbtn" onClick={onReset} title="put back the payload built from the schema">Reset</button>
        <button class="runbtn" disabled={!parsed || running} onClick={submit}
          title={parseError ? 'the payload does not parse' : 'run this call; History lists it (⌘↵)'}>
          {running ? 'Running…' : 'Run'}
        </button>
      </div>
      {(actions.length > 0 || properties.length > 0) && parsed && (
        <div class="optionform">
          {action !== undefined && actions.length > 0 && (
            <>
              <label class={rejected.action !== undefined ? 'optionrow rejected' : 'optionrow'}>
                <span class="optionname">action</span>
                <select class="optionfield short actionfield" value={action}
                  onChange={(e: Event) => onAction((e.target as HTMLSelectElement).value)}>
                  {actions.map(name => (
                    <option key={name} value={name}>{failedActions.includes(name) ? `${name} · last run failed` : name}</option>
                  ))}
                </select>
              </label>
              {rejectNote('action')}
              {actionGistOf(tool, action) && (
                <>
                  <span />
                  <span class="actiongist">{actionGistOf(tool, action)}</span>
                </>
              )}
            </>
          )}
          {properties.map(([name, property]) => {
            const branchProp = branchOf(property);
            const tip = `${typeOf(property)}${branchProp.description ? ` - ${branchProp.description}` : ''}`;
            const value = parsed![name];
            const unset = value === undefined;
            const kind = kindOf(property);
            const offers = suggestionsFor(tool.name, name, values, context);
            const listId = `offers-${tool.name}-${name}`;
            const blank = required.has(name) ? 'choose' : '–';
            return (
              <Fragment key={name}>
                <label class={['optionrow', unset ? 'unset' : '', rejected[name] !== undefined ? 'rejected' : ''].filter(Boolean).join(' ')} title={tip}>
                  <span class="optionname">{name}{required.has(name) && <span class="paramneeded" title="required" aria-label="required">*</span>}</span>
                  {kind === 'enum' ? (
                    <select class="optionfield short" value={unset ? '' : String(value)}
                      onChange={(e: Event) => {
                        const picked = (e.target as HTMLSelectElement).value;
                        set(name, picked === '' ? emptied(name, property) : branchProp.enum.find((v: unknown) => String(v) === picked));
                      }}>
                      <option value="">{blank}</option>
                      {branchProp.enum.map((v: unknown) => <option key={String(v)} value={String(v)}>{String(v)}</option>)}
                    </select>
                  ) : kind === 'boolean' ? (
                    <select class="optionfield short" value={value === true ? 'true' : value === false ? 'false' : ''}
                      onChange={(e: Event) => {
                        const picked = (e.target as HTMLSelectElement).value;
                        set(name, picked === '' ? emptied(name, property) : picked === 'true');
                      }}>
                      <option value="">{blank}</option>
                      <option value="true">true</option>
                      <option value="false">false</option>
                    </select>
                  ) : kind === 'number' ? (
                    <input type="number" class="optionfield short" placeholder={typeOf(property)}
                      value={typeof value === 'number' ? value : ''}
                      onInput={(e: Event) => {
                        const text = (e.target as HTMLInputElement).value;
                        set(name, text === '' ? emptied(name, property) : Number(text));
                      }} />
                  ) : kind === 'json' ? (
                    <input class="optionfield mono" placeholder={typeOf(property)}
                      defaultValue={unset ? '' : JSON.stringify(value)} key={unset ? 'unset' : JSON.stringify(value)}
                      onChange={(e: Event) => {
                        const text = (e.target as HTMLInputElement).value.trim();
                        if (text === '') { set(name, emptied(name, property)); return; }
                        try { set(name, JSON.parse(text)); } catch { /* left as typed until it parses */ }
                      }} />
                  ) : (
                    <>
                      <input class="optionfield" placeholder={typeOf(property)}
                        value={typeof value === 'string' ? value : ''}
                        list={offers.length ? listId : undefined}
                        onInput={(e: Event) => {
                          const text = (e.target as HTMLInputElement).value;
                          set(name, text === '' ? emptied(name, property) : text);
                        }} />
                      {offers.length > 0 && (
                        <datalist id={listId}>{offers.map(offer => <option key={offer} value={offer} />)}</datalist>
                      )}
                    </>
                  )}
                </label>
                {rejectNote(name)}
              </Fragment>
            );
          })}
        </div>
      )}
      {!parsed && <p class="hint">The payload does not parse, so the form waits for it.</p>}
      {properties.length === 0 && <p class="hint">This call takes no options.</p>}
      {jsonOpen && (
        <textarea class="toolargs" spellcheck={false} value={draft} aria-label="Payload JSON"
          rows={Math.min(16, Math.max(3, draft.split('\n').length))}
          onInput={(e: Event) => onDraft((e.target as HTMLTextAreaElement).value)} />
      )}
      <div class="toolfoot">
        <button class="jsontoggle" aria-expanded={jsonOpen} onClick={onToggleJson}>
          JSON {jsonOpen ? '▾' : '▸'}
        </button>
        {parseError && <span class="bad">{parseError}</span>}
      </div>
      {last && last !== 'running' && (
        <div class="pbox">
          <div class="pboxhead">{last.failed ? <span class="bad">failed</span> : 'returned'}</div>
          <pre class="pboxbody">{last.result || '(no text)'}</pre>
        </div>
      )}
    </div>
  );
}
