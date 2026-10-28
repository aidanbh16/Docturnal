'use strict';

// Shared test helpers.

const { accuracyReply, commentsReply, kindOf } = require('./mock-ollama');

// Wraps a mock handler so it also answers the accuracy check: every comment is accurate
// unless isAccurate(comment, code) says otherwise.
function withAccuracy(handler, isAccurate) {
  return (body, index) => (kindOf(body) === 'accuracy' ? accuracyReply(body, isAccurate) : handler(body, index));
}

// A mock handler that writes each target's comment with textFor(target) (see targetsOf in
// mock-ollama.js), and answers the accuracy check with isAccurate.
function writing(textFor, isAccurate) {
  return withAccuracy((body) => commentsReply(body, textFor), isAccurate);
}

// A mock handler that writes the comment byCode gives for the code on each target's line,
// trimmed, and leaves out the targets it has none for.
function writingByCode(byCode, isAccurate) {
  return withAccuracy((body) => {
    const prompt = body.messages.map((m) => m.content).join('\n');
    const codeAt = (line) => ((prompt.match(new RegExp(`^${line}\\| (.*)$`, 'm')) || [])[1] || '').trim();
    return commentsReply(body, (t) => byCode[codeAt(t.line)]);
  }, isAccurate);
}

module.exports = { withAccuracy, writing, writingByCode };
