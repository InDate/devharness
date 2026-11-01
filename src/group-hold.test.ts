import { afterEach, describe, it, expect } from 'vitest';
import { groupPeers, holdWithGroup, releaseWithGroup } from './group-hold.js';
import { endGroup, joinGroup } from './groups.js';
import { attachLayer, forgetConnection, hold, holdReading, type HoldLayer } from './hold.js';

const GROUP = 'pause-pair';
const RUN_ON = 'pause-pair-one';
const PEER = 'pause-pair-two';
const CLOSED = 'pause-pair-closed';
const OUTSIDE = 'pause-pair-outside';

function attach(connection: string, layers: HoldLayer[]): void {
  for (const layer of layers) {
    attachLayer(connection, layer, { engage: async () => {}, disengage: async () => {} });
  }
}

const heldLayers = (connection: string) => holdReading(connection).held.map(held => held.layer).sort();

afterEach(() => {
  endGroup(GROUP);
  for (const connection of [RUN_ON, PEER, CLOSED, OUTSIDE]) forgetConnection(connection);
});

describe('a run paused on one browser of a group holds the group', () => {
  it('holds every open member under the run\'s pause, and leaves a member with no layer out', async () => {
    joinGroup(GROUP, RUN_ON);
    joinGroup(GROUP, PEER);
    joinGroup(GROUP, CLOSED);
    attach(RUN_ON, ['code', 'network']);
    attach(PEER, ['code']);

    expect(groupPeers(RUN_ON)).toEqual([PEER]);
    await holdWithGroup(RUN_ON, { owner: { kind: 'run-pause', run: 'run-a' } });

    expect(heldLayers(RUN_ON)).toEqual(['code', 'network']);
    expect(holdReading(PEER).held.map(held => held.owners)).toEqual([[{ kind: 'run-pause', run: 'run-a' }]]);
    expect(heldLayers(CLOSED)).toEqual([]);
  });

  it('releases the pause on every member as the run carries on, leaving a person\'s hold on a peer', async () => {
    joinGroup(GROUP, RUN_ON);
    joinGroup(GROUP, PEER);
    attach(RUN_ON, ['code']);
    attach(PEER, ['code', 'network']);
    await hold(PEER, { owner: { kind: 'person' }, layers: ['network'] });
    await holdWithGroup(RUN_ON, { owner: { kind: 'run-pause', run: 'run-a' } });
    expect(heldLayers(PEER)).toEqual(['code', 'network']);

    await releaseWithGroup(RUN_ON, { by: { kind: 'run', run: 'run-a', pauseOnly: true } });

    expect(heldLayers(RUN_ON)).toEqual([]);
    expect(heldLayers(PEER)).toEqual(['network']);
  });

  it('holds the run\'s own browser alone where it belongs to no group', async () => {
    attach(RUN_ON, ['code']);
    attach(OUTSIDE, ['code']);

    await holdWithGroup(RUN_ON, { owner: { kind: 'run-pause', run: 'run-a' } });

    expect(heldLayers(RUN_ON)).toEqual(['code']);
    expect(heldLayers(OUTSIDE)).toEqual([]);
  });
});
