import test from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { removeStaleParts, transformStage } from '../src/collector.js';

function conversation(messages) {
  const mapping = { root: { id: 'root', parent: null, children: ['m1'], message: null } };
  messages.forEach((message, index) => {
    const id = `m${index + 1}`;
    mapping[id] = {
      id,
      parent: index ? `m${index}` : 'root',
      children: index + 1 < messages.length ? [`m${index + 2}`] : [],
      message: { id, author: { role: message.role }, content: { content_type: 'text', parts: [message.text] } }
    };
  });
  return { conversation_id: 'conversation-1', title: 'Large Session', create_time: 1784848039, current_node: `m${messages.length}`, mapping };
}

function markdown(messages) {
  return `# Large Session\n*2026-07-23*\n\n${messages.map((message) => `**${message.role[0].toUpperCase()}${message.role.slice(1)}:**\n\n${message.text}`).join('\n\n---\n\n')}\n`;
}

test('oversized conversations publish deterministic transclusion parts on message boundaries', async () => {
  const stage = await mkdtemp(path.join(os.tmpdir(), 'chatgpt-transclusion-'));
  try {
    const dir = path.join(stage, 'projects', 'Project', 'conversations');
    await mkdir(dir, { recursive: true });
    const messages = [
      { role: 'user', text: `${'u'.repeat(2500)}\n\n## User heading` },
      { role: 'assistant', text: `${'a'.repeat(2500)}\n\n---\n\n\`\`\`md\n**Assistant:**\n# fenced heading\n\`\`\`` },
      { role: 'user', text: `${'v'.repeat(2500)}\n\nFinal paragraph` }
    ];
    const base = path.join(dir, 'conversation-1');
    await writeFile(`${base}.json`, JSON.stringify(conversation(messages)));
    await writeFile(`${base}.md`, markdown(messages));

    await transformStage(stage, { id: 'project-id' }, 4096);
    const names = (await readdir(dir)).filter((name) => name.endsWith('.md')).sort();
    assert.deepEqual(names, ['conversation-1.md', 'conversation-1.part-0001.md', 'conversation-1.part-0002.md', 'conversation-1.part-0003.md']);
    const index = await readFile(`${base}.md`, 'utf8');
    assert.match(index, /parts: 3/);
    assert.match(index, /!\[\[projects\/Project\/conversations\/conversation-1\.part-0001\]\]/);
    const part2 = await readFile(`${base}.part-0002.md`, 'utf8');
    assert.match(part2, /##? User heading|a{100}/);
    assert.match(part2, /```md\n\*\*Assistant:\*\*\n# fenced heading\n```/);
    assert.match(part2, /\^chatgpt-m2/);

    const before = await Promise.all(names.map((name) => readFile(path.join(dir, name), 'utf8')));
    await transformStage(stage, { id: 'project-id' }, 4096);
    const after = await Promise.all(names.map((name) => readFile(path.join(dir, name), 'utf8')));
    assert.deepEqual(after, before);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
});

test('message-role mismatch fails without replacing the source markdown', async () => {
  const stage = await mkdtemp(path.join(os.tmpdir(), 'chatgpt-transclusion-mismatch-'));
  try {
    const base = path.join(stage, 'conversation-1');
    const source = markdown([{ role: 'assistant', text: 'x'.repeat(5000) }]);
    await writeFile(`${base}.json`, JSON.stringify(conversation([{ role: 'user', text: 'x'.repeat(5000) }])));
    await writeFile(`${base}.md`, source);
    await assert.rejects(transformStage(stage, { id: 'project-id' }, 4096), /roles\/messages do not match/);
    assert.equal(await readFile(`${base}.md`, 'utf8'), source);
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
});

test('stale cleanup removes only prior generated parts absent from the current manifest', async () => {
  const output = await mkdtemp(path.join(os.tmpdir(), 'chatgpt-stale-parts-'));
  try {
    await writeFile(path.join(output, 'conversation.md'), 'index');
    await writeFile(path.join(output, 'conversation.part-0001.md'), 'current');
    await writeFile(path.join(output, 'conversation.part-0002.md'), 'stale');
    const prior = { projects: [{ project: 'p', output_prefix: '.', files: [
      { path: 'conversation.md' }, { path: 'conversation.part-0001.md' }, { path: 'conversation.part-0002.md' }
    ] }] };
    const projects = [{ project: 'p', files: [{ path: 'conversation.md' }, { path: 'conversation.part-0001.md' }] }];
    assert.deepEqual(await removeStaleParts(prior, projects, output), ['conversation.part-0002.md']);
    await access(path.join(output, 'conversation.md'));
    await access(path.join(output, 'conversation.part-0001.md'));
    await assert.rejects(access(path.join(output, 'conversation.part-0002.md')));
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
