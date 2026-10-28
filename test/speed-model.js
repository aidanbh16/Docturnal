'use strict';

// Simulated model time, calibrated from a real first run on a GitHub-hosted runner (4 CPUs,
// Ollama 0.40.11): the comment model (3B) took 130 s for a folder call with a prompt of about
// 1,700 tokens and an answer cut off at 700 tokens, which fits about 26 prompt tokens and 14
// answer tokens a second. The docs model (7B) planned layers and wrote layer docs at about 24
// prompt tokens and 5 answer tokens a second. A token is counted as 3 characters.
//
// Answers are counted the way a real model writes them, not the mock's short ones: a folder
// summary is about 60 tokens plus 25 for each file it describes, a layer plan 60 plus 40 for
// each group, and a document fills its num_predict. A comment request fills its num_predict
// too, as the real comment replies often did, so comment time is never underestimated, and an
// accuracy check answers about 20 tokens for each comment it judges.

const SPEEDS = {
  'comment-model': { prompt: 26, answer: 14, load: 25 },
  'docs-model': { prompt: 24, answer: 5, load: 40 },
};
const CHARS_PER_TOKEN = 3;

function promptOf(request) {
  return (request.messages || []).map((m) => m.content).join('\n');
}

function answerTokens(request, content) {
  const props = (request.format && request.format.properties) || {};
  const prompt = promptOf(request);
  if (props.summary && props.files) return 60 + 25 * (prompt.match(/^\* /gm) || []).length;
  if (props.layers) return 60 + 40 * (prompt.match(/^- g\d+:/gm) || []).length;
  if (/documentation page/.test(prompt) && request.options && request.options.num_predict) return request.options.num_predict;
  if (props.comments && request.options && request.options.num_predict) return request.options.num_predict;
  if (props.verdicts) return 10 + 20 * (prompt.match(/^Item \d+$/gm) || []).length;
  return Math.ceil(String(content).length / CHARS_PER_TOKEN);
}

// A chat function that answers through the mock Ollama server and moves a simulated clock by
// the time the call would take. Returns { chat, now, calls }.
function simulatedChat(mock, start = Date.parse('2026-10-24T00:00:00Z')) {
  let clock = start;
  const loaded = new Set();
  const calls = [];
  const chat = async (request) => {
    const res = await fetch(`http://${mock.host}/api/chat`, { method: 'POST', body: JSON.stringify({ ...request, stream: false }) });
    const content = (await res.json()).message.content;
    const speed = SPEEDS[request.model];
    const prompt = promptOf(request);
    let seconds = prompt.length / CHARS_PER_TOKEN / speed.prompt + answerTokens(request, content) / speed.answer;
    if (!loaded.has(request.model)) {
      loaded.add(request.model);
      seconds += speed.load;
    }
    clock += seconds * 1000;
    calls.push({ model: request.model, label: request.label, promptChars: prompt.length, seconds, system: (request.messages[0] || {}).content });
    return content;
  };
  return { chat, now: () => clock, calls, minutes: () => (clock - start) / 60000 };
}

module.exports = { SPEEDS, simulatedChat };
