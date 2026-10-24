'use strict';

// Shared test helpers.

const { applyProposals } = require('../src/comments');
const { accuracyReply, kindOf } = require('./mock-ollama');

// Most tests give line numbers only. A model that counts right sends the text of that line as
// the anchor, so this fills it in the same way. A proposal with its own anchor keeps it.
function withAnchor(text, proposal) {
  if (!proposal || typeof proposal !== 'object' || 'anchor' in proposal || !Number.isInteger(proposal.line)) return proposal;
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const line = body.split(/\r\n|\n|\r/)[proposal.line - 1];
  return { ...proposal, anchor: line === undefined ? '' : line.trim() };
}

function applyAnchored(args) {
  const groups = args.groups || [args.proposals];
  return applyProposals({ ...args, proposals: undefined, groups: groups.map((group) => group.map((p) => withAnchor(args.text, p))) });
}

// Wraps a mock handler so it also answers the accuracy check: every comment is accurate
// unless isAccurate(comment, code) says otherwise.
function withAccuracy(handler, isAccurate) {
  return (body, index) => (kindOf(body) === 'accuracy' ? accuracyReply(body, isAccurate) : handler(body, index));
}

module.exports = { applyAnchored, withAccuracy, withAnchor };
