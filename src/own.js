'use strict';

// Lookups keyed by words from code, file and folder names, README text, or model output.
// A plain object answers keys such as "constructor", "toString", and "__proto__" from its
// prototype, so every such lookup reads only the object's own properties.

// obj[key] when obj has key as its own property, otherwise undefined.
function own(obj, key) {
  return obj !== null && typeof obj === 'object' && Object.hasOwn(obj, key) ? obj[key] : undefined;
}

module.exports = { own };
