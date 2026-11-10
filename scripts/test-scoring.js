#!/usr/bin/env node
'use strict';
/**
 * Offline checks for the filtering and scoring logic. No network, no token.
 * Uses the committed config/markets.example.json.
 *
 *   npm test
 */
const assert = require('assert');
const { keepKeyword, baseScore, tooSimilar } = require('../src/market-radar');

// Product-intent keywords are kept
assert.strictEqual(keepKeyword({ keyword: 'organic coffee beans 1kg' }), true);
assert.strictEqual(keepKeyword({ keyword: 'kaffee bohnen großhandel' }), true);

// Informational, review and marketplace queries are dropped
assert.strictEqual(keepKeyword({ keyword: 'what is espresso roast' }), false);
assert.strictEqual(keepKeyword({ keyword: 'coffee beans review' }), false);
assert.strictEqual(keepKeyword({ keyword: 'coffee beans amazon' }), false);

// No product signal, too short or too long
assert.strictEqual(keepKeyword({ keyword: 'espresso' }), false);
assert.strictEqual(keepKeyword({ keyword: 'pod' }), false);
assert.strictEqual(keepKeyword({ keyword: 'coffee beans '.repeat(6) }), false);

// Score rewards volume and punishes difficulty
assert.ok(baseScore({ volume: 1000, difficulty: 0 }) > baseScore({ volume: 1000, difficulty: 20 }));
assert.strictEqual(baseScore({ volume: 500, difficulty: 4 }), 100);

// Near-duplicates are collapsed before spending trend calls on them
assert.strictEqual(tooSimilar('decaf coffee beans', 'coffee beans decaf'), true);
assert.strictEqual(tooSimilar('decaf coffee beans', 'espresso capsules bulk'), false);

console.log('ok: 12 filtering and scoring checks passed');
