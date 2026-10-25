'use strict';

// Runs src/python-helper.py with python3 to analyze and verify Python source.

const { spawnSync } = require('child_process');
const path = require('path');

const HELPER = path.join(__dirname, 'python-helper.py');

let cachedPython;

// Finds a Python 3.8+ interpreter. Tries "python" too, because Windows often has no python3.
function findPython() {
  if (cachedPython !== undefined) return cachedPython;
  cachedPython = null;
  for (const command of ['python3', 'python']) {
    const result = spawnSync(command, ['-c', 'import sys; print(sys.version_info[0] * 100 + sys.version_info[1])'], {
      encoding: 'utf8',
      timeout: 10000,
      windowsHide: true,
    });
    if (result.status === 0 && Number(result.stdout.trim()) >= 308) {
      cachedPython = command;
      break;
    }
  }
  return cachedPython;
}

function runHelper(request) {
  const python = findPython();
  if (!python) throw new Error('python3 (3.8 or later) not found');
  // -I keeps PYTHON* variables and the working directory out of the import path.
  const result = spawnSync(python, ['-I', HELPER], {
    input: JSON.stringify(request),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: 120000,
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`Python helper failed: ${(result.stderr || '').trim().slice(-500)}`);
  }
  return JSON.parse(result.stdout);
}

function analyzePython(source) {
  return runHelper({ mode: 'analyze', source });
}

// The environment variables Python code reads, from its syntax tree; null when it cannot be read.
function pythonEnvNames(source) {
  const result = runHelper({ mode: 'env', source });
  return result.ok ? result.names : null;
}

function verifyPython(original, candidates) {
  return runHelper({ mode: 'verify', original, candidates }).results;
}

module.exports = { analyzePython, findPython, pythonEnvNames, verifyPython };
