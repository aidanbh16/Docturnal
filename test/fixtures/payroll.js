'use strict';

const OVERTIME_THRESHOLD_HOURS = 40;
const OVERTIME_MULTIPLIER = 1.5;
const TAX_BRACKETS = [
  { upTo: 1000, rate: 0.1 },
  { upTo: 4000, rate: 0.2 },
  { upTo: Infinity, rate: 0.3 },
];

function grossPay(hours, hourlyRate) {
  const regular = Math.min(hours, OVERTIME_THRESHOLD_HOURS);
  const overtime = Math.max(0, hours - OVERTIME_THRESHOLD_HOURS);
  return regular * hourlyRate + overtime * hourlyRate * OVERTIME_MULTIPLIER;
}

function incomeTax(gross) {
  let tax = 0;
  let lower = 0;
  for (const bracket of TAX_BRACKETS) {
    if (gross <= lower) break;
    const taxable = Math.min(gross, bracket.upTo) - lower;
    tax += taxable * bracket.rate;
    lower = bracket.upTo;
  }
  return Math.round(tax * 100) / 100;
}

function netPay(hours, hourlyRate, deductions = []) {
  const gross = grossPay(hours, hourlyRate);
  const withheld = deductions.reduce((sum, d) => sum + d.amount, 0);
  return Math.max(0, gross - incomeTax(gross) - withheld);
}

const formatCurrency = (amount) =>
  `$${amount.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ',')}`;

function payslip(employee) {
  const gross = grossPay(employee.hours, employee.rate);
  const net = netPay(employee.hours, employee.rate, employee.deductions);
  return {
    name: employee.name,
    gross: formatCurrency(gross),
    tax: formatCurrency(incomeTax(gross)),
    net: formatCurrency(net),
  };
}

module.exports = { grossPay, incomeTax, netPay, formatCurrency, payslip };
