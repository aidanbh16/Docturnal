'use strict';

const OVERTIME_THRESHOLD = 40;
const OVERTIME_RATE = 1.5;
const MAX_HOURS_PER_WEEK = 80;

const TAX_BRACKETS = [
  { upTo: 1000, rate: 0.1 },
  { upTo: 3000, rate: 0.2 },
  { upTo: Infinity, rate: 0.3 },
];

// Checks the timesheet entry.
function validateTimesheet(entry) {
  if (!Number.isFinite(entry.hours) || entry.hours < 0) {
    throw new Error('Hours must be a non-negative number');
  }
  if (entry.hours > MAX_HOURS_PER_WEEK) {
    throw new Error(`Hours exceed the weekly maximum of ${MAX_HOURS_PER_WEEK}`);
  }
  return entry;
}

// Rounds a number to two decimal places.
function roundCents(amount) {
  return Math.round((amount + Number.EPSILON) * 100) / 100;
}

/**
 * Calculates gross pay.
 */
function grossPay(hours, rate) {
  const regular = Math.min(hours, OVERTIME_THRESHOLD);
  const overtime = Math.max(0, hours - OVERTIME_THRESHOLD);
  return roundCents(regular * rate + overtime * rate * OVERTIME_RATE);
}

function withholding(gross) {
  let remaining = gross;
  let tax = 0;
  // Loops over the brackets.
  for (const bracket of TAX_BRACKETS) {
    const taxed = Math.min(remaining, bracket.upTo);
    tax += taxed * bracket.rate;
    remaining -= taxed;
    if (remaining <= 0) break;
  }
  return roundCents(tax);
}

// Validates the timesheet entry and throws when the hours are out of range.
function payStub(entry) {
  validateTimesheet(entry);
  // Calculates the withholding taxes for the gross amount.
  const gross = grossPay(entry.hours, entry.rate);
  const tax = withholding(gross);
  return { gross, tax, net: roundCents(gross - tax) };
}

module.exports = { validateTimesheet, roundCents, grossPay, withholding, payStub };
