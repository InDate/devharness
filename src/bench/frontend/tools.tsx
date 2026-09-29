/** @jsxImportSource preact */
import { useEffect, useState } from 'preact/hooks';
import { Fold, Row } from './row.js';
import { ToolGlyph } from './tool-glyph.js';
import type { ToolCard, ToolGroup, ToolRun } from '../wire.js';

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

/** What the `action` description says of one action, as in `list (list all tabs)`; empty where it says nothing. */
function actionGistOf(schema: Schema, action: string): string {
  const words = String(branchOf(branchOf(schema).properties?.action ?? {}).description ?? '');
  const escaped = action.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return words.match(new RegExp(`\\b${escaped}\\s*[:(-]\\s*([^),;]+)`))?.[1]?.trim() ?? '';
}

/** A run's state at the right end of its row. */
function readingOf(last: ToolRun | 'running' | undefined) {
  if (last === 'running') return <span class="meta">running</span>;
  if (last) return <span class={last.failed ? 'meta bad' : 'meta'}>{last.failed ? 'failed' : 'ran'}</span>;
  return null;
}

/**
 * Every tool this devharness serves, one fold per toolset, one row per tool.
 * A grouped tool opens to one row per action; a tool without actions, and
 * each action, opens to its parameters and a JSON payload that runs it as a
 * call from the bench, so History lists it with the rest.
 *
 * Drafts and results are held here rather than in the rows, keyed by tool and
 * action, so folding a toolset or closing a row keeps what was typed and what
 * came back.
 */
export function Tools({ base }: { base: string }) {
  const [groups, setGroups] = useState<ToolGroup[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [reading, setReading] = useState<string | null>(null);
  const [readingAction, setReadingAction] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [runs, setRuns] = useState<Record<string, ToolRun | 'running'>>({});

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

  const keyOf = (tool: ToolCard, action?: string) => (action === undefined ? tool.name : `${tool.name}.${action}`);

  const draftOf = (tool: ToolCard, action?: string) => drafts[keyOf(tool, action)]
    ?? JSON.stringify({ ...payloadOf(tool.inputSchema), ...(action === undefined ? {} : { action }) }, null, 2);

  const run = async (key: string, tool: ToolCard, args: Record<string, unknown>) => {
    setRuns(now => ({ ...now, [key]: 'running' }));
    const result: ToolRun = await fetch(`${base}/tools/call`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ tool: tool.name, args }),
    })
      .then(async res => (res.ok
        ? res.json()
        : { failed: true, result: `The bench answered ${res.status}: ${await res.text()}` }))
      .catch((error: unknown) => ({ failed: true, result: `The bench did not answer: ${String(error)}` }));
    setRuns(now => ({ ...now, [key]: result }));
  };

  const body = (tool: ToolCard, action?: string) => {
    const key = keyOf(tool, action);
    return (
      <ToolBody tool={tool} action={action} draft={draftOf(tool, action)} last={runs[key]}
        onDraft={text => setDrafts(now => ({ ...now, [key]: text }))}
        onReset={() => setDrafts(now => {
          const { [key]: _, ...rest } = now;
          return rest;
        })}
        onRun={args => run(key, tool, args)} />
    );
  };

  return (
    <div class="toolsets">
      {groups.map(group => (
        <Fold key={group.name} title={group.name} count={group.tools.length} open={false}
          summary={<span class="toolmarks">
            {group.tools.map(tool => <span key={tool.name} class="toolmark" title={tool.name}><ToolGlyph tool={tool.name} /></span>)}
          </span>}>
          <ol class="activitycards">
            {group.tools.map(tool => {
              const actions = actionsOf(tool.inputSchema);
              const last = actions.length ? undefined : runs[tool.name];
              return (
                <Row key={tool.name}
                  classes={['toolrow', last && last !== 'running' && last.failed ? 'failed' : '']}
                  label={<><span class="toolmark"><ToolGlyph tool={tool.name} /></span><span class="what">{tool.name}</span><span class="toolgist">{gistOf(tool.description)}</span></>}
                  title={tool.description}
                  reading={actions.length
                    ? <span class="meta">{actions.length} actions</span>
                    : readingOf(last)}
                  slots={{}} columns={[]}
                  open={reading === tool.name}
                  onOpen={() => setReading(reading === tool.name ? null : tool.name)}>
                  {actions.length === 0 ? body(tool) : (
                    <div class="body toolbody">
                      <p class="tooldescription">{tool.description}</p>
                      <ol class="activitycards toolactions">
                        {actions.map(action => {
                          const key = keyOf(tool, action);
                          const lastRun = runs[key];
                          const gist = actionGistOf(tool.inputSchema, action);
                          return (
                            <Row key={key}
                              classes={['toolrow', 'actionrow', lastRun && lastRun !== 'running' && lastRun.failed ? 'failed' : '']}
                              label={<><span class="what">{action}</span>{gist && <span class="toolgist">{gist}</span>}</>}
                              reading={readingOf(lastRun)}
                              slots={{}} columns={[]}
                              open={readingAction === key}
                              onOpen={() => setReadingAction(readingAction === key ? null : key)}>
                              {body(tool, action)}
                            </Row>
                          );
                        })}
                      </ol>
                    </div>
                  )}
                </Row>
              );
            })}
          </ol>
        </Fold>
      ))}
    </div>
  );
}

/** An opened tool: what it does, what it takes, the payload, and what the last run returned. */
function ToolBody({ tool, action, draft, last, onDraft, onReset, onRun }: {
  tool: ToolCard;
  /** The action this body runs; its tool's row above already shows the description. */
  action?: string;
  draft: string;
  last: ToolRun | 'running' | undefined;
  onDraft: (text: string) => void;
  onReset: () => void;
  onRun: (args: Record<string, unknown>) => void;
}) {
  const branch = branchOf(tool.inputSchema);
  const required = new Set<string>(branch.required ?? []);
  const properties = Object.entries<Schema>(branch.properties ?? {})
    .filter(([name]) => action === undefined || name !== 'action');

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

  return (
    <div class="body historybody toolbody">
      {action === undefined && <p class="tooldescription">{tool.description}</p>}
      {properties.length > 0 && (
        <div class="pbox">
          <div class="pboxhead">takes</div>
          <dl class="toolparams">
            {properties.map(([name, property]) => (
              <div key={name} class="toolparam">
                <dt>
                  <span class="paramname">{name}</span>
                  {required.has(name) && <span class="paramneeded">required</span>}
                  <span class="paramtype">{typeOf(property)}</span>
                </dt>
                {branchOf(property).description && <dd>{branchOf(property).description}</dd>}
              </div>
            ))}
          </dl>
        </div>
      )}
      <div class="pbox">
        <div class="pboxhead">
          <span>payload</span>
          <span class="grow" />
          {parseError && <span class="bad">{parseError}</span>}
        </div>
        <textarea class="toolargs" spellcheck={false} value={draft}
          rows={Math.min(16, Math.max(3, draft.split('\n').length))}
          onInput={(e: Event) => onDraft((e.target as HTMLTextAreaElement).value)}
          onKeyDown={(e: KeyboardEvent) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); submit(); }
          }} />
      </div>
      <div class="bodyfoot">
        <span class="footsummary">runs against the live session, and History lists the call</span>
        <span class="grow" />
        <span class="footactions">
          <button class="tool" onClick={onReset} title="put back the payload built from the schema">Reset</button>
          <button class="tool" disabled={!parsed || running} onClick={submit}
            title={parseError ? 'the payload does not parse' : 'run this tool (⌘↵)'}>
            {running ? 'Running…' : 'Run'}
          </button>
        </span>
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
