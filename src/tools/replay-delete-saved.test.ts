/**
 * Deleting a saved sequence takes the one named exactly, and the copy loaded
 * in memory with it. A deletion cannot be undone, so a name that only begins
 * another deletes nothing.
 */
import { describe, it, expect, vi } from 'vitest';
import { handleDeleteSaved } from './replay-library.js';

function recorder() {
  const deleteSequenceFromDisk = vi.fn(async () => true);
  const deleteSequence = vi.fn(() => true);
  return {
    deleteSequenceFromDisk, deleteSequence,
    listSavedSequencesOnDisk: async () => [
      { name: 'asd', filename: 'asd.json', fullPath: '/seq/asd.json' },
      { name: 'asdasd', filename: 'asdasd.json', fullPath: '/seq/asdasd.json' },
    ],
    listSequences: () => [{ id: 'seq-asd', name: 'asd' }, { id: 'seq-asdasd', name: 'asdasd' }],
  } as any;
}

describe('deleting a saved sequence', () => {
  it('deletes the file named exactly, and drops its loaded copy', async () => {
    const held = recorder();
    const result: any = await handleDeleteSaved({ action: 'deleteSaved', filename: 'asd' } as any, held);
    expect(result.isError).not.toBe(true);
    expect(held.deleteSequenceFromDisk).toHaveBeenCalledExactlyOnceWith('/seq/asd.json');
    expect(held.deleteSequence).toHaveBeenCalledExactlyOnceWith('seq-asd');
  });

  it('deletes nothing for a name that only begins another', async () => {
    const held = recorder();
    const result: any = await handleDeleteSaved({ action: 'deleteSaved', filename: 'as' } as any, held);
    expect(result.content[0].text).toContain('No saved sequence is named exactly "as"');
    expect(held.deleteSequenceFromDisk).not.toHaveBeenCalled();
    expect(held.deleteSequence).not.toHaveBeenCalled();
  });
});
