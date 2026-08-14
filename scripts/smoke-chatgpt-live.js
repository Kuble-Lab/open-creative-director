'use strict';

const fsp = require('fs/promises');

const chatgpt = require('../lib/chatgpt');

function message(role, text) {
  return {
    type: 'message',
    role,
    content: [{ type: role === 'assistant' ? 'output_text' : 'input_text', text }]
  };
}

async function main() {
  try {
    const imported = await chatgpt.importFromCodexCli();
    console.log(JSON.stringify({
      imported: imported.connected,
      planKnown: Boolean(imported.plan),
      expiryKnown: Number.isFinite(Number(imported.expiresAt)),
      modelCount: imported.models.length
    }));

    const tools = [{
      type: 'function',
      name: 'echo',
      description: 'Returns the supplied text unchanged.',
      parameters: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false
      },
      strict: false
    }];
    const input = [message('user', 'Rufe zuerst das Tool echo mit dem Text OK auf. Sage nach dem Tool-Ergebnis exakt OK.')];
    let firstDeltaLength = 0;
    const first = await chatgpt.streamResponses({
      model: 'gpt-5.6-sol',
      instructions: 'Du bist ein knapper Testassistent. Folge der Tool-Anweisung und sage danach OK.',
      input,
      tools,
      onDelta: (delta) => { firstDeltaLength += delta.length; }
    });
    if (!first.toolCalls.length) throw new Error('Live-Smoke lieferte keinen Tool-Call.');

    if (first.text) input.push(message('assistant', first.text));
    for (const call of first.toolCalls) {
      input.push({
        type: 'function_call',
        name: call.name,
        arguments: call.arguments,
        call_id: call.call_id
      });
      input.push({ type: 'function_call_output', call_id: call.call_id, output: 'OK' });
    }

    let finalDeltaLength = 0;
    const final = await chatgpt.streamResponses({
      model: 'gpt-5.6-sol',
      instructions: 'Du bist ein knapper Testassistent. Folge der Tool-Anweisung und sage danach OK.',
      input,
      tools,
      onDelta: (delta) => { finalDeltaLength += delta.length; }
    });
    console.log(JSON.stringify({
      toolCallRoundtrip: first.toolCalls.some((call) => call.name === 'echo'),
      firstDeltaLength,
      finalDeltaLength,
      finalOk: /\bOK\b/i.test(final.text),
      usageReceived: Boolean(first.usage || final.usage)
    }));
    if (!/\bOK\b/i.test(final.text)) throw new Error('Live-Smoke endete nicht mit OK.');
  } finally {
    await chatgpt.disconnect().catch(() => {});
    await fsp.rm(chatgpt.AUTH_FILE, { force: true });
  }
}

main().catch((err) => {
  console.error(`ChatGPT-Live-Smoke fehlgeschlagen: ${err.message}`);
  process.exitCode = 1;
});
