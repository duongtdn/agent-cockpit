// A process of an app that writes one key's record again and again, for the
// test of a crash in the middle of a write:
// `node --import run-source.mjs record-writer.ts <stateFolder> <key>`.
// Each record is large, so that most of the time a write is under way, and
// whole only if every entry of its history names the record's conversation.
// It prints `PUT <n>` once the n-th record is in place, and runs until killed.
import { openRecordStore } from '../../src/server/state/records.ts';

const [folder, key] = process.argv.slice(2) as [string, string];
const store = await openRecordStore(folder);

for (let n = 1; ; n += 1) {
  const conversationId = `conversation-${n}`;
  await store.put({
    key,
    conversationId,
    earlierConversations: [],
    directory: '.',
    launchSettings: { round: n },
    history: Array.from({ length: 20_000 }, (_, i) => ({
      operation: 'run' as const,
      jobId: 'explain',
      args: { file: `src/file-${i}.ts` },
      at: '2026-11-27T10:00:00.000Z',
      action: 'sent' as const,
      conversationId,
    })),
  });
  console.log(`PUT ${n}`);
}
